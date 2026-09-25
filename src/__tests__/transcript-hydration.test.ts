/**
 * §5.3 Integration — Transcript hydration flow (KR-18).
 *
 * ChatScreen focus → getSessionMessages → hydrateMessages. The store action
 * and the focus-effect guard are exercised together: hydrate only fills an
 * EMPTY session (live/optimistic state always wins), maps SessionMessage[]
 * → ChatMessage[] via toChatMessage (tool→system role normalization,
 * epoch-seconds ×1000 timestamp normalization), and a failed fetch is
 * swallowed silently (TH-01…TH-03).
 */
import { useChatStore, type ChatMessage } from '@/store/chat';
import type { SessionMessage } from '@/services/gateway-api';

// === Mock api.getSessionMessages — TH fixtures map to ChatMessage the way
// ChatScreen.focusEffect does: toChatMessage inlines here (tool→system,
// epoch-seconds ×1000) so the store-level flow is asserted without pulling
// the full ChatScreen render tree in. ===

const getSessionMessages = jest.fn<Promise<SessionMessage[]>, [string]>();

function toChatMessage(m: SessionMessage, index: number): ChatMessage {
  const meta = m as SessionMessage & { id?: unknown; timestamp?: unknown; created_at?: unknown };
  const rawTs = typeof meta.timestamp === 'number'
    ? meta.timestamp
    : typeof meta.created_at === 'number'
      ? meta.created_at
      : Date.now();
  return {
    id: typeof meta.id === 'string' ? meta.id : `history:${index}`,
    // Tool transcript entries render as system notes in the chat transcript
    role: m.role === 'tool' ? 'system' : m.role,
    content: m.content,
    // Wire note: epoch-seconds vs ms unverified per §9a — normalize.
    timestamp: rawTs < 1e12 ? rawTs * 1000 : rawTs,
    isStreaming: false,
  };
}

/** ChatScreen focus effect (KR-18, audit C1) — hydrate only when empty. */
async function hydrateFromFocus(sessionId: string): Promise<void> {
  if (useChatStore.getState().getMessages(sessionId).length === 0) {
    void getSessionMessages(sessionId)
      .then((history) => {
        if (history.length > 0) {
          useChatStore.getState().hydrateMessages(
            sessionId,
            history.map(toChatMessage),
          );
        }
      })
      .catch(() => {
        // Offline / gateway error — next focus retries.
      });
  }
  await Promise.resolve();
}

const SESSION = 'sess_hydrate';

function resetStore(): void {
  useChatStore.setState({
    messagesBySession: new Map<string, ChatMessage[]>(),
    activeRuns: new Map(),
    approvals: new Map(),
  });
  getSessionMessages.mockReset();
}

describe('§5.3 Transcript hydration flow (KR-18)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('TH-01 hydrate only when session empty — seed store with 1 message → getSessionMessages NOT called', async () => {
    useChatStore.getState().addMessage(SESSION, {
      id: 'm1',
      role: 'assistant',
      content: 'hello',
      timestamp: 1234567890000,
      isStreaming: false,
    });

    await hydrateFromFocus(SESSION);

    expect(getSessionMessages).not.toHaveBeenCalled();
    expect(useChatStore.getState().getMessages(SESSION)).toHaveLength(1);
  });

  it('TH-02 gateway history renders after focus', async () => {
    getSessionMessages.mockResolvedValue([
      { role: 'assistant', content: 'hello from gateway', token_count: 100, created_at: 1758800060 },
      { role: 'tool', content: 'tool output', token_count: 10, timestamp: 1758800000 },
    ]);

    await hydrateFromFocus(SESSION);

    const msgs = useChatStore.getState().getMessages(SESSION);
    expect(msgs).toHaveLength(2);

    const assistant = msgs[0]!;
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBe('hello from gateway');
    expect(assistant.isStreaming).toBe(false);
    expect(assistant.id).toBe('history:0');
    expect(assistant.timestamp).toBe(1758800060 * 1000); // created_at ×1000

    const tool = msgs[1]!;
    expect(tool.role).toBe('system'); // tool → system normalization
    expect(tool.content).toBe('tool output');
    expect(tool.timestamp).toBe(1758800000 * 1000); // epoch-seconds ×1000
  });

  it('TH-03 hydrate failure → no crash, silent', async () => {
    getSessionMessages.mockRejectedValue(new Error('boom'));

    await expect(hydrateFromFocus(SESSION)).resolves.toBeUndefined();

    expect(getSessionMessages).toHaveBeenCalledWith(SESSION);
    expect(useChatStore.getState().getMessages(SESSION)).toHaveLength(0);
  });
});
