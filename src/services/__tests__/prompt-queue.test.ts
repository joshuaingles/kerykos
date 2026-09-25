import { promptQueue } from '../prompt-queue';

function drain(): void {
  for (const session of ['sess_1', 'sess_2', 'other']) {
    promptQueue.clear(session);
  }
}

describe('PromptQueue (§2.5 — KR-16 in-memory queue)', () => {
  beforeEach(() => {
    drain();
  });

  it('enqueue → hasQueued → dequeue FIFO per session (findIndex order)', () => {
    expect(promptQueue.hasQueued('sess_1')).toBe(false);
    promptQueue.enqueue('sess_1', 'first');
    promptQueue.enqueue('sess_1', 'second');
    promptQueue.enqueue('sess_1', 'third');
    expect(promptQueue.hasQueued('sess_1')).toBe(true);

    const first = promptQueue.dequeue('sess_1');
    expect(first?.content).toBe('first');
    expect(promptQueue.dequeue('sess_1')?.content).toBe('second');
    expect(promptQueue.dequeue('sess_1')?.content).toBe('third');
    expect(promptQueue.dequeue('sess_1')).toBeNull();
  });

  it('dequeue wrong session → null, queue untouched', () => {
    promptQueue.enqueue('sess_1', 'stays');
    expect(promptQueue.dequeue('sess_other')).toBeNull();
    expect(promptQueue.hasQueued('sess_1')).toBe(true);
    expect(promptQueue.count('sess_1')).toBe(1);
  });

  it('count + count clear removes only that session (UI badge)', () => {
    promptQueue.enqueue('sess_1', 'a');
    promptQueue.enqueue('sess_1', 'b');
    promptQueue.enqueue('sess_2', 'c');
    expect(promptQueue.count('sess_1')).toBe(2);
    expect(promptQueue.count('sess_2')).toBe(1);

    promptQueue.clear('sess_1');
    expect(promptQueue.count('sess_1')).toBe(0);
    expect(promptQueue.count('sess_2')).toBe(1); // other session untouched
  });

  it('subscribe fires on enqueue/dequeue and clear-with-change; clear with NO items must NOT emit', () => {
    let emissions = 0;
    const unsubscribe = promptQueue.subscribe(() => { emissions++; });

    promptQueue.enqueue('sess_1', 'x');          // +1
    promptQueue.dequeue('sess_1');               // +1
    promptQueue.clear('sess_1');                 // no change → NO emit

    promptQueue.enqueue('other-session', 'y');   // +1
    promptQueue.clear('other-session');          // +1

    expect(emissions).toBe(4);
    unsubscribe();
  });

  it('unsubscribe tears down the listener', () => {
    let emissions = 0;
    const unsubscribe = promptQueue.subscribe(() => { emissions++; });
    expect(promptQueue.count('other')).toBe(0);

    promptQueue.enqueue('other', 'a');
    const before = emissions;
    expect(before).toBeGreaterThan(0);

    unsubscribe();
    promptQueue.clear('other');
    expect(emissions).toBe(before); // no emission after teardown
  });

  it('dequeue returns full payload (id + sessionId + content + enqueuedAt)', () => {
    promptQueue.enqueue('sess_1', 'payload');
    const item = promptQueue.dequeue('sess_1');
    expect(item).toMatchObject({
      sessionId: 'sess_1',
      content: 'payload',
    });
    expect(item?.id).toBeTruthy();
    expect(typeof item?.enqueuedAt).toBe('number');
  });
});
