import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import { useSessionsStore } from '@/store/sessions';
import { useAnalyticsStore } from '@/store/analytics';
import { computeDisplayCost } from '@/analytics/cost-enrichment';

interface ChatHeaderProps {
  title: string;
  model: string;
  cost: string;
}

export default function ChatHeader({ title, model, cost }: ChatHeaderProps) {
  const { tokens } = useTheme();
  return (
    <View style={styles.row}>
      <Text numberOfLines={1} style={[styles.title, { color: tokens.text }]}>
        {title}
      </Text>
      <Text style={{ color: tokens.muted }}>·</Text>
      <Text style={{ color: tokens.muted }}>{model}</Text>
      <Text style={{ color: tokens.muted }}>·</Text>
      <Text style={{ color: tokens.muted }}>{cost}</Text>
    </View>
  );
}

/**
 * Phase 5 §5.5 — live per-session cost header (KR-19).
 * Reads the session row from the sessions store and pricing from the
 * analytics store's pricingCache; computes display cost with enrichment.
 */
export function LiveChatHeader({ sessionId }: { sessionId: string }) {
  const session = useSessionsStore(s => s.getSessionById(sessionId));
  const pricing = useAnalyticsStore(s => s.getModelPricing(session?.model));

  if (!session) {
    return <ChatHeader title="Chat" model="—" cost="—" />;
  }

  const { display, isUnknown } = computeDisplayCost(session, pricing);
  return (
    <ChatHeader
      title={session.title}
      model={session.model}
      cost={isUnknown ? '—' : display}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontWeight: '600',
    flexShrink: 1,
  },
});
