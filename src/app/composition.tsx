import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useGatewayStore } from '@/store/gateway';
import { GatewayAPI } from '@/services/gateway-api';
import { RunsManager } from '@/services/runs-manager';

interface AppServices {
  getApi: (gatewayId: string) => GatewayAPI;
  runsManager: RunsManager;
  // Phase 5 additions (added when phase 5 lands — same pattern):
  // analyticsDb: AnalyticsDB;
  // getSyncEngine: (gatewayId: string) => SnapshotSyncEngine;
  // getAnalyticsQueries: (gatewayId: string) => AnalyticsQueries;
}

const ServicesContext = createContext<AppServices>(null!);

/** Mount once at the app root, below ThemeProvider. */
export function ServicesProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => {
    // One GatewayAPI instance per gateway, cached — KR-4a: every call
    // resolves credentials from the gateway record, never a global.
    const apiCache = new Map<string, GatewayAPI>();
    const getApi = (gatewayId: string): GatewayAPI => {
      let api = apiCache.get(gatewayId);
      if (!api) {
        const gw = useGatewayStore.getState().gateways.find(g => g.id === gatewayId);
        if (!gw) throw new Error(`Unknown gateway ${gatewayId}`);
        api = new GatewayAPI(gw.base_url, gatewayId);
        apiCache.set(gatewayId, api);
      }
      return api;
    };

    // RunsManager operates on the ACTIVE gateway's sessions; it resolves the
    // api per call-site (ChatScreen passes gatewayId from route params).
    const runsManager = new RunsManager(getApi);

    // KR-11/13: settle any runs persisted across a relaunch at startup
    void runsManager.recoverPersistedRuns();

    return { getApi, runsManager };
  }, []);

  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  return useContext(ServicesContext);
}

/** Phase-2 §2.6's hook — the injectable seam for sessions CRUD. */
export function useGatewayAPI(gatewayId: string): GatewayAPI {
  return useServices().getApi(gatewayId);
}
