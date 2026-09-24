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
  // async listSessions(...)      — implemented in phase-2-sessions.md §2.1
  // async createSession(...)     — implemented in phase-2-sessions.md §2.1
  // async renameSession(...)     — implemented in phase-2-sessions.md §2.1
  // async deleteSession(...)     — implemented in phase-2-sessions.md §2.1
  // async forkSession(...)       — implemented in phase-2-sessions.md §2.1
  // async getSessionMessages(...)— implemented in phase-2-sessions.md §2.1

  // === Chat (Phase 3) ===
  // async createRun(...)         — implemented in phase-3-chat-runs.md §3.2
  // async getRunStatus(...)      — implemented in phase-3-chat-runs.md §3.2
  // async steerRun(...)          — implemented in phase-3-chat-runs.md §3.2
  // async stopRun(...)           — implemented in phase-3-chat-runs.md §3.2
  // async respondToApproval(...)— implemented in phase-3-chat-runs.md §3.2
  // getRunEventsUrl(...)         — implemented in phase-3-chat-runs.md §3.2
}

// === Shared response types (defined here — used by phases 3/5) ===

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
