import type { ModelOptionsResponse } from './gateway-api';

export type { ModelOptionsResponse };

/** One row of session_snapshots (Phase 5 §5.1 — SQLite row shape). */
export interface SessionSnapshot {
  id: string;                  // `${gatewayId}:${sessionId}`
  gateway_id: string;
  session_id: string;
  title: string | null;
  model: string | null;
  source: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number;
  actual_cost_usd: number | null;
  enriched_cost_usd: number | null;
  api_call_count: number;
  tool_call_count: number;
  message_count: number;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  last_active: number | null;
  parent_session_id: string | null;
  archived: number;            // 0/1
  pinned: number;              // 0/1
  hidden: number;              // 0/1
  synced_at: number;
}

/** Per-model pricing row (Phase 5 §5.3, from /api/model/options). */
export interface ModelPricing {
  model: string;
  provider: string | null;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cached_cost_per_token: number | null;
  updated_at: number;
}
