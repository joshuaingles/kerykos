/**
 * Test setup — in-memory fakes for every native-backed dependency.
 * Runs before each test module import (setupFiles), so module-level
 * `createMMKV(...)` calls in drafts/storage/chat resolve to the fake.
 *
 * Globals exposed for test reset:
 *  - __resetMMKV()        — clears every fake MMKV instance
 *  - __resetSecureStore() — clears the secure-store fake
 *  - __getSQLiteDb()      — most recent fake sqlite database (with __spy)
 */
import { TextEncoder, TextDecoder } from 'util';

if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).TextDecoder = TextDecoder;
}

// === react-native-mmkv (v4 factory API) — in-memory factory, resettable ===
// State lives on globalThis because jest.mock factory bodies cannot close
// over setup-file scope (jest hoists mocks).

function mockMmkvStores(): Map<string, Map<string, string>> {
  const g = globalThis as unknown as { __mmkvStores?: Map<string, Map<string, string>> };
  if (!g.__mmkvStores) g.__mmkvStores = new Map();
  return g.__mmkvStores;
}

jest.mock('react-native-mmkv', () => ({
  createMMKV: (opts?: { id?: string }) => {
    const g = globalThis as unknown as { __mmkvStores?: Map<string, Map<string, string>> };
    if (!g.__mmkvStores) g.__mmkvStores = new Map();
    const stores = g.__mmkvStores;
    const id = opts?.id ?? 'default';
    let newStore = stores.get(id);
    if (!newStore) {
      newStore = new Map<string, string>();
      stores.set(id, newStore);
    }
    const store = newStore;
    return {
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => { store.set(key, value); },
      remove: (key: string) => { store.delete(key); },
      delete: () => { store.clear(); },
      clearAll: () => { store.clear(); },
    };
  },
}));

// === expo-secure-store — in-memory Map ===
function mockSecureStoreMap(): Map<string, string> {
  const g = globalThis as unknown as { __secureStoreMap?: Map<string, string> };
  if (!g.__secureStoreMap) g.__secureStoreMap = new Map();
  return g.__secureStoreMap;
}

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStoreMap().set(key, value);
  }),
  getItemAsync: jest.fn(async (key: string) => mockSecureStoreMap().get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStoreMap().delete(key);
  }),
}));

// === expo-sqlite — in-memory fake with statement capture ===
interface FakeStatement {
  sql: string;
  params: unknown[];
}

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn((_dbFile?: string) => {
    const spy = {
      exec: [] as FakeStatement[],
      runs: [] as FakeStatement[],
      prepared: [] as FakeStatement[],
    };
    const db = {
      __spy: spy,
      execSync: jest.fn((sql: string) => { spy.exec.push({ sql, params: [] }); }),
      runSync: jest.fn((sql: string, params?: unknown[]) => { spy.runs.push({ sql, params: params ?? [] }); }),
      getAllSync: jest.fn(() => [] as unknown[]),
      getFirstSync: jest.fn(() => null),
      prepareSync: jest.fn((sql: string) => ({
        executeSync: jest.fn((...args: unknown[]) => { spy.prepared.push({ sql, params: args }); }),
      })),
    };
    (globalThis as unknown as { __getSQLiteDb: () => unknown }).__getSQLiteDb = () => db;
    return db;
  }),
}));

// === react-native-purchases — spies ===
jest.mock('react-native-purchases', () => ({
  configure: jest.fn(),
  getCustomerInfo: jest.fn(),
  getOfferings: jest.fn(),
  purchasePackage: jest.fn(),
  restorePurchases: jest.fn(),
  addCustomerInfoUpdateListener: jest.fn(() => jest.fn()),
  LOG_LEVEL: { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' },
}));

// === uuid — ESM-only in v14; provide a pure-JS deterministic-counter v4 ===
jest.mock('uuid', () => {
  let counter = 0;
  return {
    v4: (): string => {
      counter++;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    __counter: () => counter,
  };
});

// === expo-image-picker / expo-file-system ===
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  MediaTypeOptions: { Images: 'Images' },
}));

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn(),
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

// === Reset helpers ===
(globalThis as unknown as { __resetMMKV: () => void }).__resetMMKV = () => {
  for (const store of mockMmkvStores().values()) store.clear();
};

(globalThis as unknown as { __resetSecureStore: () => void }).__resetSecureStore = () => {
  mockSecureStoreMap().clear();
};
