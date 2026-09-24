import type { GatewayAPI, SessionResponse } from './gateway-api';

export class SessionSyncEngine {
  private api: GatewayAPI;
  private pageSize = 200; // max per KR-6

  constructor(api: GatewayAPI) {
    this.api = api;
  }

  /**
   * Full backfill: paginate until exhausted (KR-6).
   * Paging subtlety (api-surface.md): has_more counts only non-pinned rows;
   * pinned sessions are back-filled past the limit.
   * Robust sync: page until short page PLUS one extra query including archived.
   */
  async fullSync(onBatch: (sessions: SessionResponse[]) => void): Promise<number> {
    let offset = 0;
    let total = 0;

    // Main pagination loop
    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      onBatch(resp.data);
      total += resp.data.length;
      offset += resp.data.length;

      // Short page = done (KR-6: not has_more alone)
      if (resp.data.length < this.pageSize) break;
    }

    // KR-6 extra pass: one full pagination including archived sessions.
    // Pinned/archived rows back-fill past the limit window; this pass catches
    // anything the default listing missed. Dedup happens in the store (keyed by id).
    let archOffset = 0;
    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset: archOffset,
        includeArchived: true,
      });
      onBatch(resp.data);
      total += resp.data.length;
      archOffset += resp.data.length;
      if (resp.data.length < this.pageSize) break;
    }

    return total;
  }

  /**
   * Incremental sync: fetch sessions with last_active > watermark (KR-20).
   * Used on foreground resume and periodic poll.
   */
  async incrementalSync(
    watermark: number,
    onBatch: (sessions: SessionResponse[]) => void
  ): Promise<number> {
    // Fetch all recent sessions; client-side filter by last_active
    // (API doesn't support last_active filter natively as of v0.21.3)
    let offset = 0;
    let total = 0;

    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      const recent = resp.data.filter(s => s.last_active > watermark);
      if (recent.length > 0) {
        onBatch(recent);
        total += recent.length;
      }

      offset += resp.data.length;
      if (resp.data.length < this.pageSize || resp.data.length === 0) break;

      // Optimization: if all sessions in batch are older than watermark,
      // we can stop early (assumes newest-first order)
      const oldestInBatch = Math.min(...resp.data.map(s => s.last_active));
      if (oldestInBatch <= watermark) break;
    }

    return total;
  }
}
