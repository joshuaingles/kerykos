import { createMMKV } from 'react-native-mmkv';

export const settings = createMMKV({
  id: 'kerykos-settings',
  // encryptionKey: derived from device keychain in Phase 1
});

// Typed helpers
export function getSetting<T>(key: string, fallback: T): T {
  const val = settings.getString(key);
  if (val === undefined) return fallback;
  return JSON.parse(val) as T;
}

export function setSetting<T>(key: string, value: T): void {
  settings.set(key, JSON.stringify(value));
}
