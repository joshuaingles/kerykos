import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ToolCall } from '@/store/chat';
import { useTheme } from '@/theme/ThemeProvider';

/**
 * KR-15: collapsible tool activity card — inline in the message flow,
 * never a modal. Default collapsed; running/failed/completed indicator.
 */
export function ToolActivityCard({ tool }: { tool: ToolCall }) {
  const { tokens } = useTheme();
  const [expanded, setExpanded] = useState(!tool.collapsed);

  return (
    <Pressable
      style={[
        styles.toolCard,
        {
          borderColor: tokens.border,
          backgroundColor: tool.state === 'failed' ? 'rgba(248,81,73,0.08)' : 'rgba(127,127,127,0.08)',
        },
      ]}
      onPress={() => setExpanded(!expanded)}
    >
      <View style={styles.toolHeader}>
        <ActivityIndicator
          size="small"
          animating={tool.state === 'running'}
          color={tool.state === 'failed' ? tokens.error : tokens.accent}
        />
        <Text style={[styles.toolName, { color: tokens.text }]} numberOfLines={1}>
          {tool.name}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 11 }}>
          {tool.state === 'running'
            ? 'running'
            : tool.state === 'failed'
              ? 'failed'
              : 'done'}
        </Text>
        <Text style={{ color: tokens.muted, fontSize: 11 }}>
          {expanded ? '▲' : '▼'}
        </Text>
      </View>
      {expanded && (
        <View style={styles.toolBody}>
          <Text style={[styles.toolDetail, { color: tokens.muted }]}>
            {tool.name}
            {' — '}
            {tool.state === 'failed' ? 'failed' : 'completed'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toolCard: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 6,
  },
  toolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolName: { flex: 1, fontSize: 12, fontWeight: '600' },
  toolBody: { paddingHorizontal: 8, paddingBottom: 6 },
  toolDetail: { fontSize: 12 },
});
