import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, type RouteProp } from '@react-navigation/native';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayAPI } from '@/app/composition';
import { formatCost, relativeTime } from '@/store/sessions';
import type { SessionResponse } from '@/services/gateway-api';
import type { RootStackParamList } from '@/app/navigation';

type SessionDetailRoute = RouteProp<RootStackParamList, 'SessionDetail'>;

/**
 * Plan §2.6 session detail (was a stub — audit W5): full SessionResponse
 * fields for one session, fetched live from the gateway.
 */
export default function SessionDetailScreen() {
  const route = useRoute<SessionDetailRoute>();
  const { sessionId, gatewayId } = route.params;
  const { tokens } = useTheme();
  const api = useGatewayAPI(gatewayId);

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.getSession(sessionId)
      .then((s) => {
        if (!cancelled) {
          setSession(s);
          setFetchedAt(Date.now());
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [api, sessionId]);

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]} edges={['left', 'right', 'bottom']}>
        <Text style={[styles.error, { color: tokens.error }]}>{error}</Text>
      </SafeAreaView>
    );
  }

  if (!session) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]} edges={['left', 'right', 'bottom']}>
        <Text style={[styles.muted, { color: tokens.muted }]}>Loading…</Text>
      </SafeAreaView>
    );
  }

  const started = new Date(session.started_at * 1000);

  const rows: [string, string][] = [
    ['Title', session.title],
    ['Model', session.model || '—'],
    ['Source', session.source],
    ['Status', session.ended_at === null ? 'Active' : `Ended (${session.end_reason ?? 'unknown'})`],
    ['Messages', String(session.message_count)],
    ['API calls', String(session.api_call_count)],
    ['Tool calls', String(session.tool_call_count)],
    ['Input tokens', session.input_tokens.toLocaleString()],
    ['Output tokens', session.output_tokens.toLocaleString()],
    ['Cache read', session.cache_read_tokens.toLocaleString()],
    ['Cache write', session.cache_write_tokens.toLocaleString()],
    ['Reasoning tokens', session.reasoning_tokens.toLocaleString()],
    ['Cost', formatCost(session.estimated_cost_usd, session.actual_cost_usd)],
    ['Started', started.toLocaleString()],
    ['Last active', relativeTime(session.last_active, fetchedAt / 1000)],
    ['Parent session', session.parent_session_id ?? '—'],
    ['Pinned', session.pinned ? 'Yes' : 'No'],
    ['Archived', session.archived ? 'Yes' : 'No'],
  ];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]} edges={['left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text style={[styles.label, { color: tokens.muted }]}>{label}</Text>
            <Text numberOfLines={2} style={[styles.value, { color: tokens.text }]}>{value}</Text>
          </View>
        ))}
        {session.preview ? (
          <View style={styles.row}>
            <Text style={[styles.label, { color: tokens.muted }]}>Preview</Text>
            <Text style={[styles.value, { color: tokens.text }]}>{session.preview}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    gap: 10,
  },
  row: {
    gap: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  value: {
    fontSize: 15,
  },
  error: {
    fontSize: 14,
    padding: 16,
  },
  muted: {
    fontSize: 14,
    padding: 16,
  },
});
