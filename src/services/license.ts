import { Platform } from 'react-native';
import Purchases, {
  type CustomerInfo,
  type PurchasesPackage,
} from 'react-native-purchases';

const RC_API_KEY_IOS = 'appl_XXXXX'; // from RevenueCat dashboard
const RC_API_KEY_ANDROID = 'goog_XXXXX'; // from RevenueCat dashboard

/**
 * RevenueCat wrapper (architecture §2, §7).
 * NOT react-native-iap (archived). react-native-purchases wraps
 * StoreKit 2 + Google Play Billing behind a single API.
 */
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
      Purchases.setLogLevel(Purchases.LOG_LEVEL.DEBUG);
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

  /** Listen for customer info changes. Returns a function that removes the listener. */
  static onCustomerInfoChanged(
    callback: (info: CustomerInfo) => void
  ): () => void {
    Purchases.addCustomerInfoUpdateListener(callback);
    return () => {
      Purchases.removeCustomerInfoUpdateListener(callback);
    };
  }
}
