import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { FlashListRef } from '@shopify/flash-list';

/**
 * KR-16: stick-to-bottom with manual-scroll escape.
 * - Auto-scrolls to bottom when new messages/content arrive
 * - Manual scroll up disables auto-scroll; "Return to bottom" re-enables
 * - Near-bottom (within NEAR_BOTTOM_PX) re-enables auto-scroll
 */
const NEAR_BOTTOM_PX = 100;

export function useScrollBehavior<T>(
  messages: T[],
  lastContent: string | undefined,
) {
  const listRef = useRef<FlashListRef<T> | null>(null);
  const autoScrollRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // Auto-scroll when new content arrives (while auto-scroll is on)
  useEffect(() => {
    if (!autoScrollRef.current || lastContent === undefined) return undefined;
    // Small delay to let the new item render
    const id = setTimeout(
      () => listRef.current?.scrollToEnd?.({ animated: true }),
      50,
    );
    return () => clearTimeout(id);
  }, [messages.length, lastContent]);

  // Escape hatch: user drags up → stop auto-scroll
  const onScrollBeginDrag = useCallback(() => {
    autoScrollRef.current = false;
  }, []);

  // Near-bottom re-enables auto-scroll; away-from-bottom shows the button
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      if (distanceFromBottom < NEAR_BOTTOM_PX) {
        autoScrollRef.current = true;
        setShowJumpToBottom(false);
      } else {
        setShowJumpToBottom(true);
      }
    },
    [],
  );

  // Return-to-bottom: re-enable auto-scroll + jump
  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
    setShowJumpToBottom(false);
    listRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  return { listRef, onScrollBeginDrag, onScroll, scrollToBottom, showJumpToBottom };
}
