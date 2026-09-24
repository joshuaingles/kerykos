import { create } from 'zustand';
import { createMMKV } from 'react-native-mmkv';
import type { RunStatus } from '@/services/gateway-api';

// MMKV instance for chat/run persistence (KR-11/KR-13 relaunch continuity).
// react-native-mmkv v4: factory function, not constructor.
export const chatMmkv = createMMKV({ id: 'kerykos-chat' });

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  state: 'running' | 'completed' | 'failed';
  collapsed: boolean;     // KR-15: collapse/expand
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming: boolean;
  toolCalls?: ToolCall[];
  runId?: string;         // associated run
  isSteered?: boolean;    // steer correction applied
  usage?: RunUsage;       // KR-18: captured from run.completed's usage block
  error?: boolean;        // rendered as error notice (NFR-3)
  imageDataUrl?: string;  // KR-17: image the user attached to this message
}

export interface ActiveRun {
  runId: string;
  sessionId: string;
  status: RunStatus;
  idempotencyKey: string;
  startedAt: number;
  disconnectFn?: () => void;  // SSE disconnection
}

export interface ApprovalRequest {
  runId: string;
  message: string;
  responded: boolean;
  decision?: 'approve' | 'deny';
}

// === Run persistence (MMKV) — KR-11/KR-13 relaunch continuity ===
// Wire-verified (smoke-test #11): a known run_id stays addressable across a
// gateway restart — status GET → 404 only because the in-memory owner map
// resets; runs are durable and remain resumable. Persisting run_id per
// session is what makes detach/reattach (KR-11) and pending approval cards
// (KR-13) survive an app relaunch.
const ACTIVE_RUNS_KEY = 'active_runs'; // stored in MMKV instance id 'kerykos-chat'

export interface TrackedRun {
  runId: string;
  sessionId: string;
  idempotencyKey: string;
  startedAt: number;
}

export function loadTrackedRuns(): Record<string, TrackedRun> {
  const raw = chatMmkv.getString(ACTIVE_RUNS_KEY);
  return raw ? (JSON.parse(raw) as Record<string, TrackedRun>) : {};
}

export function loadTrackedRun(sessionId: string): TrackedRun | null {
  return loadTrackedRuns()[sessionId] ?? null;
}

export function persistActiveRun(sessionId: string, run: TrackedRun): void {
  const map = loadTrackedRuns();
  map[sessionId] = run;
  chatMmkv.set(ACTIVE_RUNS_KEY, JSON.stringify(map));
}

export function clearActiveRun(sessionId: string): void {
  const map = loadTrackedRuns();
  if (map[sessionId]) {
    delete map[sessionId];
    chatMmkv.set(ACTIVE_RUNS_KEY, JSON.stringify(map));
  }
}

interface ChatState {
  // Per-session message history
  messagesBySession: Map<string, ChatMessage[]>;

  // Active runs (keyed by session id)
  activeRuns: Map<string, ActiveRun>;

  // Pending approvals (keyed by session id)
  approvals: Map<string, ApprovalRequest>;

  // Actions
  addMessage: (sessionId: string, message: ChatMessage) => void;
  updateMessage: (sessionId: string, messageId: string, update: Partial<ChatMessage>) => void;
  appendToMessage: (sessionId: string, messageId: string, delta: string) => void;
  setActiveRun: (sessionId: string, run: ActiveRun | null) => void;
  updateRunStatus: (sessionId: string, status: RunStatus) => void;
  addToolCall: (sessionId: string, messageId: string, tool: ToolCall) => void;
  updateToolCall: (sessionId: string, toolId: string, update: Partial<ToolCall>) => void;
  setApproval: (sessionId: string, approval: ApprovalRequest | null) => void;

  // Selectors (stable references — safe in zustand selectors)
  getMessages: (sessionId: string) => ChatMessage[];
  getActiveRun: (sessionId: string) => ActiveRun | undefined;
  getPendingApproval: (sessionId: string) => ApprovalRequest | undefined;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

export const useChatStore = create<ChatState>((set, get) => ({
  messagesBySession: new Map<string, ChatMessage[]>(),
  activeRuns: new Map<string, ActiveRun>(),
  approvals: new Map<string, ApprovalRequest>(),

  addMessage: (sessionId, message) => set((state) => {
    const msgs = state.messagesBySession.get(sessionId) ?? [];
    const next = new Map(state.messagesBySession);
    next.set(sessionId, [...msgs, message]);
    return { messagesBySession: next };
  }),

  updateMessage: (sessionId, messageId, update) => set((state) => {
    const msgs = state.messagesBySession.get(sessionId);
    if (!msgs) return state;
    const next = new Map(state.messagesBySession);
    next.set(sessionId, msgs.map(m => (m.id === messageId ? { ...m, ...update } : m)));
    return { messagesBySession: next };
  }),

  appendToMessage: (sessionId, messageId, delta) => set((state) => {
    const msgs = state.messagesBySession.get(sessionId);
    if (!msgs) return state;
    const next = new Map(state.messagesBySession);
    next.set(sessionId, msgs.map(m =>
      m.id === messageId ? { ...m, content: m.content + delta } : m
    ));
    return { messagesBySession: next };
  }),

  setActiveRun: (sessionId, run) => set((state) => {
    const next = new Map(state.activeRuns);
    if (run) next.set(sessionId, run);
    else next.delete(sessionId);
    return { activeRuns: next };
  }),

  updateRunStatus: (sessionId, status) => set((state) => {
    const run = state.activeRuns.get(sessionId);
    if (run) {
      const next = new Map(state.activeRuns);
      next.set(sessionId, { ...run, status });
      return { activeRuns: next };
    }
    return state;
  }),

  addToolCall: (sessionId, messageId, tool) => set((state) => {
    const msgs = state.messagesBySession.get(sessionId);
    if (!msgs) return state;
    const next = new Map(state.messagesBySession);
    next.set(sessionId, msgs.map(m => {
      if (m.id !== messageId) return m;
      // Dedup by tool id (tool.progress may repeat for one call)
      const existing = m.toolCalls ?? [];
      if (existing.some(t => t.id === tool.id)) return m;
      return { ...m, toolCalls: [...existing, tool] };
    }));
    return { messagesBySession: next };
  }),

  updateToolCall: (sessionId, toolId, update) => set((state) => {
    const msgs = state.messagesBySession.get(sessionId);
    if (!msgs) return state;
    const next = new Map(state.messagesBySession);
    next.set(sessionId, msgs.map(m => {
      if (!m.toolCalls?.some(t => t.id === toolId)) return m;
      return {
        ...m,
        toolCalls: m.toolCalls.map(t => (t.id === toolId ? { ...t, ...update } : t)),
      };
    }));
    return { messagesBySession: next };
  }),

  setApproval: (sessionId, approval) => set((state) => {
    const next = new Map(state.approvals);
    if (approval) next.set(sessionId, approval);
    else next.delete(sessionId);
    return { approvals: next };
  }),

  getMessages: (sessionId) => get().messagesBySession.get(sessionId) ?? EMPTY_MESSAGES,
  getActiveRun: (sessionId) => get().activeRuns.get(sessionId),
  getPendingApproval: (sessionId) => get().approvals.get(sessionId),
}));
