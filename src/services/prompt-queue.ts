import { v4 as uuidv4 } from 'uuid';

export interface QueuedPrompt {
  id: string;
  sessionId: string;
  content: string;
  enqueuedAt: number;
}

/**
 * KR-16: prompt queue — enqueue messages while a run is active; the
 * RunsManager auto-submits the next one when the current run completes.
 * Subscribable so the composer can show a queued-count badge without
 * polluting the chat store.
 */
class PromptQueue {
  private queue: QueuedPrompt[] = [];
  private listeners = new Set<() => void>();

  enqueue(sessionId: string, content: string): void {
    this.queue.push({
      id: uuidv4(),
      sessionId,
      content,
      enqueuedAt: Date.now(),
    });
    this.emit();
  }

  /** Get next queued prompt for a session. Returns null if empty. */
  dequeue(sessionId: string): QueuedPrompt | null {
    const idx = this.queue.findIndex(p => p.sessionId === sessionId);
    if (idx === -1) return null;
    const [next] = this.queue.splice(idx, 1);
    this.emit();
    return next ?? null;
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
    const before = this.queue.length;
    this.queue = this.queue.filter(p => p.sessionId !== sessionId);
    if (this.queue.length !== before) this.emit();
  }

  /** useSyncExternalStore subscription seam. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const promptQueue = new PromptQueue();
