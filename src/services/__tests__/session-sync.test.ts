import { SessionSyncEngine } from '../session-sync';
import type { SessionResponse, SessionListResponse } from '../gateway-api';

let counter = 0;

function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
  counter += 1;
  return {
    id: `sess_${counter}`,
    title: `Session ${counter}`,
    model: 'claude-sonnet-4-5',
    source: 'api_server',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    api_call_count: 1,
    tool_call_count: 0,
    message_count: 2,
    started_at: 1700000000,
    ended_at: null,
    end_reason: null,
    last_active: 1700000100,
    parent_session_id: null,
    pinned: false,
    archived: false,
    hidden: false,
    preview: 'hello',
    user_id: 'u1',
    ...overrides,
  };
}

function makePage(data: SessionResponse[]): SessionListResponse {
  return { object: 'list', data, limit: 200, offset: 0, has_more: true };
}

interface ListOpts {
  limit: number;
  offset: number;
  includeArchived?: boolean;
}

/**
 * listSessions mock. Main-loop calls consume `pages` in order;
 * archived-pass calls (includeArchived: true) consume `archivedPages`.
 * An exhausted list returns an empty page, which terminates the loop.
 */
function makeApi(pages: SessionResponse[][], archivedPages: SessionResponse[][] = []) {
  const calls: ListOpts[] = [];
  let mainIdx = 0;
  let archIdx = 0;
  const listSessions = jest.fn(async (opts: ListOpts): Promise<SessionListResponse> => {
    calls.push({ ...opts });
    if (opts.includeArchived) {
      const p = archivedPages[archIdx];
      if (p !== undefined) archIdx += 1;
      return makePage(p ?? []);
    }
    const p = pages[mainIdx];
    if (p !== undefined) mainIdx += 1;
    return makePage(p ?? []);
  });
  return { api: { listSessions } as never, listSessions, calls };
}

describe('SessionSyncEngine (KR-6 pagination)', () => {
  beforeEach(() => {
    counter = 0;
  });

  test('fullSync paginates until short page: 200 + 200 + 50 = 450 in 3 calls', async () => {
    const { api, listSessions, calls } = makeApi([
      Array.from({ length: 200 }, () => makeSession()),
      Array.from({ length: 200 }, () => makeSession()),
      Array.from({ length: 50 }, () => makeSession()),
    ]);
    const engine = new SessionSyncEngine(api);
    const batches: SessionResponse[][] = [];
    const total = await engine.fullSync(b => batches.push(b));

    const mainCalls = calls.filter(c => !c.includeArchived);
    expect(mainCalls).toHaveLength(3);
    expect(mainCalls.map(c => c.offset)).toEqual([0, 200, 400]);
    expect(total).toBe(450);
    expect(batches.reduce((n, b) => n + b.length, 0)).toBe(450);
    // 3 main + 1 terminating empty archived-pass call
    expect(listSessions).toHaveBeenCalledTimes(4);
  });

  test('fullSync runs a second archived pass after the main loop', async () => {
    const { api, calls } = makeApi(
      [Array.from({ length: 200 }, () => makeSession()), []],
      [Array.from({ length: 5 }, () => makeSession({ archived: true })), []]
    );
    const engine = new SessionSyncEngine(api);
    const batches: SessionResponse[][] = [];
    const total = await engine.fullSync(b => batches.push(b));

    const archCalls = calls.filter(c => c.includeArchived);
    expect(archCalls).toHaveLength(1); // 5-item page is short → pass terminates
    expect(archCalls[0]?.includeArchived).toBe(true);
    expect(archCalls[0]?.offset).toBe(0);
    expect(total).toBe(205); // 200 main + 5 archived
    expect(batches.some(b => b.some(s => s.archived))).toBe(true);
  });

  test('incrementalSync filters by watermark: only newer sessions reach the callback', async () => {
    const now = 1700001000;
    const { api, listSessions } = makeApi([
      [
        makeSession({ id: 'old-1', last_active: now - 500 }),
        makeSession({ id: 'new-1', last_active: now - 10 }),
        makeSession({ id: 'new-2', last_active: now + 5 }),
      ],
    ]);
    const engine = new SessionSyncEngine(api);
    const delivered: SessionResponse[][] = [];
    const total = await engine.incrementalSync(now - 100, b => delivered.push(b));

    expect(listSessions).toHaveBeenCalledTimes(1); // short page, no archived pass in incremental
    expect(delivered).toEqual([
      [expect.objectContaining({ id: 'new-1' }), expect.objectContaining({ id: 'new-2' })],
    ]);
    expect(delivered.flat().map(s => s.id)).not.toContain('old-1');
    expect(total).toBe(2);
  });

  test('incrementalSync early-exits when the oldest session in a full batch is at/below the watermark', async () => {
    const now = 1700001000;
    // Full 200-item page, newest-first, oldest item already ≤ watermark.
    const page = Array.from({ length: 200 }, (_, i) =>
      makeSession({ id: `s${i}`, last_active: now - 1 - i })
    );
    const { api, listSessions } = makeApi([page]);
    const engine = new SessionSyncEngine(api);
    const delivered: SessionResponse[][] = [];
    await engine.incrementalSync(now - 150, b => delivered.push(b));

    // Short-circuit after the first full batch — page 2 never fetched.
    expect(listSessions).toHaveBeenCalledTimes(1);
    // Only the sessions newer than the watermark were delivered (first 149).
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toHaveLength(149);
  });

  test('incrementalSync keeps paginating while every session is newer than the watermark', async () => {
    const now = 1700001000;
    const page = (base: number) =>
      Array.from({ length: 200 }, (_, i) =>
        makeSession({ last_active: now - base - i, id: `p${base}_${i}` })
      );
    const { api, listSessions } = makeApi([page(0), page(1000)]);
    const engine = new SessionSyncEngine(api);
    await engine.incrementalSync(now - 2000, () => {});

    // 2 full pages (early-exit not triggered: oldest batch item is still
    // newer than the watermark) + 1 terminating empty-page call.
    expect(listSessions).toHaveBeenCalledTimes(3);
  });
});
