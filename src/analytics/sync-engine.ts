import type { GatewayAPI, SessionResponse } from '@/services/gateway-api';
import type { AnalyticsDB } from '@/services/storage';
import type { SessionSnapshot } from '@/services/types';
import type { AnalyticsQueries } from './queries';

/**
 * Phase 5 §5.2 — Snapshot sync engine (KR-20).
 *
 * Poll-based sync (the API server has no push channel — v0.21.3 verified).
 * Full backfill on first launch → incremental via `last_active` watermark.
 * Polling runs ONLY while the analytics view is open (KR-20: zero polls when
 * closed — stopPolling on unmount/blur); any future background poll
 * (Tier 3 budget alerts) is a separate, slower mechanism and NOT this timer.
 */
export class SnapshotSyncEngine {
  private db: AnalyticsDB;
  private queries: AnalyticsQueries;
  private api: GatewayAPI;
  private gatewayId: string;
  private pageSize = 200;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: AnalyticsDB, queries: AnalyticsQueries, api: GatewayAPI, gatewayId: string) {
    this.db = db;
    this.queries = queries;
    this.api = api;
    this.gatewayId = gatewayId;
  }

  /**
   * Full backfill: paginate all sessions into SQLite (KR-20).
   * 2,000-session backfill < 15 s (performance target).
   * Includes the KR-6 archived extra-pass: after the main loop, re-query with
   * includeArchived so archived sessions reach the analytics history too.
   */
  async fullBackfill(onProgress?: (synced: number) => void): Promise<number> {
    let offset = 0;
    let total = 0;
    const now = Date.now();

    while (true) {
      const resp = await this.api.listSessions({ limit: this.pageSize, offset });

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
    this.queries.recomputeDailyAggregates(this.gatewayId);

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
      const resp = await this.api.listSessions({ limit: this.pageSize, offset });

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

    // Update watermark — only after a successful pass
    if (total > 0) {
      this.db.setSyncState(this.gatewayId, {
        lastSyncWatermark: now / 1000,
        lastFullSyncAt: state?.lastFullSyncAt ?? now,
        totalSessionsSynced: (state?.totalSessionsSynced ?? 0) + total,
      });
      this.queries.recomputeDailyAggregates(this.gatewayId);
    }

    return total;
  }

  /**
   * Run the one-time full backfill if this gateway has never synced (KR-20):
   * no sync_state row yet → backfill everything; otherwise a no-op.
   */
  async fullBackfillIfNeeded(onProgress?: (synced: number) => void): Promise<boolean> {
    if (this.db.getSyncState(this.gatewayId) !== null) return false;
    await this.fullBackfill(onProgress);
    return true;
  }

  /**
   * Start periodic poll — ONLY while the analytics view is open (KR-20).
   * Default interval: 45 s (inside the 30–60 s in-view cadence). Zero polls
   * when the view is closed (stopPolling on blur/unmount).
   */
  startPolling(intervalMs: number = 45_000, onSync?: () => void): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.incrementalSync()
        .then(() => onSync?.())
        .catch(() => {
          // Silent failure — will retry on next interval.
          // NFR-3: bounded retries, never infinite spinners.
        });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Upsert sessions into SQLite. Dedup by composite id. */
  private upsertSessions(sessions: SessionResponse[], syncedAt: number): void {
    const stmt = this.db.prepareUpsert('session_snapshots');
    for (const session of sessions) {
      const row: Omit<SessionSnapshot, 'enriched_cost_usd'> = {
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
      };
      stmt.run(row);
    }
  }
}
