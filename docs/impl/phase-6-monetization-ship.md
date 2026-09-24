# Phase 6 — Monetization & Ship

**Last updated:** 2026-09-23
**Source of truth:** verified against Hermes v0.21.3 at commit `d7b836ab` (2026-09-20). Before coding against any endpoint, re-verify per architecture §9a.
**Tags:** #kerykos #impl #phase-6 #monetization #ship

**Purpose:** Wire RevenueCat IAP, feature flag gating, App Store / Google Play submission, AI content disclosure, staged beta rollout. This is the final phase before public launch.

**KR/NFR coverage:** NFR-1 (no third-party analytics SDKs — RevenueCat is payment infra, not analytics), NFR-5 (AI-content disclosure, staged TestFlight → Play rollout)

---

## 6.1 RevenueCat Integration

**File:** `src/services/license.ts`

NOT `react-native-iap` (archived). Use `react-native-purchases` v10.x (architecture §2, decision from 2026-09-19).

```typescript
import Purchases, { CustomerInfo, PurchasesPackage } from 'react-native-purchases';

const RC_API_KEY_IOS = 'appl_XXXXX';     // from RevenueCat dashboard
const RC_API_KEY_ANDROID = 'goog_XXXXX'; // from RevenueCat dashboard

export class LicenseService {
  static initialized = false;

  /** Initialize RevenueCat (call once at app start). */
  static async init(): Promise<void> {
    if (this.initialized) return;

    await Purchases.configure({
      apiKey: Platform.OS === 'ios' ? RC_API_KEY_IOS : RC_API_KEY_ANDROID,
    });

    // Enable debug logging in dev
    if (__DEV__) {
      await Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
    }

    this.initialized = true;
  }

  /** Check if user has active Pro license. */
  static async isLicensed(): Promise<boolean> {
    try {
      const info = await Purchases.getCustomerInfo();
      return info.entitlements.active['pro'] !== undefined;
    } catch {
      return false;
    }
  }

  /** Get available packages for purchase. */
  static async getOfferings(): Promise<PurchasesPackage[]> {
    try {
      const offerings = await Purchases.getOfferings();
      const current = offerings.current;
      return current?.availablePackages ?? [];
    } catch {
      return [];
    }
  }

  /** Purchase a package. */
  static async purchase(pkg: PurchasesPackage): Promise<CustomerInfo> {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return customerInfo;
  }

  /** Restore purchases (App Store requirement). */
  static async restore(): Promise<CustomerInfo> {
    return Purchases.restorePurchases();
  }

  /** Listen for customer info changes. */
  static onCustomerInfoChanged(callback: (info: CustomerInfo) => void): () => void {
    return Purchases.addCustomerInfoUpdateListener(callback);
  }
}
```

**RevenueCat dashboard setup (pre-implementation):**
1. Create RevenueCat project
2. Configure App Store / Google Play integrations (API keys, shared secrets)
3. Create entitlement: `pro`
4. Create product: `kerykos_pro_monthly` ($4.99/mo)
5. Create offering: default with monthly package
6. Configure in-app products in App Store Connect / Google Play Console

**Acceptance criteria:**
- RevenueCat initializes without errors
- `isLicensed()` returns false for free users
- Purchase flow completes and `isLicensed()` returns true
- Restore purchases works (App Store requirement)
- Listener fires on entitlement changes

---

## 6.2 Feature Flag Wiring

**File:** `src/hooks/useFeature.ts`

Wires the `feature-flags.ts` structure from Phase 0 to RevenueCat license check. NOT `require()`-based (Metro bundler caveat — architecture §7).

```typescript
import { useEffect, useState } from 'react';
import { FREE_FEATURES, FeatureName } from '@/feature-flags';
import { LicenseService } from '@/services/license';

/**
 * Feature gate hook (architecture §7).
 * Runtime check backed by RevenueCat receipt — NOT require()-based.
 */
export function useFeature(feature: FeatureName): boolean {
  const [isLicensed, setIsLicensed] = useState(false);

  useEffect(() => {
    // Check license on mount
    LicenseService.isLicensed().then(setIsLicensed);

    // Listen for changes (purchase, restore)
    const unsubscribe = LicenseService.onCustomerInfoChanged((info) => {
      setIsLicensed(info.entitlements.active['pro'] !== undefined);
    });

    return unsubscribe;
  }, []);

  // Free features always available
  if (FREE_FEATURES.includes(feature)) return true;

  // Pro features require license
  return isLicensed;
}

/**
 * Non-hook version for services/non-component code.
 * Caches result briefly (not real-time like the hook).
 */
let cachedLicense: boolean | null = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

export async function isFeatureEnabled(feature: FeatureName): Promise<boolean> {
  if (FREE_FEATURES.includes(feature)) return true;

  if (cachedLicense !== null && Date.now() - cacheTime < CACHE_TTL) {
    return cachedLicense;
  }

  cachedLicense = await LicenseService.isLicensed();
  cacheTime = Date.now();
  return cachedLicense;
}
```

**Feature gating in UI:**

```typescript
// Example: Cost dashboard (Tier 3 — Pro)
function CostDashboard() {
  const showDashboard = useFeature('cost_dashboard');

  if (!showDashboard) {
    return <ProUpgradePrompt feature="Cost Dashboard" />;
  }

  return <ActualCostDashboard />;
}
```

**`feature-flags.ts` (from Phase 0, updated):**

```typescript
export const FREE_FEATURES: FeatureName[] = [
  // All Tier 1 + Tier 2 features are free (no entries needed — default is free)
  // Only Tier 3 cost features are gated:
];

// Features NOT in FREE_FEATURES require Pro:
// - cost_dashboard
// - token_breakdown
// - budget_alerts
// - cost_forecasting
// - free_only_mode
// - hard_stop
```

**Acceptance criteria:**
- `useFeature` returns true for FREE_FEATURES regardless of license
- `useFeature` returns false for Pro features when unlicensed
- `useFeature` returns true for Pro features when licensed
- License state updates reactively on purchase/restore
- No `require()`-based detection anywhere (Metro bundler caveat)

---

## 6.3 Pro Upgrade Prompt

**File:** `src/components/ProUpgradePrompt.tsx`

```typescript
export function ProUpgradePrompt({ feature }: { feature: string }) {
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);

  useEffect(() => {
    LicenseService.getOfferings().then(setPackages);
  }, []);

  const handlePurchase = async (pkg: PurchasesPackage) => {
    try {
      await LicenseService.purchase(pkg);
    } catch (err) {
      // Purchase cancelled or failed
    }
  };

  return (
    <View style={styles.container}>
      <Icon name="lock" size={48} color={tokens.accent} />
      <Text style={styles.title}>Unlock {feature}</Text>
      <Text style={styles.subtitle}>
        Upgrade to Kerykos Pro for advanced analytics, budget alerts, and more.
      </Text>
      {packages.map(pkg => (
        <Button
          key={pkg.identifier}
          title={`${pkg.product.title} — ${pkg.product.priceString}/mo`}
          onPress={() => handlePurchase(pkg)}
        />
      ))}
      <Button
        title="Restore Purchases"
        onPress={() => LicenseService.restore()}
        variant="secondary"
      />
    </View>
  );
}
```

**Acceptance criteria:**
- Shows locked feature name and Pro benefits
- Lists available packages with pricing
- Purchase flow completes
- Restore button works (App Store requirement)
- Dismissible without purchase

---

## 6.4 App Store Preparation

### AI Content Disclosure (NFR-5)

Apple requires apps that generate AI content to disclose this. Kerykos connects to a user's own AI server — the app itself doesn't generate content, but it's the interface.

**Info.plist additions:**
```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

**App Store description must include:**
- "Kerykos connects to your self-hosted Hermes Agent server"
- "All AI processing happens on your own server — no data is sent to Kerykos servers"
- "AI-generated content is produced by models running on your infrastructure"

**Privacy nutrition labels:**
- Data Not Collected (no analytics SDK, no telemetry — NFR-1)
- No third-party tracking
- All data stays on device and user's server

### App Store Connect Setup

| Field | Value |
|---|---|
| App Name | Kerykos |
| Bundle ID | `com.joshu.kerykos` (or chosen) |
| SKU | `kerykos-ios-v1` |
| Primary Category | Developer Tools |
| Secondary Category | Productivity |
| Age Rating | 4+ |
| Price | Free (with In-App Purchase) |
| IAP | `kerykos_pro_monthly` — $4.99/mo auto-renewable subscription |

### Google Play Console Setup

| Field | Value |
|---|---|
| App Name | Kerykos |
| Package Name | `com.joshu.kerykos` |
| Category | Developer Tools |
| Content Rating | Everyone |
| Pricing | Free (with In-App Purchase) |

**Acceptance criteria (NFR-5):**
- AI content disclosure in App Store description
- Privacy nutrition labels: Data Not Collected
- IAP configured in both stores
- App passes App Store review guidelines (HIG compliance)

---

## 6.5 EAS Build Configuration

**File:** `eas.json`

```json
{
  "cli": {
    "version": ">= 3.0.0"
  },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "ios": {
        "simulator": false
      }
    },
    "production": {
      "ios": {
        "autoIncrement": true,
        "bundleIdentifier": "com.joshu.kerykos"
      },
      "android": {
        "autoIncrement": true,
        "applicationId": "com.joshu.kerykos"
      }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "your-apple-id@example.com",
        "ascAppId": "1234567890"
      },
      "android": {
        "serviceAccountKeyPath": "./google-service-account.json"
      }
    }
  }
}
```

**Build commands:**
```bash
# Development build (for testing on device)
eas build --profile development --platform ios
eas build --profile development --platform android

# Preview build (TestFlight / Play internal testing)
eas build --profile preview --platform ios
eas build --profile preview --platform android

# Production build
eas build --profile production --platform ios
eas build --profile production --platform android
```

---

## 6.6 Beta Testing Strategy

**From go-to-market.md:**

### Phase 1: Internal Testing
- EAS development builds on personal devices
- Full feature verification against live Hermes gateway
- Smoke test all KR acceptance criteria

### Phase 2: TestFlight + Play Internal Testing
- EAS preview builds
- 10-20 beta testers (Hermes community)
- Collect feedback on pairing flow, chat UX, analytics
- 2-4 week beta period

### Phase 3: Public Launch
- EAS production builds
- Submit to App Store + Google Play
- Staged rollout (NFR-5): 10% → 25% → 50% → 100%

**NFR-5 compliance:**
- Staged TestFlight → Play rollout per go-to-market plan
- AI-content disclosure metadata in submission

---

## 6.7 LICENSE.md

**File:** `LICENSE.md` (repo root)

```markdown
# Functional Source License 1.1 — Apache 2.0

This software is licensed under the Functional Source License, Version 1.1,
with the Apache License, Version 2.0 as the Change License.

## License

Copyright © 2026 [Your Name]

Licensor: [Your Name]

Software: Kerykos

Change Date: 2028-09-23

Change License: Apache License, Version 2.0

## Source Code

The source code for this software is available at:
https://github.com/[your-username]/kerykos

## Terms

This license grants you the right to use, modify, and distribute this software
for any purpose that does not compete with the Software. "Competing Use" means
use in a product or service that is substantially similar to the Software and
targets the same user base.

After the Change Date, the Change License applies and this software becomes
available under the Apache License, Version 2.0.

For the full license text, see: https://fsl.software/FSL-1.1-Apache-2.0.template.md
```

---

## 6.8 Final Pre-Launch Checklist

| # | Item | Status |
|---|---|---|
| 1 | All Phase 0-5 acceptance criteria met | ☐ |
| 2 | RevenueCat IAP tested (purchase + restore) | ☐ |
| 3 | Feature flags wired (free vs Pro) | ☐ |
| 4 | AI content disclosure in store listing | ☐ |
| 5 | Privacy nutrition labels: Data Not Collected | ☐ |
| 6 | App Store screenshots (6.7" iPhone, 12.9" iPad) | ☐ |
| 7 | Google Play screenshots (phone + tablet) | ☐ |
| 8 | App icon + splash screen | ☐ |
| 9 | TestFlight beta tested (10+ testers, 2+ weeks) | ☐ |
| 10 | Play internal testing completed | ☐ |
| 11 | FSL 1.1 LICENSE.md in repo root | ☐ |
| 12 | README.md updated with public links | ☐ |
| 13 | Staged rollout configured (10% → 25% → 50% → 100%) | ☐ |
| 14 | Crash reporting (optional: Sentry, NOT analytics) | ☐ |
| 15 | Performance profiling (cold start < 1.2s, NFR-2) | ☐ |

---

## Verification Checklist

| # | Check | How to verify |
|---|---|---|
| 1 | RevenueCat init | App starts → RevenueCat initializes without error |
| 2 | Purchase flow | Tap "Upgrade" → complete purchase → Pro features unlock |
| 3 | Restore flow | Delete app → reinstall → "Restore" → Pro features restored |
| 4 | Feature gates | Free user → Pro screens show lock; Pro user → screens unlock |
| 5 | No `require()` detection | `grep -r "require.*premium" src/` returns nothing |
| 6 | EAS build succeeds | `eas build --profile production` completes for iOS + Android |
| 7 | TestFlight submission | Build appears in TestFlight → installs on device |
| 8 | Play submission | Build appears in Play Console → review passes |
| 9 | AI disclosure | Store listing includes AI content disclosure text |
| 10 | Privacy labels | App Store Connect shows "Data Not Collected" |

---

## End of Implementation Plan

All 6 phases complete the v1 implementation. Return to [[README]] for project overview.
