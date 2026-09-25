import {
  deriveSessionRow,
  relativeTime,
  formatCost,
  SOURCE_BADGES,
  useSessionsStore,
  type SessionRow,
} from '../sessions';
import type { SessionResponse } from '@/services/gateway-api';
import { makeSession } from '@/test/helpers';

const NOW = 1_000_000;

describe('relativeTime (§2.3 — KR-8 bucket formatting)', () => {
  it('buckets: <60s just now, minutes, hours, yesterday, days', () => {
    const cases: [number, string][] = [
      [NOW - 30, 'just now'],
      [NOW - 59, 'just now'],
      [NOW - 90, '1m ago'],
      [NOW - 59 * 60, '59m ago'],
      [NOW - 2 * 3600, '2h ago'],
      [NOW - 20 * 3600, '20h ago'],
      [NOW - 23 * 3600, '23h ago'],
      [NOW - 25 * 3600, 'yesterday'],
      [NOW - 47 * 3600, 'yesterday'],
      [NOW - 3 * 86400, '3d ago'],
    ];
    for (const [ts, expected] of cases) {
      expect(relativeTime(ts, NOW)).toBe(expected);
    }
  });

  it('relativeTime never negative — future ts → "just now" (Math.max(0,…))', () => {
    expect(relativeTime(NOW + 9999, NOW)).toBe('just now');
  });
});

describe('formatCost (§2.3 — KR-19 the honest-cost rule)', () => {
  it('KR-19: cost 0.0 → dash (unknown ≠ free; never $0.00)', () => {
    expect(formatCost(0, null)).toBe('—');
    expect(formatCost(0.0, 0.0)).toBe('—');
  });

  it('KR-19: actual wins over estimated', () => {
    expect(formatCost(0.5, 0.25)).toBe('$0.2500');
  });

  it('KR-19: null + null → dash; nonzero → $4dp', () => {
    expect(formatCost(null, null)).toBe('—');
    expect(formatCost(0.01234567, null)).toBe('$0.0123');
  });

  it('estimated used when actual is null', () => {
    expect(formatCost(1.5, null)).toBe('$1.5000');
  });
});

describe('deriveSessionRow (§2.3 — KR-8 row fields)', () => {
  it('isActive window: ended_at null + last_active within 900s → true; beyond → false', () => {
    const fresh = makeSession({
      ended_at: null,
      last_active: NOW - 899,
    });
    expect(deriveSessionRow(fresh, NOW).isActive).toBe(true);

    const stale = makeSession({
      ended_at: null,
      last_active: NOW - 901,
    });
    expect(deriveSessionRow(stale, NOW).isActive).toBe(false);
  });

  it('ended_at set → not active regardless of recency', () => {
    const ended = makeSession({
      ended_at: NOW - 30,
      last_active: NOW - 30,
    });
    expect(deriveSessionRow(ended, NOW).isActive).toBe(false);
  });

  it('source badge: known source mapped; unknown raw passthrough', () => {
    expect(deriveSessionRow(makeSession({ source: 'api_server' }), NOW).sourceBadge).toBe(SOURCE_BADGES['api_server']);
    expect(deriveSessionRow(makeSession({ source: 'desktop' }), NOW).sourceBadge).toBe('🖥️ Desktop');
    expect(deriveSessionRow(makeSession({ source: 'some_new_source' }), NOW).sourceBadge).toBe('some_new_source');
  });

  it('deriveSessionRow formats cost + relative time onto the row', () => {
    const row = deriveSessionRow(makeSession({ estimated_cost_usd: 0.75, actual_cost_usd: null, last_active: NOW - 30 }), NOW);
    expect(row.costDisplay).toBe('$0.7500');
    expect(row.relativeTime).toBe('just now');
  });
});

describe('sessions store (§2.3 — upsert/sort/watermark rules)', () => {
  beforeEach(() => {
    useSessionsStore.setState({
      sessions: new Map<string, SessionRow>(),
      loading: false,
      error: null,
      lastSyncWatermark: 0,
      showArchived: false,
    });
  });

  it('upsertSessions last-write-wins: existing row with newer last_active kept', () => {
    const newer = makeSession({ id: 's1', last_active: 2000 });
    const older = makeSession({ id: 's1', last_active: 1000 });
    const store = useSessionsStore.getState();
    store.upsertSessions([newer]);
    useSessionsStore.getState().upsertSessions([older]);
    expect(useSessionsStore.getState().sessions.get('s1')!.last_active).toBe(2000);
  });

  it('upsertSessions replaced by newer last_active on next sync', () => {
    useSessionsStore.getState().upsertSessions([makeSession({ id: 's1', last_active: 1000 })]);
    useSessionsStore.getState().upsertSessions([makeSession({ id: 's1', last_active: 3000 })]);
    expect(useSessionsStore.getState().sessions.get('s1')!.last_active).toBe(3000);
  });

  it('pinned-first sort in getVisibleSessions (pinned desc before unpinned desc)', () => {
    const rows: SessionResponse[] = [
      makeSession({ id: 'u-new', pinned: false, last_active: 5000 }),
      makeSession({ id: 'u-old', pinned: false, last_active: 1000 }),
      makeSession({ id: 'p-old', pinned: true, last_active: 2000 }),
      makeSession({ id: 'p-new', pinned: true, last_active: 4000 }),
    ];
    useSessionsStore.getState().upsertSessions(rows);
    const visible = useSessionsStore.getState().getVisibleSessions().map(s => s.id);
    expect(visible).toEqual(['p-new', 'p-old', 'u-new', 'u-old']);
  });

  it('KR-9: archived hidden by default; toggle shows them', () => {
    useSessionsStore.getState().upsertSessions([
      makeSession({ id: 'live', archived: false }),
      makeSession({ id: 'arch', archived: true }),
    ]);

    expect(useSessionsStore.getState().getVisibleSessions().map(s => s.id)).toEqual(['live']);

    useSessionsStore.getState().setShowArchived(true);
    expect(useSessionsStore.getState().getVisibleSessions().map(s => s.id)).toEqual(['live', 'arch']);
  });

  it('updateWatermark never moves backwards (monotonic)', () => {
    useSessionsStore.getState().updateWatermark(500);
    expect(useSessionsStore.getState().lastSyncWatermark).toBe(500);
    useSessionsStore.getState().updateWatermark(100);
    expect(useSessionsStore.getState().lastSyncWatermark).toBe(500);
    useSessionsStore.getState().updateWatermark(900);
    expect(useSessionsStore.getState().lastSyncWatermark).toBe(900);
  });

  it('removeSession deletes the row; getSessionById reflects store', () => {
    useSessionsStore.getState().upsertSessions([makeSession({ id: 's9' })]);
    expect(useSessionsStore.getState().getSessionById('s9')).toBeDefined();
    useSessionsStore.getState().removeSession('s9');
    expect(useSessionsStore.getState().getSessionById('s9')).toBeUndefined();
  });
});
