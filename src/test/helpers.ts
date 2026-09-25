/**
 * Shared test helpers (test-strategy.md §1): fetch mock with route queue +
 * SSE stream builder, session/snapshot factories.
 */
import { createElement, type ReactElement, type ReactNode } from 'react';
import { render } from '@testing-library/react-native';
import { ThemeProvider } from '@/theme/ThemeProvider';

// Resetters defined in jest.setup.ts (globalThis-attached).
declare global {
    function __resetMMKV(): void;
  function __resetSecureStore(): void;
  function __getSQLiteDb(): {
    __spy: {
      exec: { sql: string; params: unknown[] }[];
      runs: { sql: string; params: unknown[] }[];
      prepared: { sql: string; params: unknown[] }[];
    };
  };
}

export function resetMMKV(): void {
  __resetMMKV();
}

export function resetSecureStore(): void {
  __resetSecureStore();
}

// === createFetchMock — route queue + SSE stream builder ===

export type FetchHandler =
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | { stream: string[]; status?: number; headers?: Record<string, string> }
  | { abort: true };

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  init: RequestInit;
}

export interface FetchMock {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  routes: { path: string; handler: FetchHandler; calls: number }[];
  calls: FetchCall[];
  reset(): void;
}

function sseReader(chunks: string[]): { getReader: () => { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < chunks.length
          ? { done: false, value: encoder.encode(chunks[index++]!) }
          : { done: true },
      cancel: async () => { index = chunks.length; },
    }),
  };
}

function headerBag(headers: Record<string, string> | undefined): { get(name: string): string | null } {
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) map[k.toLowerCase()] = v;
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

/**
 * Hand-built Response-like object — the jsdom/jest env here exposes `fetch`
 * and `Headers` but not `Response`, and consumers only use
 * ok/status/headers/text()/json()/body.getReader().
 */
function fakeResponse(
  handler: FetchHandler,
  fetchRoute: { path: string },
): Response {
  if ('stream' in handler) {
    return fakeStreamResponse(handler);
  }
  if ('abort' in handler) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err) as unknown as Response;
  }

  void fetchRoute;
  const status = handler.status ?? 200;
  void handler.text;
  const headers = headerBag(handler.headers ?? { 'Content-Type': 'application/json' });
  const fullText = handler.text ?? (handler.json !== undefined ? JSON.stringify(handler.json) : '');

  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => fullText,
    json: async () => {
      const trimmed = fullText.trim();
      return JSON.parse(trimmed.length ? trimmed : '{}') as unknown;
    },
    body: undefined,
  } as unknown as Response;
}

/** Streaming variant: SSE chunk sequence exposed through body.getReader(). */
function fakeStreamResponse(handler: { stream: string[]; status?: number; headers?: Record<string, string> }): Response {
  const status = handler.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerBag(handler.headers ?? { 'Content-Type': 'text/event-stream' }),
    text: async () => handler.stream.join(''),
    json: async () => {
      const fullText = handler.stream.join('');
      const trimmed = fullText.trim();
      return JSON.parse(trimmed.length ? trimmed : '{}') as unknown;
    },
    body: sseReader(handler.stream),
  } as unknown as Response;
}

/**
 * Hand-rolled fetch mock (strategy §0 mock table): routes are matched
 * first-match on URL substring; `stream` handlers produce controllable
 * SSE chunk sequences through `response.body.getReader()`.
 */
export function createFetchMock(routes: { path: string; handler: FetchHandler }[] = []): void {
  const calls: FetchCall[] = [];

  const mock = Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        url,
        method,
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === 'string' ? init.body : '',
        init: init ?? {},
      });

      for (const route of mock.routes) {
        if (url.includes(route.path)) {
          route.calls++;
          return fakeResponse(route.handler, route);
        }
      }
      throw new Error(`fetch mock: unhandled request ${method} ${url}`);
    },
  ) as FetchMock;

  mock.routes = routes.map((r) => ({ ...r, calls: 0 }));
  mock.calls = calls;
  mock.reset = () => {
    for (const r of mock.routes) r.calls = 0;
    calls.length = 0;
  };
  globalThis.fetch = mock as unknown as typeof fetch;
}

/**
 * Build a hand-rolled Response-like whose body yields controlled chunks —
 * for `consumeResponse` / session-chat-fallback tests.
 */
export function streamResponse(
  chunks: string[],
  options: { status?: number } = {},
): Response {
  return fakeStreamResponse({ stream: chunks, status: options.status ?? 200 });
}

// === renderThemeProvider (§3 component wrapper) ===

/** Render a component (or tree) wrapped in the real ThemeProvider (dark default via mocked MMKV). */
export function renderThemeProvider(ui: ReactElement): ReturnType<typeof render> {
  return render(createElement(ThemeProvider, null, ui));
}

export function withThemeProvider(children: ReactNode): ReactElement {
  return createElement(ThemeProvider, null, children);
}

export function makeSession(
  overrides: Partial<import('@/services/gateway-api').SessionResponse> = {},
): import('@/services/gateway-api').SessionResponse {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'sess_1',
    title: 'Test Session',
    model: 'claude-sonnet-4',
    source: 'api_server',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    api_call_count: 1,
    tool_call_count: 0,
    message_count: 2,
    started_at: now - 120,
    ended_at: now - 60,
    end_reason: null,
    last_active: now - 60,
    parent_session_id: null,
    pinned: false,
    archived: false,
    hidden: false,
    preview: 'hello',
    user_id: 'u1',
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<import('@/services/types').SessionSnapshot> = {},
): import('@/services/types').SessionSnapshot {
  const now = Date.now() / 1000;
  return {
    id: 'gw1:sess_1',
    gateway_id: 'gw1',
    session_id: 'sess_1',
    title: 'Test Session',
    model: 'claude-sonnet-4',
    source: 'api_server',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    enriched_cost_usd: null,
    api_call_count: 1,
    tool_call_count: 0,
    message_count: 2,
    started_at: now - 120,
    ended_at: now - 60,
    end_reason: null,
    last_active: now - 60,
    parent_session_id: null,
    archived: 0,
    pinned: 0,
    hidden: 0,
    synced_at: now,
    ...overrides,
  };
}
