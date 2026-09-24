import { StyleSheet, Text, View } from 'react-native';
import type { ApprovalRequest } from '@/store/chat';
import { useTheme } from '@/theme/ThemeProvider';

export function ApprovalCard({ approval, onRespond }: {
  approval: ApprovalRequest;
  onRespond: (decision: 'approve' | 'deny') => void;
}) {
  const { tokens } = useTheme();

  if (approval.responded) {
    return (
      <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
        <Text style={[styles.text, { color: tokens.text }]}>
          {approval.decision === 'approve' ? 'Approved' : 'Denied'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.warning }]}>
      <Text style={[styles.text, { color: tokens.text }]}>
        Approval requested: {approval.message}
      </Text>
      <View style={styles.buttons}>
        <Text
          style={[styles.button, { backgroundColor: tokens.accent, color: tokens.background }]}
          onPress={() => onRespond('approve')}
        >
          Approve
        </Text>
        <Text
          style={[styles.button, { backgroundColor: tokens.error, color: '#fff' }]}
          onPress={() => onRespond('deny')}
        >
          Deny
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    marginVertical: 6,
  },
  text: {
    fontSize: 14,
    lineHeight: 20,
  },
  buttons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  button: {
    borderRadius: 8,
    fontSize: 15,
    fontWeight: '600',
    overflow: 'hidden',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
});
