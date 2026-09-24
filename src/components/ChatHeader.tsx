import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@/theme/ThemeProvider';

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
