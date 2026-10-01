import { useEffect, useState } from 'react';
import { FREE_FEATURES, type FeatureName } from '@/feature-flags';
import { LicenseService } from '@/services/license';

/**
 * Feature gate hook (architecture §7).
 * Runtime check backed by RevenueCat receipt — NOT require()-based
 * (Metro bundler breaks require()-based detection).
 */
export function useFeature(feature: FeatureName): boolean {
  const [isLicensed, setIsLicensed] = useState(false);

  useEffect(() => {
    let mounted = true;

    LicenseService.init()
      .then(() => LicenseService.isLicensed())
      .then((licensed) => {
        if (mounted) setIsLicensed(licensed);
      })
      .catch(() => {
        if (mounted) setIsLicensed(false);
      });

    // Listen for changes (purchase, restore)
    const unsubscribe = LicenseService.onCustomerInfoChanged((info) => {
      if (mounted) {
        setIsLicensed(info.entitlements.active['pro'] !== undefined);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
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

  await LicenseService.init();
  cachedLicense = await LicenseService.isLicensed();
  cacheTime = Date.now();
  return cachedLicense;
}
