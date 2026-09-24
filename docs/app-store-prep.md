# Kerykos — App Store / Google Play Preparation

**Last updated:** 2026-09-24
**Source:** docs/impl/phase-6-monetization-ship.md §6.4
**Tags:** #kerykos #phase-6 #app-store #google-play

---

## AI Content Disclosure (NFR-5)

Apple requires apps that generate AI content to disclose this. Kerykos connects to a user's own AI server — the app itself doesn't generate content, but it's the interface.

### App Store description must include

- "Kerykos connects to your self-hosted Hermes Agent server"
- "All AI processing happens on your own server — no data is sent to Kerykos servers"
- "AI-generated content is produced by models running on your infrastructure"

### Info.plist additions

```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

## Privacy Nutrition Labels

- Data Not Collected (no analytics SDK, no telemetry — NFR-1)
- No third-party tracking
- All data stays on device and user's server

Note: RevenueCat is payment infrastructure, not analytics — it processes purchase receipts only.

## App Store Connect Setup

| Field | Value |
|---|---|
| App Name | Kerykos |
| Bundle ID | `com.joshu.kerykos` |
| SKU | `kerykos-ios-v1` |
| Primary Category | Developer Tools |
| Secondary Category | Productivity |
| Age Rating | 4+ |
| Price | Free (with In-App Purchase) |
| IAP | `kerykos_pro_monthly` — $4.99/mo auto-renewable subscription |

## Google Play Console Setup

| Field | Value |
|---|---|
| App Name | Kerykos |
| Package Name | `com.joshu.kerykos` |
| Category | Developer Tools |
| Content Rating | Everyone |
| Pricing | Free (with In-App Purchase) |

## Acceptance Criteria (NFR-5)

- AI content disclosure in App Store description
- Privacy nutrition labels: Data Not Collected
- IAP configured in both stores
- App passes App Store review guidelines (HIG compliance)
