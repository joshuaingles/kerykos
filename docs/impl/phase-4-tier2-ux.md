# Phase 4 — Tier 2 UX Differentiators

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-4 #tier2 #ux

**Purpose:** Polish the chat surface with Tier 2 features: multi-line composer, prompt queue, inline images (send + receive), tool activity cards, draft persistence, and stick-to-bottom behavior. All build on the working chat from Phase 3.

**KR/NFR coverage:** KR-15, KR-16, KR-17, KR-17a (CLOSED), KR-18, NFR-2

**Demand source:** Talaria PARITY.md gaps (critical/high items) — these are the features Talaria users ask for that don't exist yet.

---

## 4.1 Multi-Line Growing Composer (KR-16)

**File:** `src/components/ChatComposer.tsx`

Talaria PARITY.md rates this as **critical**. The composer must:
- Grow vertically as user types (up to a max height, then scroll internally)
- Support Shift+Enter for newlines, Enter to send (configurable)
- Always editable during an active run — mid-run sends STEER the run (KR-14); a secondary "Queue instead" action defers to after completion (KR-16)

```typescript
import { TextInput } from 'react-native';

export function ChatComposer({ sessionId, activeRun, onSend, onSteer, onSendImage, modelSupportsVision }: {
  sessionId: string;
  activeRun: boolean;              // true while a run is in flight
  onSend: (text: string) => void;   // normal send (runs when idle)
  onSteer: (text: string) => void;  // KR-14: mid-run steering
  onSendImage: (text: string, dataUrl: string) => void; // KR-17: image send
  modelSupportsVision?: boolean | null; // null = unknown; from model options
}) {
  const [text, setText] = useState('');
  const [height, setHeight] = useState(40); // initial height
  const [pendingImage, setPendingImage] = useState<string | null>(null); // data URL (KR-17)
  const MAX_HEIGHT = 120;

  // KR-17: pick image → hold as pending data-URL until send
  const handlePickImage = async () => {
    const dataUrl = await pickImageForChat();
    if (dataUrl) setPendingImage(dataUrl);
  };

  const clearComposer = () => {
    setText('');
    setPendingImage(null);
    clearDraft(sessionId);
  };

  // KR-16: Draft persistence — save on text change
  useEffect(() => {
    const timer = setTimeout(() => {
      saveDraft(sessionId, text);
    }, 500); // debounce 500ms
    return () => clearTimeout(timer);
  }, [text, sessionId]);

  // Load draft on mount
  useEffect(() => {
    const draft = loadDraft(sessionId);
    if (draft) setText(draft);
  }, [sessionId]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed && !pendingImage) return;

    // KR-17: image attached → image send path (idle only; steering with
    // images is not supported — enqueue instead mid-run)
    if (pendingImage && !activeRun) {
      onSendImage(trimmed, pendingImage);
      clearComposer();
      return;
    }

    if (activeRun) {
      // Mid-run: user chooses steer (KR-14) vs queue (KR-16).
      // Default UI: "Steer" sends the correction to the active run;
      // a secondary "Queue" action defers it to after completion.
      onSteer(trimmed);
    } else {
      onSend(trimmed);
    }
    clearComposer();
  };

  return (
    <View style={styles.composer}>
      <TouchableOpacity onPress={handlePickImage} style={styles.attachButton}>
        <Icon name="image" />
      </TouchableOpacity>
      {/* KR-17: pending image chip with remove — send via handleSend */}
      {pendingImage && (
        <View style={styles.pendingImageChip}>
          <Image source={{ uri: pendingImage }} style={styles.pendingImageThumb} />
          <TouchableOpacity onPress={() => setPendingImage(null)}>
            <Icon name="x" />
          </TouchableOpacity>
        </View>
      )}
      {/* KR-17: client-side non-vision hint when a pending image + known
          non-vision model — derive from /api/model/options, never a hardcoded
          model-name list */}
      {pendingImage && modelSupportsVision === false && (
        <Text style={styles.visionHint}>This model can't see images.</Text>
      )}
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        onContentSizeChange={(e) => {
          setHeight(Math.min(e.nativeEvent.contentSize.height, MAX_HEIGHT));
        }}
        style={[styles.input, { height }]}
        placeholder={activeRun ? "Steer the active run, or queue…" : "Type a message..."}
        editable={true} // always editable — steer (KR-14) and queue (KR-16) both work mid-run
      />
      <TouchableOpacity
        onPress={handleSend}
        disabled={!text.trim()}
        style={styles.sendButton}
      >
        <Icon name={activeRun ? "route" : "send"} />
      </TouchableOpacity>
      {activeRun && text.trim() && (
        <TouchableOpacity
          onPress={() => { promptQueue.enqueue(sessionId, text.trim()); clearComposer(); }}
          style={styles.queueButton}
        >
          <Text>Queue instead</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
```

**Acceptance criteria (KR-16):**
- Composer grows vertically as text increases (up to max, then internal scroll)
- Always editable even during active run (for prompt queue)
- Send button disabled when text is empty

---

## 4.2 Prompt Queue (KR-16)

**File:** `src/services/prompt-queue.ts`

Talaria PARITY.md rates as **critical**. Enqueue messages while a run is active → auto-submit after current run completes.

```typescript
interface QueuedPrompt {
  id: string;
  sessionId: string;
  content: string;
  enqueuedAt: number;
}

class PromptQueue {
  private queue: QueuedPrompt[] = [];

  enqueue(sessionId: string, content: string): void {
    this.queue.push({
      id: uuidv4(),
      sessionId,
      content,
      enqueuedAt: Date.now(),
    });
  }

  /** Get next queued prompt for a session. Returns null if empty. */
  dequeue(sessionId: string): QueuedPrompt | null {
    const idx = this.queue.findIndex(p => p.sessionId === sessionId);
    if (idx === -1) return null;
    return this.queue.splice(idx, 1)[0];
  }

  /** Check if session has queued prompts. */
  hasQueued(sessionId: string): boolean {
    return this.queue.some(p => p.sessionId === sessionId);
  }

  /** Get count for UI badge. */
  count(sessionId: string): number {
    return this.queue.filter(p => p.sessionId === sessionId).length;
  }

  /** Clear queue for a session. */
  clear(sessionId: string): void {
    this.queue = this.queue.filter(p => p.sessionId !== sessionId);
  }
}

export const promptQueue = new PromptQueue();
```

**Auto-submit after run completes (wire into RunsManager):**

```typescript
// In RunsManager.handleSSEEvent, after run.completed:
case 'run.completed':
  this.store.updateMessage(sessionId, messageId, { isStreaming: false });
  this.store.updateRunStatus(sessionId, 'completed');
  this.store.setActiveRun(sessionId, null);

  // KR-16: Auto-submit next queued prompt
  const next = promptQueue.dequeue(sessionId);
  if (next) {
    await this.sendMessage(sessionId, next.content);
  }
  break;
```

**Acceptance criteria (KR-16):**
- User can type while a run is active
- Queued prompt auto-submits when run completes
- Queue persists across run boundaries (not cleared on single completion)
- UI shows queued count indicator

---

## 4.3 Draft Persistence (KR-16)

**File:** `src/services/drafts.ts`

Talaria PARITY.md rates as **high**. Draft must survive app kill (lossless per session).

```typescript
import { MMKV } from 'react-native-mmkv';

const drafts = new MMKV({ id: 'kerykos-drafts' });

export function saveDraft(sessionId: string, text: string): void {
  if (text.trim()) {
    drafts.set(`draft_${sessionId}`, text);
  } else {
    drafts.delete(`draft_${sessionId}`);
  }
}

export function loadDraft(sessionId: string): string | null {
  return drafts.getString(`draft_${sessionId}`) ?? null;
}

export function clearDraft(sessionId: string): void {
  drafts.delete(`draft_${sessionId}`);
}
```

**Storage:** MMKV (not SQLite) — fast KV, survives app kill, no schema needed.

**Acceptance criteria (KR-16):**
- Draft persisted per session in MMKV
- Draft survives app kill (lossless)
- Draft cleared on successful send
- Debounced save (500ms) to avoid excessive writes

---

## 4.4 Stick-to-Bottom with Manual-Scroll Escape (KR-16)

**File:** `src/hooks/useScrollBehavior.ts`

Talaria PARITY.md rates as **critical**.

```typescript
import { useRef, useCallback, useEffect } from 'react';

export function useScrollBehavior<T>(messages: T[]) {
  const listRef = useRef<FlashList<T>>(null);
  const autoScrollRef = useRef(true);
  const prevLengthRef = useRef(0);

  // Auto-scroll when new messages arrive (if user hasn't manually scrolled)
  useEffect(() => {
    if (messages.length > prevLengthRef.current && autoScrollRef.current) {
      // Small delay to let the new item render
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: true });
      });
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Escape hatch: user manually scrolls up → stop auto-scroll
  const onScrollBeginDrag = useCallback(() => {
    autoScrollRef.current = false;
  }, []);

  // Return to bottom button: tap → re-enable auto-scroll + scroll to end
  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  // Re-enable auto-scroll when user is near bottom
  // (NativeScrollEvent — no `any`, per phase-0's no-explicit-any gate)
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    if (distanceFromBottom < 100) {
      autoScrollRef.current = true;
    }
  }, []);

  return {
    listRef,
    onScrollBeginDrag,
    onScroll,
    scrollToBottom,
    isAtBottom: autoScrollRef.current,
  };
}
```

**UI: "Return to bottom" button appears when user has scrolled up:**

```typescript
{!isAtBottom && (
  <TouchableOpacity style={styles.scrollToBottomBtn} onPress={scrollToBottom}>
    <Icon name="arrow-down" />
    <Text>New messages</Text>
  </TouchableOpacity>
)}
```

**Acceptance criteria (KR-16):**
- New messages auto-scroll to bottom
- Manual scroll up disables auto-scroll
- "Return to bottom" button appears when scrolled up
- Tapping button re-enables auto-scroll and scrolls to end
- Near-bottom detection (within 100px) re-enables auto-scroll

---

## 4.5 Inline Images — Send (KR-17)

**File:** `src/services/image-picker.ts`

Wire-verified (KR-17a CLOSED, smoke-test #8): image parts over `/v1/runs` accepted and completed.

```typescript
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';

/**
 * Pick image from camera or library and convert to base64 data URL.
 * Used for sending photos in chat (KR-17).
 */
export async function pickImageForChat(): Promise<string | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    // SDK 57: MediaTypeOptions is deprecated — array form is current.
    // ⚠️ Verify against the installed expo-image-picker at impl time per §9a.
    mediaTypes: ['images'],
    quality: 0.8, // compress for network
    base64: true,
  });

  if (result.canceled || !result.assets[0]) return null;

  const asset = result.assets[0];

  // Read as base64 if not already
  let base64 = asset.base64;
  if (!base64) {
    base64 = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  }

  // Determine MIME type from URI
  const ext = asset.uri.split('.').pop()?.toLowerCase() ?? 'jpeg';
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

  // Return as data URL (KR-17 format)
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Format image for /v1/runs input (KR-17a, wire-verified).
 * input:[{role:"user", content:[text + image_url]}]
 */
export function formatImageContent(
  text: string,
  dataUrl: string,
): RunCreateRequest['input'] {
  return [{
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];
}
```

**Wire-verified behavior (smoke-test #8):**
- `POST /v1/runs` with `input:[{role:user, content:[text + image_url(data-URL)]}]` → accepted + completed
- Image send is runs-primary (KR-17a CLOSED)
- 12MP photo (~2-4 MB base64) sends successfully

**Acceptance criteria (KR-17):**
- Photo picker launches from composer attach button
- Image converted to base64 `data:image/...` URL
- Sent as `image_url` part in runs input (KR-17a format)
- 12MP photo (~2-4 MB) sends successfully

---

## 4.6 Inline Images — Receive (KR-17)

Images in assistant messages render inline. The markdown renderer handles this:

```typescript
// In ChatMessage component, markdown style overrides:
const markdownStyles = {
  image: {
    maxWidth: '100%',
    borderRadius: 8,
    marginVertical: 8,
  },
};

// Markdown renderer automatically handles ![alt](url) syntax
// Images from assistant messages arrive as markdown image syntax
```

**Acceptance criteria (KR-17):**
- Images in assistant messages render inline
- Images are scrollable within the chat
- Tap to expand (stretch goal, not blocking v1)

---

## 4.7 Non-Vision Model Graceful Degradation (KR-17)

Wire-verified (smoke-test #8b): non-vision model degrades gracefully to text.

```typescript
// When sending an image, check if model supports vision
// Wire-verified behavior (smoke-test #8b): text-only response + client-side
// "this model can't see images" hint.
//
// ⚠️ NEVER hardcode a non-vision model list — derive from /api/model/options
// vision metadata (see ModelOptionsResponse in phase-1). The composer receives
// modelSupportsVision: boolean | null and shows the hint when === false.

export function showVisionWarning(model: string, modelOptions: ModelOptionsResponse): boolean | null {
  // Returns: true = warning, false = known vision-capable, null = unknown
  const entry = modelOptions.models?.find(m => m.id === model);
  if (!entry || entry.vision === undefined) return null; // unknown — don't warn
  return !entry.vision;
}
```

**Acceptance criteria (KR-17):**
- Sending image to non-vision model shows client-side warning
- Message still sends (server returns text-only response gracefully)
- Warning text: "This model can't see images"

---

## 4.8 Tool Activity Cards (KR-15)

**File:** `src/components/ToolActivityCard.tsx`

Talaria PARITY.md rates as **critical**. Tool cards render inline without interrupting message flow.

```typescript
export function ToolActivityCard({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(!tool.collapsed);

  return (
    <TouchableOpacity
      style={styles.toolCard}
      onPress={() => setExpanded(!expanded)}
    >
      <View style={styles.toolHeader}>
        <ActivityIndicator
          size="small"
          animating={tool.state === 'running'}
          color={tool.state === 'failed' ? tokens.error : tokens.accent}
        />
        <Text style={styles.toolName}>{tool.name}</Text>
        <Text style={styles.toolState}>
          {tool.state === 'running' ? '⏳' : tool.state === 'failed' ? '❌' : '✅'}
        </Text>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
      </View>
      {expanded && (
        <View style={styles.toolBody}>
          {/* Tool input/output would go here if available from SSE events */}
          <Text style={styles.toolDetail}>{tool.name} completed</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}
```

**KR-15 acceptance criteria:**
- Tool name displayed
- Running/failed/completed state indicator
- Collapse/expand toggle (default collapsed)
- Inline in message flow (not modal, not interrupting)

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Multi-line composer | Type multiple lines → composer grows vertically (KR-16) |
| 2 | Prompt queue | Type during active run → queued → auto-submits after (KR-16) |
| 3 | Draft persistence | Type partial message → kill app → relaunch → draft restored (KR-16) |
| 4 | Stick-to-bottom | New messages auto-scroll → manual scroll up → escape (KR-16) |
| 5 | Return to bottom | Scroll up → "New messages" button appears → tap scrolls down (KR-16) |
| 6 | Image send | Pick photo → base64 → sent via runs → completed (KR-17, KR-17a) |
| 7 | Image receive | Assistant message with image → renders inline (KR-17) |
| 8 | Non-vision warning | Send image to non-vision model → client-side warning (KR-17) |
| 9 | Tool cards | Tool events render as collapsible cards (KR-15) |
| 10 | Tool card collapse | Default collapsed, tap to expand (KR-15) |

---

## Next: [[phase-5-cost-analytics]]
