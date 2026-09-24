import { create } from 'zustand';
import type { ModelPricing, SessionSnapshot } from '@/services/types';

/**
 * Phase 5 §5.3 — Analytics store: cached model pricing published by
 * fetchModelPricing() so ChatHeader / session rows resolve enrichment live.
 */
interface AnalyticsState {
  // Cached model pricing, refreshed by fetchModelPricing()
  pricingCache: Map<string, ModelPricing>;

  getModelPricing(model: string | undefined | null): ModelPricing | null;
  setPricingCache(models: ModelPricing[]): void;
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  pricingCache: new Map<string, ModelPricing>(),

  getModelPricing(model) {
    if (!model) return null;
    return get().pricingCache.get(model) ?? null;
  },

  setPricingCache(models) {
    const map = new Map(models.map(p => [p.model, p]));
    set({ pricingCache: map });
  },
}));

/** Narrow display-cost input so SessionRow (store/sessions.ts) satisfies it. */
export type CostSource = Pick<
  SessionSnapshot,
  'actual_cost_usd' | 'estimated_cost_usd' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens'
>;

/**
 * Display-cost shape accepted by computeDisplayCost. Relaxed to
 * estimated_cost_usd: number | null so SessionRow (store/sessions) satisfies
 * it directly — KR-19: null is treated the same as 0.0 ("unknown").
 */
export type DisplayCostArgs = Omit<CostSource, 'estimated_cost_usd'> & {
  estimated_cost_usd: number | null;
};
