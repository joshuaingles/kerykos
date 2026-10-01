import { SSEParser, type SSEEvent } from '../sse';
import { createFetchMock, streamResponse, type FetchCall } from '@/test/helpers';

/** Poll until `cond` is truthy (real timers — SSE reads are async). */
async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Response with a fake reader that yields `chunks`, then requires an
 * explicit trigger (resolve/close/fail) to continue — lets a test inject
 * a late read error after disconnect or after close.
 */
function controlledStream(): {
  response: Response;
  push: (chunk: string) => void;
  end: () => void;
  fail: (msg?: string) => void;
} {
  const encoder = new TextEncoder();
  const queue: { res: (v: { done: boolean; value?: Uint8Array }) => void; rej: (e: Error) => void }[] = [];
  const chunkQueue: string[] = [];
  const body = {
    getReader: () => ({
      read: () => new Promise<{ done: boolean; value?: Uint8Array }>((res, rej) => {
        if (chunkQueue.length > 0) {
          res({ done: false, value: encoder.encode(chunkQueue.shift()!) });
          return;
        }
        queue.push({ res, rej });
      }),
      cancel: async () => undefined,
    }),
  };
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}) as unknown,
    body,
  } as unknown as Response;
  return {
    response,
    push: (chunk) => {
      const head = queue.shift();
      if (head) head.res({ done: false, value: encoder.encode(chunk) });
      else chunkQueue.push(chunk);
    },
    end: () => {
      const head = queue.shift();
      if (head) head.res({ done: true });
    },
    fail: (msg = 'boom') => {
      const head = queue.shift();
      if (head) head.rej(new Error(msg));
    },
  };
}

function collect() {
  const events: SSEEvent[] = [];
  const errors: Error[] = [];
  let closeCount = 0;
  return {
    onEvent: (e: SSEEvent) => events.push(e),
    onError: (e: Error) => errors.push(e),
    onClose: () => { closeCount++; },
    events,
    errors,
    closeCount: () => closeCount,
  };
}

describe('SSEParser (§4.3 P0 — KR-18 keepalive skip + chunk-boundary handling)', () => {
  describe('consumeResponse — line parsing', () => {
    it('parses data: lines into JSON events (multi-event chunk)', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse([
        'data: {"type":"message.delta","delta":"Hel"}\ndata: {"type":"message.delta","delta":"lo"}\n',
      ]);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.events.length >= 2);
      expect(t.events).toEqual([
        { type: 'message.delta', delta: 'Hel' },
        { type: 'message.delta', delta: 'lo' },
      ]);
      expect(t.errors).toHaveLength(0);
    });

    it('KR-18: `:` comment lines skipped (keepalive every 10s) — no error, no event', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse([': keepalive\n: another\ndata: {"type":"run.started"}\n']);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect(t.events).toEqual([{ type: 'run.started' }]);
      expect(t.errors).toHaveLength(0);
      expect(t.closeCount()).toBe(1);
    });

    it('empty lines skipped', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse(['\n\n\ndata: {"type":"a"}\n\n\n']);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect(t.events).toEqual([{ type: 'a' }]);
      expect(t.errors).toHaveLength(0);
      expect(t.closeCount()).toBe(1);
    });

    it('partial line split across chunks → buffered until newline', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse([
        'data: {"type":"par',
        'tial","delta":"x"}\ndata: {"type":"after"}\n',
      ]);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.events.length >= 2);
      expect(t.events).toEqual([
        { type: 'partial', delta: 'x' },
        { type: 'after' },
      ]);
      expect(t.errors).toHaveLength(0);
    });

    it('non-JSON data line → silently skipped (JSON.parse try/catch)', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse(['data: not-json{{{\ndata: {"type":"good"}\n']);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect(t.events).toEqual([{ type: 'good' }]);
      expect(t.errors).toHaveLength(0);
      expect(t.closeCount()).toBe(1);
    });

    it('lines without data: prefix skipped', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse(['event: message\ncustom: whatever\ndata: {"type":"x"}\n']);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect(t.events).toEqual([{ type: 'x' }]);
      expect(t.errors).toHaveLength(0);
    });
  });

  describe('closing / errors', () => {
    it('stream done → onClose exactly once', async () => {
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse(['data: {"type":"run.completed"}\n']);
      const disconnect = parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      expect(typeof disconnect).toBe('function');
      await waitUntil(() => t.closeCount() >= 1);
      await new Promise((r) => setTimeout(r, 25)); // grace — no double close
      expect(t.closeCount()).toBe(1);
      expect(t.errors).toHaveLength(0);
    });

    it('read error (non-abort) → onError exactly once, settled flag prevents double-close', async () => {
      const parser = new SSEParser();
      const t = collect();
      const stream = controlledStream();
      stream.push('data: {"type":"message.delta","delta":"p"}\n');
      parser.consumeResponse(stream.response, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.events.length >= 1);

      stream.fail('stream blew up');
      await waitUntil(() => t.errors.length >= 1);
      await new Promise((r) => setTimeout(r, 25)); // grace — no double firing
      expect(t.errors).toHaveLength(1);
      expect(t.errors[0]!.message).toBe('stream blew up');
      expect(t.closeCount()).toBe(0);
    });

    it('disconnect() cancels reader, no onError after (AbortError + disconnected guards)', async () => {
      const parser = new SSEParser();
      const t = collect();
      const stream = controlledStream();
      stream.push('data: {"type":"a"}\n');
      const disconnect = parser.consumeResponse(stream.response, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.events.length >= 1);

      // Client disconnects BEFORE the stream errored or ended normally.
      disconnect();
      // A late stream failure must NOT fire onError (disconnected guard),
      // and the read-loop error path with AbortError must not either.
      stream.fail('late failure');
      await new Promise((r) => setTimeout(r, 25));
      expect(t.errors).toHaveLength(0);
      expect(t.closeCount()).toBe(0);
    });

    it('consumeResponse with no body → onError("No response body")', () => {
      const parser = new SSEParser();
      const t = collect();
      const res = { body: undefined } as unknown as Response;
      const disconnect = parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      expect(t.errors).toHaveLength(1);
      expect(t.errors[0]!.message).toBe('No response body');
      expect(typeof disconnect).toBe('function');
      expect(t.closeCount()).toBe(0);
    });

    it('consumeResponse never re-fetches a URL (fallback POST contract)', async () => {
      createFetchMock([]); // any fetch would be recorded
      const parser = new SSEParser();
      const t = collect();
      const res = streamResponse(['data: {"type":"message.delta","delta":"ok"}\n']);
      parser.consumeResponse(res, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect((globalThis.fetch as unknown as { calls: FetchCall[] }).calls).toHaveLength(0);
    });
  });

  describe('connect()', () => {
    it('connect() on !ok response → onError("SSE connection failed: NNN")', async () => {
      createFetchMock([
        { path: '/v1/runs/123/events', handler: { status: 404, text: 'not found' } },
      ]);
      const parser = new SSEParser();
      const t = collect();
      const disconnect = await parser.connect(
        'http://gw/v1/runs/123/events',
        { Authorization: 'Bearer k' },
        t.onEvent,
        t.onError,
        t.onClose,
      );
      expect(typeof disconnect).toBe('function');
      expect(t.errors).toHaveLength(1);
      expect(t.errors[0]!.message).toBe('SSE connection failed: 404');
      expect(t.closeCount()).toBe(0);
    });

    it('connect() sends Accept: text/event-stream and passes headers', async () => {
      createFetchMock([{ path: '/events', handler: { stream: [] } }]);
      const parser = new SSEParser();
      const t = collect();
      const disconnect = await parser.connect(
        'http://gw/v1/runs/1/events',
        { Authorization: 'Bearer key' },
        t.onEvent,
        t.onError,
        t.onClose,
      );
      const calls = (globalThis.fetch as unknown as { calls: FetchCall[] }).calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('http://gw/v1/runs/1/events');
      expect(calls[0]!.headers['Accept']).toBe('text/event-stream');
      expect(calls[0]!.headers['Authorization']).toBe('Bearer key');
      disconnect();
    });

    it('connect() streams events end-to-end through the real response body', async () => {
      createFetchMock([
        {
          path: '/events',
          handler: {
            stream: [
              ': keepalive\n',
              'data: {"type":"message.delta","delta":"A"}\n\n',
              'data: {"type":"run.completed"}\n',
            ],
          },
        },
      ]);
      const parser = new SSEParser();
      const t = collect();
      const disconnect = await parser.connect('http://gw/x/events', {}, t.onEvent, t.onError, t.onClose);
      await waitUntil(() => t.closeCount() >= 1);
      expect(t.events).toEqual([
        { type: 'message.delta', delta: 'A' },
        { type: 'run.completed' },
      ]);
      disconnect();
    });

    it('connect() fetch throws AbortError → swallowed, noop disconnect', async () => {
      const fetchMock = jest.fn().mockImplementation(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const parser = new SSEParser();
      const t = collect();
      const disconnect = await parser.connect(
        'http://gw/v1/runs/2/events',
        {},
        t.onEvent,
        t.onError,
        t.onClose,
      );
      expect(t.errors).toHaveLength(0);
      expect(t.closeCount()).toBe(0);
      expect(typeof disconnect).toBe('function');
      expect(disconnect()).toBeUndefined();
    });
  });
});
