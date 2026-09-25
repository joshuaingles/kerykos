import { RunsManager } from '@/services/runs-manager';
import { useChatStore } from '@/store/chat';
import { promptQueue } from '@/services/prompt-queue';
import { resetMMKV } from '@/test/helpers';
import type { GatewayAPI } from '@/services/gateway-api';
import type { SSEEvent } from '@/services/sse';

jest.mock('../services/sse', () => ({
  SSEParser: jest.fn().mockImplementation(() => ({
    connect: jest.fn(
      async (
        _url: string,
        _headers: Record<string, string>,
        onEvent: (event: SSEEvent) => void,
        onError: (e: Error) => void,
        onClose: () => void,
      ) => {
        (globalThis as unknown as { __fakeSSE: unknown }).__fakeSSE = {
          onEvent,
          onError,
          onClose,
        };
        const g = globalThis as unknown as { __autoSSEEvents?: SSEEvent[] };
        const auto = g.__autoSSEEvents;
        if (auto) {
          g.__autoSSEEvents = undefined;
          for (const e of auto) onEvent(e);
        }
        return async () => undefined;
      },
    ),
    disconnect: jest.fn(),
  })),
}));

interface FakeSSEHandlers {
  onEvent: (event: SSEEvent) => void;
  onError: (e: Error) => void;
  onClose: () => void;
}

function sse(): FakeSSEHandlers {
  return (globalThis as unknown as { __fakeSSE: FakeSSEHandlers }).__fakeSSE;
}

function setAutoEvents(events: SSEEvent[]): void {
  (globalThis as unknown as { __autoSSEEvents?: SSEEvent[] }).__autoSSEEvents = events;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

const SESSION = 'sess_1';
const GW = 'gw1';

describe('send message → run → terminal flow', () => {
  let manager: RunsManager;
  let createRun: jest.Mock;

  beforeEach(() => {
    useChatStore.setState({
      messagesBySession: new Map(),
      activeRuns: new Map(),
      approvals: new Map(),
    });
    resetMMKV();
    promptQueue.clear(SESSION);
    jest.clearAllMocks();

    createRun = jest.fn().mockResolvedValue({ run_id: 'run1', status: 'started' });

    const api = {
      gatewayId: GW,
      baseUrl: 'http://gw',
      createRun,
      getRunStatus: jest.fn().mockResolvedValue({ run_id: 'run1', status: 'running' }),
      getRunEventsUrl: (runId: string) => `http://gw/v1/runs/${runId}/events`,
      steerRun: jest.fn().mockResolvedValue({ accepted: true }),
      stopRun: jest.fn().mockResolvedValue({ status: 'stopping' }),
      respondToApproval: jest.fn().mockResolvedValue({ accepted: true }),
      getResolvedKey: jest.fn().mockResolvedValue('resolved-key'),
      sessionHeaders: jest.fn((sid?: string, skey?: string) => {
        const h: Record<string, string> = {};
        if (sid) h['X-Hermes-Session-Id'] = sid;
        if (skey) h['X-Hermes-Session-Key'] = skey;
        return h;
      }),
      captureSessionEcho: jest.fn(),
      getSessionEcho: jest.fn().mockReturnValue(null),
    } as unknown as GatewayAPI;

    manager = new RunsManager(() => api);
  });

  it('send message creates run and processes SSE events', async () => {
    setAutoEvents([
      { type: 'message.delta', delta: 'Hello' },
      { type: 'message.delta', delta: ', world' },
      { type: 'run.completed' },
    ]);

    await manager.sendMessage(GW, SESSION, 'hello');
    await flush();

    expect(createRun).toHaveBeenCalledWith(
      { input: 'hello', session_id: SESSION },
      expect.any(String),
      { 'X-Hermes-Session-Id': SESSION },
    );

    const msgs = useChatStore.getState().getMessages(SESSION);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hello', isStreaming: false });

    const assistant = msgs.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('Hello, world');
    expect(assistant.isStreaming).toBe(false);
    expect(useChatStore.getState().getActiveRun(SESSION)).toBeUndefined();
  });

  it('queued prompt auto-submits after run completes', async () => {
    await manager.sendMessage(GW, SESSION, 'hello');
    await flush();

    promptQueue.enqueue(SESSION, 'the follow-up');
    expect(promptQueue.count(SESSION)).toBe(1);

    const spy = jest.spyOn(manager, 'sendMessage').mockResolvedValue(undefined);
    try {
      sse().onEvent({ type: 'run.completed' });
      await flush();

      expect(spy).toHaveBeenCalledWith(GW, SESSION, 'the follow-up');
      expect(promptQueue.count(SESSION)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('retry uses same idempotency key', async () => {
    jest.useFakeTimers();
    try {
      const keys: string[] = [];
      createRun.mockImplementation((_req: unknown, idemKey: string) => {
        keys.push(idemKey);
        if (keys.length < 2) return Promise.reject(new Error('flaky net'));
        return Promise.resolve({ run_id: 'run1', status: 'started' });
      });

      const p = manager.sendMessage(GW, SESSION, 'hello').catch(() => undefined);
      await jest.advanceTimersByTimeAsync(2_000);
      await p;

      expect(keys.length).toBe(2);
      expect(new Set(keys).size).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
