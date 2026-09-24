import { useAnalyticsStore, type DisplayCostArgs } from '@/store/analytics';
import type { ModelPricing } from '@/services/types';
import type { GatewayAPI } from '@/services/gateway-api';
import type { AnalyticsDB } from '@/services/storage';
import type { AnalyticsQueries } from './queries';

/**
 * Phase 5 §5.3 — Cost enrichment (KR-19).
 * `estimated_cost_usd` can be 0.0 on providers without local pricing
 * (wire-verified, smoke-test #13). Enrich via /api/model/options pricing
 * metadata; display unknown as "—", never "$0.00".
 */

/**
 * Fetch model pricing from the gateway and store it locally.
 * GET /api/model/options → provider/model inventory + pricing metadata.
 * After persisting: publish to the store (ChatHeader/session rows resolve
 * live), run the KR-19 enrichment pass for NULL-enriched snapshots, then
 * rebuild daily aggregates so totals include pricing-derived costs.
 */
export async function fetchModelPricing(
  api: GatewayAPI,
  db: AnalyticsDB,
  queries: AnalyticsQueries,
): Promise<void> {
  const options = await api.getModelOptions(); // GET /api/model/options
  const models: ModelPricing[] = [];
  for (const model of options.models ?? []) {
    const pricing: ModelPricing = {
      model: model.id,
      provider: model.provider ?? null,
      input_cost_per_token: model.pricing?.input_cost_per_token ?? null,
      output_cost_per_token: model.pricing?.output_cost_per_token ?? null,
      cached_cost_per_token: model.pricing?.cached_cost_per_token ?? null,
      updated_at: Date.now() / 1000,
    };
    db.upsertModelPricing(pricing);
    models.push(pricing);
  }
  useAnalyticsStore.getState().setPricingCache(models);

  // KR-19 enrichment pass: fill NULL enriched_cost_usd from pricing
  const gatewayId = api.gatewayId;
  db.applyPricingEnrichment(gatewayId);
  queries.recomputeDailyAggregates(gatewayId);
}

/**
 * Compute enriched cost for display (KR-19 wire-verified rule):
 * 1. actual_cost_usd preferred when non-null (> 0)
 * 2. estimated_cost_usd when non-zero
 * 3. pricing-derived from token counts when pricing is available
 * 4. otherwise "—" — unknown is NOT $0.00
 */
export function computeDisplayCost(
  session: DisplayCostArgs,
  pricing: ModelPricing | null,
): { display: string; isUnknown: boolean } {
  // Prefer actual cost when available
  if (session.actual_cost_usd !== null && session.actual_cost_usd > 0) {
    return { display: `$${session.actual_cost_usd.toFixed(4)}`, isUnknown: false };
  }

  // Use estimated cost if non-zero
  if ((session.estimated_cost_usd ?? 0) > 0) {
    return { display: `$${(session.estimated_cost_usd ?? 0).toFixed(4)}`, isUnknown: false };
  }

  // estimated_cost_usd is 0.0 or null — try enrichment
  if (pricing && session.input_tokens > 0) {
    const cost =
      session.input_tokens * (pricing.input_cost_per_token ?? 0) +
      session.output_tokens * (pricing.output_cost_per_token ?? 0) +
      session.cache_read_tokens * (pricing.cached_cost_per_token ?? 0);
    if (cost > 0) {
      return { display: `$${cost.toFixed(4)}`, isUnknown: false };
    }
  }

  // Truly unknown — no pricing data available
  return { display: '—', isUnknown: true };
}
