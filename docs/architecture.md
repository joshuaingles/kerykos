# Kerykos — Architecture Design

**Last updated:** 2026-09-20 (v0.21.3 reality check @ upstream `d7b836ab`; transport-layer correction)
**Incorporates:** GLM 5.2 feasibility findings (14 corrections), RN vs Swift analysis, v0.21.3 verification pass
**Tags:** #kerykos #architecture #design #technical

---

## 1. System Overview

Kerykos is a React Native mobile app (iOS + Android) that connects to a user's self-hosted Hermes gateway. It provides full agent management with a focus on **better UX, cost intelligence, and cross-platform support**.

### Critical Architecture Correction (from Feasibility Analysis)

⚠️ **The Hermes gateway is TWO separate servers, not one:**

| Server | Port | Auth | Purpose | Transport |
|---|---|---|---|---|
| **API Server** | 8642 | `API_SERVER_KEY` header | Session management, chat, runs, cron, files, models | REST + WebSocket (`/api/ws`) |
| **Dashboard Server** | 9119 | Cookie-based (browser session) | Web UI, analytics endpoints, plugin management | HTTP (browser-only) |

**Kerykos connects to the API Server (8642) only.** The dashboard server is not designed for external clients.

### ⚠️ Transport correction (v0.21.3 verified — supersedes older WS-based baseline)

**The API server has NO WebSocket. iPhones/Androids talk to Hermes via REST + SSE only:**

| Transport | Server | Auth | Verdict |
|---|---|---|---|
| REST + SSE (`/v1/runs`, `/api/sessions/{id}/chat/stream`, `/api/jobs/*`, `/v1/skills`, `/api/model/options`) | API server :8642 | `Authorization: Bearer <API_SERVER_KEY>` | ✅ **Kerykos's only surface** |
| JSON-RPC WebSocket (`/api/ws`) | Dashboard/serve :9119 | Browser tickets / OAuth / password sessions | ❌ Browser-only; tickets + loopback gate reject mobile clients |
| SSH tunnel | n/a | SSH key | ❌ Desktop-app convenience; mobile OS can't spawn tunnels in-process |

- The chat WS everyone remembers lives in `hermes_cli/web_routers/chat_ws.py` on the dashboard; its `_ws_auth_reason` accepts only tickets/loopback tokens (4401/4403). **Do not plan any `ws://host:8642/api/ws` code — that endpoint does not exist.**
- The old dashboard project (hermes-webui) was monorepo'd into hermes-agent (`apps/desktop/` + `web/`); references to that repo are historical.
- Remote access story (Hermex-style Tailscale comparison): desktop "Remote gateway" connections are HTTP(S) with a token — same surface we use. Tailscale/LAN/HTTPS-proxy is a **user deployment choice**, not a Kerykos dependency. API server default-binds 127.0.0.1 and is bearer-gated everywhere, so exposure is the user's tunnel/proxy decision.

### Remote access & encryption model (Kerykos never requires Tailscale)

Kerykos needs exactly two inputs from the user: a reachable URL for the API server + `API_SERVER_KEY`. No VPN is a dependency; but whenever the phone is **not** on the same network as the Hermes machine, the user must pick one path:

| Setup | Works | Encrypted? | Setup effort |
|---|---|---|---|
| **Plain LAN (same Wi-Fi)** | Phone on the Hermes machine's network | ❌ Plaintext HTTP | 2 lines in `~/.hermes/.env` (`API_SERVER_ENABLED=true`, `API_SERVER_KEY=…`) |
| **Tailscale / WireGuard** | Anywhere — both devices join a private overlay | ✅ WireGuard, automatic | Install Tailscale on both (~5 min, recommended for non-technical users; free ≤100 devices) |
| **HTTPS reverse proxy** (Caddy/nginx + domain) | Any internet connection | ✅ TLS / Let's Encrypt | Domain + proxy config (for the self-host crowd) |

**Product rules derived from this:**
- Pairing UI: accept `http://` but show a non-blocking warning ("credentials and chats ride unencrypted; use Tailscale or an HTTPS proxy outside your home network") linking to setup docs. **Never block plain HTTP** — same-LAN HTTP is a legitimate zero-setup path (avoid competitors' HTTPS-only onboarding friction).
- No relay/VPN/bundled infrastructure — Tailscale or proxy is the user's choice.
- Future option (business decision, not architecture): Hermes Cloud gateway or a post-revenue hosted relay could make remote access zero-config (same transport, provisioned URL).

---

## 2. Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Framework** | React Native (Expo SDK 57 — current major as of 2026-09) | Cross-platform, hot reload, massive ecosystem |
| **Language** | TypeScript | Type safety, LLM code quality |
| **Navigation** | React Navigation v7 | Standard RN navigation |
| **State management** | Zustand (pinned 2026-09-21) | Lightweight, performant; single convention for LLM planners |
| **Local storage** | expo-sqlite (analytics), MMKV (settings) | SQLite for analytics queries, MMKV for fast KV |
| **HTTP / streaming** | fetch + SSE parser | **REST + Server-Sent Events are the ONLY transport** — the API server has no WebSocket. Must skip SSE `:` comment lines (keepalive every 10s). No WS library needed. |
| **Chat surface** | `/v1/runs` lifecycle primary; `POST /api/sessions/{id}/chat/stream` fallback | Runs gives detach/reattach, idempotency, steer/stop, restart semantics (decided 2026-09-21, see §3) |
| **Charts** | victory-native 42 | Actively maintained, new-arch compatible; NOT react-native-chart-kit (legacy) |
| **HTTP client** | fetch | Standard REST calls |
| **Push notifications** | expo-notifications (APNs + FCM) | Cross-platform push |
| **Voice** | expo-av (recording), Hermes TTS/STT endpoints | Leverages existing Hermes voice infra |
| **Charts** | react-native-chart-kit or victory-native | Analytics visualizations |
| **Markdown** | react-native-markdown-display | Chat message rendering |
| **Syntax highlighting** | react-native-syntax-highlighter | Code blocks in chat |
| **IAP** | RevenueCat | ⚠️ NOT react-native-iap (archived). RevenueCat wraps StoreKit 2 + Google Play Billing |
| **Build** | EAS Build (cloud) | iOS compilation on Windows |

### React Native vs Swift Tradeoffs

| Factor | React Native | Swift | Impact |
|---|---|---|---|
| **Cross-platform** | ✅ iOS + Android | ❌ iOS only | High — 2x market reach |
| **Iteration speed** | ✅ Hot reload | Slower (Xcode builds) | High — faster UX improvements |
| **Developer pool** | ✅ Larger | Smaller | High — easier to find contributors |
| **Live Activities** | ❌ Not available | ✅ Native | Low — users don't ask for it |
| **Cold start** | ~500-1200ms | ~200-400ms | Low — acceptable for chat app |
| **Memory** | Higher (+20-40MB JS runtime) | Lower | Low — negligible on modern phones |

**Verdict:** React Native covers ~90% of the feature set. The 10% lost (WidgetKit, Live Activities, CarPlay) can be added as native Swift extensions later and doesn't block v1.

---

## 3. Feature Tiers

### V1 Scope Freeze (decided 2026-09-21)

**V1 = Tier 1 (table stakes) + Tier 2 (UX differentiators) + per-session cost display. Everything else is roadmap:**

| In V1 | Deferred to roadmap |
|---|---|
| Tier 1: gateway pairing (URL+bearer key), sessions CRUD, chat with streaming, approvals, steer/stop, push (local), voice I/O (re-verify surface at impl; may move to roadmap without notice if dashboard-only), monitoring: cost display | Tier 3 cost dashboard (cross-session analytics), budget alerts, forecasting, free-only/hard-stop Pro gates |
| Tier 2: multi-line composer, prompt queue, inline images (send + receive — verified, see api-surface), tool call collapse, draft persistence, stick-to-bottom, per-session cost display, context-window gauge (if fields land upstream #86800; else roadmap) | Tier 4: skills browser, cron UI, file browser, memory, projects browser, settings surface, offline cache, share extension |
| Photo attachment (phone → session) via `image_url` data-URL parts on session chat | Advanced analytics (per-message cost, skill/MCP attribution) |

Rationale: ship the working mobile companion first (demand evidence #98196); analytics is secondary and uncontested. Eye the Tier 3 set as the post-v1 Pro launch path.

### Chat Transport Decision (decided 2026-09-21): `/v1/runs` primary

`POST /v1/runs` → poll `GET /v1/runs/{id}` → SSE `GET /v1/runs/{id}/events` → `approval|steer|stop`. Fallback (behind same `GatewayAPI` seam, auto-selected via `GET /v1/capabilities`): `POST /api/sessions/{id}/chat/stream`.

Why runs-primary (mobile-grade durability, source-verified):
- **Detach/reattach native** — SSE stream is optional; after disconnect the app polls run status (summary/tokens included) instead of losing the turn. The exact property flaky cellular networks need.
- **Idempotency built in** — `Idempotency-Key` header (≤255 visible ASCII) + durable store: retry after dropped connection replays the run rather than double-submitting (`_replay_or_conflict`).
- **Steer + stop mid-run** with per-run process ownership reaping.
- **Defined gateway-restart semantics** — interrupted runs report `status:"interrupted"` honestly instead of hanging.
- Terminal statuses standardized: `completed | cancelled | failed | partial`, with undelivered steer text carried on terminal events for client replay.

Trade-offs accepted: input constrained to `input` string or list (last message's `content` used); run_id bookkeeping; the sessions-chat path must be kept wired for two cases — (a) `capabilities`-probe failure on older gateways, (b) **messages carrying images** until image parts are verified over runs (see api-surface doc image table).

### Repo Layout Pin (decided 2026-09-21 — one convention for all impl plans)

```
kerykos/
├── src/
│   ├── app/                  # routes/screens
│   ├── components/
│   ├── services/
│   │   ├── gateway-api.ts    # REST client (all endpoints, typed)
│   │   ├── sse.ts            # SSE parser (skips ':' keepalive comments)
│   │   ├── auth.ts           # keychain-backed credential store per gateway
│   │   ├── storage.ts        # expo-sqlite + MMKV wiring
│   │   └── license.ts        # RevenueCat wrapper
│   ├── feature-flags.ts      # single source: FREE_FEATURES + useFeature
│   ├── analytics/            # SQLite engine + victory-native charts
│   └── store/                # zustand atoms
└── package.json
```

- State: **Zustand** (pinned; not Jotai) — one convention for LLM planners.
- Charts: **victory-native 42** (actively maintained, new-arch compatible, JSON-driven) — over legacy react-native-chart-kit.
- Feature flags follow the open-core doc pattern exactly: `FREE_FEATURES: FeatureName[]` + RevenueCat `isLicensed`.

### Tier 1: Table Stakes

All tier-1 features are REST + SSE on the API server (:8642). Bearer-key auth (`Authorization: Bearer <API_SERVER_KEY>`).

| Feature | API Surface | Complexity |
|---|---|---|
| Gateway connection (REST + SSE) | `GET /api/sessions`, `POST /api/sessions/{id}/chat/stream` (SSE), `/v1/runs` lifecycle | Medium |
| Authentication (server URL + key) | `Authorization: Bearer ` + `API_SERVER_KEY`; health check via `GET /v1/health` | Low |
| Session management (list, create, rename via PATCH, close, delete, fork) | `GET/POST/PATCH/DELETE /api/sessions`, `POST .../fork`, `GET .../messages` | Medium |
| Chat with streaming | SSE via `POST /api/sessions/{id}/chat/stream`, or `/v1/runs` + `GET /v1/runs/{id}/events` (SSE) | Medium |
| Approvals | `POST /v1/runs/{run_id}/approval` (REST, not WS) | Low |
| Steer/stop mid-run | `POST /v1/runs/{run_id}/steer` / `.../stop` | Low |
| Session continuity headers | `X-Hermes-Session-Id` (+ `X-Hermes-Session-Key` for memory scoping) on chat/runs | Low |
| Push notifications | APNs + FCM (local; no Hermes push server) | Medium |
| Voice input/output | Hermes STT/TTS endpoints (dashboard-surface scope — verify at impl time) | Medium |
| **Secure gateway pairing** | Manual URL + key entry (QR is a stretch goal; key lives in `~/.hermes/.env` on the server). Accept plain LAN `http://` with a non-blocking encryption warning — never block it; see "Remote access & encryption model" below Tier 1 | Low |
| **Connectivity paths** | LAN (zero setup) / Tailscale (~5 min, recommended for away-from-home) / HTTPS reverse proxy. App itself has no VPN dependency | Low (app) |
| Capabilities probe | `GET /v1/capabilities` — feature-detect runs/streaming/reasoning support | Low |

### Tier 2: UX Differentiators

| Feature | Pain Point Source | Complexity |
|---|---|---|
| Multi-line growing composer | Talaria PARITY.md (critical) | Low |
| Prompt queue | Talaria PARITY.md (critical) | Medium |
| Inline images in replies | Talaria PARITY.md (critical) | Medium |
| Tool call collapse/summary | Talaria PARITY.md (critical) | Medium |
| Draft persistence | Talaria PARITY.md (high) | Low |
| Stick-to-bottom behavior | Talaria PARITY.md (critical) | Low |
| Session cost display | GitHub #97942 | Low |
| Context-window gauge | Talaria PARITY.md (high) | Low |

### Tier 3: Cost Intelligence (Pro)

| Feature | Data Source | Complexity |
|---|---|---|
| Cost dashboard | `GET /api/sessions` → local SQLite | Low |
| Token usage breakdown | `GET /api/sessions` fields | Low |
| Daily/weekly/monthly trends | Local SQLite aggregation | Moderate |
| Budget alerts | Local computation + push | Low |
| Cost forecasting | Linear regression on daily spend | Moderate |
| Free-only mode | Config enforcement | Medium |
| Session token hard stop | Config enforcement | Medium |

### Tier 4: Desktop Parity

| Feature | API Surface | Complexity | Notes |
|---|---|---|---|
| Skills browser | `GET /v1/skills` | Low | ✅ **Already exists** (corrected from "gap") |
| Cron job management | `GET/POST/PATCH/DELETE /api/jobs/*` + pause/resume/run | Medium | Full CRUD on API server |
| File browser | ❌ Not on API server (`/api/files*` exists only on dashboard :9119) | High | Re-scope: needs either upstream API-server exposure or app-side workaround. Tier 4 + verify |
| Memory (Mnemosyne) | — | High | ⚠️ **No search/read API exists** on any mobile-reachable server — only status (`GET /api/memory`, dashboard). Must be dropped or re-scoped |
| Projects/workspace browser | ⚠️ **Upstream shipped the data model** — `projects.*` JSON-RPC lives on the dashboard backend (tui_gateway, backed by `hermes_cli/projects_db.py`); **not exposed on the API server :8642** | High | Track hermes-agent PRs #90015 (workspace header filtering API sessions) + #78923 (bind workspace header per API session) as the upstream path; not blocked on any single PR |
| Settings/config | ❌ `config.*` is dashboard-WS only. REST has no config surface | High | Re-scope |
| Offline cache | Local SQLite + AsyncStorage | Medium | |
| Share extension | iOS Share Extension / Android Intent | Medium | |

---

## 4. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kerykos (React Native / Expo)                 │
├──────────────┬────────────────┬─────────────────────────────────┤
│   UI Layer   │  Service Layer │      Analytics Engine           │
│              │                │                                  │
│ • Screens    │ • GatewayAPI   │ • DataCollector                  │
│ • Components │ • SSE streaming│   (pages GET /api/sessions)      │
│ • Navigation │ • AuthService  │ • Aggregator                     │
│ • Theming    │ • StorageSvc   │   (SUM, GROUP BY on SQLite)      │
│ • Theming    │ • PushService  │ • TrendTracker                   │
│              │ • VoiceService │   (daily/weekly/monthly deltas)  │
│              │ • IAPService   │ • BudgetMonitor                  │
│              │   (RevenueCat) │   (threshold alerts)             │
│              │                │                                  │
│              │                │ ┌──────────────────────────────┐ │
│              │                │ │ SQLite (on-device)           │ │
│              │                │ │ • session_snapshots          │ │
│              │                │ │ • daily_aggregates           │ │
│              │                │ │ • budgets                    │ │
│              │                │ └──────────────────────────────┘ │
├──────────────┴────────────────┴──────────────────────────────────┤
│                     Hermes API Server (:8642)                    │
│                                                                  │
│  REST: /api/sessions(+/{id}, /messages, /fork), /api/jobs/*,     │
│        /api/model/options, /v1/skills, /v1/runs(+/{id},          │
│        /{id}/events SSE, /{id}/approval, /{id}/steer, /{id}/stop)│
│        /v1/capabilities, /v1/health, /v1/chat/completions,       │
│        /v1/responses, /v1/toolsets, /v1/artifacts/*              │
│  SSE:  /api/sessions/{id}/chat/stream  (10s keepalive comments)  │
│  Auth: Authorization: Bearer <API_SERVER_KEY> everywhere         │
│  NO WebSocket on this server. JSON-RPC WS exists only on the     │
│  dashboard/serve backend (:9119) and is browser-ticket-gated.    │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Client-Side Analytics Architecture

**This is the core differentiator.** All analytics are computed on-device from data already available via `GET /api/sessions`.

### Data Flow

```
1. App Launch / Foreground
   └→ Paginate GET /api/sessions?limit=200&offset=N
   └→ Extract token/cost/model fields per session
   └→ Store snapshot in local SQLite

2. Incremental Updates
   └→ On sessions.changed WS event → re-fetch affected sessions
   └→ On foreground → fetch sessions with last_active > last_sync
   └→ Append new snapshots to SQLite

3. Analytics Computation
   └→ Aggregate from local SQLite (SUM, GROUP BY, ORDER BY)
   └→ Compute totals, trends, breakdowns on-device
   └→ Cache computed results for instant UI
```

See [[client-side-analytics]] for full implementation details, schema, and performance analysis.

---

## 6. Theming System

The desktop app uses CSS variable theming (`--bg`, `--text`, `--accent`, etc.) with theme (light/dark/system) + skin (accent color) layers. React Native replicates this exactly via React Context + StyleSheet tokens.

### Token Mapping (Desktop → Mobile)

| Desktop CSS Variable | React Native Token |
|---|---|
| `--bg` | `tokens.background` |
| `--text` | `tokens.text` |
| `--accent` | `tokens.accent` |
| `--sidebar` | `tokens.sidebar` |
| `--border` | `tokens.border` |
| `--font-ui` | Platform system font |

### Skin Support (corrected 2026-09-20 against `hermes_cli/skin_engine.py` v0.21.3)

- **Real built-in skins (9):** default, ares, mono, slate, daylight, warm-lightmode, poseidon, sisyphus, charizard
- The old doc's list (16 skins incl. graphite, sienna, catppuccin, zeus, verdigris…) was wrong — those are not in the engine. Port the verified 9.
- **VS Code theme import:** desktop ships a Marketplace importer (`apps/desktop/src/themes/install.ts` via `electron/vscode-marketplace.ts`). Ship top popular themes as built-in skins — that part stands.
- Skins flow from the CLI skin engine to surfaces via `skin.changed` events and `config.get skin` (desktop converts to `DesktopTheme` in `apps/desktop/src/themes/skin.ts`).

### Implementation

```typescript
const ThemeContext = createContext({
  theme: 'dark',        // light | dark | system
  skin: 'default',      // built-in skin name or extension skin value
  tokens: { ... },      // resolved color tokens
});

function resolveTokens(theme: string, skin: string): ThemeTokens {
  const base = theme === 'dark' ? darkBase : lightBase;
  const skinOverrides = SKIN_MAP[skin] || {};
  return { ...base, ...skinOverrides };
}
```

---

## 7. Open Core Architecture

See [[open-core-monetization]] for full details.

**Key points:**
- **License:** FSL 1.1-ALv2 (single repo, source-available)
- **Structure:** Single repo + runtime feature flags (App Store receipt validation)
- **NOT a private fork** — JS bundle is extractable from .ipa/.apk; only legal protection (FSL) and distribution control (App Store) matter
- **⚠️ Metro bundler breaks the `require()` pattern** for detecting premium package — use runtime feature flag service instead

```typescript
// Correct approach (not require()-based)
export function useFeature(feature: FeatureName): boolean {
  const { isLicensed } = useLicense(); // RevenueCat receipt check
  return isLicensed || FREE_FEATURES.includes(feature);
}
```

---

## 8. Open Questions (Resolved — re-verified 2026-09-20 against v0.21.3)

| Question | Answer |
|---|---|
| Is the API surface sufficient? | ✅ Yes — `/v1/runs` SSE surface + `/api/sessions/{id}/chat/stream` SSE exist; `/v1/skills` exists |
| Can we do client-side analytics? | ✅ Yes — `GET /api/sessions` returns all needed fields (verified in source AND real state.db schema) |
| Can we enforce cost limits client-side? | ❌ No — server-side enforcement needed. `session_token_hard_stop` still unmerged upstream (PR #97880) |
| Is `react-native-iap` still maintained? | ❌ No — archived. Use RevenueCat (`react-native-purchases` v10.x current) |
| Does the Skills API exist? | ✅ Yes — `GET /v1/skills` on API server |
| Does the Memory search API exist? | ❌ No — status-only, dashboard-surface. Tier 4 memory infeasible as scoped |
| Does the API server have a WebSocket? | ❌ **No. REST + SSE only.** The JSON-RPC WS lives on the dashboard backend and is ticket-gated |
| Can we use the TUI gateway for Projects? | ⚠️ Not from the API server — the projects.* RPC is reachable only over the dashboard/serve surface. Track #90015/#78923 |

---

### Multi-Gateway Model (decided 2026-09-21: design for N, ship UI for 1 in v1)

Each Hermes profile = its own Hermes home = its own `API_SERVER_KEY` (and potentially its own API server instance). One Hermes process can serve all profiles under URL-prefixed paths: `http://host:8642/p/<profile>/…`, with profile-scoped keys.

**App data model is multi-gateway from day one:**
- `gateways` store: `{id, label, base_url, profile_path?, key_ref (keychain alias), added_at, last_connected_at}`
- Every API call resolves credentials via the gateway id, never a global
- Session snapshots/analytics key on `(gatewayId, sessionId)`
- v1 pairing UI: add ONE gateway (simplest flow); multi-gateway management UI ships v1.1 using the same store (no schema migration)

**2. Verification & currency protocol for impl plans (decided 2026-09-21)**

Hermes desktop ships updates frequently (v0.20.5 → v0.21.3 within days). Every impl plan carries this banner pinned verbatim:

> *Source of truth: verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify: (1) route still exists in `gateway/platforms/api_server.py`, (2) request/response shape matches `api-surface.md`. If a newer Hermes release changed either, update `api-surface.md` FIRST, then the plan — never code against a stale surface in silence.*

**Version check routine (run at the start of each impl-planning session):**
1. Run `hermes --version` on the gateway host (or ask user) → compare `X.Y.Z` + commit hash against the pin above.
2. If same version → plan proceeds against existing `api-surface.md`.
3. If newer → `git log <old>..<new> -- gateway/platforms/api_server.py gateway/platforms/api_server_runs.py hermes_cli/web_routers/sessions.py` (quick diff of the three files owning our surface), diff against `api-surface.md`, and rewrite affected plan sections before coding begins.
4. Any endpoint used by a plan that fails re-verification → move feature to roadmap or adapt plan; never assume.

## 9. Upstream Dependencies & PRs to Track

**Baseline refreshed 2026-09-20 against local v0.21.3 (`d7b836ab`). Note: the `hermes-webui` repo no longer exists (monorepo'd into hermes-agent); older webui-PR references are dead.**

| PR/Issue | Repo | Status (2026-09-20) | Impact |
|---|---|---|---|
| #31641 | hermes-agent | Open, **draft**, last updated 2026-07 | `GET /api/usage/summary`, providers, events, Kanban |
| #55805 | hermes-agent | Open (updated 2026-08) | Per-message token accounting, analytics endpoints |
| #86800 | hermes-agent | Open (updated 2026-08) | Context-window fields in API responses |
| #90015 | hermes-agent | **Issue**, open | API sessions filterable by `X-Hermes-Workspace` (project attribution on API server) |
| #78923 | hermes-agent | Open (updated 2026-09-14) | Workspace header bound per API session |
| #97880 (new) | hermes-agent | Open (updated 2026-08-29), unmerged | `session_token_hard_stop` fuse — upstream still lacks a config reader; our "hard stop" Pro gate stays dependent unless we ship server-side config ourselves |
| ~~#5771~~ | ~~hermes-webui~~ | Repo gone | Old project-support blocker; superseded by the projects data model already shipped upstream |

**Key insight (unchanged):** We are NOT blocked on any upstream PR. Client-side analytics uses existing endpoints. Projects data model exists upstream but on the dashboard surface only — waiting means waiting for API-server exposure, not for a specific webui PR.

**Demand issues still open (validated 2026-09-20):** #98196 (iPhone companion), #97942 (free-only fallback cost), #97880 (hard-stop fuse — PR, open).

---

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Talaria ships to App Store first | High | Medium | Ship faster; differentiate on UX + cost |
| Talaria adds analytics | Medium | High | Build deeper analytics; enterprise focus; cross-platform moat |
| Apple App Review rejection | Medium | High | Follow HIG, AI content disclosure, handle offline gracefully; pairing flow reads as transparent user-controlled (URL+key they own), non-blocking HTTP warning shown as informed choice |
| Upstream API breakage between planning and coding | Medium | Medium | Verification & currency protocol (§9a): re-verify version + routes before each coding session; update api-surface.md first, never code against stale surface in silence |
| Projects API blocked long-term | Medium | Medium | Data model shipped upstream on dashboard surface; API-server exposure tracked (#90015/#78923); build without projects in v1 |
| Solo developer burnout | Medium | High | Open core model enables community contributions to core |
| React Native performance issues | Low | Low | Chat UI is text-based; FlashList handles large lists well |
