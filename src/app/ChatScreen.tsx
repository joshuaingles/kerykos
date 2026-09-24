import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';

export default function ChatScreen() {
  const { tokens } = useTheme();
  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: tokens.background }]}
      edges={['bottom', 'left', 'right']}
    >
      <Text style={{ color: tokens.text }}>Chat</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
