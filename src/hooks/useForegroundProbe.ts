import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useGatewayStore } from '@/store/gateway';
import { probeAndCache } from '@/services/capabilities';
import { checkVersionCompatibility } from '@/services/version';
import { useServices } from '@/app/composition';

/**
 * Re-probe capabilities + version on app foreground (NFR-4 version-check protocol).
 * Mount once in the root navigator. The GatewayAPI comes from the composition
 * root's per-gateway cache (NFR-6, audit W2) — never constructed inline.
 */
export function useForegroundProbe(): void {
  const { getApi } = useServices();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const { activeGatewayId } = useGatewayStore.getState();
      if (!activeGatewayId) return;
      void probeAndCache(getApi(activeGatewayId)).then(
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
  }, [getApi]);
}
