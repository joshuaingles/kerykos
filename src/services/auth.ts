import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'gw_key_';

export class AuthService {
  /** Store API key for a gateway. Called during pairing (KR-1). */
  static async storeKey(gatewayId: string, apiKey: string): Promise<void> {
    await SecureStore.setItemAsync(`${KEY_PREFIX}${gatewayId}`, apiKey);
  }

  /** Retrieve API key for a gateway. Used by GatewayAPI to resolve credentials (KR-4a). */
  static async getKey(gatewayId: string): Promise<string | null> {
    return SecureStore.getItemAsync(`${KEY_PREFIX}${gatewayId}`);
  }

  /** Delete API key for a gateway. Called during unpairing. */
  static async deleteKey(gatewayId: string): Promise<void> {
    await SecureStore.deleteItemAsync(`${KEY_PREFIX}${gatewayId}`);
  }

  /** Check if a key exists for a gateway. */
  static async hasKey(gatewayId: string): Promise<boolean> {
    return (await SecureStore.getItemAsync(`${KEY_PREFIX}${gatewayId}`)) !== null;
  }
}

/** Keychain alias for a gateway id — stored as `key_ref`, never the key itself (NFR-1). */
export function keyRefFor(gatewayId: string): string {
  return `${KEY_PREFIX}${gatewayId}`;
}
