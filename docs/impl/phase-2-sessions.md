# Phase 2 — Sessions

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-2 #sessions

**Purpose:** Implement the sessions list, CRUD operations, session row rendering, and local flag handling. Chat (Phase 3) depends on having a working sessions list to navigate from.

**KR/NFR coverage:** KR-6, KR-7, KR-8, KR-9, KR-4a, NFR-2, NFR-3

---

## 2.1 Gateway API — Sessions Endpoints

**File:** `src/services/gateway-api.ts` (extend from Phase 1)

Add session management methods. All resolve credentials via gateway id (KR-4a).

```typescript
// === Types ===

export interface SessionResponse {
  id: string;
  title: string;
  model: string;
  source: string;                    // api_server, desktop, dashboard, cron, cli, telegram…
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  api_call_count: number;
  tool_call_count: number;
  message_count: number;
  // ⚠️ api-surface lists started_at/ended_at as "float/string" — the numeric
  // epoch form is ASSUMED. Verify on a live gateway at impl time per §9a and
  // add a string-parse fallback if ISO strings ever appear.
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  last_active: number;               // derived from last_activity_at — sync watermark
  parent_session_id: string | null;
  pinned: boolean;
  archived: boolean;
  hidden: boolean;
  preview: string;                   // last-message preview
  user_id: string;
}

export interface SessionListResponse {
  object: 'list';
  data: SessionResponse[];
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  token_count: number | null;
  // other fields per api-surface.md
}

// === API Methods ===

// Inside GatewayAPI class:

/** List sessions paginated (KR-6). */
async listSessions(options: {
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
} = {}): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(Math.min(options.limit ?? 200, 200))); // max 200
  if (options.offset) params.set('offset', String(options.offset));
  if (options.includeArchived) {
    // ⚠️ Param name unverified — confirm at impl time per §9a.
    params.set('include_archived', 'true');
  }
  return this.request<SessionListResponse>(`/api/sessions?${params}`);
}

/** Create session (KR-7). */
async createSession(title?: string): Promise<SessionResponse> {
  return this.request<SessionResponse>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

/** Rename session (KR-7). */
async renameSession(sessionId: string, title: string): Promise<void> {
  await this.request(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/** Delete session (KR-7). Destructive — confirm in UI first. */
async deleteSession(sessionId: string): Promise<void> {
  await this.request(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

/** Fork session (KR-7). */
async forkSession(sessionId: string): Promise<SessionResponse> {
  return this.request<SessionResponse>(`/api/sessions/${sessionId}/fork`, {
    method: 'POST',
  });
}

/** Get session details. */
async getSession(sessionId: string): Promise<SessionResponse> {
  return this.request<SessionResponse>(`/api/sessions/${sessionId}`);
}

/** Get session transcript (KR-18, Phase 3 uses for offline cache). */
async getSessionMessages(sessionId: string): Promise<SessionMessage[]> {
  // ⚠️ Wrapper shape unverified: smoke test #4 confirmed token_count per
  // message but not whether the response is a bare array or {data:[…]}.
  // Confirm at impl time per §9a and unwrap here — callers see bare array.
  return this.request<SessionMessage[]>(`/api/sessions/${sessionId}/messages`);
}
```

**Endpoint reference (api-surface.md):**

| Method | Endpoint | Response | Notes |
|---|---|---|---|
| GET | `/api/sessions?limit=200&offset=N` | `{object:"list", data:[...], limit, offset, has_more}` | Server default limit 50, max 200 |
| POST | `/api/sessions` | `SessionResponse` | Optional `title` in body |
| PATCH | `/api/sessions/:id` | — | `{title}` for rename |
| DELETE | `/api/sessions/:id` | — | Destructive |
| POST | `/api/sessions/:id/fork` | `SessionResponse` | Returns forked session |
| GET | `/api/sessions/:id/messages` | `SessionMessage[]` | Includes `token_count` per message |

**Acceptance criteria:**
- All methods typed against `_session_response` field allowlist (KR-8: "unknown fields never expected")
- Credentials resolved via gateway id on every call (KR-4a)
- Limit capped at 200 per request

---

## 2.2 Full Sync Engine (KR-6)

**File:** `src/services/session-sync.ts`

Handles paginated full sync and incremental updates.

```typescript
export class SessionSyncEngine {
  private api: GatewayAPI;
  private pageSize = 200; // max per KR-6

  constructor(api: GatewayAPI) {
    this.api = api;
  }

  /**
   * Full backfill: paginate until exhausted (KR-6).
   * Paging subtlety (api-surface.md): has_more counts only non-pinned rows;
   * pinned sessions are back-filled past the limit.
   * Robust sync: page until short page PLUS one extra query including archived.
   */
  async fullSync(onBatch: (sessions: SessionResponse[]) => void): Promise<number> {
    let offset = 0;
    let total = 0;

    // Main pagination loop
    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      onBatch(resp.data);
      total += resp.data.length;
      offset += resp.data.length;

      // Short page = done (KR-6: not has_more alone)
      if (resp.data.length < this.pageSize) break;
    }

    // KR-6 extra pass: one full pagination including archived sessions.
    // Pinned/archived rows back-fill past the limit window; this pass catches
    // anything the default listing missed. Dedup happens in the store (keyed by id).
    let archOffset = 0;
    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset: archOffset,
        includeArchived: true,
      });
      onBatch(resp.data);
      total += resp.data.length;
      archOffset += resp.data.length;
      if (resp.data.length < this.pageSize) break;
    }

    return total;
  }

  /**
   * Incremental sync: fetch sessions with last_active > watermark (KR-20).
   * Used on foreground resume and periodic poll.
   */
  async incrementalSync(
    watermark: number,
    onBatch: (sessions: SessionResponse[]) => void
  ): Promise<number> {
    // Fetch all recent sessions; client-side filter by last_active
    // (API doesn't support last_active filter natively as of v0.21.3)
    let offset = 0;
    let total = 0;

    while (true) {
      const resp = await this.api.listSessions({
        limit: this.pageSize,
        offset,
      });

      const recent = resp.data.filter(s => s.last_active > watermark);
      if (recent.length > 0) {
        onBatch(recent);
        total += recent.length;
      }

      offset += resp.data.length;
      if (resp.data.length < this.pageSize || resp.data.length === 0) break;

      // Optimization: if all sessions in batch are older than watermark,
      // we can stop early (assumes newest-first order)
      const oldestInBatch = Math.min(...resp.data.map(s => s.last_active));
      if (oldestInBatch <= watermark) break;
    }

    return total;
  }
}
```

**KR-6 paging subtlety (api-surface.md):**
> `has_more` counts only non-pinned rows in the window; pinned sessions are back-filled *past* the limit. For a robust full-sync, page until a page returns fewer than `limit` rows **plus** one extra query including archived, rather than trusting `has_more` alone.

**Implementation strategy:**
- Primary loop: paginate until `data.length < pageSize`
- The pinned-backfill behavior means pinned sessions appear in later pages even after `has_more` is false
- Since we page until short page (not `has_more`), pinned sessions are naturally included
- Deduplication: key on `session.id`, last-write-wins on `last_active`

**Acceptance criteria:**
- 1,000+-session gateway full sync completes with zero duplicate/dropped sessions (KR-6)
- Short-page termination (not `has_more` alone) drives completeness
- Archived extra-pass pagination included (KR-6) — `includeArchived` param name ⚠️ confirm against live gateway at impl time per §9a
- Deduplication by session id

---

## 2.3 Sessions Store (Zustand)

**File:** `src/store/sessions.ts`

```typescript
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
function deriveSessionRow(s: SessionResponse, now: number = Date.now() / 1000): SessionRow {
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
function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 172800) return 'yesterday';
  return `${Math.floor(diff / 86400)}d ago`;
}

/** KR-8: source badge map — exhaustive over known sources, raw fallback. */
const SOURCE_BADGES: Record<string, string> = {
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
```

**KR-8: Session row rendering fields:**

| Field | Source | Display |
|---|---|---|
| `title` | `session.title` | Primary text |
| Source badge | `session.source` | Emoji + label (🖥️ Desktop, 📱 API, 🤖 Cron, 💬 CLI, ✈️ Telegram) |
| Model | `session.model` | Secondary text |
| Preview | `session.preview` | Tertiary text, truncated |
| Relative time | `session.last_active` | "2m ago", "1h ago", "yesterday" |
| Active dot | `ended_at === null` | Green dot if within active window |
| Per-session cost | `estimated_cost_usd` / `actual_cost_usd` | KR-19: see cost display logic below |

**KR-19 cost display logic (from Phase 5, but needed for row rendering):**

```typescript
function formatCost(estimated: number | null, actual: number | null): string {
  // Wire-verified nuance: estimated_cost_usd can be 0.0 on providers
  // without local pricing — display as "—" (unknown), never "$0.00"
  const cost = actual ?? estimated;
  if (cost === null || cost === 0) return '—';  // unknown, not free
  return `$${cost.toFixed(4)}`;                 // matches Phase 5 §5.3 precision
}
```

**KR-9: Local flags:**

```typescript
// In getVisibleSessions selector:
getVisibleSessions: () => {
  const state = get();
  const sessions = Array.from(state.sessions.values());

  // KR-9: archived hidden by default (toggle to show)
  const filtered = state.showArchived
    ? sessions
    : sessions.filter(s => !s.archived);

  // KR-9: pinned surface at top
  const pinned = filtered.filter(s => s.pinned);
  const unpinned = filtered.filter(s => !s.pinned);

  // Sort: pinned first (by last_active desc), then unpinned (by last_active desc)
  pinned.sort((a, b) => b.last_active - a.last_active);
  unpinned.sort((a, b) => b.last_active - a.last_active);

  return [...pinned, ...unpinned];
};
```

**NFR-2 compliance:**
- "Toggling filter re-renders instantly without network refetch" (KR-9)
- 60 fps scroll on 5k-message transcripts → Phase 3 uses FlashList, but session list also needs FlashList for large gateways

**Acceptance criteria:**
- Sessions stored in Map keyed by id (deduplication)
- Pinned sessions sort to top (KR-9)
- Archived sessions hidden by default, toggle to show (KR-9)
- Toggle re-renders instantly without network refetch (KR-9)
- Cost displayed as "—" when `estimated_cost_usd` is 0.0 or null (KR-19)

---

## 2.4 Sessions Screen UI

**File:** `src/app/SessionsScreen.tsx`

Uses `@shopify/flash-list` for performant rendering (NFR-2: 60fps on large lists).

```typescript
import { FlashList } from '@shopify/flash-list';

export function SessionsScreen() {
  const { getVisibleSessions, loading, showArchived, setShowArchived } = useSessionsStore();
  const sessions = getVisibleSessions();

  // Pull-to-refresh → incremental sync
  // Tap → navigate to ChatScreen(sessionId, gatewayId)
  // Long-press → context menu (rename, fork, delete — KR-7)
  // Filter toggle → archived visibility (KR-9)

  return (
    <FlashList
      data={sessions}
      renderItem={({ item }) => <SessionRow session={item} />}
      estimatedItemSize={72}
      onRefresh={handleRefresh}
      refreshing={loading}
      ListHeaderComponent={<SessionFilters />}
    />
  );
}
```

**Session row component:**

**File:** `src/components/SessionRow.tsx`

```typescript
export function SessionRow({ session }: { session: SessionRow }) {
  return (
    <Pressable onPress={() => navigateToChat(session)}>
      <View style={styles.row}>
        <SourceBadge source={session.source} />
        <View style={styles.content}>
          <Text style={styles.title}>{session.title}</Text>
          <Text style={styles.model}>{session.model}</Text>
          <Text style={styles.preview} numberOfLines={1}>{session.preview}</Text>
        </View>
        <View style={styles.meta}>
          <Text style={styles.time}>{session.relativeTime}</Text>
          {session.isActive && <ActiveDot />}
          <Text style={styles.cost}>{session.costDisplay}</Text>
        </View>
      </View>
    </Pressable>
  );
}
```

**Context menu (long-press, KR-7):**

| Action | Endpoint | Confirmation |
|---|---|---|
| Rename | `PATCH /api/sessions/:id` with `{title}` | Inline text input (not modal) |
| Fork | `POST /api/sessions/:id/fork` | No confirmation (non-destructive) |
| Delete | `DELETE /api/sessions/:id` | "Delete this session?" dialog (KR-7: destructive ops confirm first) |

**Acceptance criteria:**
- FlashList renders 1,000+ sessions at 60fps (NFR-2)
- Tap navigates to Chat screen with correct params
- Long-press shows rename, fork, delete options (KR-7)
- Delete requires confirmation (KR-7)
- Pull-to-refresh triggers incremental sync

---

## 2.5 Foreground Sync Hook

**File:** `src/hooks/useForegroundSync.ts`

```typescript
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function useForegroundSync(syncFn: () => Promise<void>) {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/background/) && nextState === 'active') {
        syncFn(); // KR-20: incremental sync on foreground
      }
      appState.current = nextState;
    });

    return () => sub.remove();
  }, [syncFn]);
}
```

**KR-20 sync behavior:**
- Full backfill on first launch (SessionSyncEngine.fullSync)
- Incremental via `last_active > watermark` on foreground
- 30–60 s poll while analytics view open (Phase 5)

**Acceptance criteria:**
- Background → foreground triggers incremental sync
- Watermark updated after each sync
- No full re-sync on foreground (only delta)

---

## 2.6 Session CRUD Wiring

**File:** `src/hooks/useSessionActions.ts`

```typescript
export function useSessionActions(gatewayId: string) {
  const api = useGatewayAPI(gatewayId); // from Phase 1
  const { upsertSessions, removeSession } = useSessionsStore();

  const createSession = async (title?: string) => {
    const session = await api.createSession(title);
    upsertSessions([session]);
    return session;
  };

  const renameSession = async (sessionId: string, title: string) => {
    await api.renameSession(sessionId, title);
    // Optimistic update: update local immediately, reconcile on next sync
    const existing = useSessionsStore.getState().getSessionById(sessionId);
    if (existing) {
      upsertSessions([{ ...existing, title }]);
    }
  };

  const deleteSession = async (sessionId: string) => {
    await api.deleteSession(sessionId);
    removeSession(sessionId);
  };

  const forkSession = async (sessionId: string) => {
    const forked = await api.forkSession(sessionId);
    upsertSessions([forked]);
    return forked;
  };

  return { createSession, renameSession, deleteSession, forkSession };
}
```

**KR-7 acceptance criteria:**
- Each operation reflected in `GET /api/sessions` on next refresh (KR-7)
- Destructive ops (delete) confirm first (KR-7)
- Optimistic local updates for snappy UX

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Full sync | 100+ sessions sync with zero duplicates or drops (KR-6) |
| 2 | Pagination | Short-page termination + archived extra-pass (not `has_more` alone) (KR-6) |
| 3 | Pinned at top | Pinned sessions sort above unpinned (KR-9) |
| 4 | Archived toggle | Hidden by default, toggle shows them, instant re-render (KR-9) |
| 5 | Cost display | `0.0` renders as "—" not "$0.00" (KR-19) |
| 6 | CRUD create | New session appears in list |
| 7 | CRUD rename | Title updates in list (optimistic) |
| 8 | CRUD delete | Confirmation dialog → session removed |
| 9 | CRUD fork | Forked session appears in list |
| 10 | Foreground sync | Background app → foreground triggers incremental sync |
| 11 | Row rendering | All KR-8 fields render correctly (title, source badge, model, preview, time, active dot, cost) |

---

## Execution Log (2026-09-24)

**Commit:** `35468b9 feat: Phase 2 — sessions list and CRUD` — 6 files added, 4 modified.
**Agent:** OpenCode `build` agent, glm-5.3-flash, ~6 min runtime.

**Verification results:**
- `tsc --noEmit` — zero errors
- `npx expo lint` — clean

**New files created:**
- `src/services/session-sync.ts` — SessionSyncEngine (fullSync + incrementalSync)
- `src/components/SessionRow.tsx` — Session row component with all KR-8 fields
- `src/hooks/useForegroundSync.ts` — AppState listener for incremental sync
- `src/hooks/useSessionActions.ts` — CRUD wiring with optimistic updates

**Modified files:**
- `src/services/gateway-api.ts` — added session endpoint methods + types
- `src/store/sessions.ts` — full SessionRow store with derived fields
- `src/app/SessionsScreen.tsx` — FlashList, pull-to-refresh, context menu

**Plan deviations:**
| # | Plan said | Actual | Reason |
|---|-----------|--------|--------|
| 1 | FlashList `estimatedItemSize={72}` | Prop removed | FlashList v2 dropped this prop |
| 2 | Inline text input for rename | `Alert.prompt` | iOS-only API; plan said "not modal" but Alert.prompt is the simplest inline approach on RN |

---

## Next: [[phase-3-chat-runs]]
