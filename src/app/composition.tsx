import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useGatewayStore } from '@/store/gateway';
import { GatewayAPI } from '@/services/gateway-api';
import { RunsManager } from '@/services/runs-manager';
import { AnalyticsDB } from '@/services/storage';
import { AnalyticsQueries } from '@/analytics/queries';
import { SnapshotSyncEngine } from '@/analytics/sync-engine';

interface AppServices {
  getApi: (gatewayId: string) => GatewayAPI;
  runsManager: RunsManager;
  // Phase 5 (KR-4a keying: everything below resolves per gateway id)
  analyticsDb: AnalyticsDB;
  getSyncEngine: (gatewayId: string) => SnapshotSyncEngine;
  getAnalyticsQueries: (gatewayId: string) => AnalyticsQueries;
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

    // Phase 5: on-device analytics engine (NFR-1 — all local, no network).
    const analyticsDb = new AnalyticsDB();
    const analyticsQueries = new AnalyticsQueries(analyticsDb);

    // One sync engine per gateway, cached (mirrors apiCache — KR-4a)
    const syncEngineCache = new Map<string, SnapshotSyncEngine>();
    const getSyncEngine = (gatewayId: string): SnapshotSyncEngine => {
      let engine = syncEngineCache.get(gatewayId);
      if (!engine) {
        engine = new SnapshotSyncEngine(analyticsDb, analyticsQueries, getApi(gatewayId), gatewayId);
        syncEngineCache.set(gatewayId, engine);
      }
      return engine;
    };

    return {
      getApi,
      runsManager,
      analyticsDb,
      getSyncEngine,
      getAnalyticsQueries: () => analyticsQueries,
    };
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

/**
 * Non-throwing variant of useGatewayAPI for screens that can render before
 * pairing completes (NFR-6: the composition root is the ONLY place a
 * GatewayAPI is constructed). Returns null for an unknown/unset gateway id
 * instead of throwing, so early-render screens degrade gracefully.
 */
export function useGatewayAPISafe(gatewayId: string | null): GatewayAPI | null {
  const services = useServices();
  if (!gatewayId) return null;
  try {
    return services.getApi(gatewayId);
  } catch {
    return null;
  }
}

/** Phase-5 §5.3's hook — analytics queries bound to a gateway. */
export function useAnalyticsQueries(gatewayId: string): AnalyticsQueries {
  // Queries themselves key on gatewayId in SQL; the service instance is shared.
  void gatewayId;
  return useServices().getAnalyticsQueries(gatewayId);
}

/** Phase-5 §5.2's hook — the snapshot sync engine for a gateway. */
export function useSyncEngine(gatewayId: string): SnapshotSyncEngine {
  return useServices().getSyncEngine(gatewayId);
}
