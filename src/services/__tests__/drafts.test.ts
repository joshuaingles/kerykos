import { saveDraft, loadDraft, clearDraft } from '../drafts';
import { resetMMKV } from '@/test/helpers';

describe('drafts (§2.4 — KR-16 draft persistence via MMKV)', () => {
  beforeEach(() => {
    resetMMKV();
  });

  it('save → load same-session roundtrip', () => {
    saveDraft('sess_1', 'Hello world');
    expect(loadDraft('sess_1')).toBe('Hello world');
  });

  it('save whitespace-only → clears (trim rule)', () => {
    saveDraft('sess_1', 'Hello');
    saveDraft('sess_1', '   ');
    expect(loadDraft('sess_1')).toBeNull();
    // empty string clears too
    saveDraft('sess_2', 'x');
    saveDraft('sess_2', '');
    expect(loadDraft('sess_2')).toBeNull();
  });

  it('clear → null', () => {
    saveDraft('sess_3', 'draft text');
    clearDraft('sess_3');
    expect(loadDraft('sess_3')).toBeNull();
  });

  it('session isolation — per-session keys', () => {
    saveDraft('sess_a', 'A draft');
    saveDraft('sess_b', 'B draft');
    expect(loadDraft('sess_a')).toBe('A draft');
    expect(loadDraft('sess_b')).toBe('B draft');
    clearDraft('sess_a');
    expect(loadDraft('sess_a')).toBeNull();
    expect(loadDraft('sess_b')).toBe('B draft'); // untouched
  });
});
