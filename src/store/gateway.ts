import { create } from 'zustand';

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
