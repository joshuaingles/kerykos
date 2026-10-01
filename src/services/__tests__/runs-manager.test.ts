import { RunsManager } from '../runs-manager';
import { GatewayAPI, GatewayError } from '../gateway-api';
import {
  useChatStore,
  loadTrackedRun,
  persistActiveRun,
} from '@/store/chat';
import { useGatewayStore } from '@/store/gateway';
import { promptQueue } from '../prompt-queue';
import { createFetchMock, resetMMKV, resetSecureStore } from '@/test/helpers';


/**
 * Fake SSE — RunsManager constructs its own SSEParser; intercept the module
 * so tests can capture connect() handlers and trigger them manually.
 */
jest.mock('../sse', () => {
  return {
    SSEParser: jest.fn().mockImplementation(() => ({
      connect: jest.fn(async (_url: string, _headers: Record<string, string>, onEvent: unknown, onError: unknown, onClose: unknown) => {
        (globalThis as unknown as { __fakeSSE: unknown }).__fakeSSE = {
          url: _url,
          headers: _headers,
          onEvent,
          onError,
          onClose,
        };
        return async () => undefined;
      }),
      disconnect: jest.fn(),
    })),
  };
});

interface FakeSSEHandlers {
  url: string;
  headers: Record<string, string>;
  onEvent: (event: { type: string; [k: string]: unknown }) => void;
  onError: (e: Error) => void;
  onClose: () => void;
}

function sse(): FakeSSEHandlers {
  return (globalThis as unknown as { __fakeSSE: FakeSSEHandlers }).__fakeSSE;
}

/** Let all pending promise chains (connectStream, close-poll) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

interface ApiMock {
  createRun: jest.Mock;
  getRunStatus: jest.Mock;
  steerRun: jest.Mock;
  stopRun: jest.Mock;
  respondToApproval: jest.Mock;
  getSessionEcho: jest.Mock;
}

function resetStores(): void {
  useChatStore.setState({
    messagesBySession: new Map(),
    activeRuns: new Map(),
    approvals: new Map(),
  });
  useGatewayStore.setState({
    gateways: [],
    activeGatewayId: 'gw1',
  });
  resetMMKV();
  resetSecureStore();
  createFetchMock([]);
  promptQueue.clear('sess_1');
}

const SESSION = 'sess_1';
const GW = 'gw1';

describe('RunsManager (§4.4 — the orchestrator)', () => {
  let calls: ApiMock;
  let manager: RunsManager;

  beforeEach(() => {
    resetStores();
    jest.clearAllMocks();

    calls = {
      createRun: jest.fn().mockResolvedValue({ run_id: 'r1', status: 'started' }),
      getRunStatus: jest.fn().mockResolvedValue({ run_id: 'r1', status: 'running' }),
      steerRun: jest.fn().mockResolvedValue({ accepted: true }),
      stopRun: jest.fn().mockResolvedValue({ status: 'stopping' }),
      respondToApproval: jest.fn().mockResolvedValue({ accepted: true }),
      getSessionEcho: jest.fn().mockReturnValue(null),
    };

    const api = {
      baseUrl: 'http://gw',
      gatewayId: GW,
      createRun: calls.createRun,
      getRunStatus: calls.getRunStatus,
      getRunEventsUrl: (r: string) => `http://gw/v1/runs/${r}/events`,
      steerRun: calls.steerRun,
      stopRun: calls.stopRun,
      respondToApproval: calls.respondToApproval,
      getResolvedKey: jest.fn().mockResolvedValue('resolved-key'),
      getSessionEcho: calls.getSessionEcho,
      sessionHeaders: (sid?: string, skey?: string) => {
        const h: Record<string, string> = {};
        if (sid) h['X-Hermes-Session-Id'] = sid;
        if (skey) h['X-Hermes-Session-Key'] = skey;
        return h;
      },
    } as unknown as GatewayAPI;

    manager = new RunsManager(() => api);
  });

  describe('sendMessage happy path', () => {
    it('SK-01: optimistic messages appear — user msg + empty streaming assistant msg', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      const msgs = useChatStore.getState().getMessages(SESSION);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello', isStreaming: false });
      expect(msgs[1]).toMatchObject({ role: 'assistant', content: '', isStreaming: true });
    });

    it('SK-02: createRun called with input/session_id + session headers via echo vs without', async () => {
      // No echo stored → sessionId-only headers
      await manager.sendMessage(GW, SESSION, 'hello');
      expect(calls.createRun).toHaveBeenCalledWith(
        { input: 'hello', session_id: SESSION },
        expect.any(String),
        { 'X-Hermes-Session-Id': SESSION },
      );

      // With a stored echo pair → full continuity headers
      calls.getSessionEcho.mockReturnValue({ sessionId: 'sess_server', sessionKey: 'sk-long' });
      await manager.sendMessage(GW, SESSION, 'again');
      expect(calls.createRun).toHaveBeenLastCalledWith(
        { input: 'again', session_id: SESSION },
        expect.any(String),
        { 'X-Hermes-Session-Id': 'sess_server', 'X-Hermes-Session-Key': 'sk-long' },
      );
    });

    it('SK-03: activeRun set + persistActiveRun written to MMKV (relaunch bridge)', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      const run = useChatStore.getState().getActiveRun(SESSION);
      expect(run).toMatchObject({ runId: 'r1', sessionId: SESSION, status: 'started' });
      expect(loadTrackedRun(SESSION)).toEqual({
        runId: 'r1',
        sessionId: SESSION,
        idempotencyKey: run!.idempotencyKey,
        startedAt: expect.any(Number),
      });
    });

    it('SK-04: connectStream passes Authorization: Bearer resolved key', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      expect(sse().headers['Authorization']).toBe('Bearer resolved-key');
      expect(sse().url).toBe('http://gw/v1/runs/r1/events');
    });

    it('SK-05: send failure (non-401) → error message rendered, activeRun cleared, rethrown', async () => {
      calls.createRun.mockRejectedValue(new Error('network gone'));
      jest.useFakeTimers();
      try {
        const p = expect(manager.sendMessage(GW, SESSION, 'msg')).rejects.toThrow('network gone');
        // burn through the 4 scheduled backoffs (1+2+4+8 capped at 15s each)
        for (let i = 0; i < 6; i++) await jest.advanceTimersByTimeAsync(16_000);
        await p;
      } finally {
        jest.useRealTimers();
      }
      const msgs = useChatStore.getState().getMessages(SESSION);
      const assistant = msgs.find(m => m.role === 'assistant')!;
      expect(assistant.content).toBe('Error: network gone');
      expect(assistant.error).toBe(true);
      expect(assistant.isStreaming).toBe(false);
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
    });

    it('KR-5 SK-06: 401 → "Authentication failed…" copy, createRun called exactly ONCE (no error-retry)', async () => {
      calls.createRun.mockRejectedValue(new GatewayError(401, 'bad key'));
      await expect(manager.sendMessage(GW, SESSION, 'msg')).rejects.toBeDefined();

      const msgs = useChatStore.getState().getMessages(SESSION);
      const assistant = msgs.find(m => m.role === 'assistant')!;
      expect(assistant.content).toBe('Authentication failed — check the API key in Settings.');
      expect(assistant.error).toBe(true);
      expect(calls.createRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryWithBackoff (NFR-3 / KR-10)', () => {
    it('retries use the SAME idempotency key across all attempts (replay, never duplicate)', async () => {
      jest.useFakeTimers();
      try {
        let attempts = 0;
        const result = manager.retryWithBackoff(async () => {
          attempts++;
          if (attempts < 3) throw new Error('flaky net');
          return 'done' as const;
        });
        const resolved = jest.fn();
        void result.then(resolved);
        for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
        expect(attempts).toBe(3);
        expect(resolved).toHaveBeenCalledWith('done');
      } finally {
        jest.useRealTimers();
      }
      // idempotency replay is asserted in the RunsManager-level test below
    });

    it('NFR-3/KR-10 (RunsManager): failed send eventually completes with ONE idempotency key', async () => {
      // createRun fails twice then succeeds; every attempt must carry the
      // SAME idempotency key (replay, never duplicate a run).
      jest.useFakeTimers();
      try {
        const keys: string[] = [];
        calls.createRun.mockImplementation((_req: unknown, idemKey: string) => {
          keys.push(idemKey);
          if (keys.length < 3) throw new Error('still down');
          return Promise.resolve({ run_id: 'r1', status: 'started' });
        });
        const p = manager.sendMessage(GW, SESSION, 'hello').catch(() => 'send failed');
        for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(16_000);
        await p;
        expect(keys.length).toBe(3);
        expect(new Set(keys).size).toBe(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('retryWithBackoff max 5 attempts with 1s/2s/4s/8s backoff (fake timers)', async () => {
      jest.useFakeTimers();
      try {
        let attempts = 0;
        const p = manager.retryWithBackoff(async () => {
          attempts++;
          throw new Error('down');
        }).catch((e: unknown) => (e as Error).message);

        await jest.advanceTimersByTimeAsync(0); // attempt 1
        expect(attempts).toBe(1);
        await jest.advanceTimersByTimeAsync(999); // still within first backoff
        expect(attempts).toBe(1);
        await jest.advanceTimersByTimeAsync(1); // +1s total → attempt 2
        expect(attempts).toBe(2);
        await jest.advanceTimersByTimeAsync(2_000); // attempt 3
        expect(attempts).toBe(3);
        await jest.advanceTimersByTimeAsync(4_000); // attempt 4
        expect(attempts).toBe(4);
        await jest.advanceTimersByTimeAsync(8_000); // attempt 5, max
        expect(attempts).toBe(5);
        expect(await p).toBe('down');
      } finally {
        jest.useRealTimers();
      }
    });

    it('retryWithBackoff backoff capped at 15s', async () => {
      jest.useFakeTimers();
      try {
        let attempts = 0;
        const p = manager.retryWithBackoff(async () => {
          attempts++;
          throw new Error('down');
        }, { maxAttempts: 8 }).catch(() => 'exhausted');

        // raw delays would be 1,2,4,8,16,32,64 — capped to 1,2,4,8,15,15,15.
        // Advancing 16s fires the first four backoffs (attempts 2..5).
        await jest.advanceTimersByTimeAsync(16_000);
        expect(attempts).toBe(5);
        // Advancing only 15s from here must fire the CAPPED timer (15s),
        // which proves no delay exceeds 15s: uncapped it would need 16s.
        await jest.advanceTimersByTimeAsync(15_000);
        expect(attempts).toBe(6);
        await jest.advanceTimersByTimeAsync(15_000);
        expect(attempts).toBe(7);
        await jest.advanceTimersByTimeAsync(15_000);
        expect(attempts).toBe(8); // max reached
        expect(await p).toBe('exhausted');
      } finally {
        jest.useRealTimers();
      }
    });

    it('KR-5: 401 rethrows immediately — attempt count 1 (default isAuthError)', async () => {
      let attempts = 0;
      await expect(
        manager.retryWithBackoff(async () => {
          attempts++;
          throw new GatewayError(401, 'nope');
        }),
      ).rejects.toThrow(GatewayError);
      expect(attempts).toBe(1);
    });

    it('KR-5: custom isAuthError also short-circuits', async () => {
      let attempts = 0;
      await expect(
        manager.retryWithBackoff(
          async () => {
            attempts++;
            throw new Error('special-auth');
          },
          { maxAttempts: 3, isAuthError: (e) => (e as Error).message.includes('special-auth') },
        ),
      ).rejects.toThrow('special-auth');
      expect(attempts).toBe(1);
    });
  });

  describe('SSE event handling', () => {
    beforeEach(async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
    });

    function assistantMessage() {
      return useChatStore.getState().getMessages(SESSION).find(m => m.role === 'assistant')!;
    }

    it('message.delta → appendToMessage accumulation (two deltas concatenated)', () => {
      sse().onEvent({ type: 'message.delta', delta: 'A' });
      sse().onEvent({ type: 'message.delta', delta: 'B' });
      expect(assistantMessage().content).toBe('AB');
    });

    it('tool.progress running → addToolCall with collapsed:true (KR-15)', () => {
      sse().onEvent({ type: 'tool.progress', tool_id: 't1', name: 'bash', state: 'running' });
      const tools = assistantMessage().toolCalls;
      expect(tools).toHaveLength(1);
      expect(tools![0]).toEqual({ id: 't1', name: 'bash', state: 'running', collapsed: true });
    });

    it('tool.progress completed/failed → updateToolCall (no duplicate add)', () => {
      sse().onEvent({ type: 'tool.progress', tool_id: 't1', name: 'bash', state: 'running' });
      sse().onEvent({ type: 'tool.progress', tool_id: 't1', state: 'completed' });
      const tools = assistantMessage().toolCalls!;
      expect(tools).toHaveLength(1); // no duplicate
      expect(tools[0]).toMatchObject({ id: 't1', state: 'completed' });
    });

    it('unknown tool state → defaults to running', () => {
      sse().onEvent({ type: 'tool.progress', tool_id: 't2', name: 'read' });
      expect(assistantMessage().toolCalls![0]).toMatchObject({ state: 'running', collapsed: true });
    });

    it('run.completed → usage stored (KR-18), isStreaming:false, status completed, MMKV cleared', () => {
      sse().onEvent({ type: 'run.completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
      const m = assistantMessage();
      expect(m.isStreaming).toBe(false);
      expect(m.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('run.completed WITHOUT usage → message finalized, no usage change', () => {
      sse().onEvent({ type: 'run.completed' });
      const m = assistantMessage();
      expect(m.isStreaming).toBe(false);
      expect(m.usage).toBeUndefined();
    });

    it('KR-14: run.completed with steered_text → system "Steer not delivered" note appended', () => {
      sse().onEvent({ type: 'run.completed', steered_text: 'do it again' });
      const msgs = useChatStore.getState().getMessages(SESSION);
      const note = msgs.find(m => m.role === 'system');
      expect(note?.content).toContain('Steer not delivered');
      expect(note?.content).toContain('do it again');
    });

    it('KR-16: queued prompt auto-submits AFTER completion', async () => {
      promptQueue.enqueue(SESSION, 'the follow-up');
      expect(promptQueue.count(SESSION)).toBe(1);

      const spy = jest.spyOn(manager, 'sendMessage').mockResolvedValue(undefined);
      sse().onEvent({ type: 'run.completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      await flush();
      expect(spy).toHaveBeenCalledWith(GW, SESSION, 'the follow-up');
      spy.mockRestore();
    });

    it('KR-16: auto-send fails → requeued (nothing silently lost)', async () => {
      promptQueue.enqueue(SESSION, 'retry me');
      const spy = jest.spyOn(manager, 'sendMessage').mockRejectedValue(new Error('offline'));
      try {
        sse().onEvent({ type: 'run.completed' });
        await flush();
        expect(promptQueue.hasQueued(SESSION)).toBe(true);
        expect(promptQueue.count(SESSION)).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('run.cancelled → cancelled state + settled message + MMKV cleared', () => {
      sse().onEvent({ type: 'run.cancelled' });
      const m = assistantMessage();
      expect(m.isStreaming).toBe(false);
      expect(m.error).toBeUndefined();
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('run.failed with existing content → content preserved, error flagged', () => {
      sse().onEvent({ type: 'message.delta', delta: 'so far so' });
      sse().onEvent({ type: 'run.failed', error: 'server blew up' });
      const m = assistantMessage();
      expect(m.content).toBe('so far so'); // preserved
      expect(m.error).toBe(true);
      expect(m.isStreaming).toBe(false);
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('run.failed with NO content → "Run failed: …" fallback copy', () => {
      sse().onEvent({ type: 'run.failed', error: 'billing error' });
      const m = assistantMessage();
      expect(m.content).toBe('Run failed: billing error');
      expect(m.error).toBe(true);
    });

    it('run.partial → message left non-streaming; suffix lands via close-poll settle', () => {
      sse().onEvent({ type: 'message.delta', delta: 'cut' });
      sse().onEvent({ type: 'run.partial' });
      const m = assistantMessage();
      expect(m.isStreaming).toBe(false);
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('approval.requested → pending approval set (KR-13 card data)', () => {
      sse().onEvent({ type: 'approval.requested', message: 'Run rm -rf?' });
      const approval = useChatStore.getState().getPendingApproval(SESSION);
      expect(approval).toEqual({ runId: 'r1', message: 'Run rm -rf?', responded: false });
    });

    it('KR-14: run.steered UPDATES the optimistic "Steer sent" entry — ONE entry, never duplicate', async () => {
      await manager.steer(GW, SESSION, 'focus on python');
      const steerMsg = useChatStore.getState().getMessages(SESSION).find(m => m.content.startsWith('Steer sent'));
      expect(steerMsg?.content).toBe('Steer sent: "focus on python"');

      sse().onEvent({ type: 'run.steered', text: 'focus on python' });
      const msgs = useChatStore.getState().getMessages(SESSION);
      expect(msgs.filter(m => m.content.includes('Steer '))).toHaveLength(1); // single transcript entry
      expect(msgs.find(m => m.content.startsWith('Steer'))!.content).toBe('Steer applied: "focus on python"');
      // updated in place: same id
      const updated = msgs.find(m => m.content.startsWith('Steer'))!;
      expect(updated.id).toBe(steerMsg!.id);
      expect(updated.isSteered).toBe(true);
    });

    it('run.steered without prior steer → no crash, nothing added', () => {
      const before = useChatStore.getState().getMessages(SESSION).length;
      sse().onEvent({ type: 'run.steered', text: 'whatever' });
      expect(useChatStore.getState().getMessages(SESSION).length).toBe(before);
    });

    it('reasoning.available → ignored (no crash, no state change)', () => {
      const before = useChatStore.getState().getMessages(SESSION);
      sse().onEvent({ type: 'reasoning.available', tokens: 5 });
      expect(useChatStore.getState().getMessages(SESSION)).toEqual(before);
    });
  });

  describe('SSE error / close', () => {
    beforeEach(async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
    });

    function assistantId(): string {
      const msgs = useChatStore.getState().getMessages(SESSION);
      return msgs.find(m => m.isStreaming)!.id;
    }

    it('onError → "Connection error: …" on the streaming message', () => {
      const id = assistantId();
      sse().onError(new Error('socket died'));
      const m = useChatStore.getState().getMessages(SESSION).find(m2 => m2.id === id);
      expect(m!.content).toBe('Connection error: socket died');
      expect(m!.error).toBe(true);
      expect(m!.isStreaming).toBe(false);
    });

    it('KR-11 onClose: status GET terminal "completed" → settled + MMKV cleared', async () => {
      const id = assistantId();
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'completed' });
      sse().onClose();
      await flush();
      const m = useChatStore.getState().getMessages(SESSION).find(m2 => m2.id === id);
      expect(m!.isStreaming).toBe(false);
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('KR-11 onClose: status "failed" → settles with "Run failed" content', async () => {
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'failed' });
      sse().onClose();
      await flush();
      const m = useChatStore.getState().getMessages(SESSION)
        .find(m2 => m2.role === 'assistant');
      expect(m!.content).toBe('Run failed');
      expect(m!.error).toBe(true);
    });

    it('KR-11 onClose: status "partial" → settles with "[Partial — run was cut short]" suffix', async () => {
      sse().onEvent({ type: 'message.delta', delta: 'chunk one' });
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'partial' });
      sse().onClose();
      await flush();
      const msgs = useChatStore.getState().getMessages(SESSION);
      const last = msgs[msgs.length - 1]!;
      expect(last.content).toBe('chunk one\n\n[Partial — run was cut short]');
      expect(last.isStreaming).toBe(false);
    });

    it('KR-11 onClose: status "cancelled" → settles + clears', async () => {
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'cancelled' });
      sse().onClose();
      await flush();
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('KR-11 onClose: status still running → message left streaming (reattach later)', async () => {
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'running' });
      sse().onClose();
      await flush();
      const m = useChatStore.getState().getMessages(SESSION).find(m2 => m2.id === assistantId());
      expect(m!.isStreaming).toBe(true); // NOT settled
      expect(loadTrackedRun(SESSION)).not.toBeNull(); // still tracked
    });

    it('onClose: status poll throws → state unchanged (no auto-retry loops)', async () => {
      const id = assistantId();
      calls.getRunStatus.mockRejectedValue(new Error('poll failed'));
      sse().onClose();
      await flush();
      const m = useChatStore.getState().getMessages(SESSION).find(m2 => m2.id === id);
      expect(m!.isStreaming).toBe(true);
    });

    it('onClose: stale run (different activeRun) → no action', async () => {
      // install a different active run in the store, then close
      useChatStore.getState().setActiveRun(SESSION, {
        runId: 'some-other-run',
        sessionId: SESSION,
        status: 'running',
        idempotencyKey: 'other-key',
        startedAt: 1,
      });
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'completed' });
      sse().onClose();
      await flush();
      expect(useChatStore.getState().getActiveRun(SESSION)!.runId).toBe('some-other-run');
      const m = useChatStore.getState().getMessages(SESSION).find(m2 => m2.isStreaming);
      expect(m).toBeDefined(); // untouched
    });
  });

  describe('detach / reattach (KR-11)', () => {
    it('in-memory activeRun + status running → reconnect SSE with content reset first', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      (globalThis as unknown as { __fakeSSE: FakeSSEHandlers }).__fakeSSE = undefined as unknown as FakeSSEHandlers;

      // simulate partial content already present (stream was interrupted)
      const stream = useChatStore.getState().getMessages(SESSION).find(m => m.isStreaming)!;
      useChatStore.getState().updateMessage(SESSION, stream.id, { content: 'partial output' });

      await manager.reattachRun(GW, SESSION);
      await flush();

      const updated = useChatStore.getState().getMessages(SESSION).find(m => m.isStreaming)!;
      expect(updated.content).toBe(''); // smoke#5 replay reset BEFORE re-append
      const handlers = (globalThis as unknown as { __fakeSSE: FakeSSEHandlers | undefined }).__fakeSSE;
      expect(handlers?.url).toBe('http://gw/v1/runs/r1/events');
    });

    it('relaunch path: no memory run → loadTrackedRun hydrates store FIRST, then reconnect', async () => {
      persistActiveRun(SESSION, { runId: 'r1', sessionId: SESSION, idempotencyKey: 'k', startedAt: 123 });
      // one hydrated assistant placeholder (as the transcript hydrator would seed)
      useChatStore.getState().addMessage(SESSION, {
        id: 'assistant-hydrated',
        role: 'assistant',
        content: '',
        timestamp: 1,
        isStreaming: true,
      });

      await manager.reattachRun(GW, SESSION);
      await flush();

      // hydrated into the store before polling
      expect(useChatStore.getState().getActiveRun(SESSION)).toMatchObject({ runId: 'r1', status: 'running' });
      expect(calls.getRunStatus).toHaveBeenCalledWith('r1');
      expect((globalThis as unknown as { __fakeSSE: FakeSSEHandlers | undefined }).__fakeSSE?.url)
        .toBe('http://gw/v1/runs/r1/events');
    });

    it('status completed-while-away → settled + cleared (memory and MMKV)', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'completed' });
      await manager.reattachRun(GW, SESSION);

      const msgs = useChatStore.getState().getMessages(SESSION);
      expect(msgs.find(m => m.role === 'assistant')!.isStreaming).toBe(false);
      expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('KR-12x: status 404 → "interrupted" + honest gateway-restart notice + clearing', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      calls.getRunStatus.mockRejectedValue(new GatewayError(404, 'gone'));

      await manager.reattachRun(GW, SESSION);

      const msgs = useChatStore.getState().getMessages(SESSION);
      const m = msgs.find(m2 => m2.role === 'assistant')!;
      expect(m.content).toBe('The gateway restarted before this run settled.');
      expect(m.error).toBe(true);
      expect(m.isStreaming).toBe(false);
      expect(loadTrackedRun(SESSION)).toBeNull();
    });

    it('no active run and no tracked run → no-op (no poll, no crash)', async () => {
      await manager.reattachRun(GW, SESSION);
      expect(calls.getRunStatus).not.toHaveBeenCalled();
    });
  });

  describe('steer/stop/approvals/recovery', () => {
    it('steer without active run → no-op', async () => {
      await manager.steer(GW, SESSION, 'x');
      expect(calls.steerRun).not.toHaveBeenCalled();
    });

    it('steer → steerRun called; ONE optimistic "Steer sent" message added with id recorded', async () => {
      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      await manager.steer(GW, SESSION, 'shorter please');

      expect(calls.steerRun).toHaveBeenCalledWith('r1', 'shorter please');
      const msgs = useChatStore.getState().getMessages(SESSION);
      expect(msgs.filter(m => m.content.startsWith('Steer sent'))).toHaveLength(1);
      expect(msgs.find(m => m.content.startsWith('Steer sent'))!.content).toBe('Steer sent: "shorter please"');
    });

    it('stop without active run → no-op; stop → stopRun called with the active run id', async () => {
      await manager.stop(GW, SESSION);
      expect(calls.stopRun).not.toHaveBeenCalled();

      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      await manager.stop(GW, SESSION);
      expect(calls.stopRun).toHaveBeenCalledWith('r1');
    });

    it('respondToApproval: no pending → no-op; approve → api call + state updated', async () => {
      await manager.respondToApproval(GW, SESSION, 'approve');
      expect(calls.respondToApproval).not.toHaveBeenCalled();

      await manager.sendMessage(GW, SESSION, 'hello');
      await flush();
      useChatStore.getState().setApproval(SESSION, {
        runId: 'r1',
        message: 'delete file?',
        responded: false,
      });

      await manager.respondToApproval(GW, SESSION, 'deny');
      expect(calls.respondToApproval).toHaveBeenCalledWith('r1', 'deny');
      const approval = useChatStore.getState().getPendingApproval(SESSION);
      expect(approval).toMatchObject({ responded: true, decision: 'deny' });
    });

    it('recoverPersistedRuns: iterates MMKV map and reattaches each tracked session', async () => {
      persistActiveRun(SESSION, { runId: 'r1', sessionId: SESSION, idempotencyKey: 'k1', startedAt: 1 });
      calls.getRunStatus.mockResolvedValue({ run_id: 'r1', status: 'running' });

      await manager.recoverPersistedRuns();

      expect(calls.getRunStatus).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().getActiveRun(SESSION)).toMatchObject({ runId: 'r1' });
    });

    it('recoverPersistedRuns: no active gateway → no-op WITHOUT clearing tracked runs', async () => {
      useGatewayStore.setState({ gateways: [], activeGatewayId: null });
      persistActiveRun(SESSION, { runId: 'r1', sessionId: SESSION, idempotencyKey: 'k1', startedAt: 1 });

      await manager.recoverPersistedRuns();

      expect(calls.getRunStatus).not.toHaveBeenCalled();
      expect(loadTrackedRun(SESSION)).not.toBeNull(); // NOT cleared
    });
  });
});
