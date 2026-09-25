import {
  useSessionsStore,
  type SessionRow,
} from '../store/sessions';
import type { SessionResponse } from '../services/gateway-api';

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

function resetStore() {
  useSessionsStore.setState({
    sessions: new Map<string, SessionRow>(),
    loading: false,
    error: null,
    lastSyncWatermark: 0,
    showArchived: false,
  });
}

describe('Session CRUD flow (KR-7) — store operations', () => {
  beforeEach(() => {
    counter = 0;
    resetStore();
  });

  test('create: upsertSessions adds the session and it appears in getVisibleSessions', () => {
    const s = makeSession({ id: 'sess_create', title: 'New chat' });
    useSessionsStore.getState().upsertSessions([s]);

    const visible = useSessionsStore.getState().getVisibleSessions();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe('sess_create');
    expect(visible[0]?.title).toBe('New chat');
    expect(useSessionsStore.getState().getSessionById('sess_create')).toBeDefined();
  });

  test('rename: upsertSessions with the same id replaces the title', () => {
    const original = makeSession({ id: 'sess_rename', title: 'Old title' });
    useSessionsStore.getState().upsertSessions([original]);
    expect(useSessionsStore.getState().getSessionById('sess_rename')?.title).toBe('Old title');

    const renamed = { ...original, title: 'Renamed title' };
    useSessionsStore.getState().upsertSessions([renamed]);

    expect(useSessionsStore.getState().getSessionById('sess_rename')?.title).toBe('Renamed title');
    const visible = useSessionsStore.getState().getVisibleSessions();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.title).toBe('Renamed title');
  });

  test('delete: removeSession drops the session from the store', () => {
    const s = makeSession({ id: 'sess_delete' });
    useSessionsStore.getState().upsertSessions([s]);
    expect(useSessionsStore.getState().getVisibleSessions()).toHaveLength(1);

    useSessionsStore.getState().removeSession('sess_delete');

    expect(useSessionsStore.getState().getSessionById('sess_delete')).toBeUndefined();
    expect(useSessionsStore.getState().getVisibleSessions()).toHaveLength(0);
  });

  test('fork: upsertSessions with parent_session_id set appears in the store', () => {
    const parent = makeSession({ id: 'sess_parent', title: 'Parent' });
    useSessionsStore.getState().upsertSessions([parent]);

    const fork = makeSession({
      id: 'sess_fork',
      title: 'Parent (fork)',
      parent_session_id: 'sess_parent',
    });
    useSessionsStore.getState().upsertSessions([fork]);

    const row = useSessionsStore.getState().getSessionById('sess_fork');
    expect(row).toBeDefined();
    expect(row?.parent_session_id).toBe('sess_parent');
    expect(useSessionsStore.getState().getVisibleSessions().map(s => s.id)).toEqual(
      expect.arrayContaining(['sess_parent', 'sess_fork'])
    );
  });
});
