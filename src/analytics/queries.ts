import type { SessionSnapshot } from '@/services/types';
import type { AnalyticsDB } from '@/services/storage';

/**
 * Phase 5 §5.4 — On-device analytics aggregation queries.
 * All computation is local SQLite (NFR-2: 2,000-row aggregation < 10 ms).
 * NFR-1: no network required — ever.
 *
 * Every query is gateway-scoped (KR-4a). Archived sessions excluded from
 * cost sums. Sessions with unknown cost (NULL enriched_cost_usd) contribute
 * to counts/token sums but not totals — an unknown never reads as $0.
 */
export class AnalyticsQueries {
  private db: AnalyticsDB;

  constructor(db: AnalyticsDB) {
    this.db = db;
  }

  /** Total spend across all non-archived sessions (all time). */
  getTotalSpend(gatewayId: string): number {
    const result = this.db.queryFirst<{ total: number | null }>(`
      SELECT SUM(enriched_cost_usd) as total
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
    `, [gatewayId]);
    return result?.total ?? 0;
  }

  /** Spend grouped by model. */
  getSpendByModel(gatewayId: string): { model: string; cost: number; sessions: number }[] {
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

  /** Spend grouped by source (api_server, cli, cron…). */
  getSpendBySource(gatewayId: string): { source: string; cost: number }[] {
    return this.db.query(`
      SELECT source,
        SUM(enriched_cost_usd) as cost
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
      GROUP BY source
      ORDER BY cost DESC
    `, [gatewayId]);
  }

  /** Daily spend trend (most recent `days` days, newest first). */
  getDailySpend(gatewayId: string, days: number = 30): { date: string; cost: number }[] {
    return this.db.query(`
      SELECT date, total_cost_usd as cost
      FROM daily_aggregates
      WHERE gateway_id = ?
      ORDER BY date DESC
      LIMIT ?
    `, [gatewayId, days]);
  }

  /** Token breakdown (input/output/cache read+write/reasoning). */
  getTokenBreakdown(gatewayId: string): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } {
    const result = this.db.queryFirst<{
      input: number | null;
      output: number | null;
      cacheRead: number | null;
      cacheWrite: number | null;
      reasoning: number | null;
    }>(`
      SELECT
        SUM(input_tokens) as input,
        SUM(output_tokens) as output,
        SUM(cache_read_tokens) as cacheRead,
        SUM(cache_write_tokens) as cacheWrite,
        SUM(reasoning_tokens) as reasoning
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
    `, [gatewayId]);
    return {
      input: result?.input ?? 0,
      output: result?.output ?? 0,
      cacheRead: result?.cacheRead ?? 0,
      cacheWrite: result?.cacheWrite ?? 0,
      reasoning: result?.reasoning ?? 0,
    };
  }

  /** Cache hit rate: cache_read / (input + cache_read). */
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

  /** Count of non-archived snapshots for a gateway (empty-state check). */
  countSessions(gatewayId: string): number {
    const result = this.db.queryFirst<{ c: number | null }>(`
      SELECT COUNT(*) as c
      FROM session_snapshots
      WHERE gateway_id = ? AND archived = 0
    `, [gatewayId]);
    return result?.c ?? 0;
  }

  /**
   * Recompute daily aggregates from session_snapshots.
   * KR-19 consistency: uses enriched_cost_usd (same resolved cost as all
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
