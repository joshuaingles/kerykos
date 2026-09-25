/**
 * §3.1 ChatComposer — send/steer/queue state machine (KR-14, KR-16, KR-17).
 *
 * The composer is the send-path front door: idle → runs; mid-run → steer or
 * queue; images only when idle. Draft persistence is KR-16 (MMKV backend,
 * debounced 500ms with flush-only guarantee).
 */
import { fireEvent, waitFor, act } from '@testing-library/react-native';
import { renderThemeProvider, resetMMKV } from '@/test/helpers';
import { ChatComposer } from '@/components/ChatComposer';
import { promptQueue } from '@/services/prompt-queue';
import { saveDraft, loadDraft } from '@/services/drafts';

// The composer consumes pickImageForChat(image-picker) — a module mock keeps
// the native expo-media machinery out of the render tree (§0 mock table).
jest.mock('@/services/image-picker', () => ({
  pickImageForChat: jest.fn(),
  formatImageContent: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-unsafe-require
const { pickImageForChat } = require('@/services/image-picker') as { pickImageForChat: jest.Mock };

const SESSION = 'sess_1';
const DATA_URL = `data:image/png;base64,${'Q'.repeat(40)}`;

interface ComposerCtrls {
  activeRun?: boolean;
  steerSupported?: boolean;
  modelSupportsVision?: boolean | null;
}

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

/** The controlled TextInput value — read straight off the host element. */
function inputValue(screen: Screen): string | null | undefined {
  const input = screen.getByPlaceholderText(/Message|Steer the run|Run active/) as unknown as {
    props: { value?: string | null };
  };
  return input.props.value;
}

describe('§3.1 ChatComposer', () => {
  let onSend: jest.Mock;
  let onSteer: jest.Mock;
  let onQueue: jest.Mock;
  let onSendImage: jest.Mock;

  beforeEach(() => {
    resetMMKV(); // drafts store clears with all fake MMKV instances
    promptQueue.clear(SESSION);
    onSend = jest.fn();
    onSteer = jest.fn();
    onQueue = jest.fn();
    onSendImage = jest.fn();
  });

  afterEach(() => {
    promptQueue.clear(SESSION);
  });

  const compose = (ctrls: ComposerCtrls = {}): Promise<Screen> =>
    renderThemeProvider(
      <ChatComposer
        sessionId={SESSION}
        activeRun={ctrls.activeRun ?? false}
        steerSupported={ctrls.steerSupported}
        modelSupportsVision={ctrls.modelSupportsVision}
        onSend={onSend}
        onSteer={onSteer}
        onQueue={onQueue}
        onSendImage={onSendImage}
      />,
    );

  describe('idle', () => {
    it('send → onSend(trimmed), composer cleared (§3.1 test 1)', async () => {
      const screen = await compose();

      await fireEvent.changeText(screen.getByPlaceholderText('Message…'), '  hello world  ');
      await fireEvent.press(screen.getByText('Send'));

      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('hello world');
      expect(onSteer).not.toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
      expect(onSendImage).not.toHaveBeenCalled();
      expect(inputValue(screen)).toBe('');
    });

    it('send clears the persisted draft (clearDraft on send)', async () => {
      saveDraft(SESSION, 'draft-into-mm');
      const screen = await compose();
      expect(inputValue(screen)).toBe('draft-into-mm'); // restore path live

      await fireEvent.press(screen.getByText('Send'));
      expect(inputValue(screen)).toBe('');
      expect(loadDraft(SESSION)).toBeNull();
    });
  });

  it('empty input + no image → send disabled (§3.1 test 2)', async () => {
    const screen = await compose();

    const send = screen.getByText('Send');
    await act(async () => {
      await fireEvent.press(send);
    }); // disabled Pressable must swallow the press

    expect(onSend).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSendImage).not.toHaveBeenCalled();
  });

  describe('mid-run (KR-14 / KR-16)', () => {
    it('activeRun + steerSupported → label Steer; press → onSteer (§3.1 test 3)', async () => {
      const screen = await compose({ activeRun: true, steerSupported: true });

      expect(screen.getByText('Steer')).toBeTruthy();
      expect(screen.queryByText('Send')).toBeNull();

      await fireEvent.changeText(screen.getByPlaceholderText('Steer the run, or queue…'), 'go faster');
      await fireEvent.press(screen.getByText('Steer'));

      expect(onSteer).toHaveBeenCalledWith('go faster');
      expect(onSend).not.toHaveBeenCalled();
      expect(inputValue(screen)).toBe('');
    });

    it('activeRun + !steerSupported (NFR-4) → label Queue; press → onQueue (§3.1 test 4)', async () => {
      const screen = await compose({ activeRun: true, steerSupported: false });

      expect(screen.getByText('Queue')).toBeTruthy();
      expect(screen.getByPlaceholderText('Run active — messages will be queued')).toBeTruthy();

      await fireEvent.changeText(screen.getByPlaceholderText('Run active — messages will be queued'), 'retry that');
      await fireEvent.press(screen.getByText('Queue'));

      expect(onQueue).toHaveBeenCalledWith('retry that');
      expect(onSteer).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
    });

    it('activeRun + steerSupported + text → "Queue instead" separate enqueue path (§3.1 test 5)', async () => {
      const screen = await compose({ activeRun: true });

      await fireEvent.changeText(screen.getByPlaceholderText('Steer the run, or queue…'), 'queue me instead');
      expect(screen.getByText('Queue instead')).toBeTruthy();

      await fireEvent.press(screen.getByText('Queue instead'));

      // §3.1: assert via the real queue — this is a distinct path from steer
      expect(promptQueue.count(SESSION)).toBe(1);
      expect(promptQueue.hasQueued(SESSION)).toBe(true);
      expect(promptQueue.dequeue(SESSION)!.content).toBe('queue me instead');
      expect(onSteer).not.toHaveBeenCalled();
      // Queue instead also clears the composer
      expect(inputValue(screen)).toBe('');
      expect(screen.queryByText('Queue instead')).toBeNull();
    });

    it('queued badge shows count via the real promptQueue (§3.1)', async () => {
      const screen = await compose({ activeRun: true });

      promptQueue.enqueue(SESSION, 'first');
      promptQueue.enqueue(SESSION, 'second');
      expect(await screen.findByText('2 queued')).toBeTruthy();

      // Queues for other sessions must not affect this badge
      promptQueue.enqueue('other_session', 'noise');
      await act(async () => {});
      expect(screen.queryByText('3 queued')).toBeNull();
      expect(screen.getByText('2 queued')).toBeTruthy();
    });
  });

  describe('KR-17 image path', () => {
    /** Press the attach 🖼 button and let the (mocked) picker resolve. */
    const attachImage = async (screen: Screen): Promise<Screen> => {
      pickImageForChat.mockResolvedValueOnce(DATA_URL);
      await act(async () => {
        await fireEvent.press(screen.getByText('🖼'));
      });
      return screen;
    };

    it('pendingImage + idle → onSendImage(text, dataUrl) (§3.1 test 6)', async () => {
      const screen = await compose();
      await attachImage(screen);

      // Pending image chip is visible with a remove affordance
      expect(screen.getByText('✖')).toBeTruthy();

      await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'check this out');
      await fireEvent.press(screen.getByText('Send'));

      expect(onSendImage).toHaveBeenCalledTimes(1);
      expect(onSendImage).toHaveBeenCalledWith('check this out', DATA_URL);
      expect(onSend).not.toHaveBeenCalled();
      // Composer cleared after the image send
      expect(screen.queryByText('✖')).toBeNull();
      expect(inputValue(screen)).toBe('');
    });

    it('pick canceled → no pending chip', async () => {
      const screen = await compose();
      pickImageForChat.mockResolvedValueOnce(null);

      await act(async () => {
        await fireEvent.press(screen.getByText('🖼'));
      });

      expect(screen.queryByText('✖')).toBeNull();
    });

    it('pendingImage + activeRun → text queued (onQueue), image dropped (§3.1 test 7)', async () => {
      const screen = await compose({ activeRun: true, steerSupported: false });
      await attachImage(screen);

      await fireEvent.changeText(screen.getByPlaceholderText('Run active — messages will be queued'), 'queued with photo');
      await fireEvent.press(screen.getByText('Queue'));

      // KR-17 mid-run rule: images are never sent mid-run — the text is
      // queued instead and the pending image is dropped.
      expect(onQueue).toHaveBeenCalledWith('queued with photo');
      expect(onSendImage).not.toHaveBeenCalled();
      expect(screen.queryByText('✖')).toBeNull();
      expect(inputValue(screen)).toBe('');
    });

    it('pendingImage + non-vision model → hint text rendered (§3.1 test 8)', async () => {
      const screen = await compose({ modelSupportsVision: false });
      await attachImage(screen);

      expect(screen.getByText(/can't see images/)).toBeTruthy();
    });

    it('pendingImage + vision-unknown model → no hint', async () => {
      const screen = await compose({ modelSupportsVision: null });
      await attachImage(screen);

      expect(screen.queryByText(/can't see images/)).toBeNull();
    });

    it('remove ✖ clears pending image (§3.1 test 9)', async () => {
      const screen = await compose();
      await attachImage(screen);
      expect(screen.getByText('✖')).toBeTruthy();

      await fireEvent.press(screen.getByText('✖'));
      expect(screen.queryByText('✖')).toBeNull();

      // Without text the send press is inert; no image send fires
      await fireEvent.press(screen.getByText('Send'));
      expect(onSendImage).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('draft persistence (KR-16)', () => {
    it('draft restored on mount (§3.1 test 10)', async () => {
      saveDraft(SESSION, 'persisted draft');
      const screen = await compose();

      expect(inputValue(screen)).toBe('persisted draft');
      // Still typable afterwards
      await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'x');
      expect(inputValue(screen)).toBe('x');
    });

    it('whitespace-only draft is not restored', async () => {
      saveDraft(SESSION, '   '); // whitespace-only → the draft was removed
      const screen = await compose();

      expect(loadDraft(SESSION)).toBeNull();
      expect(inputValue(screen)).toBe('');
    });

    it('typing persists draft debounced — save only after the 500ms flush (§3.1 test 11)', async () => {
      jest.useFakeTimers();
      const screen = await compose();

      await act(async () => {
        await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'typed text');
      });
      // Only immediate microtasks — the debounce timer has NOT fired yet
      await act(async () => {});
      expect(loadDraft(SESSION)).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(loadDraft(SESSION)).toBe('typed text');
      jest.useRealTimers();
    });

    it('unmount before flush does not persist a draft', async () => {
      jest.useFakeTimers();
      const screen = await compose();

      await act(async () => {
        await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'never saved');
      });
      await screen.unmount(); // clears the pending debounce timer
      await act(async () => {});
      jest.advanceTimersByTime(10_000);
      expect(loadDraft(SESSION)).toBeNull();
      jest.useRealTimers();
    });
  });
});
