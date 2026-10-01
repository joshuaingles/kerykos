# Kerykos Test Strategy

**Date:** 2026-09-24
**Status:** Proposed — no tests exist today. Zero test files, zero test scripts, zero test dependencies (`package.json` verified). This document defines the infrastructure and the test plan to bootstrap.

**Current-state reality check (differs slightly from `audit-report.md`):**
The audit's W1/W4 findings are now fixed (`App.tsx:12` inits RevenueCat; `SettingsScreen.tsx` displays license status and has a "Reset Gateway" unpair flow). Still-valid notes that affect testing:
- `SessionsScreen.tsx:35` still constructs `new SessionSyncEngine(api)` inline (audit W2 partially resolved — `useGatewayAPISafe` is used, but the engine is per-run). Tests should not depend on where the engine is constructed; mock at the `GatewayAPI` seam.
- `captureSessionEcho` (audit W3) IS wired now (`gateway-api.ts:51` in `handleResponse`) and must be tested — it's the `X-Hermes-Session-Key` memory-scoping path.
- `getSessionMessages` (transcript hydration, audit C1) is wired in `ChatScreen.tsx:81` — test the hydrate-only-when-empty rule.

---

## 0. Testability assessment summary

| Layer | Files | Nature | Testability |
|---|---|---|---|
| Pure logic | `services/version.ts`, `services/capabilities.ts`, `store/sessions.ts` (derive/format fns), `services/vision.ts`, `services/image-picker.ts` (formatImageContent), `analytics/cost-enrichment.ts` (computeDisplayCost), `services/prompt-queue.ts` (in-memory class), `feature-flags.ts` | No side effects | **Excellent — trivially unit-testable, zero mocks** |
| KV-backed logic | `services/drafts.ts`, `store/chat.ts` MMKV persistence (`persistActiveRun`/`loadTrackedRun`/`clearActiveRun`), `services/storage.ts` `getSetting`/`setSetting`, `services/capabilities.ts` (cache fns) | Side effects via react-native-mmkv | Good — one module mock |
| Network service | `services/gateway-api.ts`, `services/session-chat-fallback.ts`, `services/sse.ts`, `services/session-sync.ts`, `analytics/sync-engine.ts` | `fetch`-only | Good — `global.fetch` mock; no other native deps |
| Orchestrator | `services/runs-manager.ts` | fetch (via SSE) + zustand + MMKV + uuid | Good but heavy — mock api resolver + MMKV; the store is real (zustand is pure JS) |
| SQLite layer | `services/storage.ts` `AnalyticsDB`, `analytics/queries.ts` | expo-sqlite sync API | Medium — mock `openDatabaseSync` with an in-memory fake; SQL text assertions for scoping/enrichment rules |
| Native-wrapped services | `services/auth.ts` (expo-secure-store), `services/license.ts` (react-native-purchases), `services/image-picker.ts` (expo-image-picker/file-system) | Native modules | Unit-test with module mocks; don't over-invest |
| React components | `components/*` | RNTL-testable | Good — need ThemeProvider wrapper + zustand stores are global |
| Screens | `app/PairingScreen.tsx`, `app/ChatScreen.tsx`, `app/SessionsScreen.tsx`, `app/AnalyticsScreen.tsx`, `app/SettingsScreen.tsx` | RNTL + navigation mocking + composition context | Medium-Painful (navigation/FlashList/victory-native) — **prefer testing via hooks + mocked services**; full render tests P2 |
| Hooks | `hooks/*`, `app/composition.tsx` | React hooks | Good — `renderHook` from RNTL |

**Critical paths that MUST be tested (v1 P0):**
1. **Pairing/auth** — wrong-state error mapping (KR-5), key storage, http-warning dismissal
2. **GatewayAPI** — every endpoint's URL/method/headers/auth, `GatewayError` on non-OK, idempotency-key header, session echo capture/persistence
3. **SSE parser** — the only streaming parser in the app; keepalive-comment skipping, chunk-boundary splits, POST-body consumption (fallback)
4. **RunsManager lifecycle** — idempotency replay (KR-10), detach/reattach (KR-11), terminal states (KR-12), approval persistence (KR-13), steer dedup (KR-14), bounded retry no-401-retry (NFR-3/KR-5)
5. **Cost display** — the KR-19 rule "0.0 = unknown = dash, never $0.00" is the product's honest-cost promise
6. **Analytics** — gateway scoping in every query (KR-4a), archived exclusion, NULL-cost not counted as $0, pagination/short-page termination

**Dependencies needing mocking:**

| Dependency | Mock strategy |
|---|---|
| `global.fetch` | Hand-rolled `createFetchMock()` (queue of route handlers returning `Response` objects with controllable `body` streams for SSE). MSW is **not** recommended here — RN's fetch + streaming `ReadableStream` responses are easier with a tiny custom mock than with MSW handlers. |
| `react-native-mmkv` (`createMMKV`) | `jest.mock` the module → export `createMMKV: () => new InMemoryMMKV()` (a Map-based instance implementing `getString/set/remove/delete`). Reset per test. **Only ONE mock implementation needed for all 4 MMKV instances** (settings, drafts, chat, none else). |
| `expo-secure-store` | `jest.mock` → in-memory Map (`setItemAsync/getItemAsync/deleteItemAsync`) |
| `expo-sqlite` | `jest.mock('expo-sqlite')` → `openDatabaseSync` returns an in-memory fake implementing `execSync/runSync/getAllSync/getFirstSync/prepareSync`. See §4 AnalyticsDB for scope. |
| `react-native-purchases` | `jest.mock` → plain object with spies (`configure`, `getCustomerInfo`, `getOfferings`, `purchasePackage`, `restorePurchases`, listener add/remove) |
| `expo-image-picker`, `expo-file-system/legacy` | `jest.mock` → canned `launchImageLibraryAsync` result |
| `uuid` | Real uuid is fine (pure JS); for deterministic id-assertions use `jest.spyOn` on v4 where order matters (RunsManager test). |
| `AppState` (hooks) | `jest.spyOn(AppState, 'addEventListener')` → capture listener, invoke manually |
| Feedback: `Alert`/`Alert.prompt` | `jest.spyOn(Alert, 'alert')` |

---

## 1. INFRASTRUCTURE (do first — ~0.5 day)

**Stack:** Jest + `jest-expo` (Expo-blessed preset, bundles RN Testing Library compat) + `@testing-library/react-native` + custom lightweight mocks (no MSW).

```bash
npx expo install jest-expo jest @types/jest @testing-library/react-native
```

**`jest.config.js`:**
```js
module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts(x)'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^react-syntax-highlighter/dist/esm/(.*)$': 'react-syntax-highlighter/dist/cjs/$1',
  },
  testEnvironment: 'jsdom', // RNTL compat; the setup below also provides TextEncoder/TextDecoder
};
```

**`jest.setup.ts`:**
- `jest.mock('react-native-mmkv')` → in-memory factory (shared instances resettable via `__resetMMKV()`)
- `jest.mock('expo-secure-store')`, `expo-image-picker`, `react-native-purchases`, `expo-sqlite`
- Polyfill `global.ReadableStream`/`TextEncoder`/`TextDecoder` for the SSE fake-stream helper (a small polyfill such as `core-js`/`whatwg-encoding`, or `jest-environment-jsdom`'s built-ins, suffices)
- `jest.useFakeTimers()` is set per-test (backoff/debounce/polling tests need it), not globally

**Conventions:**
- Colocate: `src/services/__tests__/gateway-api.test.ts` etc.
- Shared helpers in `src/test/`: `fetchMock.ts` (route queue + SSE-stream-from-chunks builder), `mmkv.reset()`, `makeSession()`, `makeSnapshot()` factories.
- Naming: `describe('<KR-xx or §xx>')` so test names map to plan acceptance criteria.

⚠️ Verify at setup time: jest-expo version compatible with Expo 57 + React 19.2 + TS 6.0 (same discipline as the MMKV v4 factory / FlashList v2 deviations already documented in the plan logs). Run `npx expo install` rather than pinning from memory.

---

## 2. UNIT TESTS — pure logic (P0 mostly, ~45 tests)

### 2.1 `src/services/version.ts` — `checkVersionCompatibility` (P0)
Pure. Edge: the strict-equality pinned branch vs numeric compare.

| Test | Verifies |
|---|---|
| `pinned version returns proceed` | `0.21.3` → `{compatible: true, action: 'proceed'}` |
| `same major, older minor → warn but compatible` | `0.20.0` → warn |
| `same major, newer minor → proceed` | `0.22.5` → proceed (no warning on forward minor) |
| `different major → not compatible, warn` | `1.0.0` → `{compatible: false, action: 'warn'}` with breaking-changes copy |
| `malformed version → defaults applied` | `''`/'abc' (`.split('.').map(Number)` → NaN fallbacks) — pin current behavior, don't crash |

### 2.2 `src/services/capabilities.ts` — `parseCapabilities` / `selectChatTransport` (P0)
| Test | Verifies |
|---|---|
| `full caps → all supported` | wire-verified response (gateway-api.ts CapabilitiesResponse incl. authoritative negatives) parses correctly |
| `runsSupported requires all three flags` | `run_events_sse: false` → `runsSupported: false` even with submission+status true |
| `steerStop requires BOTH run_steer and run_stop` | one-false → unsupported |
| `transport: runs when runsSupported` | `'runs'` |
| `transport: session-chat fallback` | old gateway (runsSupported false) → `'session-chat'` (KR-3) |
| `cacheCapabilities/loadCapabilities roundtrip` | through mocked MMKV |

### 2.3 `src/store/sessions.ts` — `deriveSessionRow`, `relativeTime`, `formatCost` (P0 for formatCost)
| Test | Verifies |
|---|---|
| **KR-19** `cost 0.0 → dash` | `formatCost(0, null)` → `'—'` (unknown ≠ free — the wire-verified nuance) |
| **KR-19** `actual wins over estimated` | `formatCost(0.5, 0.25)` → `$0.2500` |
| **KR-19** `null+null → dash; nonzero → $4dp` | `$` + `toFixed(4)` |
| `relativeTime buckets` | <60s 'just now', 90s '1m ago', 59m, 2h, 20h, 23h, 25h 'yesterday', 47h 'yesterday', 3d '3d ago' |
| `relativeTime never negative` | future ts → 'just now' (`Math.max(0, …)`) |
| `deriveSessionRow isActive window` | `ended_at: null` + last_active 899s → true; 901s → false; ended_at set → false |
| `deriveSessionRow source badge` | known source (`api_server`) → `'📱 API'`; unknown source → raw passthrough |
| `upsertSessions last-write-wins` | existing row with newer `last_active` is kept (prevents stale overwrite) |
| `pinned-first sort in getVisibleSessions` | pinned sorted desc before unpinned |
| `archived hidden unless showArchived` | KR-9 toggle |
| `updateWatermark never moves backwards` | monotonic |

### 2.4 `src/services/drafts.ts` (P1)
| Test | Verifies |
|---|---|
| `save → load same-session roundtrip` | string persists |
| `save whitespace-only → clears` | `saveDraft('s', '   ')` removes (trim rule) |
| `clear → null` | |
| `session isolation` | per-session keys |

### 2.5 `src/services/prompt-queue.ts` — `enqueue`/`dequeue`/`hasQueued` (P1)
| Test | Verifies |
|---|---|
| `enqueue → hasQueued → dequeue FIFO per session` | findIndex order |
| `dequeue wrong session → null, queue untouched` | |
| `count + clear` | UI badge; clear removes only that session |
| `subscribe fires on enqueue/dequeue and clear-with-change` | emit rules (clear with no items must NOT emit) |
| `unsubscribe tears down` | returned function removes the listener |
| `KR-16 dequeue on completed` | integration — see §5.2 |

### 2.6 `src/services/vision.ts` — `showVisionWarning` (P1)
| Test | Verifies |
|---|---|
| `known non-vision → true (warn)` | |
| `known vision-capable → false` | |
| `model not in list → null (never warn)` | no-metadata model |
| `vision undefined → null` | entry without `vision` field |

### 2.7 `src/analytics/cost-enrichment.ts` — `computeDisplayCost` (P0)
| Test | Verifies |
|---|---|
| `actual > 0 wins` | 4dp |
| `estimated > 0 used` | |
| `estimated 0/null + pricing → token-derived` | input×in + out×out + cacheRead×cached |
| `token cost 0 (zero pricing fields) → '—'/isUnknown` | `cost > 0` gate |
| `no pricing (null) + estimated 0 → '—'` | the honest-unknown rule |
| `missing pricing fields (null in ModelPricing) → COALES to 0` | `?? 0` in the formula |

### 2.8 `src/analytics/queries.ts` (P0 — see also §4)
Because expo-sqlite is native, the queries class needs the SQLite fake. Two test layers:

**Layer A (SQL contract, no fake runtime needed):** mock `getAllSync`/`getFirstSync` to return canned rows and spy the executed SQL + bind params.
| Test | Verifies |
|---|---|
| `every query is gateway-scoped` | SQL contains `gateway_id = ?` AND params bind the passed id (KR-4a) — loop over all 8 methods |
| `archived=0 filter in cost sums except getDailySpend` | daily uses precomputed aggregate table |
| `NULL enriched cost excluded from SUM naturally` | passes `total` through `?? 0` |
| `getCacheHitRate zero-division → 0` | |
| `recomputeDailyAggregates groups by date(started_at,'unixepoch')` | catches regressions in the epoch-seconds assumption |

**Layer B (behaviour on the fake DB):** `preparedUpsert` enriched-cost rule runs the exact SQL string — assert it's the INSERT OR REPLACE with 27 placeholders and that `run()` binds `actual>0 ? actual : estimated>0 ? estimated : null` into the `enriched_cost_usd` slot (the KR-19 rule from `storage.ts:160-164`). Verify order by matching bound args against the SQL's column list.

### 2.9 `src/services/image-picker.ts` — `formatImageContent` (P0, KR-17)
| Test | Verifies |
|---|---|
| `formatImageContent shape` | `[{role:'user', content:[{type:'text',text},{type:'image_url',image_url:{url:dataUrl}}]}]` — wire-verified smoke #8 format; this is the exact payload sent over `/v1/runs` |
| `pickImageForChat: canceled → null` | mock picker |
| `pickImageForChat: no asset → null` | guards `!result.assets[0]` (noUncheckedIndexedAccess path) |
| `pickImageForChat: mimeType fallback` | `.png` URI → `image/png`; otherwise `image/jpeg` |
| `pickImageForChat: picker base64 absent → readAsStringAsync fallback` | mocks file-system |

### 2.10 `src/feature-flags.ts` + `useFeature`/`isFeatureEnabled` (P1 — currently near-dead code but must not rot)
| Test | Verifies |
|---|---|
| `FREE_FEATURES inclusion → always true (hook + async)` | |
| `unlicensed → false` | mock LicenseService |
| `licensed → true` | |
| `onCustomerInfoChanged updates license live` | emit from mock listener |
| `isFeatureEnabled caches for 30s TTL` | second call inside TTL doesn't re-call `isLicensed` |
| `init failure → not licensed, no crash` | |

---

## 3. COMPONENT TESTS — @testing-library/react-native (mostly P1)

Wrap with a `renderThemeProvider()` helper providing resolved tokens (dark default). Zustand stores are plain JS — import and reset via `useChatStore.setState(...)` fresh Maps per test.

### 3.1 `ChatComposer.tsx` (P1 — the send/steer/queue state machine is complex)
| Test | Verifies |
|---|---|
| `send when idle → onSend(trimmed), composer cleared, draft cleared` | |
| `empty input + no image → send disabled` | disabled Pressable |
| `activeRun + steerSupported → onSteer` | label shows 'Steer' |
| `activeRun + !steerSupported → onQueue` | label shows 'Queue' (NFR-4) |
| `activeRun + steerSupported + text → "Queue instead" visible` | separate enqueue path (calls `promptQueue.enqueue` — assert via `promptQueue.count`) |
| `pendingImage + idle → onSendImage(text, dataUrl)` | image path only when idle |
| `pendingImage + activeRun → text queued, image dropped` | KR-17 mid-run rule |
| `pendingImage + non-vision model → hint text rendered` | `modelSupportsVision === false` |
| `remove ✖ clears pending image` | chip dismiss |
| `draft restored on mount` | `loadDraft(sessionId)` initial state |
| `typing persists draft debounced (500ms fake timers)` | `saveDraft` called after 500ms, and only after flush |
| `queued badge shows count` | `useSyncExternalStore` against `promptQueue` — enqueue via the real queue, assert text |

### 3.2 `SessionRow.tsx` (P1 — all KR-8 fields)
| Test | Verifies |
|---|---|
| `renders title, model, preview, badge, relativeTime, cost` | |
| `active dot only when isActive` | |
| `press → onPress(session)`; `longPress → onLongPress` | |
| `dash cost rendered for unknown` | KR-19 split case in UI |

### 3.3 `ApprovalCard.tsx` (P1)
| Test | Verifies |
|---|---|
| `pending → Approve + Deny press onRespond with decision` | |
| `responded approve → 'Approved' static card, no buttons` | likewise deny |
| `message text rendered` | |

### 3.4 `ToolActivityCard.tsx` (P2)
| Test | Verifies |
|---|---|
| `state labels: running/failed/done` | and ActivityIndicator animating only when running |
| `press toggles expanded body` | default from `tool.collapsed` |
| `failed → red-tinted background` | |

### 3.5 `ProUpgradePrompt.tsx` (P1 — payment surface)
With `react-native-purchases` mocked:
| Test | Verifies |
|---|---|
| `offerings load → package prices rendered` (incl. `/mo` format) | |
| `offerings failure → "Packages unavailable"` | empty state copy |
| `purchase → calls LicenseService.purchase with pkg` | |
| `purchase rejection → error copy, no crash` | cancelled purchase |
| `restore → calls restore; failure → restore error copy` | |
| `unmount mid-load → no setState warning` | mounted flag |

### 3.6 `ChatHeader.tsx` / `LiveChatHeader.tsx` (P1)
| Test | Verifies |
|---|---|
| `LiveChatHeader composes computeDisplayCost with session + pricingCache` | zustand stores seeded |
| `unknown session → fallback 'Chat — —'` | |
| `isUnknown → '—'` even though compute returned non-null display | the `ChatHeader` display gate |

---

## 4. SERVICE TESTS — mocked dependencies (P0, the big block ~70 tests)

### 4.1 `AuthService` (P1 — thin over SecureStore)
`jest.mock('expo-secure-store')` → in-memory Map.
| Test | Verifies |
|---|---|
| `storeKey/getKey roundtrip; isolated per gatewayId` | key prefix `gw_key_` (assert actualSecureStore key format used in pairing `key_ref`) |
| `deleteKey removes; hasKey reflects` | |
| `getKey unknown gateway → null` | `GatewayAPI` must surface "No API key" error, not undefined crash |

### 4.2 `GatewayAPI` — `fetch` mock, **P0 crown jewel**
`createFetchMock()` returns a Response-like object `{ok, status, text, json, headers: Headers-like}`. Capture `fetch.mock.calls`. Seed SecureStore key.

**Pairing surface:**
| Test | Verifies |
|---|---|
| `healthCheck unauthed: GET {base}/v1/health, NO Authorization header` | unauthed by design |
| `capabilities: GET /v1/capabilities WITH Authorization: Bearer <key>` | key from SecureStore (KR-4a) |
| `missing key → throws 'No API key for gateway …'` | no fetch call made |
| `401 → GatewayError(401, body)` | KR-5 machinery depends on `instanceof GatewayError` — also assert `status`/`body` fields |

**Sessions:**
| Test | Verifies |
|---|---|
| `listSessions default: limit=200 clamp` | `Math.min(limit, 200)` — request 1000 → `?limit=200` |
| `listSessions offset + includeArchived → include_archived=true` | floater: param name flagged ⚠️ per §9a — test pins current behavior |
| `createSession POST body {title}`; `rename → PATCH body {title}`; `delete → DELETE`; `fork → POST /fork`; `getSession` | exact method+path matrix |
| `rename/delete void-typed` | response `.json()` not required |

**Runs:**
| Test | Verifies |
|---|---|
| **KR-10** `createRun sends Idempotency-Key header` | exact key value |
| `createRun merges sessionHeaders (X-Hermes-Session-Id/Key)` | spread order doesn't clobber auth/json headers |
| `getRunStatus GET /v1/runs/{id}`; `steerRun POST body {text}`; `stopRun POST → {status:"stopping"}` passthrough; `respondToApproval → body {decision}` | response shapes match wire notes |
| `getRunEventsUrl → {base}/v1/runs/{id}/events` without request | |

**Session echo (audit W3, KR-11):**
| Test | Verifies |
|---|---|
| `captureSessionEcho persists X-Hermes-Session-Id(+Key)` | MMKV `session_echoes_{gwId}` map JSON |
| `echo WITHOUT key captured; second echo WITH key merges` | merge semantics `{...map[sid], ...(skey...)}` |
| `no echo headers → no-op` | |
| `getSessionEcho returns {sessionId, sessionKey}` / null | |
| `handleResponse auto-captures on every ok response` | the integration at `gateway-api.ts:51` |
| `sessionHeaders(sid?, skey?)` | omit-empty rules |

**Model options:** `getModelOptions` `GET /api/model/options` (P1).

### 4.3 `SSEParser` (P0 — everything streams through this)
Build a fake `Response` whose `body.getReader()` yields controlled chunks.

| Test | Verifies |
|---|---|
| `parses data: lines into JSON events` | multi-event chunks |
| **KR-18** `':' comment lines skipped` (keepalive every 10s) | no error, no event |
| `empty lines skipped` | |
| `partial line split across chunks → buffered until newline` | the `lines.pop()` reassembly rule |
| `non-JSON data line → silently skipped` | catches the `JSON.parse` in try |
| `stream done → onClose exactly once` | |
| `read error (non-abort) → onError exactly once, settled flag prevents double-close` | |
| `disconnect() cancels reader, no onError after` | the `AbortError` exclusion |
| `connect() on !ok response → onError('SSE connection failed: NNN')` | |
| `connect() fetch throws AbortError → swallowed` | |
| `consumeResponse with no body → onError('No response body')` | the `?.getReader?.()` guard (RN response quirk) |
| `consumeResponse never re-fetches a URL` | fallbackPOST contract — the disconnect returned works |

**Integration with real stream shape (P1):** a chunked stream simulating a run event sequence (`message.delta` ×3 interleaved with `:` comments → `run.completed` with usage) drives `consumeResponse` end-to-end.

### 4.4 `RunsManager` (P0 — the orchestrator; most valuable suite in the repo)
Setup: real zustand store (fresh Maps per test), mocked `getApi` resolver returning a mock GatewayAPI (hand-built object with `createRun`, `getRunStatus`, `getRunEventsUrl`, `steerRun`, `stopRun`, `respondToApproval`, `getResolvedKey`, `getSessionEcho`, `sessionHeaders`), MMKV mocked, `SSEParser.connect/consumeResponse` mocked to a fake that we trigger manually (`fakeSSE.connect(url, headers, onEvent, onError, onClose)` → we hold the handlers). Use `jest.spyOn(uuid, 'v4')` for deterministic ids.

**sendMessage happy path:**
| Test | Verifies |
|---|---|
| `SK-01 optimistic messages appear` | user msg + empty streaming assistant msg BEFORE any await |
| `SK-02 createRun called with input/session_id + session headers via echo` | echo HEADERS: with stored echo pair vs without (falls back to sessionId-only headers) — covers `echoHeaders`
| `SK-03 activeRun set + persistActiveRun written to MMKV` | relaunch continuity bridge |
| `SK-04 connectStream passes Authorization: Bearer resolved key` | |
| `SK-05 send failure (non-401) → error message rendered, activeRun cleared, rethrown` | |
| **KR-5** `SK-06 401 → 'Authentication failed…' copy, no error-retry` | assert createRun called exactly ONCE |
| **NFR-3/KR-10** `retryWithBackoff: same idempotency key across all attempts` | spy: 3 attempts, same key each call (replay, never duplicate) |
| `retryWithBackoff: max 5, backoff 1s,2s,4s,8s(fake timers), never >15s` | |
| **KR-5** `retryWithBackoff: 401 rethrows immediately, attempt count 1` | via `isAuthError` default and custom |

**SSE event handling (drive the fake SSE handlers per event type):**
| Test | Verifies |
|---|---|
| `message.delta → appendToMessage accumulation` | two deltas concatenated |
| `tool.progress running → addToolCall with collapsed:true (KR-15)` | |
| `tool.progress completed/failed → updateToolCall (no duplicate add)` | |
| `unknown tool state → defaults 'running'` | |
| `run.completed → usage stored (KR-18), isStreaming:false, status completed, activeRun cleared, clearActiveRun MMKV removed` | |
| `run.completed WITHOUT usage → message finalized, no usage change` | `usage ? … : undefined` |
| **KR-14** `run.completed with steered_text → system 'Steer not delivered' note appended` | |
| **KR-16** `queued prompt auto-submits AFTER completion` | `promptQueue.enqueue` before event → `sendMessage(gatewayId…)` called with queued content |
| **KR-16** `auto-send fails → requeued` | `promptQueue.hasQueued` true again |
| `run.cancelled → cancelled state + settled message + MMKV cleared` | |
| `run.failed → error content preserved or 'Run failed: …'` | both branches (content kept vs fallback) |
| `run.partial → '[Partial — run was cut short]' suffix` | via `settleStreamingMessage` |
| `approval.requested → setApproval{runId, responded:false}` | |
| **KR-14** `run.steered → UPDATES optimistic 'Steer sent' message to 'Steer applied'` — ONE entry, never duplicate | `lastSteerMessageId` map; assert id match |
| `run.steered without prior steer → no crash` | missing map entry |
| `reasoning.available → ignored` | |

**SSE error/close:**
| Test | Verifies |
|---|---|
| `onError → 'Connection error: …' on streaming message` | re-found by `isStreaming` fallback if id mismatch |
| **KR-11** `onClose: status GET completed/cancelled/failed/partial → settle + MMKV cleared` | all 4 terminal cases |
| **KR-11** `onClose: status still active → message left streaming (reattach later)` | NO settle |
| `onClose: status poll throws → state unchanged` | |
| `onClose: stale run (different activeRun) → no action` | guard `activeRun.runId !== runId` |

**Detach/reattach (KR-11, P0):**
| Test | Verifies |
|---|---|
| `in-memory activeRun + status running → reconnect SSE` | |
| `relaunch path: no memory run → loadTrackedRun hydrates store FIRST` | then same reconnect |
| `smoke#5 replay: reconnect resets the message content BEFORE re-appending` | `updateMessage(content:'')` precedes `connectStream` |
| `status completed-while-away → settled + cleared (both memory and MMKV)` | |
| **KR-12x** `status 404 → 'interrupted' + 'The gateway restarted…' + clearing` | gateway-restart honesty |
| `no active run and no tracked run → no-op` | |

**steer/stop/approvals/recovery:**
| Test | Verifies |
|---|---|
| `steer without active run → no-op` | |
| `steer → steerRun called, 'Steer sent' message added with id recorded` | |
| `stop without active run → no-op`; `stop → stopRun called` | |
| `respondToApproval: no pending → no-op; approve/deny → respondToApproval + state updated{decision}` | |
| `recoverPersistedRuns: iterates MMKV map, reattach each` | |
| `recoverPersistedRuns: no active gateway → no-op WITHOUT clearing` | early return honesty |

### 4.5 `SessionSyncEngine` / session-sync (P0 pagination)
Mock `listSessions` with paged fixtures.
| Test | Verifies |
|---|---|
| `fullSync paginates until short page (not trusting has_more)` | 450 sessions in 200+200+50 pages → 3 calls |
| `ignores has_more: true on short page → stops` | KR-6 rule |
| **KR-6** `archived extra pass: one full archived re-pagination after main` | two loops; `include_archived=true` in second's URL |
| `fullSync returns total count` | |
| `incrementalSync filters last_active > watermark` | client-side filter (API has no native filter) |
| `incrementalSync early-exit: oldest batch ≤ watermark` | newest-first assumption |
| `incrementalSync empty page → stops` | |
| `paginate exact multiple of pageSize (zero pages' termination)` | last page length == 200 with no more data → must not hang (add a hard call-count cap in the mock to fail loudly) |

(`analytics/sync-engine.ts` SnapshotSyncEngine shares the same paging rules; test IT via the AnalyticsDB fake: `fullBackfill` writes rows keyed `${gatewayId}:${sessionId}`, sets sync-state, calls `recomputeDailyAggregates`; `fullBackfillIfNeeded` only when state null; `incrementalSync` advances the watermark ONLY when total > 0; `startPolling/stopPolling` with fake timers — zero polls after stop (KR-20).)

### 4.6 `AnalyticsDB` (P1 — with in-memory sqlite fake)
Fake implements `execSync/runSync/getAllSync/getFirstSync/prepareSync` minimally: capture executed statements+params; for `prepareSync`, return a stub whose `executeSync` records bound args.
| Test | Verifies |
|---|---|
| `initialize creates 4 tables + 3 indexes (execSync captures)` | schema presence by regex |
| `prepareUpsert enriched rule: actual>0 / estimated>0 / null` | three bound-arg cases for the `enriched_cost_usd` position (27 placeholders) |
| `getSyncState row mapping (snake→camel, nulls→0 fallbacks)` | |
| `setSyncState INSERT OR REPLACE with 4 binds` | |
| `upsertModelPricing/getModelPricing roundtrip` | |
| `applyPricingEnrichment SQL: only NULL-enriched rows + gatewayId scoping + has token counts` | regex-on-SQL assertions (KR-4a, KR-19) |

### 4.7 `LicenseService` (P1)
With `react-native-purchases` mocked:
| Test | Verifies |
|---|---|
| `init → configure with ios vs android api key (Platform.OS)` | `jest.requireActual('react-native').Platform` override per test |
| `init idempotent (second call no configure)` | `initialized` guard |
| `isLicensed: 'pro' entitlement present → true; missing → false; getCustomerInfo throws → false` | |
| `getOfferings: current missing → []; error → []` | |
| `purchase/restore delegate and reject-through` | |
| `onCustomerInfoChanged returns unsubscribe removing listener` | |

### 4.8 `session-chat-fallback.ts` (P1)
| Test | Verifies |
|---|---|
| `POST to /api/sessions/{id}/chat/stream with bearer + session headers, body {message}` | never re-requested for SSE — asserted by exactly 1 fetch call while events flow |
| `response !ok → onError('…: NNN')` | |
| `arguments: initial-fetch failure → onError + noop disconnect` | |
| `onDelta on message.delta; onComplete on message.complete AND on close` | event names flagged ⚠️ §9a — pin current behavior |

---

## 5. INTEGRATION TESTS — multi-module flows (P0 as they land)

Use real zustand stores + real (mocked-MMKV) persistence + mocked `fetch`; only network is simulated.

### 5.1 Pairing flow (KR-1/KR-3/KR-5, P0)
`render(<PairingScreen/>)` with fetch mock + SecureStore mock.
| Test | Verifies |
|---|---|
| `PF-01 health fail (network) → unreachable copy` | GatewayError vs other → gateway-down |
| `PF-02 health 500 → gateway-down copy` | |
| `PF-03 capabilities 401 → bad-key copy, key NOT stored` | KR-5 auth failure surfaced, not auto-retried |
| `PF-04 capabilities network error → connection-lost copy` | |
| `PF-05 happy path → AuthService.storeKey called + addGateway with label 'Hermes v{ver}'` | |
| `PF-06 version warn displays non-blockingly and pairing still completes` | |
| `KR-2 PF-07 http URL → modal warn; 'Pair anyway' proceeds` | |
| `PF-08 http URL dismissed persists (second pair skips modal)` | `http_warn_{url}` MMKV setting |
| `PF-09 'Edit URL' aborts without pairing` | |
| `PF-10 trailing slashes stripped; empty URL/key → no-op` | |

### 5.2 Send message → run → terminal (KR-10/16, P0)
RunsManager + real SSEParser + fetch streaming mock (no SSE mock-out — the real parser runs on a real fake Response body).
| Test | Verifies |
|---|---|
| `send → run created → deltas appended in order → completed → usage badge + spinner gone` | full transcript shape |
| `queued prompt (UI 'Queue instead') auto-sends next after completion` | through the REAL promptQueue + store |
| `two failed sends → queue intact both times` | requeue-on-error path |

### 5.3 Transcript hydration flow (KR-18, P1)
`ChatScreen` focus effect with mocked api (`getSessionMessages` → canned history) + real stores.
| Test | Verifies |
|---|---|
| `TH-01 hydrate only when session empty; live messages NEVER clobbered` | seed store with 1 message → `getSessionMessages` not called |
| `TH-02 gateway history renders after focus` | mapped via `toChatMessage` (assert epoch-seconds ×1000 normalization and tool→system role map) |
| `TH-03 hydrate failure → no crash, silent` | |

### 5.4 Session CRUD flow (KR-7, P1)
`useSessionActions` with a mock api + real sessions store.
| Test | Verifies |
|---|---|
| `create → row in store + watermark updated`; fork likewise | |
| `rename → optimistic row update; api failure still leaves optimistic state (documented behavior)` | pin current semantics |
| `delete → removed from store after DELETE resolves` | |
| `null api → throws 'Gateway … not found' on action` | `requireApi` |
| `SessionsScreen render → renders rows from store; confirmDelete requires Alert confirm` (P2 — Alert.spy) | |

### 5.5 Cost enrichment flow (KR-19, P1)
`fetchModelPricing` + AnalyticsDB fake + queries fake + real analytics store.
| Test | Verifies |
|---|---|
| `CE-01 options.pricing → model_pricing rows + store cache published` | `useAnalyticsStore.getModelPricing` live |
| `CE-02 enrichment pass fills NULL-enriched snapshots from tokens×pricing; verified via SELECT after` | (with slightly better fake: in-memory table emulation — 50 lines, worth it for this one) |
| `CE-03 recomputeDailyAggregates after enrichment` | daily_aggregates updated |
| `CE-04 missing model in options → untouched` | |

---

## 6. KR-SPECIFIC TEST MATRIX — acceptance-criteria verification

These cut across unit + integration; listed here as the traceability checklist. Each row references the strongest test above.

| KR | Criterion | Primary test(s) | Priority |
|---|---|---|---|
| KR-1 | Pairing: health→capabilities, error states | §5.1 PF-01…05 | P0 |
| KR-2 | HTTP allowed + warning (never blocked) | PF-07/08/09 | P0 |
| KR-3 | capabilities probe → transport selection | §2.2 selectChatTransport + paired-path in ChatScreen (P2 render) | P0 |
| KR-4a | per-gateway credentials/scoping everywhere | §4.2 auth header tests + `gateway_scope` loop §2.8 | P0 |
| KR-5 | 401 never auto-retried; distinct error copy | SK-06, retry 401 test, PF-03 | P0 |
| KR-6 | pagination max-200, short-page, archived pass | §4.5 | P0 |
| KR-7 | sessions CRUD | §5.4 | P1 |
| KR-8 | row fields (badge/time/active/cost) | §3.2 + §2.3 | P1 |
| KR-9 | archived hidden by default, toggle | §2.3 getVisibleSessions | P1 |
| **KR-10** | **idempotency: retries replay the same key; no duplicate runs** | SK retry same-key spy + §5.2 + §4.2 Idempotency-Key header | **P0** |
| **KR-11** | **detach/reattach after background AND cold relaunch; honest 'interrupted' on 404** | reattach battery §4.4 + TH focus effect | **P0** |
| **KR-12** | **all terminal statuses settle the UI (completed/cancelled/failed/partial + interrupted)** | event handlers §4.4 + close-poll 4 cases + 404 | **P0** |
| **KR-13** | **approval card survives relaunch (persisted tracked run → restoreApprovalState → replayed approval.requested re-renders the card)** | SK approval.requested + `restoreApprovalState` + `persistActiveRun` MMKV round trip | **P0** |
| KR-14 | steer: ONE optimistic entry, UPDATES on steered; stop → cancelled | SK run.steered update + steer/stop no-ops | P0 |
| KR-15 | tool cards collapse/expand, dedup by id | tool handlers §4.4 + §3.4 | P1 |
| KR-16 | prompt queue + auto-submit after completion + requeue-on-failure + drafts | §2.5 + §5.2 + draft tests | P1 |
| **KR-17** | **image send format `[{role:user, content:[text + image_url data-URL]}]`; vision hint; markdown image receipt** | §2.9 formatImageContent (wire-verified smoke #8) + composer branch | **P0** |
| KR-18 | transcript via `/messages` hydration; usage from terminal event; SSE keepalive skip | TH-01/02/03 + run.completed usage + `':' skip` §4.3 | P1 |
| **KR-19** | **0.0/null cost → '—' (never `$0.00`); actual>estimated>pricing-derived>unknown** | §2.7 + §2.3 formatCost + §5.5 | **P0** |
| KR-20 | watermark incremental sync; zero polls when view closed | §4.5 polling fake-timers | P1 |
| NFR-3 | bounded retry ≤5 exponential ≤15s; no infinite spinner | retryWithBackoff timing tests | P0 |

---

## 7. Estimate

| Suite | Files covered | Tests | Effort |
|---|---|---|---|
| Infrastructure setup | — | — | 0.5 d |
| Unit (§2) | 12 | ~45 | 1.5 d |
| Service mocks (§4) | 10 | ~70 | 3 d |
| Components (§3) | 6 | ~35 | 2 d |
| Integration (§5) | 6 flows | ~25 | 2.5 d |
| KR traceability (§6) | largely overlapping | (scored into above) | 0.5 d filler/verification |
| **Total** | | **~175 cases** | **~10 dev-days** |

**Coverage-per-effort ranking (build in this order):**
1. **`SSEParser` (§4.3)** — 12 tests, zero deps beyond a fetchable fake, gates every streaming feature.
2. **Pure unit block (§2.1–2.9)** — 40 cheap tests across the most bug-prone display logic (KR-19 dash rule lives here).
3. **`GatewayAPI` endpoint matrix (§4.2)** — 20 tests, single fetch mock; catches all wire regressions before device smoke.
4. **`RunsManager` (§4.4)** — the largest suite (~25) but the app's core; do after 1–3 since it reuses their helpers.
5. **Pairing integration (§5.1)** — user-visible error-state coverage.
6. Everything else (components, sync engine, license) is P1/P2 polish.

**What NOT to test:** theme tokens/skins (placeholder colors per plan §0.5), `AnalyticsScreen` chart internals (victory-native library behavior), `navigation.tsx` wiring (P2 smoke only), `SessionDetailScreen` (still a stub pending Phase-2 §2.6), and `index.ts`/`.d.ts` files.

**Non-automatable, stays manual per the plan's smoke-test protocol (`§9a`/§10):** wire-shape ⚠️ items (`include_archived` param name, steer request field, session-chat event names, epoch-seconds on timestamps). Unit tests pin current client behavior; live-gateway smoke tests remain the truth source for wire shape — the two layers must move together whenever `api-surface.md` is updated.
