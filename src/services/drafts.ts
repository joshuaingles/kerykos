import { createMMKV } from 'react-native-mmkv';

// KR-16: draft persistence — MMKV (not SQLite): fast KV, survives app kill,
// no schema needed. None of the legacy `new MMKV()` shims — v4 factory only.
const drafts = createMMKV({ id: 'kerykos-drafts' });

export function saveDraft(sessionId: string, text: string): void {
  if (text.trim()) {
    drafts.set(`draft_${sessionId}`, text);
  } else {
    drafts.remove(`draft_${sessionId}`);
  }
}

export function loadDraft(sessionId: string): string | null {
  return drafts.getString(`draft_${sessionId}`) ?? null;
}

export function clearDraft(sessionId: string): void {
  drafts.remove(`draft_${sessionId}`);
}
