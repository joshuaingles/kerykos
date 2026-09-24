import { StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';

export default function AnalyticsScreen() {
  const { tokens } = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={{ color: tokens.text }}>Analytics</Text>
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
