/**
 * §5.5 Integration — Cost enrichment flow (KR-19).
 *
 * Real AnalyticsDB + AnalyticsQueries + fetchModelPricing over an in-memory
 * sqlite fake that actually EMULATES the statements used by the pipeline
 * (model_pricing upsert, session_snapshots prepared upsert, enrichment
 * UPDATE…FROM, daily_aggregates recompute) so enriched values can be
 * SELECT-verified after the pass.
 */
import { openDatabaseSync } from 'expo-sqlite';
import { AnalyticsDB } from '@/services/storage';
import { AnalyticsQueries } from '@/analytics/queries';
import { fetchModelPricing } from '@/analytics/cost-enrichment';
import { useAnalyticsStore } from '@/store/analytics';
import type { GatewayAPI } from '@/services/gateway-api';
import type { SessionSnapshot } from '@/services/types';

// === In-memory sqlite fake (strategy §5.5 CE-02: "50 lines, worth it") ===

type Row = Record<string, unknown>;
type Table = Map<string, Row>;

// Column order matches storage.ts prepareUpsert bind args.
function bindRowToSnapshot(args: unknown[]): Row {
  return {
    id: args[0],
    gateway_id: args[1],
    session_id: args[2],
    model: args[4],
    input_tokens: args[6],
    output_tokens: args[7],
    cache_read_tokens: args[8],
    estimated_cost_usd: args[11],
    actual_cost_usd: args[12],
    enriched_cost_usd: args[13],
    api_call_count: args[14],
    tool_call_count: args[15],
    started_at: args[17],
    ended_at: args[18],
    archived: args[22],
    hidden: args[24],
  };
}

function createFakeDb() {
  const snapshots: Table = new Map();
  const modelPricing: Table = new Map();
  const dailyAggregates: Table = new Map();

  const utcDate = (epochSeconds: number): string =>
    new Date(epochSeconds * 1000).toISOString().slice(0, 10);

  const runSnapshotStatements = ({ sql, params }: { sql: string; params: unknown[] }): void => {
    if (sql.includes('INSERT OR REPLACE INTO model_pricing')) {
      modelPricing.set(params[0] as string, {
        model: params[0],
        provider: params[1],
        input_cost_per_token: params[2],
        output_cost_per_token: params[3],
        cached_cost_per_token: params[4],
        updated_at: params[5],
      });
      return;
    }

    // applyPricingEnrichment: UPDATE … SET enriched = tokens×pricing WHERE
    // gateway matches AND enriched IS NULL AND (input>0 OR output>0).
    if (sql.includes('UPDATE session_snapshots')) {
      for (const row of snapshots.values()) {
        if (row.gateway_id !== params[0]) continue;
        if (row.enriched_cost_usd !== null) continue;
        if (!((row.input_tokens as number) > 0 || (row.output_tokens as number) > 0)) continue;
        const pricing = modelPricing.get(row.model as string);
        if (!pricing) continue; // SQL join misses → stays NULL
        row.enriched_cost_usd =
          (row.input_tokens as number) * ((pricing.input_cost_per_token as number) ?? 0) +
          (row.output_tokens as number) * ((pricing.output_cost_per_token as number) ?? 0) +
          (row.cache_read_tokens as number) * ((pricing.cached_cost_per_token as number) ?? 0);
      }
      return;
    }

    // recomputeDailyAggregates: GROUP BY date(started_at,'unixepoch');
    // NULL enriched costs contribute to counts but not cost sums.
    if (sql.includes('INSERT OR REPLACE INTO daily_aggregates')) {
      for (const row of snapshots.values()) {
        if (row.gateway_id !== params[0]) continue;
        if (row.archived !== 0) continue;
        const date = utcDate(row.started_at as number);
        const key = `${row.gateway_id}|${date}`;
        if (!dailyAggregates.has(key)) {
          dailyAggregates.set(key, {
            gateway_id: row.gateway_id,
            date,
            total_cost_usd: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_api_calls: 0,
            total_tool_calls: 0,
            session_count: 0,
          });
        }
        const agg = dailyAggregates.get(key)!;
        agg.total_cost_usd = (agg.total_cost_usd as number) + ((row.enriched_cost_usd as number) ?? 0);
        agg.total_input_tokens = (agg.total_input_tokens as number) + (row.input_tokens as number);
        agg.total_output_tokens = (agg.total_output_tokens as number) + (row.output_tokens as number);
        agg.total_api_calls = (agg.total_api_calls as number) + (row.api_call_count as number);
        agg.total_tool_calls = (agg.total_tool_calls as number) + (row.tool_call_count as number);
        agg.session_count = (agg.session_count as number) + 1;
      }
    }
  };

  const statements: { sql: string; params: unknown[] }[] = [];

  const db = {
    execSync: jest.fn((sql: string) => { statements.push({ sql, params: [] }); }),
    runSync: jest.fn((sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      runSnapshotStatements({ sql, params });
    }),
    getAllSync: jest.fn(() => []),
    getFirstSync: jest.fn((sql: string, params: unknown[] = []) => {
      // Minimal SELECT emulation: pricing lookup.
      if (sql.includes('FROM model_pricing WHERE model = ?')) {
        if (!modelPricing.has(params[0] as string)) return null;
        const { updated_at: _drop, ...pricing } = modelPricing.get(params[0] as string) as Row;
        void _drop;
        return pricing;
      }
      // total spend via SUM(enriched_cost_usd)
      if (sql.includes('SUM(enriched_cost_usd)')) {
        let total = 0;
        for (const row of snapshots.values()) {
          if (row.gateway_id !== params[0]) continue;
          if (row.archived !== 0) continue;
          if (row.enriched_cost_usd !== null && row.enriched_cost_usd !== undefined) {
            total += row.enriched_cost_usd as number;
          }
        }
        return { total };
      }
      return null;
    }),
    prepareSync: jest.fn((sql: string) => ({
      executeSync: jest.fn((...args: unknown[]) => {
        statements.push({ sql, params: args });
        if (sql.includes('INSERT OR REPLACE INTO session_snapshots')) {
          const row = bindRowToSnapshot(args);
          snapshots.set(row.id as string, row);
        }
      }),
    })),
  };

  return { db, statements, snapshots, modelPricing, dailyAggregates };
}

type FakeDb = ReturnType<typeof createFakeDb>;

// === Fixtures ===

const PRICED_MODEL = 'claude-sonnet-4';
const UNPRICED_MODEL = 'local/llama-3';
const PRICING = {
  input_cost_per_token: 0.000003,
  output_cost_per_token: 0.000012,
  cached_cost_per_token: 0.0000005,
};

function makeSnapshotRow(overrides: Partial<SessionSnapshot> = {}): Omit<SessionSnapshot, 'enriched_cost_usd'> {
  const { enriched_cost_usd: _ignored, ...row } = {
    id: 'gw1:sess_1',
    gateway_id: 'gw1',
    session_id: 'sess_1',
    title: 'Test Session',
    model: PRICED_MODEL,
    source: 'api_server',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    enriched_cost_usd: null as number | null,
    api_call_count: 1,
    tool_call_count: 0,
    message_count: 2,
    started_at: 1758800000,
    ended_at: 1758800060,
    end_reason: null,
    last_active: 1758800060,
    parent_session_id: null,
    archived: 0,
    pinned: 0,
    hidden: 0,
    synced_at: 1758800070,
    ...overrides,
  };
  void _ignored;
  return row;
}

const MODEL_OPTIONS = {
  models: [
    { id: PRICED_MODEL, provider: 'anthropic', vision: true, pricing: PRICING },
    { id: UNPRICED_MODEL, provider: null }, // no pricing metadata at all
  ],
};

function mockApi(): { api: GatewayAPI; getModelOptions: jest.Mock } {
  const getModelOptions = jest.fn();
  return {
    getModelOptions,
    api: { gatewayId: 'gw1', getModelOptions } as unknown as GatewayAPI,
  };
}

// === Tests ===

describe('§5.5 Cost enrichment flow (KR-19)', () => {
  let fake: FakeDb;
  let db: AnalyticsDB;
  let queries: AnalyticsQueries;

  beforeEach(() => {
    fake = createFakeDb();
    (openDatabaseSync as jest.Mock).mockImplementation(() => fake.db);
    db = new AnalyticsDB();
    queries = new AnalyticsQueries(db);
    useAnalyticsStore.setState({ pricingCache: new Map() });
  });

  afterEach(() => {
    (openDatabaseSync as jest.Mock).mockReset();
  });

  it('CE-01 fetchModelPricing writes model_pricing rows + publishes to useAnalyticsStore', async () => {
    const { api, getModelOptions } = mockApi();
    getModelOptions.mockResolvedValue(MODEL_OPTIONS);

    await fetchModelPricing(api, db, queries);

    // persisted rows, snake_case mapping from the wire shape
    expect(db.getModelPricing(PRICED_MODEL)).toEqual({
      model: PRICED_MODEL,
      provider: 'anthropic',
      input_cost_per_token: PRICING.input_cost_per_token,
      output_cost_per_token: PRICING.output_cost_per_token,
      cached_cost_per_token: PRICING.cached_cost_per_token,
    });
    // model without pricing metadata → null price fields, still a row
    expect(db.getModelPricing(UNPRICED_MODEL)).toEqual({
      model: UNPRICED_MODEL,
      provider: null,
      input_cost_per_token: null,
      output_cost_per_token: null,
      cached_cost_per_token: null,
    });

    // published live to the store (ChatHeader/session rows resolve here)
    const store = useAnalyticsStore.getState();
    expect(store.getModelPricing(PRICED_MODEL)?.input_cost_per_token).toBe(PRICING.input_cost_per_token);
    expect(store.getModelPricing(UNPRICED_MODEL)?.provider).toBeNull();
    expect(store.getModelPricing(undefined)).toBeNull();
    expect(store.getModelPricing('unknown-model')).toBeNull();
  });

  it('CE-02 applyPricingEnrichment fills NULL enriched_cost_usd from token counts × pricing', async () => {
    const { api, getModelOptions } = mockApi();
    getModelOptions.mockResolvedValue(MODEL_OPTIONS);

    // Four seeded rows covering the KR-19 precedence cases:
    //  s1: priced model, estimated 0  → NULL, should become token-derived
    //  s2: unpriced model in options  → pricing row exists (all-null fields)
    //                                   → COALESCEs to 0 (renders as "—" downstream)
    //  s3: priced model, estimated>0  → already enriched, not overwritten
    //  s4: priced model, actual>0     → already enriched with actual, kept
    //  s5: model missing from options → pricing join misses → stays NULL
    const upsert = db.prepareUpsert('session_snapshots');
    upsert.run(makeSnapshotRow({ id: 'gw1:s1', session_id: 's1' }));
    upsert.run(makeSnapshotRow({
      id: 'gw1:s2', session_id: 's2', model: UNPRICED_MODEL,
      input_tokens: 4000, output_tokens: 1000,
    }));
    upsert.run(makeSnapshotRow({ id: 'gw1:s3', session_id: 's3', estimated_cost_usd: 0.5 }));
    upsert.run(makeSnapshotRow({ id: 'gw1:s4', session_id: 's4', actual_cost_usd: 0.25 }));
    upsert.run(makeSnapshotRow({
      id: 'gw1:s5', session_id: 's5', model: 'never-probed/model',
      input_tokens: 4000, output_tokens: 1000,
    }));

    expect(fake.snapshots.get('gw1:s1')!.enriched_cost_usd).toBeNull();

    await fetchModelPricing(api, db, queries); // runs the enrichment pass

    const s1 = fake.snapshots.get('gw1:s1')!;
    const expected = 1000 * PRICING.input_cost_per_token + 500 * PRICING.output_cost_per_token;
    expect(s1.enriched_cost_usd).toBeCloseTo(expected, 12);
    expect(fake.snapshots.get('gw1:s2')!.enriched_cost_usd).toBe(0);   // COALESCE of null pricing
    expect(fake.snapshots.get('gw1:s3')!.enriched_cost_usd).toBe(0.5); // estimated wins
    expect(fake.snapshots.get('gw1:s4')!.enriched_cost_usd).toBe(0.25); // actual wins
    expect(fake.snapshots.get('gw1:s5')!.enriched_cost_usd).toBeNull(); // no pricing row → gap kept

    // the real queries see the enriched totals (NULLs excluded, never $0)
    expect(queries.getTotalSpend('gw1')).toBeCloseTo(expected + 0.5 + 0.25, 12);
  });

  it('CE-03 recomputeDailyAggregates groups by date(started_at) after enrichment', async () => {
    const { api, getModelOptions } = mockApi();
    getModelOptions.mockResolvedValue(MODEL_OPTIONS);

    const DAY_1 = 1758800000; // 2025-09-25 UTC
    const DAY_2 = 1758886400; // 2025-09-26 UTC
    const upsert = db.prepareUpsert('session_snapshots');
    // day 1: priced session (enriched from tokens) + one unpriced unknown
    upsert.run(makeSnapshotRow({
      id: 'gw1:s1', session_id: 's1', started_at: DAY_1, ended_at: DAY_1 + 60, last_active: DAY_1 + 60,
    }));
    upsert.run(makeSnapshotRow({
      id: 'gw1:s2', session_id: 's2', model: UNPRICED_MODEL, started_at: DAY_1,
      ended_at: DAY_1 + 60, last_active: DAY_1 + 60, input_tokens: 4000, output_tokens: 1000,
      api_call_count: 2, tool_call_count: 1,
    }));
    // day 2: priced session
    upsert.run(makeSnapshotRow({
      id: 'gw1:s3', session_id: 's3', started_at: DAY_2, ended_at: DAY_2 + 60, last_active: DAY_2 + 60,
      input_tokens: 2000, output_tokens: 300,
    }));

    await fetchModelPricing(api, db, queries);

    expect(fake.dailyAggregates.size).toBe(2);

    const day1 = fake.dailyAggregates.get('gw1|2025-09-25')!;
    const s1Cost = 1000 * PRICING.input_cost_per_token + 500 * PRICING.output_cost_per_token;
    expect(day1.total_cost_usd).toBeCloseTo(s1Cost, 12); // NULL cost NOT counted as $0
    expect(day1.total_input_tokens).toBe(1000 + 4000);
    expect(day1.total_output_tokens).toBe(500 + 1000);
    expect(day1.total_api_calls).toBe(1 + 2);
    expect(day1.total_tool_calls).toBe(0 + 1);
    expect(day1.session_count).toBe(2); // unknown-cost session still counted

    const day2 = fake.dailyAggregates.get('gw1|2025-09-26')!;
    const s3Cost = 2000 * PRICING.input_cost_per_token + 300 * PRICING.output_cost_per_token;
    expect(day2.total_cost_usd).toBeCloseTo(s3Cost, 12);
    expect(day2.session_count).toBe(1);
  });
});
