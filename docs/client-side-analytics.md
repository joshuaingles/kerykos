# Kerykos — Client-Side Analytics

**Last updated:** 2026-09-20 (re-verified against v0.21.3; sync-mode corrected poll-based)
**Status:** Core differentiator — no other mobile Hermes app has this
**Tags:** #kerykos #analytics #differentiator #technical

---

## Executive Summary

Client-side analytics is highly viable. The `GET /api/sessions` endpoint already returns per-session token/cost data. No backend server required. No new API endpoints needed. No upstream PRs blocked. Data stays on device — strongest possible privacy guarantee.

---

## Data Source

**Single endpoint:** `GET /api/sessions` (paginated, max 200/page)

**Data source:** `GET /api/sessions` (paginated, **max 200/page**, server default 50) — fields verified in `api_server.py::_session_response` and the real `state.db` schema: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `estimated_cost_usd`, `actual_cost_usd`, `api_call_count`, `tool_call_count`, `message_count`, `model`, `source`, `started_at`, `ended_at`, `end_reason`, `last_active`, `parent_session_id`, `pinned`, `archived`, `hidden`, `preview`, `user_id`.

**Enrichment:** `GET /api/model/options` for provider/model mapping **and per-model pricing metadata** (present in the response — useful for cost accuracy when `estimated_cost_usd` is 0).

## Sync Mode: POLL, not push (v0.21.3 verified)

The API server (:8642) has **no push channel** — the `sessions.changed` event exists only on the dashboard's WebSocket. On our transport, incremental sync is **poll-based**:

1. Foreground / app launch → incremental fetch
2. While app is in foreground with analytics open → periodic poll (e.g. 30–60s), skipping when offline
3. Background → nothing (iOS suspends sockets anyway; a BGAppRefresh task can do a light poll for budget alerts — evaluate battery impact at impl time)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 iOS/Android App                  │
├─────────────┬───────────────┬───────────────────┤
│   Screens   │   Services    │   Analytics Engine │
│             │               │                    │
│ • Dashboard │ • GatewayAPI  │ • DataCollector    │
│ • Sessions  │ • SSE stream  │ • Aggregator       │
│ • Analytics │ • Auth        │ • TrendTracker     │
│ • Settings  │ • Storage     │ • BudgetMonitor    │
│             │               │                    │
│             │               │ ┌────────────────┐ │
│             │               │ │ SQLite (local) │ │
│             │               │ │ • snapshots    │ │
│             │               │ │ • daily totals │ │
│             │               │ │ • budgets      │ │
│             │               │ └────────────────┘ │
└─────────────┴───────┬───────┴───────────────────┘
                      │
              ┌───────▼───────┐
              │  Hermes API   │
              │ GET /api/     │
              │   sessions    │
              └───────────────┘
```

### Data Flow (poll-based — no push exists on our transport)

1. **On app launch / foreground (incremental):** `GET /api/sessions?limit=200&offset=…`, client-side filter `last_active > last_sync`, upsert into local SQLite
2. **Full backfill (first launch):** paginate every page, then keep the `last_sync` watermark. Mind the `has_more` pinned-row subtlety (see api-surface doc).
3. **Optional in-foreground poll (30–60s)** while analytics screen open
4. **Analytics computation:** Aggregate from local SQLite (fast, no network), cache results for instant UI

---

## SQLite Schema

```sql
CREATE TABLE session_snapshots (
  id TEXT PRIMARY KEY,              -- means "(gateway base_url, session_id)"; composite or hash
  session_id TEXT,
  title TEXT,
  model TEXT,
  source TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  api_call_count INTEGER,
  tool_call_count INTEGER,
  message_count INTEGER,
  started_at REAL,
  ended_at REAL,                    -- NEW: session window
  end_reason TEXT,                  -- NEW: termination reason
  last_active REAL,
  parent_session_id TEXT,           -- NEW: lineage; exclude children when summing totals (avoid double-count)
  archived INTEGER DEFAULT 0,       -- NEW: 0/1 flag
  pinned INTEGER DEFAULT 0,         -- NEW: 0/1 flag
  hidden INTEGER DEFAULT 0,         -- NEW: 0/1 flag
  synced_at REAL
);

CREATE TABLE daily_aggregates (
  date TEXT PRIMARY KEY,
  total_cost_usd REAL,
  total_input_tokens INTEGER,
  total_output_tokens INTEGER,
  total_api_calls INTEGER,
  total_tool_calls INTEGER,
  session_count INTEGER
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  name TEXT,
  amount_usd REAL,
  period TEXT,          -- daily, weekly, monthly
  alert_threshold REAL  -- 0.8 = alert at 80%
);
```

---

## What We Can Build

### Tier 1: Core Analytics (No PRs Needed)

| Feature | Data Source | Complexity |
|---|---|---|
| Total spend (all time) | Sum `estimated_cost_usd` | Trivial |
| Spend by model | Group by `model`, sum costs | Trivial |
| Spend by time period | Filter by `started_at`, sum | Trivial |
| Token usage breakdown | Sum input/output/cache/reasoning | Trivial |
| Cost per session | Display per session | Trivial |
| Most expensive sessions | Sort by cost | Trivial |
| Cache hit rate | `cache_read / (input + cache_read)` | Trivial |
| Provider breakdown | Map model → provider via `model/options` | Simple |

### Tier 2: Enhanced Analytics

| Feature | Data Source | Complexity |
|---|---|---|
| Daily/weekly/monthly trends | Store daily snapshots, compute deltas | Moderate |
| Budget alerts | Compare cumulative spend vs threshold | Simple |
| Cost forecasting | Linear regression on daily spend | Moderate |
| Reasoning overhead | `reasoning_tokens / output_tokens` | Trivial |
| Session efficiency | Cost per message, tokens per tool call | Simple |

### Tier 3: Advanced (Requires Enrichment)

| Feature | Complexity |
|---|---|
| Per-message cost (parse transcript) | Complex |
| Skill/MCP cost attribution | Complex |
| Cost by project | Moderate |

---

## Performance

| Scenario | Sessions | API Calls | Time | Storage |
|---|---|---|---|---|
| Light user | 50 | 1 | <1s | <100 KB |
| Moderate user | 200 | 1 | <2s | <500 KB |
| Power user | 500 | 3 | <5s | <2 MB |
| Enterprise | 2000 | 10 | <15s | <2 MB |

SQLite aggregation on 2000 rows: **<10ms** on modern iPhones.

**Optimization:** Incremental sync (only `last_active > last_sync`) means most refreshes are <10 sessions.

---

## Security & Privacy

| Concern | Assessment |
|---|---|
| Data leaves device | ❌ No. All analytics computed on-device. |
| New attack surface | ❌ No. Uses existing `GET /api/sessions` with existing bearer auth. |
| Backend server | ❌ No backend needed. |
| Third-party services | ❌ No analytics SDK, no telemetry, no tracking. |
| Data persistence | ✅ SQLite encrypted by iOS when device locked. |
| Data deletion | ✅ Delete app = delete all data. User can also clear cache. |
| Gateway key storage | ⚠️ Store `API_SERVER_KEY` in device Keychain / Android Keystore, never in AsyncStorage/MMKV plaintext. |
| Transport | ⚠️ Three user-chosen paths: same-LAN plaintext HTTP (zero setup, legitimate — app warns but never blocks), Tailscale/WireGuard (recommended away-from-home, encrypted), or HTTPS reverse proxy. Kerykos itself has **no Tailscale/VPN dependency**. See "Remote access & encryption model" in [[architecture]]. |

**No data leaves the device.** This is a strong selling point for security-conscious users and enterprises.

---

## Tradeoff: Historical Data

Client-side analytics only has data from when the app was installed.

**Mitigation:** On first launch, do a full sync of all sessions (paginated). This captures all existing session data.

**For most users:** Fine. They care about current and future spend.

**For enterprises:** May want centralized audit logs. This is a Tier 3 / Enterprise tier feature that would require a backend — but it's also a revenue opportunity.
