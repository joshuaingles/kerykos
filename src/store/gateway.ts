import { create } from 'zustand';
import { GatewayAPI } from '@/services/gateway-api';

export interface Gateway {
  id: string;
  label: string;
  base_url: string;
  profile_path?: string;
  key_ref: string;  // Keychain alias, not the actual key
  added_at: number;
  last_connected_at: number | null;
}

interface GatewayStore {
  gateways: Gateway[];
  activeGatewayId: string | null;
  addGateway: (gw: Gateway) => void;
  removeGateway: (id: string) => void;
  setActive: (id: string) => void;
}

export const useGatewayStore = create<GatewayStore>((set) => ({
  gateways: [],
  activeGatewayId: null,
  addGateway: (gw) => set((s) => ({
    gateways: [...s.gateways, gw],
    activeGatewayId: s.activeGatewayId ?? gw.id, // auto-select first
  })),
  removeGateway: (id) => set((s) => ({
    gateways: s.gateways.filter(g => g.id !== id),
    activeGatewayId: s.activeGatewayId === id
      ? (s.gateways[0]?.id ?? null)
      : s.activeGatewayId,
  })),
  setActive: (id) => set({ activeGatewayId: id }),
}));

/**
 * KR-4a: build a GatewayAPI for a gateway by id. Credentials are resolved
 * inside GatewayAPI per call (gateway id keyed — NEVER a global key).
 */
export function apiForGateway(gatewayId: string): GatewayAPI | null {
  const gw = useGatewayStore.getState().gateways.find((g) => g.id === gatewayId);
  if (!gw) return null;
  return new GatewayAPI(gw.base_url, gatewayId);
}

/** KR-5a: GatewayAPI for the currently active gateway, or null if unpaired. */
export function apiForActiveGateway(): GatewayAPI | null {
  const { activeGatewayId } = useGatewayStore.getState();
  return activeGatewayId ? apiForGateway(activeGatewayId) : null;
}
