import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRoute, type RouteProp } from '@react-navigation/native';
import Markdown from 'react-native-markdown-display';
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import hljsStyle from 'react-syntax-highlighter/dist/esm/styles/hljs/atelier-dune-dark';
import { useTheme } from '@/theme/ThemeProvider';
import {
  useChatStore,
  loadTrackedRun,
  type ChatMessage,
} from '@/store/chat';
import { useGatewayAPI, useServices, useAnalyticsQueries } from './composition';
import { fetchModelPricing } from '@/analytics/cost-enrichment';
import { loadCapabilities, selectChatTransport } from '@/services/capabilities';
import { sendChatMessageFallback } from '@/services/session-chat-fallback';
import { promptQueue } from '@/services/prompt-queue';
import { showVisionWarning } from '@/services/vision';
import { v4 as uuidv4 } from 'uuid';
import { ApprovalCard } from '@/components/ApprovalCard';
import { ChatComposer } from '@/components/ChatComposer';
import { ToolActivityCard } from '@/components/ToolActivityCard';
import { useScrollBehavior } from '@/hooks/useScrollBehavior';
import type { RootStackParamList } from './navigation';

type ChatRoute = RouteProp<RootStackParamList, 'Chat'>;

const EMPTY: ChatMessage[] = [];

export default function ChatScreen() {
  const route = useRoute<ChatRoute>();
  const { sessionId, gatewayId } = route.params;
  const { tokens } = useTheme();
  const runsManager = useServices().runsManager;
  const analyticsDb = useServices().analyticsDb;
  const analyticsQueries = useAnalyticsQueries(gatewayId);
  const api = useGatewayAPI(gatewayId);

  const messages = useChatStore(s => s.messagesBySession.get(sessionId) ?? EMPTY);
  const activeRun = useChatStore(s => s.activeRuns.get(sessionId));
  const approval = useChatStore(s => s.approvals.get(sessionId));

  // KR-3: transport selection — runs primary, session-chat fallback
  const transport = useMemo(() => {
    const caps = loadCapabilities(gatewayId);
    return caps ? selectChatTransport(caps) : 'runs';
  }, [gatewayId]);

  // KR-11: Detach/reattach on focus — including after app relaunch. The read
  // of the MMKV tracked run happens inside the effect so it re-checks every
  // focus even if the store never held the active run in memory.
  useFocusEffect(
    useCallback(() => {
      // In-memory run OR a run persisted before relaunch (KR-11/13)
      if (useChatStore.getState().activeRuns.get(sessionId) || loadTrackedRun(sessionId)) {
        void runsManager.reattachRun(gatewayId, sessionId);
      }
    }, [gatewayId, sessionId, runsManager]),
  );

  // KR-13: restore pending approval card on relaunch (app-initiated runs only)
  useEffect(() => {
    void runsManager.restoreApprovalState(gatewayId, sessionId);
  }, [gatewayId, sessionId, runsManager]);

  // === KR-16: stick-to-bottom with manual-scroll escape hatch (4.4 hook) ===
  const lastContent = useChatStore(s => s.messagesBySession.get(sessionId)?.at(-1)?.content);
  const {
    listRef,
    onScrollBeginDrag,
    onScroll,
    scrollToBottom,
    showJumpToBottom,
  } = useScrollBehavior(messages, lastContent);

  const isRunActive = activeRun?.status === 'started' || activeRun?.status === 'running';

  // KR-17: derive vision capability from /api/model/options for the
  // current session's model — never a hardcoded non-vision list (4.7).
  const [modelSupportsVision, setModelSupportsVision] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [session, options] = await Promise.all([
          api.getSession(sessionId),
          api.getModelOptions(),
        ]);
        if (cancelled) return;
        setModelSupportsVision(
          session.model
            ? showVisionWarning(session.model, options)
            : null,
        );
      } catch {
        if (!cancelled) setModelSupportsVision(null); // unknown — don't warn
      }
    })();
    return () => { cancelled = true; };
  }, [api, sessionId]);

  // Phase 5 §5.3: refresh model pricing so ChatHeader enrichment stays live
  useEffect(() => {
    void fetchModelPricing(api, analyticsDb, analyticsQueries).catch(() => {
      // Silent — enrichment is best-effort; next sync retries
    });
  }, [api, analyticsDb, analyticsQueries]);

  const handleSend = useCallback(async (text: string) => {
    if (!text) return;
    if (!isRunActive) {
      if (transport === 'runs') {
        await runsManager.sendMessage(gatewayId, sessionId, text);
      } else {
        await sendViaSessionChatFallback(api, sessionId, text);
      }
    } else {
      // KR-14: mid-run — the send button steers the active run
      void runsManager.steer(gatewayId, sessionId, text);
    }
  }, [isRunActive, transport, gatewayId, sessionId, runsManager, api]);

  // KR-16: queue action from the composer
  const handleQueue = useCallback((text: string) => {
    if (text) promptQueue.enqueue(sessionId, text);
  }, [sessionId]);

  // KR-17: image send path — runs-only (KR-17a wire-verified over /v1/runs).
  const handleSendImage = useCallback(async (text: string, dataUrl: string) => {
    await runsManager.sendImageMessage(gatewayId, sessionId, text, dataUrl);
  }, [gatewayId, sessionId, runsManager]);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: tokens.background }]}
      edges={['bottom', 'left', 'right']}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
      >
        <FlashList
          ref={listRef}
          data={messages}
          renderItem={({ item }) => <MessageBubble message={item} />}
          keyExtractor={(m) => m.id}
          // KR-16: manual-scroll escape hatch + near-bottom re-enable
          onScrollBeginDrag={onScrollBeginDrag}
          onScroll={onScroll}
          scrollEventThrottle={100}
          ListFooterComponent={
            isRunActive ? <Text style={[styles.streaming, { color: tokens.accent }]}>Streaming…</Text> : null
          }
        />

        {showJumpToBottom && (
          <Pressable style={styles.jumpToBottom} onPress={scrollToBottom}>
            <Text style={[styles.jumpToBottomText, { color: tokens.accent }]}>
              ↓ New messages
            </Text>
          </Pressable>
        )}

        {approval && (
          <View style={styles.approvalDock}>
            <ApprovalCard
              approval={approval}
              onRespond={(d) => void runsManager.respondToApproval(gatewayId, sessionId, d)}
            />
          </View>
        )}

        <ChatComposer
          key={sessionId}
          sessionId={sessionId}
          activeRun={isRunActive}
          onSend={(t) => void handleSend(t)}
          onSteer={(t) => void handleSend(t)}
          onQueue={handleQueue}
          onSendImage={(t, url) => void handleSendImage(t, url)}
          modelSupportsVision={modelSupportsVision}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// === NFR-4 fallback send path ===

async function sendViaSessionChatFallback(
  api: ReturnType<typeof useGatewayAPI>,
  sessionId: string,
  text: string,
): Promise<void> {
  const store = useChatStore.getState();
  store.addMessage(sessionId, {
    id: uuidv4(),
    role: 'user',
    content: text,
    timestamp: Date.now(),
    isStreaming: false,
  });

  const assistantMessageId = uuidv4();
  store.addMessage(sessionId, {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
  });

  store.setActiveRun(sessionId, {
    runId: `fallback:${assistantMessageId}`,
    sessionId,
    status: 'running',
    idempotencyKey: '',
    startedAt: Date.now(),
  });

  const disconnect = await sendChatMessageFallback(
    api,
    sessionId,
    text,
    (delta) => useChatStore.getState().appendToMessage(sessionId, assistantMessageId, delta),
    () => {
      useChatStore.getState().updateMessage(sessionId, assistantMessageId, { isStreaming: false });
      useChatStore.getState().setActiveRun(sessionId, null);
    },
    (err) => {
      useChatStore.getState().updateMessage(sessionId, assistantMessageId, {
        isStreaming: false,
        error: true,
        content: `Connection error: ${err.message}`,
      });
      useChatStore.getState().setActiveRun(sessionId, null);
    },
  );

  // The disconnect function resolves async inside sendChatMessageFallback —
  // it is already resolved by the time this point is reached (await). Attach
  // cleanup through a placeholder ActiveRun update.
  const active = useChatStore.getState().activeRuns.get(sessionId);
  if (active?.runId === `fallback:${assistantMessageId}`) {
    useChatStore.getState().setActiveRun(sessionId, { ...active, disconnectFn: disconnect });
  }
}

// === Message rendering (KR-18) ===

function MessageBubble({ message }: { message: ChatMessage }) {
  const { tokens } = useTheme();

  if (message.role === 'system') {
    return (
      <Text style={[styles.systemText, { color: tokens.muted }]}>
        {message.content}
      </Text>
    );
  }

  return (
    <View
      style={[
        styles.bubble,
        message.role === 'user'
          ? { backgroundColor: tokens.accent, alignSelf: 'flex-end' }
          : { backgroundColor: tokens.card, alignSelf: 'flex-start' },
      ]}
    >
      {message.role === 'user' ? (
        <>
          {message.imageDataUrl && (
            <Image
              source={{ uri: message.imageDataUrl }}
              style={styles.sentImage}
            />
          )}
          {message.content !== '' && (
            <Text style={[styles.messageText, { color: tokens.background }]}>{message.content}</Text>
          )}
        </>
      ) : (
        <Markdown
          style={markdownStyles(tokens)}
          rules={{
            // KR-18: syntax-highlighted fenced code blocks
            fence: (node) => {
              const lang = (node as typeof node & { sourceInfo?: string }).sourceInfo;
              return (
                <ScrollView key={node.key} horizontal showsHorizontalScrollIndicator={false}>
                  <SyntaxHighlighter
                    language={(lang || 'plaintext').split(/\s+/)[0]}
                    style={hljsStyle}
                    useInlineStyles={false}
                  >
                    {node.content.replace(/\n$/, '')}
                  </SyntaxHighlighter>
                </ScrollView>
              );
            },
            code_inline: (node) => (
              <Text key={node.key} style={styles.inlineCode}>
                {node.content}
              </Text>
            ),
          }}
        >
          {message.content}
        </Markdown>
      )}
      {message.toolCalls?.map(tool => (
        <ToolActivityCard key={tool.id} tool={tool} />
      ))}
      {message.usage && (
        <Text style={[styles.usage, { color: tokens.muted }]}>
          {message.usage.inputTokens} in / {message.usage.outputTokens} out tokens
        </Text>
      )}
      {message.isStreaming && (
        <Text style={[styles.streaming, { color: tokens.accent }]} />
      )}
      {message.error && message.role === 'assistant' && !message.content && (
        <Text style={styles.errorTag}>No response — retry from the composer</Text>
      )}
      {message.error && message.content && message.role === 'user' && (
        <Text style={styles.errorTag} />
      )}
    </View>
  );
}

function markdownStyles(tokens: { text: string; accent: string; muted: string }): Record<string, TextStyle | ImageStyle> {
  return {
    body: { color: tokens.text },
    text: { color: tokens.text },
    strong: { color: tokens.text },
    heading1: { color: tokens.text, fontSize: 20, fontWeight: '700' as const },
    heading2: { color: tokens.text, fontSize: 18, fontWeight: '700' as const },
    heading3: { color: tokens.text, fontSize: 16, fontWeight: '600' as const },
    blockquote: { color: tokens.muted },
    paragraph: { marginTop: 0, marginBottom: 4 },
    fence: { backgroundColor: '#16181d' },
    code_inline: { color: tokens.accent, backgroundColor: 'rgba(127,127,127,0.2)' },
    // KR-17: images in assistant messages render inline (markdown ![alt](url))
    image: {
      width: 220,
      borderRadius: 8,
      marginVertical: 8,
      resizeMode: 'contain',
    },
  };
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    marginVertical: 4,
    marginHorizontal: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  messageText: { fontSize: 15, lineHeight: 21 },
  systemText: {
    fontSize: 13,
    fontStyle: 'italic',
    marginHorizontal: 16,
    marginVertical: 2,
    opacity: 0.8,
  },
  inlineCode: {
    fontSize: 14,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  sentImage: {
    width: 220,
    height: 220,
    borderRadius: 8,
    resizeMode: 'cover',
    marginBottom: 6,
  },
  jumpToBottom: {
    position: 'absolute',
    bottom: 8,
    alignSelf: 'center',
    backgroundColor: 'rgba(22,27,34,0.95)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  jumpToBottomText: { fontSize: 13, fontWeight: '600' },
  usage: { fontSize: 11, marginTop: 6 },
  streaming: { textAlign: 'center', fontSize: 13, paddingBottom: 6 },
  errorTag: { fontSize: 11, color: '#e17055', marginTop: 4 },
  approvalDock: { paddingHorizontal: 12, paddingBottom: 4 },
});
