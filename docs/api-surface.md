# Kerykos — API Surface Reference

**Last updated:** 2026-09-20
**Verified against:** Hermes v0.21.3 @ upstream `d7b836ab` (source-level grep of `api_server.py`, `web_routers/`, `tui_gateway/` + live GitHub checks). Supersedes the earlier v0.20.5 baseline.
**Tags:** #kerykos #api #reference #technical

---

## ⚠️ Critical: Two Separate Servers

| Server | Port | Auth | For |
|---|---|---|---|
| **API Server** | 8642 | `Authorization: Bearer <API_SERVER_KEY>` (header, constant-time compare) | Mobile apps, external OpenAI-compatible clients |
| **Dashboard/serve Server** | 9119 | Browser sessions: password/OAuth + tickets (full auth provider required on any non-loopback bind) | Web dashboard + desktop app only |

**Kerykos connects to the API Server (8642) only.**

### ⚠️ Transport correction (v0.21.3 verified)

**The API server (:8642) has NO WebSocket.** Kerykos uses REST + SSE only:

- Chat streaming: `POST /api/sessions/{id}/chat/stream` → SSE. All SSE streams (chat/stream, `/v1/runs/{id}/events`, `/v1/chat/completions`) emit a `: keepalive` comment line every 10s — parsers must skip `:`-prefixed lines.
- Long-form runs: `/v1/runs` (POST) → poll `GET /v1/runs/{id}` → stream `GET /v1/runs/{id}/events` (SSE) → `POST /v1/runs/{id}/approval|steer|stop`.
- The JSON-RPC WS (`/api/ws`, `session.*`, `prompt.submit`, `config.*`, voice.*, `sessions.changed` events…) exists only on the dashboard backend and is authenticated with browser tickets / loopback tokens (`_ws_auth_reason` rejects others with 4401). **Not usable from a mobile app.**
- The only WS on :8642 is `/v1/browser-control/ws` (one-shot ticket, browser-control feature) — not for us.
- API client should send `X-Hermes-Session-Id` (+ `X-Hermes-Session-Key` for long-term-memory scoping) on chat/runs calls; both are response-echoed on session-creating calls.
- Default bind is `127.0.0.1` (config `platforms.api_server.host` or `API_SERVER_HOST` to change); expose via LAN, Tailscale, or HTTPS reverse proxy — user's choice, not an app dependency.

---

## REST Endpoints (API Server — Exists Today)

### Session Management

| Endpoint | Method | Purpose | Used For |
|---|---|---|---|
| `/api/sessions` | GET | List sessions with token/cost data | Session list, **analytics data source** |
| `/api/sessions` | POST | Create new session | New chat |
| `/api/sessions/:id` | GET | Get session details | Session view |
| `/api/sessions/:id` | DELETE | Delete session | Session management |

### Cron Jobs

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/jobs` | GET | List cron jobs |
| `/api/jobs` | POST | Create cron job |
| `/api/jobs/:id` | PATCH | Update cron job |
| `/api/jobs/:id` | DELETE | Delete cron job |
| `/api/jobs/:id/pause` | POST | Pause cron job |
| `/api/jobs/:id/resume` | POST | Resume cron job |
| `/api/jobs/:id/run` | POST | Run cron job immediately |

### Other

| Endpoint | Method | Purpose | Used For | Server |
|---|---|---|---|---|
| `/v1/capabilities` | GET | Feature flags (runs, streaming, reasoning) | Feature detection at connect | API :8642 |
| `/v1/health` | GET | Gateway liveness | Pairing/health check | API :8642 |
| `/api/model/options` | GET | Provider/model inventory + **pricing metadata** | Settings, analytics provider mapping, cost math | API :8642 |
| `/v1/toolsets` | GET | Installed toolsets | Skills/tools browser | API :8642 |
| `/v1/artifacts/*` | GET/POST | Artifact upload/download | Artifact viewing (stretch) | API :8642 |
| `/v1/chat/completions`, `/v1/responses` | POST | OpenAI-compatible endpoints | Compatibility only — not our chat path | API :8642 |
| `/api/platforms/{platform}/events` | POST | Platform event ingress (bot platforms) | Not for mobile | API :8642 |
| `/api/sessions/{id}` | PATCH | Rename / end_reason | Session management | API :8642 |
| `/api/sessions/{id}/fork` | POST | Fork session | Session tools | API :8642 |
| `/api/sessions/{id}/messages` | GET | Transcript fetch | Offline cache, per-message cost | API :8642 |
| `/api/sessions/stats`, `/api/sessions/search`, `/api/sessions/bulk-delete`, `/api/sessions/prune` | GET/POST | Bulk ops | Stretch (dashboard server surface for some) | ⚠️ verify per-call |
| `/api/files*`, `/api/git/*`, `/api/analytics/usage`, `/api/memory`, `/api/config/raw` | — | Workspace/analytics/memory/config | **Dashboard surface only (:9119)** — flag anything reaching for these | Dashboard :9119 |

---

## Inline Images — verified support map (2026-09-21)

Photo send/receive IS viable on our transport. The normalizer `_normalize_multimodal_content` (api_server.py) accepts parts:

| Part type | Accepted on | Notes |
|---|---|---|
| `text` / `input_text` | ✅ all chat surfaces | Standard |
| `image_url` / `input_image` — **http(s) URL** | ✅ `/v1/chat/completions`, `/v1/responses`, ✅ `POST /api/sessions/{id}/chat[+stream]` (message/input parsed by same normalizer) | ✅ v1 path for **receiving** inline images + sending remote URLs |
| `image_url` — **`data:image/...` (base64)** | ✅ same surfaces | This is the **phone-photo send path**: capture → base64 data URL → part. No upload endpoint needed. Agent core materializes data URLs for vision (`_materialize_data_url_for_vision`); adapters convert per provider (Anthropic/Bedrock/Gemini convertors); durable rows store `[screenshot]` projection. Size limit per endpoint config — impl-time test with a real 12MP photo (~2-4MB base64) |
| `file` / `input_file`, non-image data URLs, audio parts | ❌ **rejected** — `400 unsupported_content_type` ("Only text and image_url/input_image parts are supported") | Document uploads = NOT possible on API server today; roadmap/watch |
| ⚠️ **Unverified: image parts on `POST /v1/runs`** | ⚠️ impl-time test required | Runs reads the last content part raw (`raw_input[-1]["content"]`) without the route-level normalizer — agent core accepts list content (`_is_multimodal_tool_result` handles lists), so it *likely* works, but verify with one live call BEFORE basing image-bearing chat on runs. Until then: **messages carrying images → use the session-chat fallback path** |

**Chat transport decision (2026-09-21):** `/v1/runs` lifecycle is primary (idempotency, steer/stop, restart semantics, durable status). `POST /api/sessions/{id}/chat/stream` remains wired as fallback for (a) gateways failing the `GET /v1/capabilities` probe, (b) image-bearing messages until the runs-image test passes. See [[architecture]] §3.

## WebSocket JSON-RPC Methods (Dashboard/serve Backend — ⚠️ NOT for Kerykos)

These live on :9119 (`tui_gateway` over `/api/ws`),authenticated via browser tickets — a mobile app cannot authenticate. **Reference only, so we know what we are NOT getting.** Where each maps for us is shown on the right.

| Dashboard WS Method | Purpose | Kerykos equivalent (API server) |
|---|---|---|
| `session.list/create/close/interrupt` | Session lifecycle | `GET/POST/DELETE /api/sessions`, runs steer/stop |
| `prompt.submit` | Send messages | `POST /api/sessions/{id}/chat` / `chat/stream`, `POST /v1/runs` |
| `approval.respond/pending` | Approvals | `POST /v1/runs/{run_id}/approval`; pending state via run status/events |
| `config.get/set/show` | Session config | ❌ No REST equivalent (re-scope Tier 4 settings) |
| `model.options` | Model inventory | `GET /api/model/options` ✅ |
| `cron.manage` | Cron jobs | `/api/jobs/*` REST CRUD ✅ |
| `voice.toggle/record/tts` | Voice | ❌ Dashboard-surface; verify at impl time |
| `projects.*` (list/get/tree/create/…) | Projects | ❌ Dashboard-only today; data model exists upstream — track #90015/#78923 |
| `sessions.changed` events | Live push | ❌ No push on API server — **poll** (`GET /api/sessions` on foreground + interval) |

---

## `/v1/runs` — Major Simplification (Feasibility Finding)

The `/v1/runs` endpoint was missed in the original architecture doc. It provides:

- **Async run lifecycle:** create, poll, cancel
- **SSE streaming:** real-time events for message chunks, tool calls, approvals
- **Approval handling:** approve/deny via the same surface
- **Steer/stop:** mid-run course correction

**Impact:** Tier 1+2 features need only ONE transport (the API server). No need to connect to the dashboard server for any feature.

---

## `GET /api/sessions` — Analytics Data Source (field list verified in `_session_response`)

Every session object includes these fields (exact keys from `api_server.py::_session_response`):

| Field | Type | Analytics Use |
|---|---|---|
| `id` | string | Session identity |
| `title` | string | Display name |
| `model` | string | Model used |
| `source` | string | Origin (api_server, desktop, dashboard, cron, cli, telegram…) |
| `input_tokens` / `output_tokens` | int | Token counts |
| `cache_read_tokens` / `cache_write_tokens` | int | Cache hit/write tokens |
| `reasoning_tokens` | int | Thinking tokens |
| `estimated_cost_usd` | float | Estimated cost |
| `actual_cost_usd` | float | Actual cost (when reported upstream) |
| `api_call_count` | int | Number of API calls |
| `tool_call_count` | int | Number of tool calls |
| `message_count` | int | Message count |
| `started_at` / `ended_at` / `end_reason` | float/string | Session window + termination reason |
| `last_active` | float | Derived (from `last_activity_at`); sync watermark |
| `parent_session_id` | string | Lineage — exclude children from cost totals if counting both |
| `pinned` / `archived` / `hidden` | bool | Flags — decide whether archived sessions count toward history |
| `preview` | string | Last-message preview |
| `user_id` | string | Owner (multi-profile) |

**Pagination:** `GET /api/sessions?limit=200&offset=0` — server default limit 50, **max 200**. Response shape: `{object:"list", data:[...], limit, offset, has_more}`.

⚠️ **Paging subtlety:** `has_more` counts only non-pinned rows in the window; pinned sessions are back-filled *past* the limit. For a robust full-sync, page until a page returns fewer than `limit` rows **plus** one extra query including archived, rather than trusting `has_more` alone.
Also available on this server: `GET /api/sessions/{id}/messages` (per-message token counts `token_count`), `include_children` query param for lineage.

---

## Endpoints That Don't Exist (mobile-reachable) — verified 2026-09-20

| Endpoint | Status | Impact | Workaround |
|---|---|---|---|
| **Projects API on :8642** | Data model shipped upstream (`projects.*` JSON-RPC + `hermes_cli/projects_db.py`), dashboard/serve surface only | Cannot browse/switch projects from API-server transport | Track hermes-agent #90015 + #78923; until then no projects in app |
| **Memory search/read** | Does not exist on either server | Cannot search/view memories | `GET /api/memory` is status-only (dashboard surface) |
| **Account-level analytics** | `/api/analytics/usage` is dashboard-surface only | No server-side aggregation on our transport | **Client-side analytics (our approach)** |
| **Server-side cost enforcement** | `session_token_hard_stop` still unmerged (PR #97880); `auxiliary.free_only` exists in agent config | Hard-stop/free-only Pro gates depend on user's server config | Requires server-side opt-in; no app enforcement |
| **Config RW over REST** | `config.*` is dashboard-WS only | No remote settings surface | Re-scope Tier 4 settings |
| **Push server** | No Hermes push infrastructure | APNs/FCM need our own relay | Local notifications v1 (Talaria ships a small Python push relay) |

---

## Key Source Files (Hermes v0.21.3 codebase, verified 2026-09-20)

| File | Purpose |
|---|---|
| `gateway/platforms/api_server.py` | HTTP API server (port 8642) — routes + `_session_response` field allowlist |
| `gateway/platforms/api_server_runs.py` | `/v1/runs` admission, status, SSE events, control |
| `hermes_cli/web_server.py` (+ `web_routers/*`) | Dashboard server (port 9119) and FastAPI routers |
| `hermes_cli/web_routers/chat_ws.py` | `/api/ws` JSON-RPC sidecar (dashboard backend, ticket-gated) |
| `tui_gateway/server.py` | JSON-RPC method registry (`projects.*`, `config.*`, voice, …) |
| `hermes_state_usage.py` / `hermes_state_sessions.py` | Token/cost persistence (`input_tokens`, `estimated_cost_usd`, …) |
| `hermes_cli/skin_engine.py` | Built-in skins (9 verified) |
| `agent/auxiliary_client.py` | `auxiliary.free_only` config hook (upstream free-only support) |
