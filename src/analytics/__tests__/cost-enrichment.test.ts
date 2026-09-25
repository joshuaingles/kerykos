import { computeDisplayCost } from '../cost-enrichment';
import type { ModelPricing } from '@/services/types';

function args(overrides: Partial<Parameters<typeof computeDisplayCost>[0]> = {}) {
  return {
    actual_cost_usd: null as number | null,
    estimated_cost_usd: 0 as number | null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    ...overrides,
  };
}

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    input_cost_per_token: null,
    output_cost_per_token: null,
    cached_cost_per_token: null,
    updated_at: 1,
    ...overrides,
  };
}

describe('computeDisplayCost (§2.7 — KR-19 cost display truth table)', () => {
  it('actual > 0 wins ($4dp)', () => {
    const result = computeDisplayCost(
      args({ actual_cost_usd: 0.25, estimated_cost_usd: 0.5, input_tokens: 999 }),
      pricing({ input_cost_per_token: 0.0001 }),
    );
    expect(result.display).toBe('$0.2500');
    expect(result.isUnknown).toBe(false);
  });

  it('actual = 0.0 does NOT win — falls through (wire-verified 0.0-estimated nuance)', () => {
    const result = computeDisplayCost(
      args({ actual_cost_usd: 0, estimated_cost_usd: 0.3 }),
      null,
    );
    expect(result.display).toBe('$0.3000');
    expect(result.isUnknown).toBe(false);
  });

  it('estimated > 0 used when actual is null/zero', () => {
    const result = computeDisplayCost(args({ estimated_cost_usd: 1.234 }), null);
    expect(result.display).toBe('$1.2340');
    expect(result.isUnknown).toBe(false);
  });

  it('estimated 0/null + pricing → token-derived (input×in + out×out + cacheRead×cached)', () => {
    const result = computeDisplayCost(
      args({
        estimated_cost_usd: 0,
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200,
      }),
      pricing({
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000012,
        cached_cost_per_token: 0.0000005,
      }),
    );
    // 1000×0.000003 + 500×0.000012 + 200×0.0000005 = 0.003 + 0.006 + 0.0001 = 0.0091
    expect(result.display).toBe('$0.0091');
    expect(result.isUnknown).toBe(false);
  });

  it('token cost 0 (zero pricing fields) → dash/isUnknown (`cost > 0` gate)', () => {
    const result = computeDisplayCost(
      args({ input_tokens: 1000, output_tokens: 500 }),
      pricing({ input_cost_per_token: 0, output_cost_per_token: 0, cached_cost_per_token: 0 }),
    );
    expect(result.display).toBe('—');
    expect(result.isUnknown).toBe(true);
  });

  it('no pricing (null) + estimated 0 → dash — the honest-unknown rule', () => {
    const result = computeDisplayCost(args({ estimated_cost_usd: 0 }), null);
    expect(result).toEqual({ display: '—', isUnknown: true });
  });

  it('missing pricing fields (null in ModelPricing) → COALESCE to 0, then unknown if 0 tokens', () => {
    const result = computeDisplayCost(
      args({ estimated_cost_usd: null, input_tokens: 10 }), // some tokens, null price fields → cost 0
      pricing({ input_cost_per_token: null, output_cost_per_token: null, cached_cost_per_token: null }),
    );
    expect(result.display).toBe('—');
    expect(result.isUnknown).toBe(true);
  });

  it('no tokens (input 0) → pricing not consulted → dash', () => {
    const result = computeDisplayCost(
      args({ input_tokens: 0 }),
      pricing({ input_cost_per_token: 0.001 }),
    );
    expect(result.display).toBe('—');
    expect(result.isUnknown).toBe(true);
  });
});
