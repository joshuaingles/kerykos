import * as SQLite from 'expo-sqlite';
import { createMMKV } from 'react-native-mmkv';
import type { ModelPricing, SessionSnapshot } from './types';

export const settings = createMMKV({
  id: 'kerykos-settings',
  // encryptionKey: derived from device keychain in Phase 1
});

// Typed helpers
export function getSetting<T>(key: string, fallback: T): T {
  const val = settings.getString(key);
  if (val === undefined) return fallback;
  return JSON.parse(val) as T;
}

export function setSetting<T>(key: string, value: T): void {
  settings.set(key, JSON.stringify(value));
}

// === Phase 5 §5.1 — SQLite AnalyticsDB ===

const DB_NAME = 'kerykos-analytics.db';

export interface SyncStateRow {
  lastSyncWatermark: number;
  lastFullSyncAt: number;
  totalSessionsSynced: number;
}

export interface SyncStateDbRow {
  gateway_id: string;
  last_sync_watermark: number | null;
  last_full_sync_at: number | null;
  total_sessions_synced: number | null;
}

/**
 * On-device analytics storage (Phase 5 §5.1). Synchronous expo-sqlite API.
 * KR-4a: every snapshot/aggregate row keys on gateway_id — all queries filter.
 *
 * NFR-1: data lives only in this local DB — no third-party SDKs, no network.
 */
export class AnalyticsDB {
  private db: SQLite.SQLiteDatabase;

  constructor() {
    this.db = SQLite.openDatabaseSync(DB_NAME);
    this.initialize();
  }

  private initialize(): void {
    this.db.execSync(`
      CREATE TABLE IF NOT EXISTS session_snapshots (
        id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        model TEXT,
        source TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL DEFAULT 0,
        actual_cost_usd REAL,
        enriched_cost_usd REAL,
        api_call_count INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        started_at REAL,
        ended_at REAL,
        end_reason TEXT,
        last_active REAL,
        parent_session_id TEXT,
        archived INTEGER DEFAULT 0,
        pinned INTEGER DEFAULT 0,
        hidden INTEGER DEFAULT 0,
        synced_at REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_gateway
        ON session_snapshots(gateway_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_last_active
        ON session_snapshots(gateway_id, last_active);
      CREATE INDEX IF NOT EXISTS idx_snapshots_model
        ON session_snapshots(gateway_id, model);

      CREATE TABLE IF NOT EXISTS daily_aggregates (
        gateway_id TEXT NOT NULL,
        date TEXT NOT NULL,
        total_cost_usd REAL DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_api_calls INTEGER DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0,
        PRIMARY KEY (gateway_id, date)
      );

      CREATE TABLE IF NOT EXISTS model_pricing (
        model TEXT PRIMARY KEY,
        provider TEXT,
        input_cost_per_token REAL,
        output_cost_per_token REAL,
        cached_cost_per_token REAL,
        updated_at REAL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        gateway_id TEXT PRIMARY KEY,
        last_sync_watermark REAL,
        last_full_sync_at REAL,
        total_sessions_synced INTEGER DEFAULT 0
      );
    `);
  }

  // === Typed helper wrappers ===

  /** Run a SELECT returning typed rows. */
  query<T>(sql: string, params: SQLite.SQLiteBindParams = []): T[] {
    return this.db.getAllSync<T>(sql, params);
  }

  /** Run a SELECT expecting at most one row. */
  queryFirst<T>(sql: string, params: SQLite.SQLiteBindParams = []): T | null {
    return this.db.getFirstSync<T>(sql, params) ?? null;
  }

  /** Run a DDL/DML statement with params (INSERT OR REPLACE, UPDATE…). */
  exec(sql: string, params: SQLite.SQLiteBindParams = []): void {
    this.db.runSync(sql, params);
  }

  /**
   * Batch upsert for session_snapshots. Writes enriched_cost_usd at write
   * time (KR-19 rule: actual>0 ?? estimated>0 ?? NULL-unknown); a later
   * enrichment pass (applyPricingEnrichment, after fetchModelPricing) fills
   * pricing-derived values for the NULL rows.
   */
  prepareUpsert(_table: string): { run: (row: Omit<SessionSnapshot, 'enriched_cost_usd'>) => void } {
    const stmt = this.db.prepareSync(`
      INSERT OR REPLACE INTO session_snapshots (
        id, gateway_id, session_id, title, model, source,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, estimated_cost_usd, actual_cost_usd, enriched_cost_usd,
        api_call_count, tool_call_count, message_count,
        started_at, ended_at, end_reason, last_active,
        parent_session_id, archived, pinned, hidden, synced_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    return {
      run: (row) => {
        const actual = row.actual_cost_usd;
        const estimated = row.estimated_cost_usd;
        // KR-19: 0.0 estimated is "unknown", not free — don't persist it as a
        // usable cost. actual > 0 wins; else estimated > 0; else NULL.
        const enriched = actual !== null && actual > 0
          ? actual
          : estimated > 0
            ? estimated
            : null;
        stmt.executeSync(
          row.id, row.gateway_id, row.session_id, row.title, row.model, row.source,
          row.input_tokens, row.output_tokens, row.cache_read_tokens,
          row.cache_write_tokens, row.reasoning_tokens,
          estimated, actual, enriched,
          row.api_call_count, row.tool_call_count, row.message_count,
          row.started_at, row.ended_at, row.end_reason, row.last_active,
          row.parent_session_id, row.archived, row.pinned, row.hidden, row.synced_at,
        );
      },
    };
  }

  getSyncState(gatewayId: string): SyncStateRow | null {
    const row = this.queryFirst<SyncStateDbRow>(
      'SELECT * FROM sync_state WHERE gateway_id = ?',
      [gatewayId],
    );
    if (!row) return null;
    return {
      lastSyncWatermark: row.last_sync_watermark ?? 0,
      lastFullSyncAt: row.last_full_sync_at ?? 0,
      totalSessionsSynced: row.total_sessions_synced ?? 0,
    };
  }

  setSyncState(gatewayId: string, state: SyncStateRow): void {
    this.exec(`
      INSERT OR REPLACE INTO sync_state
        (gateway_id, last_sync_watermark, last_full_sync_at, total_sessions_synced)
      VALUES (?, ?, ?, ?)
    `, [gatewayId, state.lastSyncWatermark, state.lastFullSyncAt, state.totalSessionsSynced]);
  }

  upsertModelPricing(p: ModelPricing): void {
    this.exec(`
      INSERT OR REPLACE INTO model_pricing
        (model, provider, input_cost_per_token, output_cost_per_token, cached_cost_per_token, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [p.model, p.provider, p.input_cost_per_token, p.output_cost_per_token, p.cached_cost_per_token, p.updated_at]);
  }

  getModelPricing(model: string): ModelPricing | null {
    return this.queryFirst<ModelPricing>(
      'SELECT model, provider, input_cost_per_token, output_cost_per_token, cached_cost_per_token FROM model_pricing WHERE model = ?',
      [model],
    );
  }

  /**
   * KR-19 enrichment pass: for snapshots whose enriched_cost_usd is NULL
   * (estimated was 0.0 / unknown) but which have a pricing row, derive cost
   * from token counts × pricing. Leaves truly-unpriced sessions NULL.
   */
  applyPricingEnrichment(gatewayId: string): void {
    this.exec(`
      UPDATE session_snapshots
      SET enriched_cost_usd = (
        input_tokens * COALESCE(p.input_cost_per_token, 0)
        + output_tokens * COALESCE(p.output_cost_per_token, 0)
        + cache_read_tokens * COALESCE(p.cached_cost_per_token, 0)
      )
      FROM model_pricing p
      WHERE session_snapshots.model = p.model
        AND session_snapshots.gateway_id = ?
        AND session_snapshots.enriched_cost_usd IS NULL
        AND (session_snapshots.input_tokens > 0 OR session_snapshots.output_tokens > 0)
    `, [gatewayId]);
  }
}
