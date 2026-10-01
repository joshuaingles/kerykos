import { GatewayAPI, GatewayError } from '../gateway-api';
import { AuthService } from '../auth';
import { createFetchMock, resetMMKV, resetSecureStore, type FetchCall } from '@/test/helpers';

const BASE = 'http://192.168.1.5:8642';

function calls(): FetchCall[] {
  return (globalThis.fetch as unknown as { calls: FetchCall[] }).calls;
}

function lastCall(): FetchCall {
  const all = calls();
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1]!;
}

async function seedKey(gatewayId = 'gw1', key = 'test-key-123'): Promise<void> {
  await AuthService.storeKey(gatewayId, key);
}

describe('GatewayAPI (§4.2 P0 — endpoint matrix, GatewayError, session echo)', () => {
  beforeEach(() => {
    resetSecureStore();
    resetMMKV();
    createFetchMock([]);
    jest.clearAllMocks();
  });

  describe('pairing surface', () => {
    it('healthCheck — unauthed GET {base}/v1/health with NO Authorization header', async () => {
      createFetchMock([
        { path: '/v1/health', handler: { status: 200, text: '' } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.healthCheck();
      expect(calls()).toHaveLength(1);
      expect(lastCall().method).toBe('GET');
      expect(lastCall().url).toBe(`${BASE}/v1/health`);
      expect(lastCall().headers['Authorization']).toBeUndefined();
    });

    it('capabilities — GET /v1/capabilities WITH Authorization: Bearer <key from SecureStore>', async () => {
      await seedKey();
      const raw = JSON.stringify({});
      createFetchMock([{ path: '/v1/capabilities', handler: { status: 200, text: raw } }]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.capabilities();
      expect(lastCall().method).toBe('GET');
      expect(lastCall().url).toBe(`${BASE}/v1/capabilities`);
      expect(lastCall().headers['Authorization']).toBe('Bearer test-key-123');
    });

    it('missing key → throws "No API key for gateway …" and no fetch call is made', async () => {
      const api = new GatewayAPI(BASE, 'gw1');
      await expect(api.capabilities()).rejects.toThrow('No API key for gateway gw1');
      expect(calls()).toHaveLength(0);
    });

    it('401 → GatewayError with status/body (KR-5 machinery relies on instanceof)', async () => {
      await seedKey();
      createFetchMock([
        { path: '/v1/capabilities', handler: { status: 401, text: '{"error":"gateway_auth_failed"}' } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      const err = await api.capabilities().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(GatewayError);
      const gwErr = err as GatewayError;
      expect(gwErr.status).toBe(401);
      expect(gwErr.body).toBe('{"error":"gateway_auth_failed"}');
      expect(gwErr.message).toContain('401');
    });
  });

  describe('sessions', () => {
    it('listSessions clamps limit to 200 (request 1000 → ?limit=200)', async () => {
      await seedKey();
      createFetchMock([
        { path: '/api/sessions', handler: { status: 200, json: { object: 'list', data: [], has_more: false } } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.listSessions({ limit: 1000 });
      expect(lastCall().url).toContain('limit=200');
      expect(lastCall().url).not.toContain('limit=1000');
    });

    it('listSessions default limit 200, offset forwarded, no include_archived by default', async () => {
      await seedKey();
      createFetchMock([
        { path: '/api/sessions', handler: { status: 200, json: { object: 'list', data: [] } } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.listSessions({ offset: 400 });
      expect(lastCall().url).toContain('limit=200');
      expect(lastCall().url).toContain('offset=400');
      expect(lastCall().url).not.toContain('include_archived');
    });

    it('listSessions includeArchived → include_archived=true (⚠️ §9a param pinned as-is)', async () => {
      await seedKey();
      createFetchMock([
        { path: '/api/sessions', handler: { status: 200, json: { object: 'list', data: [] } } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.listSessions({ includeArchived: true });
      expect(lastCall().url).toContain('include_archived=true');
    });

    it('method+path matrix: create POST, rename PATCH, delete DELETE, fork POST /fork, getSession GET', async () => {
      await seedKey();
      createFetchMock([
        { path: '/api/sessions', handler: { status: 200, json: {} } },
        { path: '/api/sessions/s7', handler: { status: 200, json: {} } },
        { path: '/api/sessions/s7/fork', handler: { status: 200, json: {} } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');

      await api.createSession('My Title');
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/api/sessions`);
      expect(JSON.parse(lastCall().body)).toEqual({ title: 'My Title' });

      await api.renameSession('s7', 'New Name');
      expect(lastCall().method).toBe('PATCH');
      expect(JSON.parse(lastCall().body)).toEqual({ title: 'New Name' });

      await api.deleteSession('s7');
      expect(lastCall().method).toBe('DELETE');

      await api.forkSession('s7');
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/api/sessions/s7/fork`);

      await api.getSession('s7');
      expect(lastCall().method).toBe('GET');
      expect(lastCall().url).toBe(`${BASE}/api/sessions/s7`);

      await api.getSessionMessages('s7');
      expect(lastCall().method).toBe('GET');
      expect(lastCall().url).toBe(`${BASE}/api/sessions/s7/messages`);
    });
  });

  describe('runs', () => {
    it('KR-10: createRun sends Idempotency-Key header with the exact key', async () => {
      await seedKey();
      createFetchMock([
        { path: '/v1/runs', handler: { status: 202, text: '' } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.createRun({ input: 'hello', session_id: 's1' }, 'idem-key-999', { 'X-Hermes-Session-Id': 's1' });
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/v1/runs`);
      expect(lastCall().headers['Idempotency-Key']).toBe('idem-key-999');
      expect(JSON.parse(lastCall().body)).toEqual({ input: 'hello', session_id: 's1' });
    });

    it('createRun merges session headers without clobbering Authorization/Content-Type', async () => {
      await seedKey();
      createFetchMock([{ path: '/v1/runs', handler: { status: 202, text: '' } }]);
      const api = new GatewayAPI(BASE, 'gw1');
      await api.createRun(
        { input: 'x' },
        'idem',
        { 'X-Hermes-Session-Id': 's9', 'X-Hermes-Session-Key': 'key9' },
      );
      const h = lastCall().headers;
      expect(h['Authorization']).toBe('Bearer test-key-123');
      expect(h['Content-Type']).toBe('application/json');
      expect(h['X-Hermes-Session-Id']).toBe('s9');
      expect(h['X-Hermes-Session-Key']).toBe('key9');
    });

    it('getRunStatus GET /v1/runs/{id}; steer POST {text}; stop POST → {status:"stopping"} passthrough; approval POST {decision}', async () => {
      await seedKey();
      createFetchMock([
        { path: '/api/x', handler: { status: 200, json: {} } },
        { path: '/v1/runs/r1/', handler: { status: 200, json: {} } },
        { path: '/v1/runs/r1', handler: { status: 200, json: {} } },
        { path: '/v1/runs/', handler: { status: 200, json: {} } },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');

      await api.getRunStatus('r1');
      expect(lastCall().method).toBe('GET');
      expect(lastCall().url).toBe(`${BASE}/v1/runs/r1`);

      await api.steerRun('r1', 'slow down');
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/v1/runs/r1/steer`);
      expect(JSON.parse(lastCall().body)).toEqual({ text: 'slow down' });

      await api.stopRun('r1');
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/v1/runs/r1/stop`);

      await api.respondToApproval('r1', 'approve');
      expect(lastCall().method).toBe('POST');
      expect(lastCall().url).toBe(`${BASE}/v1/runs/r1/approval`);
      expect(JSON.parse(lastCall().body)).toEqual({ decision: 'approve' });
    });

    it('getRunEventsUrl → {base}/v1/runs/{id}/events without any request', () => {
      const api = new GatewayAPI(BASE, 'gw1');
      expect(api.getRunEventsUrl('run-42')).toBe(`${BASE}/v1/runs/run-42/events`);
      expect(calls()).toHaveLength(0);
    });
  });

  describe('session echo (audit W3 / KR-11 — X-Hermes-Session-Key memory scoping)', () => {
    it('captureSessionEcho persists X-Hermes-Session-Id (+Key) to MMKV map', () => {
      const api = new GatewayAPI(BASE, 'gw1');
      const res = {
        ok: true,
        status: 202,
        headers: {
          get: (n: string) => ({
            'X-Hermes-Session-Id': 'sess-77',
            'X-Hermes-Session-Key': 'sk-abc',
          })[n as keyof Record<string, never>] ?? null,
        },
      };
      api.captureSessionEcho(res as unknown as Response, 'gw1');
      expect(api.getSessionEcho('gw1', 'sess-77')).toEqual({ sessionId: 'sess-77', sessionKey: 'sk-abc' });
    });

    it('echo WITHOUT key captured; second echo WITH key merges', () => {
      const api = new GatewayAPI(BASE, 'gw1');

      api.captureSessionEcho(makeEcho('sess-77', null), 'gw1');
      expect(api.getSessionEcho('gw1', 'sess-77')).toEqual({ sessionId: 'sess-77' });

      api.captureSessionEcho(makeEcho('sess-77', 'sk-later'), 'gw1');
      expect(api.getSessionEcho('gw1', 'sess-77')).toEqual({ sessionId: 'sess-77', sessionKey: 'sk-later' });
    });

    it('no echo headers → no-op (no map written)', () => {
      const api = new GatewayAPI(BASE, 'gw1');
      api.captureSessionEcho(makeEcho(null, null), 'gw1');
      expect(api.getSessionEcho('gw1', 'anything')).toBeNull();
    });

    it('getSessionEcho returns {sessionId, sessionKey} / null for unknown', () => {
      const api = new GatewayAPI(BASE, 'gw1');
      api.captureSessionEcho(makeEcho('sess-1', 'key-1'), 'gw1');
      expect(api.getSessionEcho('gw1', 'sess-1')).toEqual({ sessionId: 'sess-1', sessionKey: 'key-1' });
      expect(api.getSessionEcho('gw1', 'nope')).toBeNull();
      expect(api.getSessionEcho('gw2', 'sess-1')).toBeNull(); // other gateway
    });

    it('handleResponse auto-captures on every ok response (gateway-api.ts:51 integration)', async () => {
      await seedKey();
      createFetchMock([
        {
          path: '/api/sessions',
          handler: {
            status: 200,
            json: { id: 'sess-99' },
            headers: { 'X-Hermes-Session-Id': 'sess-99' },
          },
        },
      ]);
      const api = new GatewayAPI(BASE, 'gw1');
      void await api.createSession('t');
      // No manual capture call — the header must have been persisted anyway.
      expect(api.getSessionEcho('gw1', 'sess-99')).toEqual({ sessionId: 'sess-99' });
    });

    it('sessionHeaders(sid?, skey?) — omit-empty rules', () => {
      const api = new GatewayAPI(BASE, 'gw1');
      expect(api.sessionHeaders()).toEqual({});
      expect(api.sessionHeaders('s1')).toEqual({ 'X-Hermes-Session-Id': 's1' });
      expect(api.sessionHeaders('s1', 'k1')).toEqual({ 'X-Hermes-Session-Id': 's1', 'X-Hermes-Session-Key': 'k1' });
    });
  });

  it('getModelOptions GET /api/model/options with auth', async () => {
    await seedKey();
    createFetchMock([{ path: '/api/model/options', handler: { status: 200, json: { models: [] } } }]);
    const api = new GatewayAPI(BASE, 'gw1');
    void await api.getModelOptions();
    expect(lastCall().method).toBe('GET');
    expect(lastCall().url).toBe(`${BASE}/api/model/options`);
    expect(lastCall().headers['Authorization']).toBe('Bearer test-key-123');
  });

  it('baseUrl strips trailing slashes (constructor)', () => {
    expect(new GatewayAPI(`${BASE}/`, 'gw1').baseUrl).toBe(BASE);
    expect(new GatewayAPI(`${BASE}///`, 'gw1').baseUrl).toBe(BASE);
  });
});

/** Build a raw Response-like carrying X-Hermes-* echo headers. */
function makeEcho(sid: string | null, skey: string | null): Response {
  const bag: Record<string, string> = {};
  if (sid) bag['x-hermes-session-id'] = sid;
  if (skey) bag['x-hermes-session-key'] = skey;
  return {
    ok: true,
    status: 202,
    headers: { get: (name: string) => bag[name.toLowerCase()] ?? null },
  } as unknown as Response;
}
