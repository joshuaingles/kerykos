# Phase 1 — Gateway & Auth

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-1 #gateway #auth

**Purpose:** Implement gateway pairing, secure credential storage, multi-gateway data model, capabilities probing, and all connection error states. Every subsequent phase depends on `GatewayAPI` and `AuthService` existing.

**KR/NFR coverage:** KR-1, KR-2, KR-3, KR-4, KR-4a, KR-5, NFR-1, NFR-3, NFR-4

---

## 1.1 Auth Service (Secure Storage)

**File:** `src/services/auth.ts`

Wraps `expo-secure-store` (iOS Keychain / Android Keystore). Credentials keyed by gateway id, never stored in AsyncStorage/MMKV plaintext.

**Wire-verified behavior (smoke-test-results.md):**
- `GET /v1/health` is unauthed — returns `{status, platform, version}` — CANNOT validate a key
- `GET /v1/capabilities` requires `Authorization: Bearer <key>` — 401 without valid key
- This two-step probe is the pairing flow (KR-1)

```typescript
import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'gw_key_';

export class AuthService {
  /** Store API key for a gateway. Called during pairing (KR-1). */
  static async storeKey(gatewayId: string, apiKey: string): Promise<void> {
    await SecureStore.setItemAsync(`${KEY_PREFIX}${gatewayId}`, apiKey);
  }

  /** Retrieve API key for a gateway. Used by GatewayAPI to resolve credentials (KR-4a). */
  static async getKey(gatewayId: string): Promise<string | null> {
    return SecureStore.getItemAsync(`${KEY_PREFIX}${gatewayId}`);
  }

  /** Delete API key for a gateway. Called during unpairing. */
  static async deleteKey(gatewayId: string): Promise<void> {
    await SecureStore.deleteItemAsync(`${KEY_PREFIX}${gatewayId}`);
  }

  /** Check if a key exists for a gateway. */
  static async hasKey(gatewayId: string): Promise<boolean> {
    return (await SecureStore.getItemAsync(`${KEY_PREFIX}${gatewayId}`)) !== null;
  }
}
```

**NFR-1 compliance:**
- Key in Keychain/Keystore only — `expo-secure-store` maps to iOS Keychain / Android Keystore
- Never AsyncStorage or MMKV for secrets
- `key_ref` in Zustand store is the alias (e.g., `gw_key_abc123`), not the key itself

**Acceptance criteria:**
- Key stored via `SecureStore.setItemAsync` — accessible only via `SecureStore.getItemAsync`
- Key deleted on unpair
- Key never appears in MMKV, AsyncStorage, or plain text anywhere in the app

---

## 1.2 Gateway API Service

**File:** `src/services/gateway-api.ts`

Typed REST client for all API server (:8642) endpoints. Every API call resolves credentials via gateway id (KR-4a) — never a global key.

```typescript
import { AuthService } from './auth';
import { getSetting, setSetting } from './storage'; // phase-0 §0.8 MMKV helpers

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
    const map = JSON.parse(getSetting(`session_echoes_${gatewayId}`, '{}'));
    map[sid] = { ...(map[sid] ?? {}), ...(skey ? { sessionKey: skey } : {}) };
    setSetting(`session_echoes_${gatewayId}`, JSON.stringify(map));
  }

  /** Recall the persisted echo pair for a session (used by chat/runs calls). */
  getSessionEcho(gatewayId: string, sessionId: string): { sessionId: string; sessionKey?: string } | null {
    const map = JSON.parse(getSetting(`session_echoes_${gatewayId}`, '{}'));
    return map[sessionId] ?? null;
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

/**
 * GET /api/model/options response. Top-level shape (models array vs nested
 * providers) and pricing field names: ⚠️ verify at impl time per §9a — the
 * smoke test confirmed pricing metadata IS present, not its exact key names.
 */
export interface ModelOptionsResponse {
  models?: Array<{
    id: string;
    provider?: string;
    vision?: boolean;                 // KR-17: drives the non-vision hint
    pricing?: {
      input_cost_per_token?: number;
      output_cost_per_token?: number;
      cached_cost_per_token?: number;
    };
  }>;
  [key: string]: unknown;             // forward-compatible
}

export class GatewayError extends Error {
  constructor(public status: number, public body: string) {
    super(`Gateway error ${status}: ${body}`);
  }
}
```

**Types to define:**

```typescript
interface HealthResponse {
  status: string;      // "ok"
  platform: string;    // "hermes-agent"
  version: string;     // "0.21.3"
}

interface CapabilitiesResponse {
  // Full feature matrix from wire-verified smoke test #3
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
```

**NFR-4 compliance:**
- Capabilities response drives transport selection (KR-3): `run_submission === true` → `/v1/runs` primary; `false` → fallback to session-chat
- Version from `healthCheck()` compared against pin (`0.21.3` / `d7b836ab`)

**Acceptance criteria:**
- `GatewayAPI` resolves credentials via gateway id on every request (KR-4a)
- No global key lookup anywhere in the API path
- `healthCheck()` works without authentication
- `capabilities()` returns 401 on bad key (KR-5)

---

## 1.3 Pairing Flow

**File:** `src/app/PairingScreen.tsx`

**Two-step validation (KR-1, wire-verified):**

```
User enters: URL + API_SERVER_KEY
    ↓
Step 1: GET /v1/health (unauthed)
    ↓ success: { status, platform, version }
    ↓ failure: KR-5 state "unreachable"
    ↓
Step 2: GET /v1/capabilities (authed with Bearer key)
    ↓ success: feature flags → pair complete
    ↓ 401: KR-5 state "bad key" (gateway_auth_failed)
    ↓ network error: KR-5 state "gateway down"
```

**KR-2: Plain HTTP handling:**

```typescript
function shouldShowHttpWarning(url: string): boolean {
  return url.startsWith('http://');
}
```

When `http://` detected:
1. Show **non-blocking** warning modal (once per gateway, tracked in MMKV)
2. Copy: "Your credentials and chats will travel unencrypted. Use Tailscale or an HTTPS proxy outside your home network."
3. Link to setup docs
4. **Never blocks** pairing or use — user can dismiss and proceed (KR-2)

**KR-5: Distinct error states:**

| Condition | UI State | Copy |
|---|---|---|
| `healthCheck()` network error | Unreachable | "Cannot reach the gateway. Check the URL and ensure the API server is running." |
| `healthCheck()` HTTP error | Gateway down | "Gateway returned an unexpected error. It may be starting up." |
| `capabilities()` 401 | Bad key | "The API key was rejected. Check your API_SERVER_KEY in ~/.hermes/.env" |
| `capabilities()` network error | Connection lost | "Lost connection during pairing. Try again." |

**Each state has distinct UI copy.** 401 is never retried automatically (KR-5).

**Pairing flow (full):**

1. User enters URL (text input, auto-trim)
2. User enters API_SERVER_KEY (text input, secure entry)
3. If `http://` → show warning, user dismisses or edits URL
4. Tap "Pair Gateway"
5. Show progress indicator (not a spinner — "Checking connection…" / "Verifying key…")
6. On success:
   - Call `authService.storeKey(gatewayId, apiKey)`
   - Add `Gateway` to `useGatewayStore`
   - Persist capabilities response for transport selection (KR-3)
   - Navigate to Main → Sessions
7. On failure: show distinct error state per table above

**Acceptance criteria:**
- Pairing succeeds against a live `:8642` (KR-1)
- Key accessible only via SecureStore (NFR-1)
- Wrong key produces 401 `gateway_auth_failed` on capabilities call (KR-5)
- `http://` shows non-blocking warning that doesn't block pairing (KR-2)
- Warning shown once per gateway unless URL changes (KR-2)
- Each failure state has distinct UI copy (KR-5)

---

## 1.4 Capabilities Probe & Transport Selection

**File:** `src/services/capabilities.ts`

Store and query the capabilities response to drive transport selection (KR-3).

```typescript
export interface GatewayCapabilities {
  runsSupported: boolean;       // run_submission + run_status + run_events_sse
  sessionChatSupported: boolean; // session_chat + session_chat_streaming
  approvalsSupported: boolean;   // run_approval_response
  steerStopSupported: boolean;   // run_steer + run_stop
  skillsApiSupported: boolean;   // skills_api (wire-verified: currently 500s upstream)
  modelOptionsSupported: boolean; // model_options
  version: string;               // from healthCheck
}

export function parseCapabilities(resp: CapabilitiesResponse, version: string): GatewayCapabilities {
  return {
    runsSupported: resp.run_submission && resp.run_status && resp.run_events_sse,
    sessionChatSupported: resp.session_chat && resp.session_chat_streaming,
    approvalsSupported: resp.run_approval_response,
    steerStopSupported: resp.run_steer && resp.run_stop,
    skillsApiSupported: resp.skills_api,
    modelOptionsSupported: resp.model_options,
    version,
  };
}

/** Which chat transport to use (KR-3). */
export function selectChatTransport(caps: GatewayCapabilities): 'runs' | 'session-chat' {
  return caps.runsSupported ? 'runs' : 'session-chat';
}
```

**KR-3 behavior:**
- Gateway with `run_submission: true` → `/v1/runs` primary
- Gateway without runs → transparent fallback to session-chat streaming
- Capabilities cached per gateway in MMKV (key: `caps_{gatewayId}`)
- Re-probed on each app foreground (NFR-4: version-check protocol)

**Acceptance criteria:**
- Capabilities parsed into typed struct (KR-3)
- Transport selection is automatic based on probe result
- Fallback path works when runs not supported

---

## 1.5 Multi-Gateway Store Wiring

**Architecture §8 — design for N, ship UI for 1 in v1 (KR-4):**

The `useGatewayStore` from Phase 0 already supports N gateways. This phase wires it:

**KR-4 compliance:**
- Data model supports N gateways from day one (store from Phase 0)
- v1 pairs exactly ONE gateway in UI (pairing screen has no "add another" button)
- v1.1 adds gateway management UI against the **same schema** — no migration needed

**KR-4a compliance — credential resolution path:**
```
Any API call
  → useGatewayStore.getState().activeGatewayId
  → AuthService.getKey(gatewayId)  // from Keychain/Keystore
  → GatewayAPI instance with resolved baseUrl + key
```

No global key lookup anywhere. Session snapshots and analytics key on `(gatewayId, sessionId)` (Phase 5).

**Acceptance criteria:**
- Two gateways coexist in store in v1 (second added via dev/debug tooling only) (KR-4)
- Every API call resolves credentials via gateway id (KR-4a)
- No global key variable exists in the codebase

---

## 1.6 Version Check Protocol

**Architecture §8 — verification & currency protocol:**

```typescript
export function checkVersionCompatibility(serverVersion: string): {
  compatible: boolean;
  action: 'proceed' | 'warn' | 'block';
  message?: string;
} {
  const PINNED = '0.21.3';
  if (serverVersion === PINNED) return { compatible: true, action: 'proceed' };

  const [sMaj, sMin] = serverVersion.split('.').map(Number);
  const [pMaj, pMin] = PINNED.split('.').map(Number);

  if (sMaj !== pMaj) {
    return {
      compatible: false,
      action: 'warn',
      message: `Gateway version ${serverVersion} may have breaking changes vs tested ${PINNED}. Some features may not work.`,
    };
  }
  if (sMin < pMin) {
    return {
      compatible: true,
      action: 'warn',
      message: `Gateway v${serverVersion} is older than tested v${PINNED}. Some features may be unavailable.`,
    };
  }
  return { compatible: true, action: 'proceed' };
}
```

**NFR-4 compliance:**
- Version checked at pairing and on foreground resume
- Older gateways: hide unsupported features rather than break
- Major version mismatch: warn but don't block (user may know what they're doing)

**Acceptance criteria:**
- Version mismatch produces a non-blocking warning (NFR-4)
- Capabilities drive feature visibility, not version alone

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Pairing success | Enter valid URL + key → navigates to Sessions screen |
| 2 | Key in Keychain | Kill app → relaunch → key resolves from SecureStore (not re-entered) |
| 3 | Bad key → 401 | Enter wrong key → "API key was rejected" error (KR-5) |
| 4 | Unreachable gateway | Enter bad URL → "Cannot reach the gateway" error (KR-5) |
| 5 | HTTP warning | Enter `http://` URL → non-blocking warning shows, pairing proceeds |
| 6 | Capabilities cached | After pairing, capabilities available without re-probe |
| 7 | Multi-gateway store | Two gateways in store (debug), second doesn't appear in pairing UI |
| 8 | Version check | Pair against older/newer version → appropriate warning |
| 9 | Credential resolution | All API calls go through `gatewayId → getKey → request` path |

---

## Execution Log (2026-09-24)

**Commit:** `2136f18 feat: Phase 1 — gateway auth and pairing` — 8 files changed, 622 insertions.
**Agent:** OpenCode `build` agent, glm-5.3-flash, ~5 min runtime.

**Verification results:**
- `tsc --noEmit` — zero errors
- `npx expo lint` — clean

**New files created:**
- `src/services/auth.ts` — AuthService (expo-secure-store wrapper)
- `src/services/gateway-api.ts` — GatewayAPI REST client + all shared types
- `src/services/capabilities.ts` — parseCapabilities, selectChatTransport, probeAndCache
- `src/services/version.ts` — checkVersionCompatibility
- `src/hooks/useForegroundProbe.ts` — AppState listener for NFR-4 re-probe

**Modified files:**
- `src/app/PairingScreen.tsx` — full two-step pairing with KR-5 error states
- `src/store/gateway.ts` — apiForGateway/apiForActiveGateway helpers
- `src/app/navigation.tsx` — mounts useForegroundProbe

**Plan deviations:** None.

---

## Next: [[phase-2-sessions]]
