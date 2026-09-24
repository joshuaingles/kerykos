import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useGatewayStore } from '@/store/gateway';
import { GatewayAPI } from '@/services/gateway-api';
import { probeAndCache } from '@/services/capabilities';
import { checkVersionCompatibility } from '@/services/version';

/**
 * Re-probe capabilities + version on app foreground (NFR-4 version-check protocol).
 * Mount once in the root navigator.
 */
export function useForegroundProbe(): void {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const { activeGatewayId, gateways } = useGatewayStore.getState();
      if (!activeGatewayId) return;
      const gw = gateways.find((g) => g.id === activeGatewayId);
      if (!gw) return;
      void probeAndCache(new GatewayAPI(gw.base_url, activeGatewayId)).then(
        ({ health }) => {
          const compat = checkVersionCompatibility(
            typeof health.version === 'string' ? health.version : '',
          );
          if (compat.action === 'warn' && __DEV__) {
            console.warn(`[kerykos] version warning: ${compat.message}`);
          }
        },
        () => {
          // Gateway briefly unreachable on foreground — capabilities cache
          // persists; KR-5 machinery lives in the chat calling path.
        },
      );
    });
    return () => sub.remove();
  }, []);
}
