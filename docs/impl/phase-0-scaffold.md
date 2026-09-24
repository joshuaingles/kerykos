# Phase 0 — Project Scaffold

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a: (1) route still exists, (2) request/response shape matches `api-surface.md`. If a newer Hermes release changed either, update `api-surface.md` FIRST, then the plan — never code against a stale surface in silence.
**Tags:** #kerykos #impl #phase-0 #scaffold

**Purpose:** Bootstrap the React Native project with correct structure, TypeScript strictness, navigation, theming, and Zustand store shells. Every subsequent phase depends on this existing.

**KR/NFR coverage:** NFR-6 (code quality gates: TypeScript strict, injectable seams, feature flag structure)

---

## 0.1 Expo Project Init

**Create the Expo project:**

```bash
npx create-expo-app@latest kerykos --template blank-typescript
cd kerykos
```

**Pin dependencies (per architecture §2):**

| Package | Version | Purpose |
|---|---|---|
| `expo` | SDK 57 (latest stable) | Framework |
| `react-native` | 0.79.x (SDK 57 default) | Runtime |
| `typescript` | 5.x strict | Language |
| `@react-navigation/native` | v7 | Navigation |
| `@react-navigation/bottom-tabs` | v7 | Tab navigator |
| `@react-navigation/native-stack` | v7 | Stack navigator |
| `zustand` | 4.x (pinned 2026-09-21) | State management |
| `expo-secure-store` | latest | Keychain/Keystore wrapper |
| `expo-sqlite` | latest | Analytics engine (Phase 5) |
| `react-native-mmkv` | latest | Fast KV (settings) |
| `victory-native` | 42 | Charts (Phase 5) |
| `react-native-markdown-display` | latest | Chat rendering (Phase 3) |
| `react-native-syntax-highlighter` | latest | Code blocks (Phase 3) |
| `@shopify/flash-list` | latest | Performant lists (Phase 2) |
| `react-native-purchases` | 10.x | RevenueCat IAP (Phase 6) |

```bash
npx expo install @react-navigation/native @react-navigation/bottom-tabs @react-navigation/native-stack
npx expo install zustand
npx expo install expo-secure-store expo-sqlite
npx expo install react-native-mmkv
npx expo install @shopify/flash-list
npx expo install react-native-markdown-display
# Used by later phases — install now so the manifest is complete:
npx expo install expo-image-picker    # Phase 4 (KR-17 image send)
npx expo install expo-file-system     # Phase 4 (image base64 read)
npm install uuid && npm install -D @types/uuid  # Phase 3 (Idempotency-Key)
# victory-native 42 + react-native-purchases 10.x installed later when needed
```

**Acceptance criteria:**
- `npx expo start` launches without errors
- TypeScript compiles with zero errors

---

## 0.2 TypeScript Strict Config

**File:** `tsconfig.json`

```json
{
  "extends": "expo/tsconfig.base",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*", "app.json"],
  "exclude": ["node_modules"]
}
```

**NFR-6 compliance:**
- `strict: true` — no implicit any, strict null checks, strict function types
- `noUncheckedIndexedAccess` — array/object index returns `T | undefined`
- `noImplicitReturns` — every code path must return
- Path aliases configured (`@/` maps to `src/`)

**Acceptance criteria:**
- `npx tsc --noEmit` passes with zero errors
- Any `any` usage flagged by linter (add `@typescript-eslint/no-explicit-any: error` in ESLint config)

---

## 0.3 Repo Layout

**Matches architecture §3 exactly:**

```
kerykos/
├── src/
│   ├── app/                  # routes/screens (one file per screen)
│   ├── components/           # shared UI components
│   ├── services/
│   │   ├── gateway-api.ts    # REST client (all endpoints, typed) — Phase 1
│   │   ├── sse.ts            # SSE parser — Phase 3
│   │   ├── auth.ts           # keychain-backed credential store — Phase 1
│   │   ├── storage.ts        # expo-sqlite + MMKV wiring — Phase 5
│   │   └── license.ts        # RevenueCat wrapper — Phase 6
│   ├── feature-flags.ts      # single source: FREE_FEATURES + useFeature
│   ├── analytics/            # SQLite engine + victory-native charts — Phase 5
│   └── store/                # zustand atoms (one file per domain)
│       ├── gateway.ts        # gateway store — Phase 1
│       ├── sessions.ts       # sessions store — Phase 2
│       └── chat.ts           # chat/runs store — Phase 3
├── assets/                   # icons, splash, adaptive icons
├── app.json                  # Expo config
├── tsconfig.json
├── babel.config.js
└── package.json
```

**Create the directory structure:**

```bash
mkdir -p src/{app,components,services,analytics,store}
```

**Acceptance criteria:**
- Directory structure matches above exactly
- All imports use `@/` path alias
- No files outside `src/` except config and assets

---

## 0.4 Navigation Skeleton

**File:** `src/app/navigation.tsx`

```typescript
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

// Stack types
export type RootStackParamList = {
  Pairing: undefined;
  Main: undefined;
  Chat: { sessionId: string; gatewayId: string };
  SessionDetail: { sessionId: string; gatewayId: string };
};

export type MainTabParamList = {
  Sessions: undefined;
  Analytics: undefined;  // Phase 5
  Settings: undefined;   // Phase 6 (or v1.1)
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
```

**Navigation flow:**
1. First launch / no paired gateway → `Pairing` screen (full-screen, no tabs)
2. Paired gateway exists → `Main` (tabs: Sessions, Analytics, Settings)
3. Tap session row → push `Chat` screen (pass `sessionId` + `gatewayId`)
4. Long-press session → push `SessionDetail`

**Placeholder screens to create:**

| File | Screen | Content |
|---|---|---|
| `src/app/PairingScreen.tsx` | Gateway pairing | Placeholder: "Pairing" centered text |
| `src/app/SessionsScreen.tsx` | Session list | Placeholder: "Sessions" centered text |
| `src/app/ChatScreen.tsx` | Chat | Placeholder: "Chat" centered text |
| `src/app/AnalyticsScreen.tsx` | Cost analytics | Placeholder: "Analytics" centered text |
| `src/app/SettingsScreen.tsx` | Settings | Placeholder: "Settings" centered text |
| `src/components/ChatHeader.tsx` | Chat header (title, model, per-session cost) | Stub in phase 0 — "title · model · cost" text row; full KR-19 cost logic lands phase 5 §5.5 |
| `src/components/SessionDetailScreen.tsx` | Session detail (rename/fork/delete surface) | Stub in phase 0 — placeholder screen; CRUD actions wired in phase 2 §2.6 |

**Acceptance criteria:**
- App launches to Pairing screen (no gateway configured)
- Tab navigation works between Sessions, Analytics, Settings
- Stack push to Chat screen works with params

---

## 0.5 Theme System

**Architecture §6 — 9 verified skins, light/dark/system:**

**File:** `src/theme/tokens.ts`

```typescript
export type ThemeMode = 'light' | 'dark' | 'system';
export type SkinName = 'default' | 'ares' | 'mono' | 'slate' | 'daylight'
  | 'warm-lightmode' | 'poseidon' | 'sisyphus' | 'charizard';

export interface ThemeTokens {
  background: string;
  text: string;
  accent: string;
  sidebar: string;
  border: string;
  muted: string;
  card: string;
  success: string;
  warning: string;
  error: string;
}

// Base light/dark
const darkBase: ThemeTokens = {
  background: '#0d1117',
  text: '#e6edf3',
  accent: '#58a6ff',
  sidebar: '#161b22',
  border: '#30363d',
  muted: '#8b949e',
  card: '#161b22',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
};

const lightBase: ThemeTokens = {
  background: '#ffffff',
  text: '#24292f',
  accent: '#0969da',
  sidebar: '#f6f8fa',
  border: '#d0d7de',
  muted: '#656d76',
  card: '#f6f8fa',
  success: '#1a7f37',
  warning: '#9a6700',
  error: '#cf222e',
};
```

**File:** `src/theme/skins.ts`

```typescript
// Skin NAMES verified against hermes_cli/skin_engine.py v0.21.3 — 9 skins only.
// ⚠️ Color values are PLACEHOLDERS — port the real values from
// hermes_cli/skin_engine.py at impl time before shipping any skin.
export const SKIN_MAP: Record<SkinName, Partial<ThemeTokens>> = {
  default: {},
  ares: {},            // TODO: port tokens from skin_engine.py
  mono: {},
  slate: {},
  daylight: {},
  'warm-lightmode': {},
  poseidon: {},
  sisyphus: {},
  charizard: {},
};
```

**File:** `src/theme/ThemeProvider.tsx`

```typescript
import { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { SKIN_MAP } from './skins';
import { darkBase, lightBase } from './tokens';
import type { SkinName, ThemeMode, ThemeTokens } from './tokens';

interface ThemeContextValue {
  theme: ThemeMode;
  skin: SkinName;
  tokens: ThemeTokens;
  setTheme: (mode: ThemeMode) => void;
  setSkin: (name: SkinName) => void;
}

const ThemeContext = createContext<ThemeContextValue>(null!);
export const useTheme = () => useContext(ThemeContext);

function resolveTokens(mode: ThemeMode, skin: SkinName, systemScheme: string | null): ThemeTokens {
  const effectiveDark = mode === 'system' ? systemScheme === 'dark' : mode === 'dark';
  const base = effectiveDark ? darkBase : lightBase;
  const overrides = SKIN_MAP[skin] ?? {};
  return { ...base, ...overrides };
}
```

**Acceptance criteria:**
- Theme context provides tokens to all screens
- `resolveTokens` returns correct colors for all 9 skins × 3 modes
- System theme follows device setting

---

## 0.6 Feature Flags Structure

**Architecture §7 — open core pattern (NOT `require()`-based):**

**File:** `src/feature-flags.ts`

```typescript
export type FeatureName =
  | 'cost_dashboard'       // Tier 3 — Pro
  | 'token_breakdown'      // Tier 3 — Pro
  | 'budget_alerts'        // Tier 3 — Pro
  | 'cost_forecasting'     // Tier 3 — Pro
  | 'free_only_mode'       // Tier 3 — Pro
  | 'hard_stop'            // Tier 3 — Pro
  | 'context_window_gauge' // Tier 2 — Pro (if fields land upstream)
  | 'multi_gateway_ui'     // v1.1
  ;

// Features available without Pro license
export const FREE_FEATURES: FeatureName[] = [
  // All Tier 1 + Tier 2 features are free
  // Tier 3 cost features are Pro-only (not listed here)
];

// Usage in components:
// const showCostDashboard = useFeature('cost_dashboard');
// Phase 6 wires useFeature to RevenueCat isLicensed check
```

**NFR-6 compliance:**
- Single source of truth for feature gating
- Pro-marked surfaces behind flag at compile time
- `useFeature` hook (Phase 6) checks license state, never uses `require()`

**Acceptance criteria:**
- `FREE_FEATURES` array exported and type-safe
- `FeatureName` union includes all gated features from architecture §3
- No `require()`-based detection anywhere in the codebase

---

## 0.7 Zustand Store Shells

**File:** `src/store/gateway.ts`

```typescript
import { create } from 'zustand';

export interface Gateway {
  id: string;
  label: string;
  base_url: string;
  profile_path?: string;
  key_ref: string;  // Keychain alias, not the actual key
  added_at: number;
  last_connected_at: number | null;
}

interface GatewayStore {
  gateways: Gateway[];
  activeGatewayId: string | null;
  addGateway: (gw: Gateway) => void;
  removeGateway: (id: string) => void;
  setActive: (id: string) => void;
}

export const useGatewayStore = create<GatewayStore>((set) => ({
  gateways: [],
  activeGatewayId: null,
  addGateway: (gw) => set((s) => ({
    gateways: [...s.gateways, gw],
    activeGatewayId: s.activeGatewayId ?? gw.id, // auto-select first
  })),
  removeGateway: (id) => set((s) => ({
    gateways: s.gateways.filter(g => g.id !== id),
    activeGatewayId: s.activeGatewayId === id
      ? (s.gateways[0]?.id ?? null)
      : s.activeGatewayId,
  })),
  setActive: (id) => set({ activeGatewayId: id }),
}));
```

**File:** `src/store/sessions.ts` — placeholder, Phase 2 fills in

**File:** `src/store/chat.ts` — placeholder, Phase 3 fills in

**Acceptance criteria:**
- Store compiles with TypeScript strict
- `useGatewayStore` accessible from any component
- Multi-gateway data model (KR-4): store supports N gateways from day one

---

## 0.8 MMKV Settings Store

**File:** `src/services/storage.ts`

```typescript
import { MMKV } from 'react-native-mmkv';

export const settings = new MMKV({
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
```

**Acceptance criteria:**
- MMKV initializes without errors
- Settings persist across app restarts
- `expo-sqlite` wiring deferred to Phase 5 (analytics engine)

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | Expo app launches | `npx expo start` → no errors, renders Pairing screen |
| 2 | TypeScript strict | `npx tsc --noEmit` → zero errors |
| 3 | Navigation works | Tap through tabs, push Chat screen |
| 4 | Theme system | Toggle dark/light/system, cycle through all 9 skins |
| 5 | Store accessible | `useGatewayStore` usable from any screen (add a test gateway in dev) |
| 6 | MMKV persists | Set a setting, kill app, relaunch — value persists |
| 7 | Repo layout matches | Directory tree matches architecture §3 |

---

## Next: [[phase-1-gateway-auth]]
