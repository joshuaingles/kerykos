# Phase 3 — Chat (Runs-Primary)

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-3 #chat #runs #sse

**Purpose:** Implement the chat surface using `/v1/runs` as primary transport. This is the core feature — streaming messages, detach/reattach, terminal states, approvals, steer/stop, and SSE parsing. Phase 4 (Tier 2 UX) builds on this.

**KR/NFR coverage:** KR-10, KR-11, KR-12, KR-12x, KR-13, KR-14, KR-15, KR-18, NFR-2, NFR-3, NFR-4

---

## 3.1 SSE Parser

**File:** `src/services/sse.ts`

The API server emits SSE on multiple surfaces. All streams emit `:` comment lines as keepalive (every 10s). Parser must skip these (KR-18).

**Wire-verified format (smoke-test-results.md #14):**
```
data: {"type":"message.delta","delta":"Hello"}

: keepalive (10s cadence)

data: {"type":"run.completed","usage":{"input_tokens":13718,"output_tokens":15}}
```

```typescript
export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

export type SSEEventHandler = (event: SSEEvent) => void;
export type SSEErrorHandler = (error: Error) => void;
export type SSECloseHandler = () => void;

export class SSEParser {
  private abortController: AbortController | null = null;

  /**
   * Connect to an SSE endpoint and stream events.
   * Skips ':' comment lines (keepalive, KR-18).
   * Returns a disconnection function.
   */
  async connect(
    url: string,
    headers: Record<string, string>,
    onEvent: SSEEventHandler,
    onError: SSEErrorHandler,
    onClose: SSECloseHandler,
  ): Promise<() => void> {
    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        headers: { ...headers, 'Accept': 'text/event-stream' },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      return this.consumeResponse(response, onEvent, onError, onClose);
    } catch (err) {
      onError(err as Error);
      return () => {};
    }
  }

  /**
   * Consume an already-open streaming Response — GET /v1/runs/{id}/events,
   * OR the body of a POST /api/sessions/{id}/chat/stream response (§3.8):
   * the SSE stream rides that POST's response body, so never re-request the URL.
   */
  consumeResponse(
    response: Response,
    onEvent: SSEEventHandler,
    onError: SSEErrorHandler,
    onClose: SSECloseHandler,
  ): () => void {
    const reader = response.body?.getReader();
    if (!reader) {
      onError(new Error('No response body'));
      return () => {};
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let settled = false;

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line

          for (const line of lines) {
            // Skip empty lines and keepalive comments (KR-18)
            if (!line.trim() || line.startsWith(':')) continue;

            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              try {
                const event = JSON.parse(jsonStr) as SSEEvent;
                onEvent(event);
              } catch {
                // Non-JSON data line — skip
              }
            }
          }
        }
        if (!settled) {
          settled = true;
          onClose();
        }
      } catch (err) {
        if (!settled && (err as Error).name !== 'AbortError') {
          settled = true;
          onError(err as Error);
        }
      }
    };

    read();

    return () => {
      settled = true;
      this.abortController?.abort();
      reader.cancel();
    };
  }

  disconnect() {
    this.abortController?.abort();
  }
}
```

**KR-18 acceptance criteria:**
- `:` keepalive comment lines skipped (10s cadence confirmed on wire)
- `data:` lines parsed as JSON
- Non-JSON data lines skipped gracefully
- Tool-call-only long stretches (30s+) don't trip idle timeouts — stream stays alive

**NFR-2 compliance:**
- First SSE event painted < 300 ms after emission
- Event parsing adds negligible latency

---

## 3.2 Runs API Methods

**File:** `src/services/gateway-api.ts` (extend)

```typescript
// === Runs (KR-10, KR-11, KR-14) ===

export interface RunCreateRequest {
  input: string | Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  session_id?: string; // attach to existing session for continuity
  model?: string;
}

export interface RunCreateResponse {
  run_id: string;
  status: 'started';
}

export interface RunStatusResponse {
  run_id: string;
  status: RunStatus;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export type RunStatus = 'started' | 'running' | 'completed' | 'cancelled'
  | 'failed' | 'partial' | 'interrupted';

export interface RunCompletedEvent {
  type: 'run.completed';
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

// Inside GatewayAPI class:

/**
 * Create a run (KR-10).
 * POST /v1/runs with Idempotency-Key header.
 * Returns 202 {run_id, status:"started"}.
 * Idempotency: retry after network drop replays the same run — never creates a duplicate.
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
 * Events: message.delta, reasoning.available, tool.progress, run.completed, run.cancelled
 */
getRunEventsUrl(runId: string): string {
  return `${this.baseUrl}/v1/runs/${runId}/events`;
}

/**
 * Steer mid-run (KR-14).
 * POST /v1/runs/{id}/steer with correction text.
 * Undelivered steer text carried on terminal event for client replay.
 */
async steerRun(runId: string, text: string): Promise<{ accepted: boolean }> {
  // ⚠️ Request body field name ("text") unverified — smoke test #9 verified
  // the {accepted:true} RESPONSE, not the request field. Confirm per §9a.
  return this.request(`/v1/runs/${runId}/steer`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

/**
 * Stop mid-run (KR-14).
 * POST /v1/runs/{id}/stop → terminal "cancelled".
 * ⚠️ Body shape assumed empty — confirm at impl time per §9a.
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
```

**Endpoint reference (api-surface.md + smoke-test-results.md):**

| Method | Endpoint | Response | Wire-verified |
|---|---|---|---|
| POST | `/v1/runs` | 202 `{run_id, status:"started"}` | ✅ #5 |
| GET | `/v1/runs/:id` | `{run_id, status, usage}` | ✅ #5 |
| GET | `/v1/runs/:id/events` | SSE stream | ✅ #5, #14 |
| POST | `/v1/runs/:id/steer` | `{accepted:true}` | ✅ #9 |
| POST | `/v1/runs/:id/stop` | `{status:"stopping"}` → terminal `cancelled` | ✅ #10 |
| POST | `/v1/runs/:id/approval` | `{accepted:true}` | ✅ (KR-13 scoping) |

**Idempotency (KR-10, smoke-test #6, #7):**
- `Idempotency-Key` header: UUID generated per **send attempt batch** (not per retry)
- Same key + same payload → 202 with same `run_id` + `"replayed":true`
- Same key + different payload → 409 `idempotency_key_conflict`
- Retry after network drop replays the run, never creates a duplicate turn

**Acceptance criteria:**
- `createRun` sends `Idempotency-Key` header (KR-10)
- Retry with same key replays, doesn't duplicate (KR-10)
- `getRunStatus` works for detach/reattach polling (KR-11)
- All terminal states reachable (KR-12)

---

## 3.2b App Composition Root

**File:** `src/app/composition.tsx`

Nothing in the app constructs `GatewayAPI` / `RunsManager` / `AnalyticsDB` / `SnapshotSyncEngine` inline — they are created ONCE here and injected (NFR-6: all services behind injectable seams). Screens consume the hooks; services never import each other's singletons.

```typescript
import { createContext, useContext, useMemo } from 'react';
import { useGatewayStore } from '@/store/gateway';
import { GatewayAPI } from '@/services/gateway-api';
import { RunsManager } from '@/services/runs-manager';
import { SSEParser } from '@/services/sse';

interface AppServices {
  getApi: (gatewayId: string) => GatewayAPI;        // phase-2's useGatewayAPI
  runsManager: RunsManager;                          // phase-3 ChatScreen
  // Phase 5 additions (added when phase 5 lands — same pattern):
  // analyticsDb: AnalyticsDB;
  // getSyncEngine: (gatewayId: string) => SnapshotSyncEngine;
  // getAnalyticsQueries: (gatewayId: string) => AnalyticsQueries;
}

const ServicesContext = createContext<AppServices>(null!);

/** Mount once at the app root, below ThemeProvider. */
export function ServicesProvider({ children }: { children: React.ReactNode }) {
  const services = useMemo(() => {
    // One GatewayAPI instance per gateway, cached — KR-4a: every call
    // resolves credentials from the gateway record, never a global.
    const apiCache = new Map<string, GatewayAPI>();
    const getApi = (gatewayId: string): GatewayAPI => {
      let api = apiCache.get(gatewayId);
      if (!api) {
        const gw = useGatewayStore.getState().gateways.find(g => g.id === gatewayId);
        if (!gw) throw new Error(`Unknown gateway ${gatewayId}`);
        api = new GatewayAPI(gw.base_url, gw.id);
        apiCache.set(gatewayId, api);
      }
      return api;
    };

    // RunsManager operates on the ACTIVE gateway's sessions; it resolves the
    // api per call-site (ChatScreen passes gatewayId from route params).
    const runsManager = new RunsManager(getApi, useChatStore.getState());

    // KR-11/13: settle any runs persisted across a relaunch at startup
    void runsManager.recoverPersistedRuns();

    return { getApi, runsManager };
  }, []);

  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  return useContext(ServicesContext);
}

/** Phase-2 §2.6's hook — the injectable seam for sessions CRUD. */
export function useGatewayAPI(gatewayId: string): GatewayAPI {
  return useServices().getApi(gatewayId);
}

/** Phase-5's hook — analytics queries bound to a gateway. */
export function useAnalyticsQueries(gatewayId: string): AnalyticsQueries {
  // Implemented in phase 5 via the same provider; declared here so
  // phase-5's store import resolves. (Deferred import — see phase-5 §5.3.)
  return useServices().getAnalyticsQueries!(gatewayId);
}
```

**Wiring notes:**
- `RunsManager` constructor takes `getApi` (a resolver), not a single `GatewayAPI` — chat screens know their gatewayId from route params and resolve through it. This keeps multi-gateway (KR-4a) honest: no global key anywhere.
- Phase 5 extends `AppServices` with `analyticsDb` / `getSyncEngine` / `getAnalyticsQueries` — same provider, same pattern. `analyticsQueriesFor(gatewayId)` from phase-5 §5.3 is implemented as `getAnalyticsQueries` here.
- Type imports shared across phases live in `src/services/types.ts` — see §3.2c.

---

## 3.2c Shared Service Types

**File:** `src/services/types.ts`

Cross-phase types that are imported by multiple docs must have ONE home. Phase-5's store imports `SessionSnapshot` / `ModelPricing`; phase-1 defines `ModelOptionsResponse` (re-exported here for convenience, canonical definition stays in gateway-api.ts):

```typescript
// src/services/types.ts
import type { ModelOptionsResponse } from './gateway-api';
export type { ModelOptionsResponse };

/** Phase-5 §5.1: one row of session_snapshots (SQLite row shape). */
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

/** Phase-5 §5.3: per-model pricing row (from /api/model/options). */
export interface ModelPricing {
  model: string;
  provider: string | null;
  input_cost_per_token: number | null;
  output_cost_per_token: number | null;
  cached_cost_per_token: number | null;
  updated_at: number;
}
```

---

## 3.3 Chat Store (Zustand)

**File:** `src/store/chat.ts`

```typescript
import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

// MMKV instance for chat/run persistence (KR-11/KR-13 relaunch continuity)
const mmkv = new MMKV({ id: 'kerykos-chat' });

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming: boolean;
  toolCalls?: ToolCall[];
  runId?: string;         // associated run
  isSteered?: boolean;    // steer correction applied
  usage?: RunUsage;       // KR-18: captured from run.completed's usage block
}

/** KR-18: token stats from the terminal event (status GET fields were null). */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  state: 'running' | 'completed' | 'failed';
  collapsed: boolean;     // KR-15: collapse/expand
}

export interface ActiveRun {
  runId: string;
  sessionId: string;
  status: RunStatus;
  idempotencyKey: string;
  startedAt: number;
  disconnectFn?: () => void;  // SSE disconnection
}

// === Run persistence (MMKV) — KR-11/KR-13 relaunch continuity ===
// Wire-verified (smoke-test #11): a known run_id stays addressable across a
// gateway restart — status GET → 404 only because the in-memory owner map
// resets; runs are durable and remain resumable. Persisting run_id per
// session is what makes detach/reattach (KR-11) and pending approval cards
// (KR-13) survive an app relaunch.
const ACTIVE_RUNS_KEY = 'active_runs'; // stored in MMKV instance id 'kerykos-chat'

interface TrackedRun {
  runId: string;
  sessionId: string;
  idempotencyKey: string;
  startedAt: number;
}

export function loadTrackedRuns(): Record<string, TrackedRun> {
  return JSON.parse(mmkv.getString(ACTIVE_RUNS_KEY) ?? '{}');
}

export function loadTrackedRun(sessionId: string): TrackedRun | null {
  return loadTrackedRuns()[sessionId] ?? null;
}

export function persistActiveRun(sessionId: string, run: TrackedRun): void {
  const map = loadTrackedRuns();
  map[sessionId] = run;
  mmkv.set(ACTIVE_RUNS_KEY, JSON.stringify(map));
}

export function clearActiveRun(sessionId: string): void {
  const map = loadTrackedRuns();
  if (map[sessionId]) {
    delete map[sessionId];
    mmkv.set(ACTIVE_RUNS_KEY, JSON.stringify(map));
  }
}

export interface ApprovalRequest {
  runId: string;
  message: string;
  responded: boolean;
  decision?: 'approve' | 'deny';
}

interface ChatState {
  // Per-session message history
  messagesBySession: Map<string, ChatMessage[]>;

  // Active runs (keyed by session id)
  activeRuns: Map<string, ActiveRun>;

  // Pending approvals
  approvals: Map<string, ApprovalRequest>;

  // Actions
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateMessage: (sessionId: string, messageId: string, update: Partial<ChatMessage>) => void;
  appendToMessage: (sessionId: string, messageId: string, delta: string) => void;
  setActiveRun: (sessionId: string, run: ActiveRun | null) => void;
  updateRunStatus: (sessionId: string, status: RunStatus) => void;
  addToolCall: (sessionId: string, messageId: string, tool: ToolCall) => void;
  updateToolCall: (sessionId: string, toolId: string, update: Partial<ToolCall>) => void;
  setApproval: (sessionId: string, approval: ApprovalRequest) => void;

  // Selectors
  getMessages: (sessionId: string) => ChatMessage[];
  getActiveRun: (sessionId: string) => ActiveRun | undefined;
  getPendingApproval: (sessionId: string) => ApprovalRequest | undefined;
}
```

---

## 3.4 Runs Manager

**File:** `src/services/runs-manager.ts`

Orchestrates the full runs lifecycle: create, stream, detach/reattach, steer/stop, terminal states.

```typescript
import { v4 as uuidv4 } from 'uuid';

export class RunsManager {
  // getApi: resolver injected by the composition root (phase-3 §3.2b) —
  // per-gateway, KR-4a. RunsManager itself is gateway-agnostic.
  private getApi: (gatewayId: string) => GatewayAPI;
  private api: GatewayAPI;        // resolved for the active call's gateway
  private store: ChatState; // zustand store reference
  private sse: SSEParser;
  // KR-14: id of the optimistic "Steer sent" message per session, so
  // run.steered UPDATES it instead of adding a duplicate transcript entry.
  private lastSteerMessageId: Record<string, string> = {};

  constructor(getApi: (gatewayId: string) => GatewayAPI, store: ChatState) {
    this.getApi = getApi;
    this.api = getApi(useGatewayStore.getState().activeGatewayId ?? '');
    this.store = store;
    this.sse = new SSEParser();
  }

  /** Resolve the api for a specific gateway (chat screens carry gatewayId). */
  private apiFor(gatewayId?: string): GatewayAPI {
    return gatewayId ? this.getApi(gatewayId) : this.api;
  }

  /**
   * Send a message (KR-10).
   * Creates a run with idempotency key and starts SSE stream.
   */
  async sendMessage(
    sessionId: string,
    content: string | RunCreateRequest['input'],
  ): Promise<void> {
    const idempotencyKey = uuidv4();
    const userMessageId = uuidv4();

    // Add user message to store
    this.store.addMessage(sessionId, {
      id: userMessageId,
      role: 'user',
      content: typeof content === 'string' ? content : JSON.stringify(content),
      timestamp: Date.now(),
      isStreaming: false,
    });

    // Create assistant placeholder
    const assistantMessageId = uuidv4();
    this.store.addMessage(sessionId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    });

    try {
      // Create run (KR-10) — session continuity headers per api-surface.md.
      // NFR-3: bounded retry (≤5, exponential); 401 never retried (KR-5);
      // retries reuse the SAME idempotency key → replay, not duplicate (KR-10).
      const { run_id } = await this.retryWithBackoff(() =>
        this.api.createRun(
          { input: content, session_id: sessionId },
          idempotencyKey,
          this.api.sessionHeaders(sessionId),
        ),
      );

      // Set active run
      this.store.setActiveRun(sessionId, {
        runId: run_id,
        sessionId,
        status: 'started',
        idempotencyKey,
        startedAt: Date.now(),
      });

      // KR-11/KR-13: persist run so relaunch can reconnect (reattachRun)
      persistActiveRun(sessionId, {
        runId: run_id,
        sessionId,
        idempotencyKey,
        startedAt: Date.now(),
      });

      // Connect SSE stream (KR-10)
      await this.connectStream(sessionId, run_id, assistantMessageId);

    } catch (err) {
      this.store.updateMessage(sessionId, assistantMessageId, {
        content: `Error: ${(err as Error).message}`,
        isStreaming: false,
      });
      this.store.setActiveRun(sessionId, null);
    }
  }

  /**
   * Connect SSE stream for a run (KR-10).
   * Handles all event types: message.delta, reasoning, tool.progress,
   * run.completed, run.cancelled, approval.requested
   */
  private async connectStream(
    sessionId: string,
    runId: string,
    messageId: string,
  ): Promise<void> {
    const key = await this.api.getResolvedKey(); // internal method
    const url = this.api.getRunEventsUrl(runId);

    const disconnect = await this.sse.connect(
      url,
      { 'Authorization': `Bearer ${key}` },
      (event) => this.handleSSEEvent(sessionId, runId, messageId, event),
      (error) => this.handleSSEError(sessionId, messageId, error),
      () => this.handleSSEClose(sessionId, runId),
    );

    // Store disconnect function for cleanup
    const activeRun = this.store.getActiveRun(sessionId);
    if (activeRun) {
      activeRun.disconnectFn = disconnect;
    }
  }

  private handleSSEEvent(
    sessionId: string,
    runId: string,
    messageId: string,
    event: SSEEvent,
  ): void {
    switch (event.type) {
      case 'message.delta':
        // Append delta to message content
        this.store.appendToMessage(sessionId, messageId, event.delta as string);
        break;

      case 'reasoning.available':
        // Reasoning tokens (optional display)
        break;

      case 'tool.progress':
        // KR-15: Tool activity cards
        this.store.addToolCall(sessionId, messageId, {
          id: event.tool_id as string,
          name: event.name as string,
          state: 'running',
          collapsed: true, // default collapsed (KR-15)
        });
        break;

      case 'run.completed':
        // KR-18: run stats come from the terminal event's usage block — the
        // status GET's token fields were null on the wire. Capture + persist.
        {
          const usage = (event as RunCompletedEvent).usage;
          this.store.updateMessage(sessionId, messageId, {
            isStreaming: false,
            // KR-18: tokens/cost for the run-stats display
            usage: usage ? {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            } : undefined,
          });
          this.store.updateRunStatus(sessionId, 'completed');
          this.store.setActiveRun(sessionId, null);
          clearActiveRun(sessionId); // run settled — stop tracking (KR-11/13)
          // KR-14: if a steer was sent but undelivered, its text is carried
          // on the terminal event — render it in the transcript (below).
          const undelivered = (event as SSEEvent & { steered_text?: string }).steered_text;
          if (typeof undelivered === 'string' && undelivered.trim()) {
            this.store.addMessage(sessionId, {
              id: uuidv4(),
              role: 'system',
              content: `Steer not delivered before the run ended: "${undelivered}"`,
              timestamp: Date.now(),
              isStreaming: false,
              runId,
            });
          }
        }
        break;

      case 'run.cancelled':
        this.store.updateMessage(sessionId, messageId, { isStreaming: false });
        this.store.updateRunStatus(sessionId, 'cancelled');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId); // run settled — stop tracking (KR-11/13)
        break;

      case 'approval.requested':
        // KR-13: Approval card
        this.store.setApproval(sessionId, {
          runId,
          message: event.message as string,
          responded: false,
        });
        break;

      case 'run.steered':
        // KR-14: steer accepted — UPDATE the optimistic entry (one transcript
        // entry per steer; never a duplicate).
        {
          const steerMsgId = this.lastSteerMessageId[sessionId];
          if (steerMsgId) {
            this.store.updateMessage(sessionId, steerMsgId, {
              isSteered: true,
              content: `Steer applied: "${event.text as string}"`,
            });
          }
        }
        break;
    }
  }

  private handleSSEError(sessionId: string, messageId: string, error: Error): void {
    this.store.updateMessage(sessionId, messageId, {
      content: `Connection error: ${error.message}`,
      isStreaming: false,
    });
    this.store.setActiveRun(sessionId, null);
    // NFR-3: bounded retry with backoff — but NEVER auto-retry a 401 (KR-5).
    // Attempted retries re-run sendMessage with the SAME idempotency key
    // (KR-10: replay, never duplicate). See retryWithBackoff below.
  }

  private handleSSEClose(sessionId: string, runId: string): void {
    // SSE closed — run may still be active server-side (KR-11: never mark
    // failed on a bare stream close). But NFR-3 forbids an infinite spinner:
    // settle the truth with ONE status poll. If the run settled server-side,
    // apply its terminal state; if still running, leave the streaming message
    // alone (reattach on next focus will reconnect).
    void this.api.getRunStatus(runId).then((status) => {
      if (this.store.getActiveRun(sessionId)?.runId !== runId) return; // stale
      switch (status.status) {
        case 'completed':
        case 'cancelled':
        case 'failed':
        case 'partial':
          this.store.updateRunStatus(sessionId, status.status);
          this.store.setActiveRun(sessionId, null);
          clearActiveRun(sessionId);
          const msgs = this.store.getMessages(sessionId);
          const last = [...msgs].reverse().find(m => m.isStreaming);
          if (last) this.store.updateMessage(sessionId, last.id, { isStreaming: false });
          break;
        // 'started'/'running' → still live server-side; next focus reattaches
      }
    }).catch(() => {
      // Poll failed (e.g. network gone): leave state as-is; NFR-3 offline
      // banner + manual retry cover this — no auto-retry loops here.
    });
  }

  // === Detach/Reattach (KR-11) ===

  /**
   * Reconnect to an active run after returning from background OR after app
   * relaunch. Polls GET /v1/runs/{id} and resumes streaming if still active.
   *
   * Resolution order (KR-11/13 must work after a cold relaunch, when the
   * in-memory Zustand store is empty): in-memory ActiveRun first, then the
   * MMKV-persisted TrackedRun — hydrated into the store before polling so
   * every downstream path (connectStream, steer, stop) has a live handle.
   */
  async reattachRun(sessionId: string): Promise<void> {
    let activeRun = this.store.getActiveRun(sessionId);
    if (!activeRun) {
      // Relaunch path: hydrate from MMKV (KR-11/13 relaunch continuity)
      const tracked = loadTrackedRun(sessionId);
      if (!tracked) return;
      activeRun = {
        runId: tracked.runId,
        sessionId,
        status: 'running',
        idempotencyKey: tracked.idempotencyKey,
        startedAt: tracked.startedAt,
      };
      this.store.setActiveRun(sessionId, activeRun);
    }

    try {
      const status = await this.api.getRunStatus(activeRun.runId);

      switch (status.status) {
        case 'started':
        case 'running':
          // Run still active — reconnect SSE stream.
          // ⚠️ Replay semantics (smoke-test #5): the events stream replays
          // from the START of the run, so a message that already holds
          // partial content would get the full transcript re-appended.
          // Reset the streaming message's content BEFORE reconnecting.
          const messages = this.store.getMessages(sessionId);
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            this.store.updateMessage(sessionId, lastAssistant.id, { content: '' });
            await this.connectStream(sessionId, activeRun.runId, lastAssistant.id);
          }
          break;

        case 'completed':
        case 'cancelled':
        case 'failed':
        case 'partial':
          // Run finished while we were away — update state (KR-11)
          this.store.updateRunStatus(sessionId, status.status);
          this.store.setActiveRun(sessionId, null);
          clearActiveRun(sessionId); // run settled — stop tracking (KR-13)
          // Mark last assistant message as not streaming
          const msgs = this.store.getMessages(sessionId);
          const last = [...msgs].reverse().find(m => m.isStreaming);
          if (last) {
            this.store.updateMessage(sessionId, last.id, { isStreaming: false });
          }
          break;
      }
    } catch (err) {
      // KR-12x: 404 on a tracked run = gateway restarted = interrupted
      if ((err as GatewayError).status === 404) {
        this.store.updateRunStatus(sessionId, 'interrupted');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId); // owner map wiped server-side — stop tracking
        // Show honest notice: "the gateway restarted before this run settled"
      }
    }
  }

  // === Steer/Stop (KR-14) ===

  async steer(sessionId: string, text: string): Promise<void> {
    const activeRun = this.store.getActiveRun(sessionId);
    if (!activeRun) return;
    await this.api.steerRun(activeRun.runId, text);
    // KR-14: ONE optimistic transcript entry now; run.steered UPDATES it to
    // "applied", and undelivered steer text is carried on the terminal event.
    const msgId = uuidv4();
    this.lastSteerMessageId[sessionId] = msgId;
    this.store.addMessage(sessionId, {
      id: msgId,
      role: 'system',
      content: `Steer sent: "${text}"`,
      timestamp: Date.now(),
      isStreaming: false,
      runId: activeRun.runId,
    });
  }

  async stop(sessionId: string): Promise<void> {
    const activeRun = this.store.getActiveRun(sessionId);
    if (!activeRun) return;
    await this.api.stopRun(activeRun.runId);
    // Terminal "cancelled" arrives via SSE or poll
  }

  // === Approvals (KR-13) ===

  async respondToApproval(
    sessionId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const approval = this.store.getPendingApproval(sessionId);
    if (!approval) return;

    await this.api.respondToApproval(approval.runId, decision);
    this.store.setApproval(sessionId, {
      ...approval,
      responded: true,
      decision,
    });
  }

  // === Relaunch recovery (KR-11 / KR-13) ===

  /**
   * Called at app start / chat-screen focus: for every persisted tracked run
   * (MMKV 'active_runs'), poll status and reattach or settle. Pending
   * approvals for app-initiated runs are re-derived by reconnecting the run
   * event stream (events replay server-side — smoke-test #5), so the
   * approval card survives relaunch pre-approval (KR-13).
   */
  async recoverPersistedRuns(): Promise<void> {
    const tracked = loadTrackedRuns();
    for (const sessionId of Object.keys(tracked)) {
      await this.reattachRun(sessionId);
    }
  }

  /** KR-13: re-derive pending approval state for one session on relaunch.
   *  Reconnect events → replayed approval.requested re-renders the card. */
  async restoreApprovalState(sessionId: string): Promise<void> {
    if (loadTrackedRun(sessionId)) {
      await this.reattachRun(sessionId);
    }
  }

  // === Bounded retry (NFR-3) ===

  /**
   * Exponential backoff retry, max 5 attempts. NEVER retries on 401
   * (KR-5: auth failures are terminal, user must fix the key).
   * Retries of a send reuse the SAME idempotency key (KR-10 replay).
   */
  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    opts: { maxAttempts?: number; isAuthError?: (err: unknown) => boolean } = {},
  ): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 5;
    const isAuthError = opts.isAuthError ??
      ((err: unknown) => err instanceof GatewayError && err.status === 401);

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (isAuthError(err)) throw err; // KR-5: no auto-retry on 401
        if (attempt === maxAttempts) break;
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 15_000)));
      }
    }
    throw lastErr;
  }
}
```

---

## 3.5 Terminal States (KR-12, KR-12x)

**All five terminal states must be reachable in integration tests:**

| Status | Trigger | UI Behavior |
|---|---|---|
| `completed` | Run finished normally | Show final message, run stats from `run.completed` event (KR-18) |
| `cancelled` | User called `stop` | Show "Stopped by user" notice |
| `failed` | Server-side error | Show "Run failed: [reason]" notice |
| `partial` | Partial completion (timeout/resource) | Show partial content + "Partial — run was cut short" |
| `interrupted` | Gateway restarted mid-run (KR-12x) | Show "Gateway restarted before this run settled" — honest notice, not generic error |

**KR-12x — gateway restart detection:**
```
Run status poll → 404 "Run not found"
  → This means the gateway restarted (in-memory owner map wiped)
  → Treat as interrupted state
  → Show: "the gateway restarted before this run settled"
```

Wire-verified (smoke-test #11): own key after gateway restart → 404 `Run not found`.

**NFR-3 compliance:**
- Every failure state has distinct UI + bounded retries (exponential, ≤ 5)
- Never a hang or generic spinner (KR-5 pattern, extended to runs)
- Manual retry available on all error states

---

## 3.6 Approvals (KR-13)

**Scope: app-initiated runs only.**

Wire-verified (smoke-test #11): run-scope isolation confirmed — wrong key → 401, own key after restart → 404.

**Approval card in chat UI:**
```typescript
export function ApprovalCard({ approval, onRespond }: {
  approval: ApprovalRequest;
  onRespond: (decision: 'approve' | 'deny') => void;
}) {
  if (approval.responded) {
    return (
      <View style={styles.approvalCard}>
        <Text>{approval.decision === 'approve' ? '✅ Approved' : '❌ Denied'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.approvalCard}>
      <Text>Approval requested: {approval.message}</Text>
      <View style={styles.buttons}>
        <Button title="Approve" onPress={() => onRespond('approve')} />
        <Button title="Deny" onPress={() => onRespond('deny')} variant="destructive" />
      </View>
    </View>
  );
}
```

**KR-13 acceptance criteria:**
- Approve/deny changes run outcome visibly
- Pending card survives app relaunch pre-approval for app-initiated runs
- Runs initiated from other surfaces (desktop, Telegram, cron) are out of v1 scope

---

## 3.7 Chat Screen UI

**File:** `src/app/ChatScreen.tsx`

```typescript
import { FlashList } from '@shopify/flash-list';
import Markdown from 'react-native-markdown-display';
import SyntaxHighlighter from 'react-native-syntax-highlighter';

export function ChatScreen({ sessionId, gatewayId }: {
  sessionId: string;
  gatewayId: string;
}) {
  const messages = useChatStore(s => s.getMessages(sessionId));
  const activeRun = useChatStore(s => s.getActiveRun(sessionId));
  const approval = useChatStore(s => s.getPendingApproval(sessionId));

  // KR-11: Detach/reattach on focus — including after app relaunch
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      // In-memory active run OR a run persisted before relaunch (KR-11/13)
      if (activeRun || loadTrackedRun(sessionId)) {
        runsManager.reattachRun(sessionId);
      }
    });
    return unsub;
  }, [sessionId, activeRun]);

  // KR-13: restore pending approval card on relaunch (app-initiated runs only)
  useEffect(() => {
    runsManager.restoreApprovalState(sessionId);
  }, [sessionId]);

  return (
    <View style={styles.container}>
      <ChatHeader sessionId={sessionId} />
      <FlashList
        data={messages}
        renderItem={({ item }) => <ChatMessage message={item} />}
        estimatedItemSize={80}
        // KR-16: stick-to-bottom with manual-scroll escape hatch
        ref={listRef}
        onScrollBeginDrag={() => setAutoScroll(false)}
      />
      {approval && !approval.responded && (
        <ApprovalCard
          approval={approval}
          onRespond={(d) => runsManager.respondToApproval(sessionId, d)}
        />
      )}
      <ChatComposer
        sessionId={sessionId}
        activeRun={!!activeRun}
        onSend={(text) => runsManager.sendMessage(sessionId, text)}
        onSteer={(text) => runsManager.steer(sessionId, text)} // KR-14: mid-run steering
      />
    </View>
  );
}
```

**Chat message rendering (KR-18):**

```typescript
function ChatMessage({ message }: { message: ChatMessage }) {
  return (
    <View style={styles.message}>
      {message.role === 'user' ? (
        <Text style={styles.userText}>{message.content}</Text>
      ) : (
        <Markdown
          style={markdownStyles}
          // KR-18: markdown + syntax-highlighted code blocks
          renderers={{
            code_inline: ({ children }) => (
              <SyntaxHighlighter>{children}</SyntaxHighlighter>
            ),
          }}
        >
          {message.content}
        </Markdown>
      )}
      {message.toolCalls?.map(tool => (
        <ToolActivityCard key={tool.id} tool={tool} />
      ))}
      {message.isStreaming && <StreamingIndicator />}
    </View>
  );
}
```

**KR-18 rendering requirements:**
- Markdown rendered with `react-native-markdown-display`
- Syntax-highlighted code blocks via `react-native-syntax-highlighter`
- Tool-call-only long stretches keep stream alive (SSE keepalive handles this)
- Run stats (tokens/cost) from terminal `run.completed` event's `usage` block

---

## 3.8 Session Chat Fallback (NFR-4)

**File:** `src/services/session-chat-fallback.ts`

For gateways without `/v1/runs` support (capabilities probe returns `run_submission: false`):

```typescript
/**
 * Fallback chat via POST /api/sessions/{id}/chat/stream (SSE).
 * Used when:
 * (a) capabilities probe fails for runs
 * (b) older gateways (pre-runs)
 * Auto-selected via selectChatTransport() from Phase 1 (KR-3).
 *
 * ⚠️ Wire nuance: the SSE stream rides the POST's response body — there is
 * no separate GET to open. Consume `response.body` directly via
 * SSEParser.consumeResponse (never re-request the URL).
 *
 * ⚠️ Event schema UNVERIFIED on the wire (smoke tests only exercised runs):
 * event type names below (`message.delta`, completion marker) are assumed
 * from the runs surface. Verify actual event names against a live
 * session-chat stream at impl time per §9a before relying on them.
 */
export async function sendChatMessageFallback(
  api: GatewayAPI,
  sessionId: string,
  content: string,
  onDelta: (text: string) => void,
  onComplete: () => void,
  onError: (err: Error) => void,
): Promise<() => void> {
  const sse = new SSEParser();

  // Initial POST — returns the SSE stream in its response body
  const response = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/chat/stream`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${await api.getResolvedKey()}`,
      'Content-Type': 'application/json',
      // Session continuity headers per api-surface.md
      ...api.sessionHeaders(sessionId),
    },
    body: JSON.stringify({ message: content }),
  });

  if (!response.ok) {
    onError(new Error(`Session chat stream failed: ${response.status}`));
    return () => {};
  }

  // Consume the POST's streaming body — do NOT re-fetch the URL
  return sse.consumeResponse(
    response,
    (event) => {
      // ⚠️ Event names assumed from runs — verify on live stream at impl time
      if (event.type === 'message.delta') {
        onDelta(event.delta as string);
      } else if (event.type === 'message.complete') {
        onComplete();
      }
    },
    onError,
    onComplete,
  );
}
```

**NFR-4 compliance:**
- Fallback path exists and is wired behind the `GatewayAPI` seam
- Auto-selected via capabilities probe (KR-3)
- Session-chat path kept for (a) pre-runs gateways, (b) image-bearing messages (before runs-image verification was done — now verified, images are runs-primary per KR-17a CLOSED)

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Send message | POST /v1/runs → SSE stream → message renders |
| 2 | Idempotency | Retry with same key → same run_id, no duplicate (KR-10) |
| 3 | SSE keepalive | 30s idle tool call → stream stays alive (KR-18) |
| 4 | Detach/reattach | Background 2 min → return → truthful state (KR-11) |
| 5 | Completed state | Run finishes → `run.completed` event → stats displayed (KR-12) |
| 6 | Cancelled state | Stop button → `run.cancelled` → notice shown (KR-12) |
| 7 | Gateway restart | Kill gateway mid-run → 404 → interrupted notice (KR-12x) |
| 8 | Steer | Submit correction mid-run → accepted (KR-14) |
| 9 | Stop | Stop mid-run → cancelled (KR-14) |
| 10 | Approval | Approval card renders → approve/deny changes outcome (KR-13) |
| 11 | Tool cards | Tool events render inline, collapsed by default (KR-15) |
| 12 | Markdown | Messages render with markdown + code highlighting (KR-18) |
| 13 | Fallback | Disable runs capability → session-chat fallback works (NFR-4) |
| 14 | Error states | Each terminal state shows distinct UI (NFR-3) |
| 15 | Bounded retry | Kill network mid-send → retries ≤5 with backoff, same key replay; 401 shows error immediately, no auto-retry (NFR-3, KR-5, KR-10) |
| 16 | Relaunch continuity | Mid-run → kill app → relaunch → chat screen → reconnects to run / shows truthful state (KR-11) |
| 17 | Approval survives relaunch | Pending approval → kill app → relaunch → approval card restored (KR-13) |
| 18 | Steer affordance | Type during active run → send button steers the run (KR-14); "Queue instead" defers (KR-16) |
| 19 | Session headers | `X-Hermes-Session-Id` (+ `X-Hermes-Session-Key`) sent on runs POST per api-surface.md |

---

## Execution Log (2026-09-24)

**Commit:** `8d22f37 feat: Phase 3 — chat runs and SSE streaming` — 8 files added, 5 modified.
**Agent:** OpenCode `build` agent, glm-5.3-flash, ~12 min runtime.

**Verification results:**
- `tsc --noEmit` — zero errors
- `npx expo lint` — clean (0 errors, 0 warnings)

**New files created:**
- `src/services/sse.ts` — SSEParser with connect/consumeResponse, keepalive skip
- `src/services/runs-manager.ts` — full runs lifecycle (send/stream/reattach/steer/stop/approve)
- `src/services/session-chat-fallback.ts` — fallback for non-runs gateways
- `src/services/types.ts` — SessionSnapshot, ModelPricing, re-exports
- `src/app/composition.tsx` — ServicesProvider composition root
- `src/components/ApprovalCard.tsx` — approve/deny card
- `src/types/hljs-styles.d.ts` — module declaration for syntax highlighter styles
- `src/types/react-native-syntax-highlighter.d.ts` — module declaration

**Modified files:**
- `src/services/gateway-api.ts` — added runs API methods + types
- `src/store/chat.ts` — full ChatState with MMKV run persistence
- `src/app/ChatScreen.tsx` — FlashList messages, Markdown, composer, reattach

**Plan deviations:**
| # | Plan said | Actual | Reason |
|---|-----------|--------|--------|
| 1 | `new MMKV({ id: 'kerykos-chat' })` | `createMMKV(...)` | MMKV v4 API (same as Phase 0 deviation) |
| 2 | `estimatedItemSize={80}` on FlashList | Prop dropped | FlashList v2 (same as Phase 2 deviation) |
| 3 | Plan assumed `react-native-syntax-highlighter` ships types | No types shipped | Added `.d.ts` module declarations |
| 4 | Plan used `ComponentRef` import | Removed | Not needed for the actual ref pattern used |

---

## Next: [[phase-4-tier2-ux]]
