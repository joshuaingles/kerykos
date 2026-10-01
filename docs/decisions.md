# Kerykos — Decisions Log

**Last updated:** 2026-09-19
**Status:** All decisions locked unless noted
**Tags:** #kerykos #decisions #reference

---

## Locked Decisions

| Decision | Choice | Date | Rationale |
|---|---|---|---|
| **Name** | Kerykos | 2026-09-01 | Greek "of a herald" (genitive of κῆρυξ), easy to pronounce, fully available on GitHub/npm/App Store |
| **Logo** | Caduceus | 2026-09-01 | Hermes' staff (two snakes, winged) — iconic symbol of the messenger god |
| **Architecture** | React Native (Expo) | 2026-08-31 (SDK 57 pinned 2026-09-20) | Cross-platform (iOS + Android), hot reload, massive ecosystem, LLM code quality covers ~90% of features |
| **Transport** | REST + SSE on API server (:8642) only | 2026-09-20 | Verified: API server has no WebSocket; dashboard WS is ticket-gated browser-only. Bearer-key auth; remote access via user's Tailscale/proxy of choice — no app dependency |
| **Chat surface** | `/v1/runs` primary, sessions-chat/stream fallback | 2026-09-21 | Runs: detach/reattach, `Idempotency-Key`, mid-run steer/stop, defined restart semantics. Fallback for capability-probe failures + image-bearing messages until runs-image parts verified (api-surface doc) |
| **V1 scope** | Tier 1 + Tier 2 + per-session cost display | 2026-09-21 | Ship the working companion first (#98196); analytics dashboards etc. = post-v1 Pro path. Photo send via data-URL parts (verified) |
| **Multi-gateway** | Data model for N gateways day one; UI ships 1 in v1 | 2026-09-21 | Per-profile keys/URLs (`/p/<profile>/`); `gateways` store + per-gateway keychain refs; no v1.1 schema migration |
| **App convention pin** | Zustand / victory-native 42 / `src/services/` + `src/feature-flags.ts` | 2026-09-21 | One convention set for LLM impl planners; chart lib chosen over legacy chart-kit |
| **License** | FSL 1.1 → Apache 2.0 | 2026-09-16 | Source-available, 2-year conversion, clear "Competing Use" definition, App Store compatible, standardized (Sentry model) |
| **Code structure** | Single repo + feature flags | 2026-09-16 | One codebase, one CI. JS bundle is extractable from .ipa/.apk anyway — legal protection (FSL) matters, not code hiding |
| **Monetization** | Feature Gates | 2026-09-01 | Free tier fully functional (unlimited sessions). Pro tier motivated by real need (cost control), not arbitrary limits |
| **Pro price** | $4.99/month | 2026-09-01 | Sweet spot for individual developers. Apple takes 15% (<$1M/yr), net ~$4.24/month per subscriber |
| **Differentiator** | Better UX + cost intelligence + cross-platform | 2026-08-30 | Users want core mobile features first; analytics is secondary but uncontested. Talaria has zero analytics. |
| **Analytics** | Client-side on-device SQLite | 2026-08-30 | `GET /api/sessions` already returns per-session cost data. No backend needed, no upstream PRs blocked, strongest privacy |
| Dev environment | Windows + EAS Build (cloud) | 2026-08-31 | Expo solves iOS compilation on Windows. 90% of dev has instant hot reload |
| **Remote access model** | User chooses: LAN HTTP / Tailscale / HTTPS proxy | 2026-09-20 | Kerykos has NO Tailscale/VPN dependency. Recommended default for away-from-home: Tailscale (~5 min). App warns on plain-HTTP pairing but never blocks. Compared to Hermex-style setups, our API-server transport removes the auth-provider/tunnel complexity on the app side |
| Payment processing | Apple App Store (start here) | 2026-09-01 | 15% cut, handles tax/refunds, highest user trust, Face ID checkout. Revisit at 1,000+ subscribers |

---

## Name Research History

Explored many names before settling on Kerykos:

- **Nuntius** — Latin "messenger" (crowded)
- **Praeco** — Latin "herald" (available, but user didn't love it)
- **Petasos** — Hermes' helmet (taken by another Hermes companion app)
- **Heraldis** — Not real Latin (hallucination — caught by user)
- **Heraldus** — Medieval Latin (not in Wiktionary)
- **Tribunus** — Roman magistrate (legal risk with Tribunus-dev)
- **Keryx** — Greek "herald" (crowded)
- **Kerux** — English-friendly form of keryx (crowded)

**Kerykos** emerged as the winner: authentic Greek, meaningful ("of a herald"), fully available, easy to pronounce (keh-REE-kos).

### Availability (checked 2026-09-01)

| Platform | Status |
|---|---|
| GitHub repos | 0 repos |
| GitHub org | ✅ Available |
| kerykos-app, kerykos-ai, kerykos-hermes | ✅ All available |
| npm | ✅ Available |
| App Store | 5 results (Greek apps, not competing) |

---

## License Decision: FSL 1.1 (Not BSL)

**Chosen:** FSL 1.1-ALv2 (Functional Source License)
**Rejected:** BSL 1.1, MIT, GPL, AGPL

| License | Problem for Kerykos |
|---|---|
| MIT / Apache 2.0 | No protection against commercial cloning |
| GPL / AGPL | App Store incompatible (Apple ToS conflict with copyleft) |
| BSL 1.1 | Complex (custom "Additional Use Grant" language), 4-year conversion, not standardized |
| **FSL 1.1** | ✅ Standardized, 2-year conversion to Apache 2.0, clear "Competing Use" definition, created by Sentry |

**What FSL allows:**
- ✅ Self-hosting (running your own Hermes server)
- ✅ Internal/non-commercial use
- ✅ Learning, modification, and proposing improvements
- ✅ Non-commercial distribution

**What FSL prohibits:**
- ❌ Publishing a competing app to the App Store
- ❌ Launching Kerykos as a commercial product

**Template:** [FSL-1.1-ALv2](https://fsl.software/FSL-1.1-ALv2.template.md)
**Contributions:** Consider a CLA for community contributions (standard for single-vendor source-available projects).

---

## Revenue Projection (5% conversion)

| Users | Monthly Revenue | Annual Revenue |
|---|---|---|
| 1,000 | $249 | $2,994 |
| 5,000 | $1,248 | $14,976 |
| 10,000 | $2,495 | $29,940 |

---

## Business Phasing

| Phase | GitHub | Entity | Trigger |
|---|---|---|---|
| **Development** | Personal account | None | Now |
| **Open Core ready** | Move to org (`kerykos`) | None | When core features are complete |
| **Collecting subscriptions** | Org | Form LLC | When Pro tier launches |

---

## Branding

- **Name:** Kerykos
- **Subtitle:** "Hermes Agent Companion"
- **Logo:** Caduceus (Hermes' staff — two snakes, winged)
- **Pronunciation:** keh-REE-kos
- **Brand tagline:** "Kerykos: Of the Herald"
