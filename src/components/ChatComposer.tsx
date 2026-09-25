import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { saveDraft, loadDraft, clearDraft } from '@/services/drafts';
import { pickImageForChat } from '@/services/image-picker';
import { promptQueue } from '@/services/prompt-queue';

const MAX_HEIGHT = 120;

export type ChatComposerProps = {
  sessionId: string;
  activeRun: boolean;
  /** Gateway supports steering (run_steer + run_stop caps). Default true. */
  steerSupported?: boolean;
  /** Normal send (runs when idle). */
  onSend: (text: string) => void;
  /** KR-14: mid-run steering. */
  onSteer: (text: string) => void;
  /** KR-16: defer message until after the active run completes. */
  onQueue: (text: string) => void;
  /** KR-17: image send (idle only — mid-run images are queued instead). */
  onSendImage: (text: string, dataUrl: string) => void;
  /** null = unknown; derived from /api/model/options vision metadata (KR-17). */
  modelSupportsVision?: boolean | null;
};

export function ChatComposer({
  sessionId,
  activeRun,
  steerSupported = true,
  onSend,
  onSteer,
  onQueue,
  onSendImage,
  modelSupportsVision,
}: ChatComposerProps) {
  const { tokens } = useTheme();
  // Draft restore is keyed by remount in ChatScreen (key={sessionId}) — the
  // useState initializer reads the persisted draft synchronously.
  const [text, setText] = useState(() => loadDraft(sessionId) ?? '');
  const [height, setHeight] = useState(0);
  const [pendingImage, setPendingImage] = useState<string | null>(null); // data URL (KR-17)
  const queuedCount = useSyncExternalStore(
    promptQueue.subscribe.bind(promptQueue),
    () => promptQueue.count(sessionId),
  );

  // KR-16: draft persistence — debounced save on text change
  useEffect(() => {
    const timer = setTimeout(() => saveDraft(sessionId, text), 500);
    return () => clearTimeout(timer);
  }, [text, sessionId]);

  const clearComposer = () => {
    setText('');
    setPendingImage(null);
    clearDraft(sessionId);
  };

  // KR-17: pick image → hold as pending data-URL until send
  const handlePickImage = async () => {
    const dataUrl = await pickImageForChat();
    if (dataUrl) setPendingImage(dataUrl);
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;

    // KR-17: image attached → image send path. Idle only; steering with
    // images is not supported — the text is enqueued instead mid-run.
    if (pendingImage && !activeRun) {
      onSendImage(trimmed, pendingImage);
      clearComposer();
      return;
    }

    if (!trimmed) {
      // Image pending but run active → queue the text (may be empty)
      return;
    }

    if (activeRun) {
      // Mid-run: send button steers (KR-14) when the gateway supports it;
      // otherwise it queues (NFR-4: hide unsupported, don't break). "Queue
      // instead" defers explicitly (KR-16).
      if (steerSupported) {
        onSteer(trimmed);
      } else {
        onQueue(trimmed);
      }
    } else {
      onSend(trimmed);
    }
    clearComposer();
  };

  return (
    <View
      style={[
        styles.composer,
        { borderColor: tokens.border, backgroundColor: tokens.card },
      ]}
    >
      <Pressable onPress={() => void handlePickImage()} style={styles.attachButton}>
        <Text style={{ color: tokens.accent }}>🖼</Text>
      </Pressable>

      <View style={{ flex: 1 }}>
        {/* KR-17: pending image chip with remove */}
        {pendingImage && (
          <View style={styles.pendingImageChip}>
            <Image
              source={{ uri: pendingImage }}
              style={[styles.pendingImageThumb, { backgroundColor: tokens.border }]}
            />
            <Pressable onPress={() => setPendingImage(null)}>
              <Text style={{ color: tokens.error }}>✖</Text>
            </Pressable>
          </View>
        )}
        {/* KR-17: client-side non-vision hint when a pending image + known
            non-vision model — derived from /api/model/options, never a
            hardcoded model-name list */}
        {pendingImage && modelSupportsVision === false && (
          <Text style={[styles.visionHint, { color: tokens.warning }]}>
            This model can&apos;t see images. It will reply with text only.
          </Text>
        )}

        <TextInput
          value={text}
          onChangeText={(t) => { setText(t); }}
          multiline
          onContentSizeChange={(e) => {
            const h = e.nativeEvent.contentSize.height;
            setHeight(Math.min(h, MAX_HEIGHT));
          }}
          style={[styles.input, { height: Math.max(MIN_INPUT_HEIGHT, height), color: tokens.text }]}
          placeholder={
            activeRun
              ? (steerSupported ? 'Steer the run, or queue…' : 'Run active — messages will be queued')
              : 'Message…'
          }
          placeholderTextColor={tokens.muted}
        />
      </View>

      <Pressable disabled={!text.trim()} onPress={handleSend}>
        <Text
          style={[
            styles.send,
            { color: text.trim() ? tokens.accent : tokens.muted },
          ]}
        >
          {activeRun ? (steerSupported ? 'Steer' : 'Queue') : 'Send'}
        </Text>
      </Pressable>

      {/* KR-16: queue action — only distinct from send when steering exists */}
      {activeRun && steerSupported && text.trim() && (
        <Pressable
          onPress={() => {
            promptQueue.enqueue(sessionId, text.trim());
            clearComposer();
          }}
          style={styles.queueButton}
        >
          <Text style={{ color: tokens.muted, fontSize: 11 }}>Queue instead</Text>
        </Pressable>
      )}

      {/* KR-16: queued count badge */}
      {queuedCount > 0 && (
        <Text style={[styles.queuedBadge, { color: tokens.accent }]}>
          {queuedCount} queued
        </Text>
      )}
    </View>
  );
}

const MIN_INPUT_HEIGHT = 40;

const styles = StyleSheet.create({
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 8,
    gap: 8,
  },
  attachButton: { paddingBottom: 10, paddingHorizontal: 4 },
  pendingImageChip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 8,
  },
  pendingImageThumb: { width: 44, height: 44, borderRadius: 6 },
  visionHint: { fontSize: 12, marginBottom: 4 },
  input: {
    flex: 1,
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_HEIGHT,
    fontSize: 15,
  },
  send: { fontWeight: '600', paddingBottom: 10, paddingLeft: 6 },
  queueButton: { paddingBottom: 10, paddingHorizontal: 2 },
  queuedBadge: {
    fontSize: 11,
    alignSelf: 'center',
    paddingHorizontal: 2,
    paddingBottom: 10,
  },
});
