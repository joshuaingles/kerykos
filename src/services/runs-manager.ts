import { v4 as uuidv4 } from 'uuid';
import { SSEParser, type SSEEvent } from './sse';
import {
  GatewayAPI,
  GatewayError,
  type RunCompletedEvent,
  type RunStatus,
} from './gateway-api';
import {
  useChatStore,
  clearActiveRun,
  loadTrackedRun,
  loadTrackedRuns,
  persistActiveRun,
} from '@/store/chat';
import { useGatewayStore } from '@/store/gateway';

/**
 * Runs lifecycle orchestrator (phase-3 §3.4): create, stream, detach/reattach,
 * steer/stop, terminal states, relaunch recovery.
 *
 * getApi is the resolver injected by the composition root (§3.2b) — per-gateway,
 * KR-4a. RunsManager itself is gateway-agnostic; every call site carries the
 * gatewayId it operates on.
 */
export class RunsManager {
  private getApi: (gatewayId: string) => GatewayAPI;
  private sse = new SSEParser();

  // KR-14: id of the optimistic "Steer sent" message per session, so
  // run.steered UPDATES it instead of adding a duplicate transcript entry.
  private lastSteerMessageId: Record<string, string> = {};

  constructor(getApi: (gatewayId: string) => GatewayAPI) {
    this.getApi = getApi;
  }

  private get store() {
    return useChatStore.getState();
  }

  /** Build continuity headers from the persisted session echo (api-surface.md). */
  private echoHeaders(gatewayId: string, sessionId: string): Record<string, string> {
    const api = this.getApi(gatewayId);
    const echo = api.getSessionEcho(gatewayId, sessionId);
    return echo ? api.sessionHeaders(echo.sessionId, echo.sessionKey) : api.sessionHeaders(sessionId);
  }

  /**
   * Send a message (KR-10).
   * Creates a run with idempotency key and starts SSE stream.
   */
  async sendMessage(gatewayId: string, sessionId: string, content: string): Promise<void> {
    const store = this.store;
    const idempotencyKey = uuidv4();
    const userMessageId = uuidv4();

    // Add user message to store
    store.addMessage(sessionId, {
      id: userMessageId,
      role: 'user',
      content,
      timestamp: Date.now(),
      isStreaming: false,
    });

    // Create assistant placeholder
    const assistantMessageId = uuidv4();
    store.addMessage(sessionId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    });

    const api = this.getApi(gatewayId);

    try {
      // Create run (KR-10) — session continuity headers per api-surface.md.
      // NFR-3: bounded retry (≤5, exponential); 401 never retried (KR-5);
      // retries reuse the SAME idempotency key → replay, not duplicate (KR-10).
      const { run_id } = await this.retryWithBackoff(() =>
        api.createRun(
          { input: content, session_id: sessionId },
          idempotencyKey,
          this.echoHeaders(gatewayId, sessionId),
        ),
      );

      // Set active run
      const activeRun = {
        runId: run_id,
        sessionId,
        status: 'started' as const,
        idempotencyKey,
        startedAt: Date.now(),
      };
      this.store.setActiveRun(sessionId, activeRun);

      // KR-11/KR-13: persist run so relaunch can reconnect (reattachRun)
      persistActiveRun(sessionId, {
        runId: run_id,
        sessionId,
        idempotencyKey,
        startedAt: activeRun.startedAt,
      });

      // Connect SSE stream (KR-10)
      this.connectStream(api, sessionId, run_id, assistantMessageId);
    } catch (err) {
      // KR-5: auth failures surface immediately (no auto-retry happens inside
      // retryWithBackoff). Show error inline on the placeholder.
      const gwErr = err as GatewayError;
      const is401 = gwErr instanceof GatewayError && gwErr.status === 401;
      this.store.updateMessage(sessionId, assistantMessageId, {
        content: is401
          ? 'Authentication failed — check the API key in Settings.'
          : `Error: ${(err as Error).message}`,
        isStreaming: false,
        error: true,
      });
      this.store.setActiveRun(sessionId, null);
      throw err;
    }
  }

  /**
   * Connect SSE stream for a run (KR-10).
   * Handles all event types: message.delta, reasoning.available, tool.progress,
   * run.completed, run.cancelled, run.steered, approval.requested
   */
  private connectStream(
    api: GatewayAPI,
    sessionId: string,
    runId: string,
    messageId: string,
  ): void {
    void (async () => {
      try {
        const key = await api.getResolvedKey();
        const url = api.getRunEventsUrl(runId);
        const disconnect = await this.sse.connect(
          url,
          { 'Authorization': `Bearer ${key}` },
          (event) => this.handleSSEEvent(api, sessionId, runId, messageId, event),
          (error) => this.handleSSEError(sessionId, messageId, error),
          () => this.handleSSEClose(api, sessionId, runId),
        );

        // Store disconnect function for cleanup
        const activeRun = this.store.getActiveRun(sessionId);
        if (activeRun && activeRun.runId === runId) {
          this.store.setActiveRun(sessionId, { ...activeRun, disconnectFn: disconnect });
        }
      } catch (err) {
        this.handleSSEError(sessionId, messageId, err as Error);
      }
    })();
  }

  private handleSSEEvent(
    api: GatewayAPI,
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
        // Reasoning tokens (optional display — deferred to Phase 4)
        break;

      case 'tool.progress': {
        // KR-15: Tool activity cards
        const state = (event.state as 'running' | 'completed' | 'failed' | undefined) ?? 'running';
        if (state === 'running') {
          this.store.addToolCall(sessionId, messageId, {
            id: event.tool_id as string,
            name: (event.name as string) ?? 'tool',
            state,
            collapsed: true, // default collapsed (KR-15)
          });
        } else {
          this.store.updateToolCall(sessionId, event.tool_id as string, { state });
        }
        break;
      }

      case 'run.completed': {
        // KR-18: run stats come from the terminal event's usage block — the
        // status GET's token fields were null on the wire. Capture + persist.
        const usage = (event as unknown as RunCompletedEvent).usage;
        this.store.updateMessage(sessionId, messageId, {
          isStreaming: false,
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
        // on the terminal event — render it in the transcript.
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
        break;
      }

      case 'run.cancelled':
        this.store.updateMessage(sessionId, messageId, { isStreaming: false });
        this.store.updateRunStatus(sessionId, 'cancelled');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId); // run settled — stop tracking (KR-11/13)
        break;

      case 'run.failed':
        this.store.updateMessage(sessionId, messageId, {
          isStreaming: false,
          error: true,
          content: this.store.getMessages(sessionId).find(m => m.id === messageId)?.content
            || `Run failed: ${(event.error as string | undefined) ?? 'server-side error'}`,
        });
        this.store.updateRunStatus(sessionId, 'failed');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId);
        break;

      case 'run.partial':
        this.store.updateMessage(sessionId, messageId, { isStreaming: false });
        this.store.updateRunStatus(sessionId, 'partial');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId);
        break;

      case 'approval.requested':
        // KR-13: Approval card
        this.store.setApproval(sessionId, {
          runId,
          message: (event.message as string) ?? '',
          responded: false,
        });
        break;

      case 'run.steered': {
        // KR-14: steer accepted — UPDATE the optimistic entry (one transcript
        // entry per steer; never a duplicate).
        const steerMsgId = this.lastSteerMessageId[sessionId];
        if (steerMsgId) {
          this.store.updateMessage(sessionId, steerMsgId, {
            isSteered: true,
            content: `Steer applied: "${(event.text as string) ?? ''}"`,
          });
        }
        break;
      }
    }
  }

  private handleSSEError(sessionId: string, messageId: string, error: Error): void {
    // Find the streaming assistant message if the placeholder id moved on
    // (e.g. reconnect assigned a different message id).
    const streaming = this.store.getMessages(sessionId).find(m => m.isStreaming);
    const targetId = streaming?.id ?? messageId;
    this.store.updateMessage(sessionId, targetId, {
      content: `Connection error: ${error.message}`,
      isStreaming: false,
      error: true,
    });
    // NFR-3: bounded retry with backoff — but NEVER auto-retry a 401 (KR-5).
    // Attempted retries re-run sendMessage with the SAME idempotency key
    // (KR-10: replay, never duplicate). Manual retry lives in the composer.
  }

  private handleSSEClose(api: GatewayAPI, sessionId: string, runId: string): void {
    // SSE closed — run may still be active server-side (KR-11: never mark
    // failed on a bare stream close). But NFR-3 forbids an infinite spinner:
    // settle the truth with ONE status poll. If the run settled server-side,
    // apply its terminal state; if still running, leave the streaming message
    // alone (reattach on next focus will reconnect).
    void api.getRunStatus(runId).then((status) => {
      if (this.store.getActiveRun(sessionId)?.runId !== runId) return; // stale
      switch (status.status) {
        case 'completed':
        case 'cancelled':
        case 'failed':
        case 'partial': {
          this.store.updateRunStatus(sessionId, status.status);
          this.store.setActiveRun(sessionId, null);
          clearActiveRun(sessionId);
          this.settleStreamingMessage(sessionId, status.status);
          break;
        }
        // 'started'/'running' → still live server-side; next focus reattaches
      }
    }).catch(() => {
      // Poll failed (e.g. network gone): leave state as-is; NFR-3 offline
      // banner + manual retry cover this — no auto-retry loops here.
    });
  }

  /** Terminal-state helper: stop the spinner on the last streaming message. */
  private settleStreamingMessage(sessionId: string, status: RunStatus): void {
    const msgs = this.store.getMessages(sessionId);
    const last = [...msgs].reverse().find(m => m.isStreaming);
    if (last) {
      this.store.updateMessage(sessionId, last.id, {
        isStreaming: false,
        ...(status === 'failed' ? { content: 'Run failed', error: true } : {}),
        ...(status === 'partial' ? { content: `${last.content}\n\n[Partial — run was cut short]` } : {}),
      });
    }
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
  async reattachRun(gatewayId: string, sessionId: string): Promise<void> {
    const api = this.getApi(gatewayId);
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
      const status = await api.getRunStatus(activeRun.runId);

      switch (status.status) {
        case 'started':
        case 'running': {
          // Run still active — reconnect SSE stream.
          // ⚠️ Replay semantics (smoke-test #5): the events stream replays
          // from the START of the run, so a message that already holds
          // partial content would get the full transcript re-appended.
          // Reset the streaming message's content BEFORE reconnecting.
          const messages = this.store.getMessages(sessionId);
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          if (lastAssistant) {
            this.store.updateMessage(sessionId, lastAssistant.id, { content: '' });
            this.connectStream(api, sessionId, activeRun.runId, lastAssistant.id);
          }
          break;
        }

        case 'completed':
        case 'cancelled':
        case 'failed':
        case 'partial': {
          // Run finished while we were away — update state (KR-11)
          this.store.updateRunStatus(sessionId, status.status);
          this.store.setActiveRun(sessionId, null);
          clearActiveRun(sessionId); // run settled — stop tracking (KR-13)
          this.settleStreamingMessage(sessionId, status.status);
          break;
        }
      }
    } catch (err) {
      // KR-12x: 404 on a tracked run = gateway restarted = interrupted
      if (err instanceof GatewayError && err.status === 404) {
        this.store.updateRunStatus(sessionId, 'interrupted');
        this.store.setActiveRun(sessionId, null);
        clearActiveRun(sessionId); // owner map wiped server-side — stop tracking
        // Show honest notice: "the gateway restarted before this run settled"
        const messages = this.store.getMessages(sessionId);
        const last = [...messages].reverse().find(m => m.isStreaming);
        if (last) {
          this.store.updateMessage(sessionId, last.id, {
            isStreaming: false,
            error: true,
            content: 'The gateway restarted before this run settled.',
          });
        }
      }
      // Other poll errors: leave state; the offline banner + manual retry
      // cover them (NFR-3).
    }
  }

  // === Steer/Stop (KR-14) ===

  /** Steer mid-run (KR-14). */
  async steer(gatewayId: string, sessionId: string, text: string): Promise<void> {
    const activeRun = this.store.getActiveRun(sessionId);
    if (!activeRun) return;
    const api = this.getApi(gatewayId);
    await api.steerRun(activeRun.runId, text);

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

  /** Stop mid-run (KR-14). Terminal "cancelled" arrives via SSE or poll. */
  async stop(gatewayId: string, sessionId: string): Promise<void> {
    const activeRun = this.store.getActiveRun(sessionId);
    if (!activeRun) return;
    const api = this.getApi(gatewayId);
    await api.stopRun(activeRun.runId);
  }

  // === Approvals (KR-13) ===

  async respondToApproval(
    gatewayId: string,
    sessionId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const approval = this.store.getPendingApproval(sessionId);
    if (!approval) return;

    const api = this.getApi(gatewayId);
    await api.respondToApproval(approval.runId, decision);
    this.store.setApproval(sessionId, {
      ...approval,
      responded: true,
      decision,
    });
  }

  // === Relaunch recovery (KR-11 / KR-13) ===

  /**
   * Called at app start: for every persisted tracked run (MMKV 'active_runs'),
   * poll status and reattach or settle. Pending approvals for app-initiated
   * runs are re-derived by reconnecting the run event stream (events replay
   * server-side — smoke-test #5), so the approval card survives relaunch
   * pre-approval (KR-13).
   */
  async recoverPersistedRuns(): Promise<void> {
    const tracked = loadTrackedRuns();
    for (const sessionId of Object.keys(tracked)) {
      const run = tracked[sessionId];
      if (!run) continue;
      // gatewayId is not stored on the TrackedRun — resolve via active gateway.
      // Multi-gateway surfacing of cross-gateway runs lands in v1.1.
      const gatewayId = useGatewayStore.getState().activeGatewayId;
      if (!gatewayId) {
        // Don't leave orphan tracked runs spinning when nothing is active,
        // but only clear refs if we know the run belongs elsewhere.
        return;
      }
      await this.reattachRun(gatewayId, sessionId);
    }
  }

  /** KR-13: re-derive pending approval state for one session on relaunch.
   *  Reconnect events → replayed approval.requested re-renders the card. */
  async restoreApprovalState(gatewayId: string, sessionId: string): Promise<void> {
    if (loadTrackedRun(sessionId)) {
      await this.reattachRun(gatewayId, sessionId);
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
