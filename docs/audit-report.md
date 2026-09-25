# Kerykos Code Audit — v1 (Phases 0–6)

**Date:** 2026-09-24
**Auditor:** OpenCode build agent (glm-5.3-flash)
**Verified:** `npx tsc --noEmit` — zero errors. `npx expo lint` — clean. No `any`, no `@ts-ignore`, no ESLint suppressions outside two documented inline disables. Overall the codebase is high-fidelity to the plans; the findings below are ordered by severity.

## 1. Wiring (biggest real problems)

| # | Finding | Location |
|---|---|---|
| **W1** | **RevenueCat is never initialized anywhere.** Phase-6 log claims "SettingsScreen — RevenueCat init + license status display", but `SettingsScreen.tsx` only has theme/skin cycler — no `LicenseService.init()`, no license status. Init only happens lazily inside `ProUpgradePrompt`/`useFeature`, and **neither is ever mounted** (`useFeature`/`ProUpgradePrompt`/`isFeatureEnabled` have zero importers, verified by grep). The feature-flag system is fully built but dead code. | `src/app/SettingsScreen.tsx`, `src/hooks/useFeature.ts`, `src/components/ProUpgradePrompt.tsx` |
| **W2** | **Composition root is bypassed in three places** — NFR-6 says "nothing constructs GatewayAPI inline; services never import each other's singletons". Violations: `SessionsScreen.tsx:36-38` (dynamic `import('@/services/gateway-api')` + `new GatewayAPI`), `useSessionActions.ts:15` via `apiForGateway` (new instance per call — no caching), `useForegroundProbe.ts:20` (`new GatewayAPI` inline). The cached `getApi`/`useGatewayAPI` seam exists in `composition.tsx` but only Chat/Analytics use it. Two competing API-instantiation paths is a consistency smell. | `src/app/SessionsScreen.tsx:36`, `src/hooks/useSessionActions.ts`, `src/hooks/useForegroundProbe.ts:20` |
| **W3** | **`captureSessionEcho` is dead code** — defined in `gateway-api.ts:88` but never called, so `getSessionEcho` (used in `runs-manager.ts:47`) always returns null and X-Hermes-Session-Key memory scoping never actually happens (Session-Id does get sent as the sessionId itself). | `src/services/gateway-api.ts:88-101` |
| **W4** | **`AuthService.deleteKey` / `hasKey` / `keyRefFor` unused** — no unpair flow exists; there is no way to remove a gateway once paired (removeGateway store action is also never called). | `src/services/auth.ts:17-29` |
| **W5** | **SessionDetail route is dead and still a stub.** `SessionDetailScreen` renders plain "Session Detail" text (plan §0.4 deferred CRUD to phase 2 §2.6, which never landed). No code path ever navigates to it — long-press opens an Alert menu instead. | `src/components/SessionDetailScreen.tsx:5-9`, `src/app/navigation.tsx:71` |

## 2. Completeness

- `capacity` gaps: Phase-1 `GatewayCapabilities` includes `approvalsSupported`/`steerStopSupported` but nothing consumes them — `ApprovalCard` renders regardless of gateway capability (plan NFR-4: "hide unsupported features rather than break"). Minor.
- `listSessions` includes `include_children`, `/api/sessions/:id/messages`, and archive-param — the `include_archived` param name remains flagged as unverified per §9a (honest, matches plan).
- `useSessionActions` is missing from plan §2.6's `useGatewayAPI` seam (uses `apiForGateway` directly instead — see W2).
- Plan §2.3 NFR-2 "60fps on 5k transcripts"; chat messages that never got a `session.messages` backfill: `getSessionMessages` (KR-18 transcript fetch / offline cache) is defined in `gateway-api.ts:177` but **never called** — chat after relaunch shows only the in-memory session's messages, not gateway history. This is the largest real feature gap vs. plans.
- `stopPolling`/`startPolling`, focus-gated sync, archived extra-pass, dedup — all implemented faithfully (`sync-engine.ts`, `session-sync.ts`). ✓
- Duplicated logic (Plan deviations, documented in execution logs: MMKV v4 factory, FlashList v2 prop drop, TS 6 paths) are all legit and consistent.

## 3. Type safety

Clean. Specifically:
- No `any` anywhere (grep-verified; only a word inside a comment).
- `noUncheckedIndexedAccess` handled properly (`result.assets[0]` guarded via cancel check + `!result.assets[0]` at `image-picker.ts:17`; `PIE_PALETTE[i % len] ?? PIE_PALETTE[0]!` at `AnalyticsScreen.tsx:156`).
- `exactOptionalPropertyTypes` disabled per plan §0.2.
- The one thing worth polish: SSE event payloads use `as` narrowing (`event.delta as string`, `event.tool_id as string`, `(event as unknown as RunCompletedEvent)`) — acceptable since payloads are wire-dynamic, but a discriminated-union `SSEEvent` map would be stricter. Not a violation.

## 4. API accuracy vs `docs/api-surface.md`

**All match.** Verified endpoint-by-endpoint:
- Sessions: `GET/POST/PATCH/DELETE /api/sessions[:id]`, `/fork`, `/messages` ✓ (fields match `_session_response` allowlist including `preview`, `parent_session_id`, flags)
- Runs: `POST /v1/runs` (Idempotency-Key + session headers), `GET /v1/runs/{id}`, `/events`, `/steer`, `/stop`, `/approval` ✓
- Probe: `/v1/health` unauthed, `/v1/capabilities` authed ✓
- `/api/model/options` ✓; session-chat fallback POST `/api/sessions/{id}/chat/stream` consuming the response body (never re-requesting URL) ✓
- Pagination: max-200 clamp + short-page termination + archived extra-pass (not trusting `has_more`) ✓
- `stopRun` returns `{status}` matching wire-verified `{status:"stopping"}` ✓
- No dashboard-(`:9119`)only endpoints reached anywhere ✓ (checked: no `/api/analytics`, `/api/config`, `/api/files`, `/api/memory` calls)

One low-risk note: `run.failed`/`run.partial` SSE event types in `runs-manager.ts:320,332` are client-side assumptions not in the wire list (plan lists only completed/cancelled/steered/approval/delta/tool/reasoning) — harmless defensive handling, but the truth-source remains the close-poll path.

## 5. Consistency

- All imports use `@/` alias; store files one-domain-per-file; naming (`KR-xx` comments, §-references) is uniform. Good.
- `AnalyticsScreen.tsx:160` defines a **local `ThemeTokens` interface** instead of importing `src/theme/tokens.ts` — shadowing duplicate type definition. Minor.
- `PairingScreen` state `httpWarningSeen` is really "http hint visible" (reset on every keystroke at line 165) — misleading name; also `getSetting<string|null>(http_warn_${url}, url)` stores and truth-checks the URL rather than a boolean. Works but muddy.
- Message text via `sendViaSessionChatFallback` sets fake `runId: 'fallback:...'` — pragma fine, consistent.
- `useSyncExternalStore` binding `promptQueue.subscribe.bind(promptQueue)` — functional but unusual; a stable bound method would be more idiomatic.

## 6. Missing files / plan-vs-actual

All planned files exist (services, analytics, stores, hooks, components, types, theme, feature-flags). Root artifacts `eas.json`, `LICENSE.md`, `docs/app-store-prep.md`, `app.json` present. Remaining planned-but-absent:

1. **Unpair/gateway-management path** (`AuthService.deleteKey` has no caller) — v1 allows adding exactly one gateway, but there is no way to *escape* the Pairing screen either (it renders only when `gateways.length === 0`, and nothing can remove one). If a user pairs to a dead gateway, the app is stuck in Sessions-analytics-only-against-a-dead-host. This is the most user-visible gap.
2. **Transcript hydration** — `getSessionMessages` defined, never wired (see above).
3. **Skin color values** — placeholders per plan §0.5 TODO (documented deferral).
4. **Phase-6 execution-log claim mismatch**: "SettingsScreen — RevenueCat init + license status" is not in the file (W1).

## 7. Prioritized Fix Recommendations

1. **Mount `LicenseService.init()` at app start** + wire license status display in SettingsScreen
2. **Route sessions CRUD through `useGatewayAPI`** — delete `apiForGateway`/inline `new GatewayAPI` constructions
3. **Call `captureSessionEcho` on session-creating responses** so X-Hermes-Session-Key scoping works
4. **Wire transcript fetch into ChatScreen** — call `getSessionMessages` on focus to hydrate history
5. **Add unpair/switch-gateway affordance** — at minimum a "Reset Gateway" in Settings