import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PolarChart, Pie } from 'victory-native';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore } from '@/store/gateway';
import { useSyncEngine, useAnalyticsQueries, useGatewayAPI, useServices } from './composition';
import { fetchModelPricing } from '@/analytics/cost-enrichment';
import type { AnalyticsQueries } from '@/analytics/queries';

/**
 * Phase 5 §5.6 — Analytics screen (v1 cut: session-level cost display).
 * All data comes from on-device SQLite (NFR-1/NFR-2) — no network calls
 * during rendering. The in-view poll runs ONLY while this screen has focus
 * (KR-20: zero polls when the view is closed).
 */
export default function AnalyticsScreen() {
  const { tokens } = useTheme();
  const gatewayId = useGatewayStore(s => s.activeGatewayId);
  // Engines/queries are per-gateway (KR-4a); hook forms exist in composition.
  const syncEngine = useSyncEngine(gatewayId ?? '');
  const queries: AnalyticsQueries = useAnalyticsQueries(gatewayId ?? '');
  const api = useGatewayAPI(gatewayId ?? '');
  const analyticsDb = useServices().analyticsDb;

  const [totalSpend, setTotalSpend] = useState(0);
  const [spendByModel, setSpendByModel] = useState<{ model: string | null; cost: number }[]>([]);
  const [tokenBreakdown, setTokenBreakdown] = useState<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  } | null>(null);
  const [cacheHitRate, setCacheHitRate] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [hasSynced, setHasSynced] = useState(false);

  const refresh = useCallback(() => {
    if (!gatewayId) return;
    setTotalSpend(queries.getTotalSpend(gatewayId));
    setSpendByModel(
      queries.getSpendByModel(gatewayId).map(m => ({ model: m.model, cost: m.cost ?? 0 })),
    );
    setTokenBreakdown(queries.getTokenBreakdown(gatewayId));
    setCacheHitRate(queries.getCacheHitRate(gatewayId));
    setSessionCount(queries.countSessions(gatewayId));
  }, [gatewayId, queries]);

  useFocusEffect(
    useCallback(() => {
      if (!gatewayId) return;
      let cancelled = false;

      const run = async () => {
        try {
          // KR-20: full backfill on first launch, incremental afterwards
          await syncEngine.fullBackfillIfNeeded();
          await syncEngine.incrementalSync();
          if (!cancelled) {
            setHasSynced(true);
            refresh();
          }
          syncEngine.startPolling(45_000, () => {
            if (!cancelled) refresh();
          });
        } catch {
          // NFR-3: bounded behavior, will retry on next focus
        }
      };
      void run();

      return () => {
        cancelled = true;
        syncEngine.stopPolling(); // KR-20: zero polls when view closed
      };
    }, [gatewayId, syncEngine, refresh]),
  );

  // Phase 5 §5.3: pricing refresh so enrichment ("—" vs derived cost) is live
  useEffect(() => {
    if (!gatewayId) return;
    void fetchModelPricing(api, analyticsDb, queries)
      .then(refresh)
      .catch(() => { /* best-effort — retry next focus */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayId, api, analyticsDb, queries]);

  const isEmpty = hasSynced && sessionCount === 0;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: tokens.background }]}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.screenTitle, { color: tokens.text }]}>Analytics</Text>

        {!hasSynced ? null : isEmpty ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: tokens.text }]}>No data yet</Text>
            <Text style={[styles.emptyBody, { color: tokens.muted }]}>
              Run a session on your gateway, then come back — costs sync
              automatically while this screen is open.
            </Text>
          </View>
        ) : (
          <>
            <StatCard title="Total Spend" value={`$${totalSpend.toFixed(2)}`} tokens={tokens} />

            {spendByModel.length > 0 && (
              <View style={[styles.card, { backgroundColor: tokens.card }]}>
                <Text style={[styles.cardTitle, { color: tokens.text }]}>Spend by Model</Text>
                {/* victory-native 42 (architecture §2): PolarChart + Pie slices */}
                <PolarChart
                  data={pieData(spendByModel)}
                  labelKey="label"
                  valueKey="value"
                  colorKey="color"
                  containerStyle={styles.pieContainer}
                >
                  <Pie.Chart>
                    {({ slice }) => <Pie.Slice />}
                  </Pie.Chart>
                </PolarChart>
                <Legend items={spendByModel} />
              </View>
            )}

            {tokenBreakdown && (
              <View style={[styles.card, { backgroundColor: tokens.card }]}>
                <Text style={[styles.cardTitle, { color: tokens.text }]}>Token Usage</Text>
                <TokenBreakdownChart data={tokenBreakdown} tokens={tokens} />
              </View>
            )}

            <StatCard title="Cache Hit Rate" value={`${(cacheHitRate * 100).toFixed(1)}%`} tokens={tokens} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const PIE_PALETTE = [
  '#7c6cf2', '#4fb0e8', '#5bc98f', '#f2b04e', '#e17055',
  '#b56df2', '#4eb8c0', '#e2919f',
];

/** Color-assign pie data for PolarChart (colorKey="color"). */
function pieData(items: { model: string | null; cost: number }[]) {
  return items.map((item, i) => ({
    label: item.model ?? 'unknown',
    value: Math.max(item.cost, 0.0001),
    color: PIE_PALETTE[i % PIE_PALETTE.length] ?? PIE_PALETTE[0]!,
  }));
}

interface ThemeTokens {
  background: string;
  text: string;
  muted: string;
  accent: string;
  card: string;
  border: string;
}

function StatCard({ title, value, tokens }: { title: string; value: string; tokens: ThemeTokens }) {
  return (
    <View style={[styles.card, { backgroundColor: tokens.card }]}>
      <Text style={[styles.statTitle, { color: tokens.muted }]}>{title}</Text>
      <Text style={[styles.statValue, { color: tokens.text }]}>{value}</Text>
    </View>
  );
}

function Legend({ items }: { items: { model: string | null; cost: number }[] }) {
  const total = items.reduce((sum, i) => sum + (i.cost ?? 0), 0);
  return (
    <View style={styles.legend}>
      {items.slice(0, 6).map((item) => {
        const pct = total > 0 ? ((item.cost / total) * 100).toFixed(1) : '0.0';
        return (
          <View key={item.model ?? 'unknown'} style={styles.legendRow}>
            <Text numberOfLines={1} style={styles.legendModel}>{item.model ?? 'unknown'}</Text>
            <Text style={styles.legendData}>
              ${(item.cost ?? 0).toFixed(4)} · {pct}%
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function TokenBreakdownChart({
  data,
  tokens,
}: {
  data: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  tokens: ThemeTokens;
}) {
  const rows: { label: string; value: number }[] = [
    { label: 'Input', value: data.input },
    { label: 'Output', value: data.output },
    { label: 'Cache Read', value: data.cacheRead },
    { label: 'Cache Write', value: data.cacheWrite },
    { label: 'Reasoning', value: data.reasoning },
  ];
  const max = Math.max(...rows.map(r => r.value), 1);
  return (
    <View style={styles.tokensBox}>
      {rows.map(r => (
        <View key={r.label} style={styles.tokenRow}>
          <Text style={[styles.tokenLabel, { color: tokens.muted }]}>{r.label}</Text>
          <View style={[styles.tokenBarTrack, { backgroundColor: tokens.border }]}>
            <View
              style={[
                styles.tokenBarFill,
                { backgroundColor: tokens.accent, width: `${(r.value / max) * 100}%` },
              ]}
            />
          </View>
          <Text style={[styles.tokenValue, { color: tokens.text }]}>
            {r.value.toLocaleString()}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 24 },
  screenTitle: { fontSize: 28, fontWeight: '700', padding: 16 },
  card: { marginHorizontal: 16, marginBottom: 12, borderRadius: 14, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: '600', marginBottom: 8 },
  pieContainer: { height: 210, width: 260, alignSelf: 'center' },
  statTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: 30, fontWeight: '700', marginTop: 4 },
  legend: { gap: 4 },
  legendRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  legendModel: { flexShrink: 1, fontSize: 12 },
  legendData: { fontSize: 12, fontVariant: ['tabular-nums'] },
  tokensBox: { gap: 8, marginTop: 4 },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenLabel: { width: 88, fontSize: 12 },
  tokenBarTrack: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  tokenBarFill: { height: 6, borderRadius: 3 },
  tokenValue: { width: 76, textAlign: 'right', fontSize: 12, fontVariant: ['tabular-nums'] },
  empty: { padding: 32, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptyBody: { fontSize: 14, textAlign: 'center', marginTop: 8 },
});
