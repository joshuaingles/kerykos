import { AuthService } from './auth';
import { getSetting, setSetting } from './storage';

export class GatewayAPI {
  // Public readonly: cross-service access (phase-3 fallback builds URLs from
  // baseUrl; phase-5 enrichment reads gatewayId) must compile under TS strict.
  public readonly baseUrl: string;
  public readonly gatewayId: string;

  constructor(baseUrl: string, gatewayId: string) {
    // baseUrl: e.g. "http://192.168.1.5:8642" or "https://hermes.example.com"
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.gatewayId = gatewayId;
  }

  /** Resolve credentials and make authenticated request. */
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const key = await AuthService.getKey(this.gatewayId);
    if (!key) throw new Error(`No API key for gateway ${this.gatewayId}`);

    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    return this.handleResponse<T>(response);
  }

  /** Unauthenticated request (health check only). */
  private async requestUnauthed<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url);
    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new GatewayError(response.status, await response.text());
    }
    // Session-creating calls (createSession/fork/createRun) echo
    // X-Hermes-Session-Id (+ X-Hermes-Session-Key) on their responses —
    // capture here at the only layer holding the raw Response (audit W3).
    // No-op unless the echo headers are present.
    this.captureSessionEcho(response, this.gatewayId);
    return response.json() as Promise<T>;
  }

  // === Pairing endpoints (Phase 1) ===

  /**
   * Step 1: Unauthed liveness check (KR-1).
   * GET /v1/health → { status, platform, version }
   * Cannot validate a key — only confirms server is reachable.
   */
  async healthCheck(): Promise<HealthResponse> {
    return this.requestUnauthed<HealthResponse>('/v1/health');
  }

  /**
   * Step 2: Authed credential probe (KR-1, KR-3).
   * GET /v1/capabilities → feature flags matrix
   * 401 = bad key (KR-5: gateway_auth_failed)
   */
  async capabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('/v1/capabilities');
  }

  /**
   * Session continuity headers (api-surface.md): chat/runs calls should carry
   * X-Hermes-Session-Id (+ X-Hermes-Session-Key for long-term-memory scoping).
   * Both are RESPONSE-ECHOED on session-creating calls — capture the echo and
   * persist it per session so later calls keep memory scoping (KR-11 note).
   */
  sessionHeaders(sessionId?: string, sessionKey?: string): Record<string, string> {
    const h: Record<string, string> = {};
    if (sessionId) h['X-Hermes-Session-Id'] = sessionId;
    if (sessionKey) h['X-Hermes-Session-Key'] = sessionKey;
    return h;
  }

  /**
   * Capture the echoed X-Hermes-Session-Id / X-Hermes-Session-Key from a
   * session-creating response. Store per (gatewayId, sessionId) in MMKV
   * (settings instance) so subsequent chat/runs calls carry them.
   */
  captureSessionEcho(response: Response, gatewayId: string): void {
    const sid = response.headers.get('X-Hermes-Session-Id');
    const skey = response.headers.get('X-Hermes-Session-Key');
    if (!sid) return;
    const map = JSON.parse(getSetting(`session_echoes_${gatewayId}`, '{}')) as Record<string, { sessionKey?: string }>;
    map[sid] = { ...(map[sid] ?? {}), ...(skey ? { sessionKey: skey } : {}) };
    setSetting(`session_echoes_${gatewayId}`, JSON.stringify(map));
  }

  /** Recall the persisted echo pair for a session (used by chat/runs calls). */
  getSessionEcho(gatewayId: string, sessionId: string): { sessionId: string; sessionKey?: string } | null {
    const map = JSON.parse(getSetting(`session_echoes_${gatewayId}`, '{}')) as Record<string, { sessionKey?: string }>;
    const entry = map[sessionId];
    return entry ? { sessionId, ...entry } : null;
  }

  /**
   * Resolve the gateway API key for direct use (SSE connects, fallback path).
   * Same credential-resolution path as request() — gateway id keyed (KR-4a).
   */
  async getResolvedKey(): Promise<string> {
    const key = await AuthService.getKey(this.gatewayId);
    if (!key) throw new Error(`No API key for gateway ${this.gatewayId}`);
    return key;
  }

  /**
   * Model inventory + pricing metadata (Phase 5 cost enrichment, KR-19).
   * GET /api/model/options.
   * ⚠️ Exact pricing-field names in the response: verify at impl time per §9a.
   */
  async getModelOptions(): Promise<ModelOptionsResponse> {
    return this.request<ModelOptionsResponse>('/api/model/options');
  }

  // === Sessions (Phase 2) ===

  /** List sessions paginated (KR-6). */
  async listSessions(options: {
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  } = {}): Promise<SessionListResponse> {
    const params = new URLSearchParams();
    params.set('limit', String(Math.min(options.limit ?? 200, 200))); // max 200
    if (options.offset) params.set('offset', String(options.offset));
    if (options.includeArchived) {
      // ⚠️ Param name unverified — confirm at impl time per §9a.
      params.set('include_archived', 'true');
    }
    return this.request<SessionListResponse>(`/api/sessions?${params}`);
  }

  /** Create session (KR-7). */
  async createSession(title?: string): Promise<SessionResponse> {
    return this.request<SessionResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  /** Rename session (KR-7). */
  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    });
  }

  /** Delete session (KR-7). Destructive — confirm in UI first. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  }

  /** Fork session (KR-7). */
  async forkSession(sessionId: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/sessions/${sessionId}/fork`, {
      method: 'POST',
    });
  }

  /** Get session details. */
  async getSession(sessionId: string): Promise<SessionResponse> {
    return this.request<SessionResponse>(`/api/sessions/${sessionId}`);
  }

  /** Get session transcript (KR-18, Phase 3 uses for offline cache). */
  async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
    // ⚠️ Wrapper shape unverified: smoke test #4 confirmed token_count per
    // message but not whether the response is a bare array or {data:[…]}.
    // Confirm at impl time per §9a and unwrap here — callers see bare array.
    return this.request<SessionMessage[]>(`/api/sessions/${sessionId}/messages`);
  }

  // === Runs (Phase 3 — KR-10, KR-11, KR-14) ===

  /**
   * Create a run (KR-10).
   * POST /v1/runs with Idempotency-Key header.
   * Returns 202 {run_id, status:"started"}.
   * Idempotency: retry after network drop replays the same run — never
   * creates a duplicate.
   */
  async createRun(
    request: RunCreateRequest,
    idempotencyKey: string,
    sessionHeaders: Record<string, string> = {},
  ): Promise<RunCreateResponse> {
    return this.request<RunCreateResponse>('/v1/runs', {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
        // X-Hermes-Session-Id (+ X-Hermes-Session-Key) per api-surface.md
        ...sessionHeaders,
      },
      body: JSON.stringify(request),
    });
  }

  /**
   * Poll run status (KR-11 — detach/reattach).
   * GET /v1/runs/{id} → status + usage.
   * Use when returning from background to check run state.
   */
  async getRunStatus(runId: string): Promise<RunStatusResponse> {
    return this.request<RunStatusResponse>(`/v1/runs/${runId}`);
  }

  /**
   * Stream run events via SSE (KR-10).
   * GET /v1/runs/{id}/events → SSE stream.
   * Events: message.delta, reasoning.available, tool.progress, run.completed,
   * run.cancelled
   */
  getRunEventsUrl(runId: string): string {
    return `${this.baseUrl}/v1/runs/${runId}/events`;
  }

  /**
   * Steer mid-run (KR-14).
   * POST /v1/runs/{id}/steer with correction text.
   * Undelivered steer text carried on terminal event for client replay.
   * ⚠️ Request body field name ("text") unverified — smoke test #9 verified
   * the {accepted:true} RESPONSE, not the request field. Confirm per §9a.
   */
  async steerRun(runId: string, text: string): Promise<{ accepted: boolean }> {
    return this.request(`/v1/runs/${runId}/steer`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  }

  /**
   * Stop mid-run (KR-14).
   * POST /v1/runs/{id}/stop → terminal "cancelled".
   * ⚠️ Response body shape: wire-verified {status:"stopping"} (smoke #10) —
   * terminal "cancelled" arrives via the events stream afterwards.
   */
  async stopRun(runId: string): Promise<{ status: string }> {
    return this.request(`/v1/runs/${runId}/stop`, {
      method: 'POST',
    });
  }

  /**
   * Approve/deny (KR-13).
   * POST /v1/runs/{id}/approval.
   * Scoped to app-initiated runs only (KR-13).
   * ⚠️ Request body field name ("decision") unverified — confirm per §9a.
   */
  async respondToApproval(
    runId: string,
    decision: 'approve' | 'deny',
  ): Promise<{ accepted: boolean }> {
    return this.request(`/v1/runs/${runId}/approval`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    });
  }
}

// === Run types (KR-10/11/14) ===

export interface RunCreateRequest {
  input: string | {
    role: string;
    content: string | { type: string; text?: string; image_url?: { url: string } }[];
  }[];
  session_id?: string; // attach to existing session for continuity
  model?: string;
}

export interface RunCreateResponse {
  run_id: string;
  status: 'started';
  replayed?: boolean;
}

export type RunStatus = 'started' | 'running' | 'completed' | 'cancelled'
  | 'failed' | 'partial' | 'interrupted';

export interface RunStatusResponse {
  run_id: string;
  status: RunStatus;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  // ⚠️ Wire note (KR-18): token fields on the status GET were null in the
  // smoke tests — usage comes from the run.completed terminal event instead.
}

export interface RunCompletedEvent {
  type: 'run.completed';
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// === Shared response types (defined here — used by phases 3/5) ===

export interface SessionResponse {
  id: string;
  title: string;
  model: string;
  source: string;                    // api_server, desktop, dashboard, cron, cli, telegram…
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  api_call_count: number;
  tool_call_count: number;
  message_count: number;
  // ⚠️ api-surface lists started_at/ended_at as "float/string" — the numeric
  // epoch form is ASSUMED. Verify on a live gateway at impl time per §9a and
  // add a string-parse fallback if ISO strings ever appear.
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  last_active: number;               // derived from last_activity_at — sync watermark
  parent_session_id: string | null;
  pinned: boolean;
  archived: boolean;
  hidden: boolean;
  preview: string;                   // last-message preview
  user_id: string;
}

export interface SessionListResponse {
  object: 'list';
  data: SessionResponse[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  token_count: number | null;
  // other fields per api-surface.md
  [key: string]: unknown;
}

/** GET /v1/health — unauthed liveness (wire-verified smoke test #1). */
export interface HealthResponse {
  status: string;      // "ok"
  platform: string;    // "hermes-agent"
  version: string;     // "0.21.3"
}

/** GET /v1/capabilities — full feature matrix (wire-verified smoke test #3). */
export interface CapabilitiesResponse {
  run_submission: boolean;
  run_status: boolean;
  run_events_sse: boolean;
  run_stop: boolean;
  run_steer: boolean;
  run_approval_response: boolean;
  tool_progress_events: boolean;
  approval_events: boolean;
  session_chat: boolean;
  session_chat_streaming: boolean;
  session_fork: boolean;
  model_options: boolean;
  skills_api: boolean;
  // Authoritative negatives
  admin_config_rw: boolean;      // false
  jobs_admin: boolean;           // false (REST CRUD exists but admin cap is false)
  memory_write_api: boolean;     // false
  audio_api: boolean;            // false
  realtime_voice: boolean;       // false — voice cut from v1 confirmed
  [key: string]: boolean;        // forward-compatible
}

/**
 * GET /api/model/options response. Top-level shape (models array vs nested
 * providers) and pricing field names: ⚠️ verify at impl time per §9a — the
 * smoke test confirmed pricing metadata IS present, not its exact key names.
 */
export interface ModelOptionsResponse {
  models?: {
    id: string;
    provider?: string;
    vision?: boolean;                 // KR-17: drives the non-vision hint
    pricing?: {
      input_cost_per_token?: number;
      output_cost_per_token?: number;
      cached_cost_per_token?: number;
    };
  }[];
  [key: string]: unknown;             // forward-compatible
}

export class GatewayError extends Error {
  constructor(public status: number, public body: string) {
    super(`Gateway error ${status}: ${body}`);
  }
}
