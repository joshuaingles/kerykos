import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';
import type { SessionRow as SessionRowData } from '@/store/sessions';

export function SessionRowItem({ session, onPress, onLongPress }: {
  session: SessionRowData;
  onPress: (session: SessionRowData) => void;
  onLongPress: (session: SessionRowData) => void;
}) {
  const { tokens } = useTheme();
  return (
    <Pressable onPress={() => onPress(session)} onLongPress={() => onLongPress(session)}>
      <View style={[styles.row, { backgroundColor: tokens.card, borderBottomColor: tokens.border }]}>
        <Text style={styles.badge}>{session.sourceBadge}</Text>
        <View style={styles.content}>
          <Text style={[styles.title, { color: tokens.text }]} numberOfLines={1}>
            {session.title}
          </Text>
          <Text style={[styles.model, { color: tokens.muted }]}>{session.model}</Text>
          <Text style={[styles.preview, { color: tokens.muted }]} numberOfLines={1}>
            {session.preview}
          </Text>
        </View>
        <View style={styles.meta}>
          <Text style={[styles.time, { color: tokens.muted }]}>{session.relativeTime}</Text>
          <View style={styles.metaBottom}>
            {session.isActive && (
              <View style={[styles.dot, { backgroundColor: tokens.success }]} />
            )}
            <Text style={[styles.cost, { color: tokens.muted }]}>{session.costDisplay}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export const SessionRow = memo(SessionRowItem);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  badge: {
    fontSize: 12,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  model: {
    fontSize: 12,
  },
  preview: {
    fontSize: 12,
  },
  meta: {
    alignItems: 'flex-end',
    gap: 4,
  },
  time: {
    fontSize: 11,
  },
  metaBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cost: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
