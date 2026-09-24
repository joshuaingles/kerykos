# Phase 5 — Cost Display & Analytics

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-5 #analytics #cost

**Purpose:** Build the client-side analytics engine — the core differentiator. On-device SQLite computation from `GET /api/sessions` data. Per-session cost display (v1 cut) plus the foundation for Tier 3 Pro analytics (post-v1).

**KR/NFR coverage:** KR-19, KR-20, NFR-1, NFR-2

---

## 5.1 SQLite Storage Service

**File:** `src/services/storage.ts` (extend Phase 0 shell)

Wire up `expo-sqlite` with the schema from `client-side-analytics.md`.

```typescript
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'kerykos-analytics.db';

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
        enriched_cost_usd REAL,           -- actual ?? estimated(>0) ?? pricing-derived; NULL = unknown (KR-19)
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

  // === Helper API used across this phase ===
  // Thin typed wrappers over expo-sqlite. All analytics queries filter by
  // gateway_id (KR-4a: multi-gateway isolation).

  /** Run a SELECT returning typed rows. */
  query<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.getAllSync<T>(sql, params);
  }

  /** Run a SELECT expecting at most one row. */
  queryFirst<T>(sql: string, params: unknown[] = []): T | null {
    return this.db.getFirstSync<T>(sql, params) ?? null;
  }

  /** Run a DDL/DML statement with params (INSERT OR REPLACE, UPDATE…). */
  exec(sql: string, params: unknown[] = []): void {
    this.db.runSync(sql, params);
  }

  /**
   * Batch upsert for session_snapshots. Writes enriched_cost_usd at write
   * time (KR-19 rule: actual ?? estimated>0 ?? NULL-unknown); a later
   * enrichment pass (after fetchModelPricing) fills pricing-derived values.
   */
  prepareUpsert(_table: string): { run: (row: Record<string, unknown>) => void } {
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
        const actual = row.actual_cost_usd as number | null;
        const estimated = row.estimated_cost_usd as number;
        // KR-19: 0.0 estimated is "unknown", not free — don't persist it as a
        // usable cost. actual > 0 wins; else estimated > 0; else NULL.
        const enriched = (actual !== null && actual > 0) ? actual
          : (estimated > 0 ? estimated : null);
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

  getSyncState(gatewayId: string): { lastSyncWatermark: number; lastFullSyncAt: number; totalSessionsSynced: number } | null {
    return this.queryFirst('SELECT * FROM sync_state WHERE gateway_id = ?', [gatewayId]);
  }

  setSyncState(gatewayId: string, state: { lastSyncWatermark: number; lastFullSyncAt: number; totalSessionsSynced: number }): void {
    this.exec(`
      INSERT OR REPLACE INTO sync_state
        (gateway_id, last_sync_watermark, last_full_sync_at, total_sessions_synced)
      VALUES (?, ?, ?, ?)
    `, [gatewayId, state.lastSyncWatermark, state.lastFullSyncAt, state.totalSessionsSynced]);
  }

  upsertModelPricing(p: { model: string; provider: string | null; input_cost_per_token: number | null; output_cost_per_token: number | null; cached_cost_per_token: number | null; updated_at: number }): void {
    this.exec(`
      INSERT OR REPLACE INTO model_pricing
        (model, provider, input_cost_per_token, output_cost_per_token, cached_cost_per_token, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [p.model, p.provider, p.input_cost_per_token, p.output_cost_per_token, p.cached_cost_per_token, p.updated_at]);
  }

  getModelPricing(model: string): { model: string; input_cost_per_token: number | null; output_cost_per_token: number | null; cached_cost_per_token: number | null } | null {
    return this.queryFirst('SELECT model, input_cost_per_token, output_cost_per_token, cached_cost_per_token FROM model_pricing WHERE model = ?', [model]);
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
```

**Schema notes (from `client-side-analytics.md`):**
- `id` = composite `(gateway_id, session_id)` or hash — supports multi-gateway (KR-4a)
- `parent_session_id` for lineage — exclude children when summing totals (avoid double-count)
- `sync_state` tracks watermark per gateway for incremental sync

**NFR-1 compliance:**
- SQLite encrypted by iOS when device locked (at-rest encryption is automatic)
- No third-party analytics/telemetry/tracking SDKs
- No data leaves the device — all computation is local
- Delete app = delete all data

**Acceptance criteria:**
- Schema creates without errors
- Indexes exist on gateway_id, last_active, model
- Multi-gateway support via gateway_id column (KR-4a)

---

## 5.2 Snapshot Sync Engine (KR-20)

**File:** `src/analytics/sync-engine.ts`

Poll-based sync. Full backfill on first launch → incremental via watermark.

```typescript
export class SnapshotSyncEngine {
  private db: AnalyticsDB;
  private api: GatewayAPI;
  private gatewayId: string;
  private pageSize = 200;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: AnalyticsDB, api: GatewayAPI, gatewayId: string) {
    this.db = db;
    this.api = api;
    this.gatewayId = gatewayId;
  }

  /**
   * Full backfill: paginate all sessions into SQLite (KR-20).
   * 2,000-session backfill < 15 s (performance target).
   * Includes the KR-6 archived extra-pass (see Phase 2 §2.2): after the main
   * loop, re-query with includeArchived to catch archived rows the default
   * listing may back-fill past the limit or omit.
   */
  async fullBackfill(onProgress?: (synced: number) => void): Promise<number> {
    let offset = 0;
    let total = 0;
    const now = Date.now();

    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      this.upsertSessions(resp.data, now);
      total += resp.data.length;
      offset += resp.data.length;
      onProgress?.(total);

      // Short page = done (KR-6 paging logic)
      if (resp.data.length < this.pageSize) break;
    }

    // KR-6 extra pass: include archived so analytics history is complete
    let archOffset = 0;
    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset: archOffset,
        includeArchived: true,
      });
      this.upsertSessions(resp.data, now);
      archOffset += resp.data.length;
      if (resp.data.length < this.pageSize) break;
    }

    // Update sync state
    this.db.setSyncState(this.gatewayId, {
      lastSyncWatermark: now / 1000, // API uses seconds
      lastFullSyncAt: now,
      totalSessionsSynced: total,
    });

    return total;
  }

  /**
   * Incremental sync: fetch sessions with last_active > watermark (KR-20).
   * Used on foreground resume and periodic poll.
   */
  async incrementalSync(): Promise<number> {
    const state = this.db.getSyncState(this.gatewayId);
    const watermark = state?.lastSyncWatermark ?? 0;
    const now = Date.now();

    let offset = 0;
    let total = 0;

    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      // Client-side filter: last_active > watermark
      const recent = resp.data.filter(s => s.last_active > watermark);
      if (recent.length > 0) {
        this.upsertSessions(recent, now);
        total += recent.length;
      }

      offset += resp.data.length;

      // Early termination: if oldest in batch is older than watermark
      if (resp.data.length > 0) {
        const oldest = Math.min(...resp.data.map(s => s.last_active));
        if (oldest <= watermark) break;
      }

      if (resp.data.length < this.pageSize) break;
    }

    // Update watermark
    if (total > 0) {
      this.db.setSyncState(this.gatewayId, {
        lastSyncWatermark: now / 1000,
        lastFullSyncAt: state?.lastFullSyncAt ?? now,
        totalSessionsSynced: (state?.totalSessionsSynced ?? 0) + total,
      });
    }

    return total;
  }

  /**
   * Start periodic poll — ONLY while the analytics view is open (KR-20).
   * Default interval: 30–60 s in-view cadence. Zero polls when the view is
   * closed (call stopPolling on view unmount). Any future background poll
   * (Tier 3 budget alerts) is a separate, slower mechanism (≤6/hour) and is
   * NOT this timer.
   */
  startPolling(intervalMs: number = 45_000): void {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        await this.incrementalSync();
        this.db.recomputeDailyAggregates(this.gatewayId);
      } catch (err) {
        // Silent failure — will retry on next interval
        // NFR-3: bounded retries, not infinite spinners
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Upsert sessions into SQLite. Dedup by composite id. */
  private upsertSessions(sessions: SessionResponse[], syncedAt: number): void {
    const stmt = this.db.prepareUpsert('session_snapshots');
    for (const session of sessions) {
      stmt.run({
        id: `${this.gatewayId}:${session.id}`,
        gateway_id: this.gatewayId,
        session_id: session.id,
        title: session.title,
        model: session.model,
        source: session.source,
        input_tokens: session.input_tokens,
        output_tokens: session.output_tokens,
        cache_read_tokens: session.cache_read_tokens,
        cache_write_tokens: session.cache_write_tokens,
        reasoning_tokens: session.reasoning_tokens,
        estimated_cost_usd: session.estimated_cost_usd ?? 0,
        actual_cost_usd: session.actual_cost_usd,
        api_call_count: session.api_call_count,
        tool_call_count: session.tool_call_count,
        message_count: session.message_count,
        started_at: session.started_at,
        ended_at: session.ended_at,
        end_reason: session.end_reason,
        last_active: session.last_active,
        parent_session_id: session.parent_session_id,
        archived: session.archived ? 1 : 0,
        pinned: session.pinned ? 1 : 0,
        hidden: session.hidden ? 1 : 0,
        synced_at: syncedAt / 1000,
      });
    }
  }
}
```

**KR-20 performance targets:**

| Scenario | Sessions | API Calls | Time | Storage |
|---|---|---|---|---|
| Light user | 50 | 1 | <1s | <100 KB |
| Moderate user | 200 | 1 | <2s | <500 KB |
| Power user | 500 | 3 | <5s | <2 MB |
| Enterprise | 2,000 | 10 | <15s | <2 MB |

**Acceptance criteria (KR-20):**
- 2,000-session backfill < 15 s
- Incremental sync only fetches sessions with `last_active > watermark`
- In-view poll cadence 30–60 s; **zero polls** when analytics view closed (KR-20)
- Any future background poll (Tier 3) is a separate ≤6/hour mechanism, not this timer
- Watermark updated after each successful sync
- Instrumented (progress callback for debugging)

---

## 5.3 Cost Enrichment (KR-19)

**File:** `src/analytics/cost-enrichment.ts` + **File:** `src/store/analytics.ts`

`estimated_cost_usd` can be `0.0` on providers without local pricing (wire-verified, smoke-test #13). Enrich via `/api/model/options` pricing metadata.

**Analytics store (used by screens — defined here since phase-5 owns it):**

```typescript
// src/store/analytics.ts
import { create } from 'zustand';
import { AnalyticsDB } from '@/services/storage';
import type { SessionSnapshot, ModelPricing } from '@/services/types';

export const useAnalyticsStore = create((get) => ({
  // Cached model pricing, refreshed by fetchModelPricing()
  pricingCache: new Map<string, ModelPricing>(),

  getModelPricing(model: string | undefined): ModelPricing | null {
    if (!model) return null;
    return get().pricingCache.get(model) ?? null;
  },

  setPricingCache(models: ModelPricing[]): void {
    const map = new Map(models.map(p => [p.model, p]));
    useAnalyticsStore.setState({ pricingCache: map });
  },
}));

/** Hook: analytics queries bound to a gateway (wraps AnalyticsQueries). */
export function useAnalyticsQueries(gatewayId: string): AnalyticsQueries {
  // Resolves through the composition root (phase-3 §3.2b ServicesProvider);
  // phase 5 registers getAnalyticsQueries there when it lands.
  const svc = useServices();
  return svc.getAnalyticsQueries(gatewayId);
}
```

```typescript
/**
 * Fetch model pricing from gateway and store locally.
 * GET /api/model/options → provider/model inventory + pricing metadata
 */
export async function fetchModelPricing(api: GatewayAPI, db: AnalyticsDB): Promise<void> {
  const options = await api.getModelOptions(); // GET /api/model/options
  // Response includes per-model pricing — store in model_pricing table
  const models: ModelPricing[] = [];
  for (const model of options.models ?? []) {
    const pricing: ModelPricing = {
      model: model.id,
      provider: model.provider,
      input_cost_per_token: model.pricing?.input_cost_per_token ?? null,
      output_cost_per_token: model.pricing?.output_cost_per_token ?? null,
      cached_cost_per_token: model.pricing?.cached_cost_per_token ?? null,
      updated_at: Date.now() / 1000,
    };
    db.upsertModelPricing(pricing);
    models.push(pricing);
  }
  // Publish to the store so ChatHeader/session rows resolve enrichment live
  useAnalyticsStore.getState().setPricingCache(models);

  // KR-19 enrichment pass: fill NULL enriched_cost_usd from pricing
  const gatewayId = api.gatewayId;
  db.applyPricingEnrichment(gatewayId);
  db.recomputeDailyAggregates(gatewayId);
}

/**
 * Compute enriched cost for a session.
 * Wire-verified nuance (KR-19): estimated_cost_usd can be 0.0 on providers
 * without local pricing — display as "—" (unknown), never "$0.00".
 */
export function computeDisplayCost(
  session: SessionSnapshot,
  pricing: ModelPricing | null,
): { display: string; isUnknown: boolean } {
  // Prefer actual cost when available
  if (session.actual_cost_usd !== null && session.actual_cost_usd > 0) {
    return { display: `$${session.actual_cost_usd.toFixed(4)}`, isUnknown: false };
  }

  // Use estimated cost if non-zero
  if (session.estimated_cost_usd > 0) {
    return { display: `$${session.estimated_cost_usd.toFixed(4)}`, isUnknown: false };
  }

  // estimated_cost_usd is 0.0 or null — try enrichment
  if (pricing && session.input_tokens > 0) {
    const cost =
      session.input_tokens * (pricing.input_cost_per_token ?? 0) +
      session.output_tokens * (pricing.output_cost_per_token ?? 0) +
      session.cache_read_tokens * (pricing.cached_cost_per_token ?? 0);
    if (cost > 0) {
      return { display: `$${cost.toFixed(4)}`, isUnknown: false };
    }
  }

  // Truly unknown — no pricing data available
  return { display: '—', isUnknown: true };
}
```

**KR-19 acceptance criteria:**
- `estimated_cost_usd` of `0.0` renders as "—" (unknown), never "$0.00"
- `actual_cost_usd` preferred when non-null
- Enrichment via `/api/model/options` pricing metadata when available
- Values match gateway `GET /api/sessions` output exactly — no invented conversions

---

## 5.4 Analytics Aggregation Queries

**File:** `src/analytics/queries.ts`

All queries run on local SQLite. NFR-2: aggregation of 2,000 rows < 10 ms.

```typescript
export class AnalyticsQueries {
  private db: AnalyticsDB;

  constructor(db: AnalyticsDB) {
    this.db = db;
  }

  /** Total spend across all sessions (all time). */
  getTotalSpend(gatewayId: string): number {
    const result = this.db.queryFirst(`
      SELECT COALESCE(SUM(enriched_cost_usd), 0) as total
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
    `, [gatewayId]);
    return result?.total ?? 0;
  }

  /** Spend grouped by model. */
  getSpendByModel(gatewayId: string): Array<{ model: string; cost: number; sessions: number }> {
    return this.db.query(`
      SELECT model,
        SUM(enriched_cost_usd) as cost,
        COUNT(*) as sessions
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
      GROUP BY model
      ORDER BY cost DESC
    `, [gatewayId]);
  }

  /** Spend grouped by source. */
  getSpendBySource(gatewayId: string): Array<{ source: string; cost: number }> {
    return this.db.query(`
      SELECT source,
        SUM(enriched_cost_usd) as cost
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
      GROUP BY source
      ORDER BY cost DESC
    `, [gatewayId]);
  }

  /** Daily spend trend (last 30 days). */
  getDailySpend(gatewayId: string, days: number = 30): Array<{ date: string; cost: number }> {
    return this.db.query(`
      SELECT date, total_cost_usd as cost
      FROM daily_aggregates
      WHERE gateway_id = ?
      ORDER BY date DESC
      LIMIT ?
    `, [gatewayId, days]);
  }

  /** Token breakdown (input/output/cache/reasoning). */
  getTokenBreakdown(gatewayId: string): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } {
    const result = this.db.queryFirst(`
      SELECT
        SUM(input_tokens) as input,
        SUM(output_tokens) as output,
        SUM(cache_read_tokens) as cacheRead,
        SUM(cache_write_tokens) as cacheWrite,
        SUM(reasoning_tokens) as reasoning
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
    `, [gatewayId]);
    return result ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  }

  /** Cache hit rate. */
  getCacheHitRate(gatewayId: string): number {
    const tokens = this.getTokenBreakdown(gatewayId);
    const total = tokens.input + tokens.cacheRead;
    return total > 0 ? tokens.cacheRead / total : 0;
  }

  /** Top N most expensive sessions. */
  getMostExpensive(gatewayId: string, limit: number = 10): SessionSnapshot[] {
    return this.db.query(`
      SELECT * FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
      ORDER BY enriched_cost_usd DESC
      LIMIT ?
    `, [gatewayId, limit]);
  }

  /**
   * Recompute daily aggregates from session_snapshots.
   * KR-19 consistency: uses enriched_cost_usd (the same resolved cost as all
   * other queries). Sessions with unknown cost (NULL enriched) are excluded
   * from cost sums but still counted in session_count / token sums — an
   * unknown never silently reads as $0.
   */
  recomputeDailyAggregates(gatewayId: string): void {
    this.db.exec(`
      INSERT OR REPLACE INTO daily_aggregates
        (gateway_id, date, total_cost_usd, total_input_tokens, total_output_tokens,
         total_api_calls, total_tool_calls, session_count)
      SELECT
        gateway_id,
        date(started_at, 'unixepoch') as date,
        SUM(enriched_cost_usd) as total_cost_usd,
        SUM(input_tokens),
        SUM(output_tokens),
        SUM(api_call_count),
        SUM(tool_call_count),
        COUNT(*)
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
      GROUP BY gateway_id, date
    `, [gatewayId]);
  }
}
```

**NFR-2 compliance:**
- SQLite aggregation of 2,000 rows < 10 ms (indexed on gateway_id + last_active)
- Results cached in memory for instant UI
- No network required for analytics queries

---

## 5.5 Per-Session Cost Display (KR-19)

Already implemented in Phase 2 (session row rendering). This section documents the complete flow:

**Display locations:**
1. **Session list row** (Phase 2, `SessionRow.tsx`) — `session.costDisplay`
2. **Chat header** (Phase 3, `ChatHeader.tsx`) — shows cost for current session

**Chat header cost display:**

```typescript
function ChatHeader({ sessionId, gatewayId }: { sessionId: string; gatewayId: string }) {
  const session = useSessionsStore(s => s.getSessionById(sessionId));
  const pricing = useAnalyticsStore(s => s.getModelPricing(session?.model));

  if (!session) return null;

  const { display, isUnknown } = computeDisplayCost(session, pricing);

  return (
    <View style={styles.header}>
      <Text style={styles.title}>{session.title}</Text>
      <Text style={styles.model}>{session.model}</Text>
      <Text style={[styles.cost, isUnknown && styles.costUnknown]}>
        {display}
      </Text>
    </View>
  );
}
```

**Acceptance criteria (KR-19):**
- Per-session cost in chat header and session list row
- Uses `estimated_cost_usd`; shows `actual_cost_usd` when non-null
- `0.0` renders as "—" (unknown), never "$0.00"
- Enrichment from `/api/model/options` pricing when available

---

## 5.6 Analytics Screen (v1 Cut)

**File:** `src/app/AnalyticsScreen.tsx`

V1 cut = session-level cost display only. Tier 3 dashboard (cross-session analytics, budget alerts, forecasting) is post-v1 Pro path.

```typescript
import { VictoryPie, VictoryChart, VictoryBar } from 'victory-native';

export function AnalyticsScreen() {
  const gatewayId = useGatewayStore(s => s.activeGatewayId);
  const queries = useAnalyticsQueries(gatewayId!);

  const totalSpend = queries.getTotalSpend(gatewayId!);
  const spendByModel = queries.getSpendByModel(gatewayId!);
  const tokenBreakdown = queries.getTokenBreakdown(gatewayId!);
  const cacheHitRate = queries.getCacheHitRate(gatewayId!);

  return (
    <ScrollView style={styles.container}>
      {/* Total spend card */}
      <StatCard title="Total Spend" value={`$${totalSpend.toFixed(2)}`} />

      {/* Spend by model (pie chart) */}
      <VictoryPie
        data={spendByModel.map(m => ({ x: m.model, y: m.cost }))}
        colorScale="qualitative"
      />

      {/* Token breakdown */}
      <TokenBreakdownChart data={tokenBreakdown} />

      {/* Cache hit rate */}
      <StatCard title="Cache Hit Rate" value={`${(cacheHitRate * 100).toFixed(1)}%`} />
    </ScrollView>
  );
}
```

**Acceptance criteria:**
- Analytics screen renders with real data from SQLite
- Charts use victory-native 42 (architecture §2)
- No network calls — all queries from local SQLite
- Empty state for first-time users (no data yet)

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Full backfill | 2,000 sessions sync in <15s (KR-20) |
| 2 | Incremental sync | Only sessions with `last_active > watermark` fetched |
| 3 | In-view poll | 30–60 s cadence while analytics open (KR-20) |
| 4 | Polling stops | Closing analytics screen stops poll timer — zero polls when closed (KR-20) |
| 5 | Cost display "—" | `estimated_cost_usd: 0.0` renders as "—" not "$0.00" (KR-19) |
| 6 | Cost enrichment | `/api/model/options` pricing fills in when estimated is 0 |
| 7 | Aggregation speed | 2,000-row query < 10ms (NFR-2) |
| 8 | Multi-gateway | Analytics queries filter by gatewayId (KR-4a) |
| 9 | Privacy | No third-party SDKs, no data leaves device (NFR-1) |
| 10 | Charts render | victory-native pie/bar charts render with real data |

---

## Execution Log (2026-09-24)

**Commit:** `3f81228 feat: Phase 5 — cost display and analytics` — 4 files added, 5 modified.
**Agent:** OpenCode `build` agent, glm-5.3-flash, ~12 min runtime.

**Verification results:**
- `tsc --noEmit` — zero errors
- `npm run lint` — clean

**New files created:**
- `src/analytics/sync-engine.ts` — SnapshotSyncEngine (fullBackfill + incrementalSync + polling)
- `src/analytics/cost-enrichment.ts` — fetchModelPricing, computeDisplayCost
- `src/analytics/queries.ts` — AnalyticsQueries (all aggregation queries)
- `src/store/analytics.ts` — useAnalyticsStore with pricingCache

**Modified files:**
- `src/services/storage.ts` — extended with AnalyticsDB class (SQLite schema + helpers)
- `src/app/AnalyticsScreen.tsx` — rebuilt with StatCards, charts, focus-gated sync
- `src/components/ChatHeader.tsx` — LiveChatHeader with pricing enrichment
- `src/app/composition.tsx` — added analyticsDb, getSyncEngine, getAnalyticsQueries
- `src/app/ChatScreen.tsx` — pricing refresh integration

**Plan deviations:**
| # | Plan said | Actual | Reason |
|---|-----------|--------|--------|
| 1 | `VictoryPie` from victory-native | `PolarChart` + `Pie.Chart`/`Pie.Slice` | victory-native v42 removed VictoryPie; new PolarChart API is the replacement |
| 2 | victory-native v42 | Installed via `npx expo install` | Resolved to compatible version automatically |

---

## Next: [[phase-6-monetization-ship]]
