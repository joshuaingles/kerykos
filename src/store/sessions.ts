import { create } from 'zustand';
import type { SessionResponse } from '@/services/gateway-api';

export interface SessionRow extends SessionResponse {
  // Derived fields for UI — computed in deriveSessionRow() below and
  // refreshed on every upsert (no lazy derivation, keeps rows immutable).
  relativeTime: string;   // "2m ago", "1h ago", "yesterday"
  costDisplay: string;    // "$0.0123" or "—" (unknown) — 4dp, matches phase-5 §5.3
  isActive: boolean;      // ended_at === null && within active window
  sourceBadge: string;    // emoji + label from source field
}

/**
 * Derivation for all KR-8 row fields. Pure function over SessionResponse —
 * called from upsertSessions before the row enters the store.
 */
export function deriveSessionRow(s: SessionResponse, now: number = Date.now() / 1000): SessionRow {
  return {
    ...s,
    relativeTime: relativeTime(s.last_active, now),
    costDisplay: formatCost(s.estimated_cost_usd, s.actual_cost_usd),
    // Active = no end AND last_active within the activity window (15 min —
    // matches Hermes' own active-session convention; wire-check at impl).
    isActive: s.ended_at === null && (now - s.last_active) < 900,
    sourceBadge: SOURCE_BADGES[s.source] ?? s.source,
  };
}

/** KR-8: relative-time formatting (returns refreshed strings on re-render). */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  return `${Math.floor(diff / 86400)}d ago`;
}

/** KR-19: cost display logic (from Phase 5, but needed for row rendering). */
export function formatCost(estimated: number | null, actual: number | null): string {
  // Wire-verified nuance: estimated_cost_usd can be 0.0 on providers
  // without local pricing — display as "—" (unknown), never "$0.00"
  const cost = actual ?? estimated;
  if (cost === null || cost === 0) return '—';  // unknown, not free
  return `$${cost.toFixed(4)}`;                 // matches Phase 5 §5.3 precision
}

/** KR-8: source badge map — exhaustive over known sources, raw fallback. */
export const SOURCE_BADGES: Record<string, string> = {
  api_server: '📱 API',
  desktop: '🖥️ Desktop',
  dashboard: '🖥️ Dashboard',
  cron: '⏰ Cron',
  cli: '💻 CLI',
  telegram: '✈️ Telegram',
};

interface SessionsState {
  sessions: Map<string, SessionRow>;
  loading: boolean;
  error: string | null;
  lastSyncWatermark: number;
  showArchived: boolean;  // KR-9: archived hidden by default

  // Actions
  upsertSessions: (sessions: SessionResponse[]) => void;
  removeSession: (id: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setShowArchived: (show: boolean) => void;
  updateWatermark: (timestamp: number) => void;

  // Derived (selectors)
  getVisibleSessions: () => SessionRow[];
  getSessionById: (id: string) => SessionRow | undefined;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: new Map<string, SessionRow>(),
  loading: false,
  error: null,
  lastSyncWatermark: 0,
  showArchived: false,

  upsertSessions: (sessions) => set((state) => {
    const next = new Map(state.sessions);
    const now = Date.now() / 1000;
    for (const s of sessions) {
      const prev = next.get(s.id);
      // Last-write-wins: only newer last_active replaces an existing row.
      if (prev && prev.last_active > s.last_active) continue;
      next.set(s.id, deriveSessionRow(s, now));
    }
    return { sessions: next };
  }),

  removeSession: (id) => set((state) => {
    const next = new Map(state.sessions);
    next.delete(id);
    return { sessions: next };
  }),

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setShowArchived: (show) => set({ showArchived: show }),
  updateWatermark: (timestamp) => set({
    // Never move the watermark backwards.
    lastSyncWatermark: Math.max(timestamp, get().lastSyncWatermark),
  }),

  // KR-9: archived hidden by default (toggle to show), pinned surface at top.
  getVisibleSessions: () => {
    const state = get();
    const sessions = Array.from(state.sessions.values());

    const filtered = state.showArchived
      ? sessions
      : sessions.filter(s => !s.archived);

    const pinned = filtered.filter(s => s.pinned);
    const unpinned = filtered.filter(s => !s.pinned);

    // Sort: pinned first (by last_active desc), then unpinned (by last_active desc)
    pinned.sort((a, b) => b.last_active - a.last_active);
    unpinned.sort((a, b) => b.last_active - a.last_active);

    return [...pinned, ...unpinned];
  },

  getSessionById: (id) => get().sessions.get(id),
}));
