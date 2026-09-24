import { Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { v4 as uuidv4 } from 'uuid';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore, type Gateway } from '@/store/gateway';

export default function PairingScreen() {
  const { tokens } = useTheme();
  const addGateway = useGatewayStore((s) => s.addGateway);

  const addTestGateway = () => {
    const gateway: Gateway = {
      id: uuidv4(),
      label: 'Dev Gateway',
      base_url: 'http://192.168.1.10:8642',
      key_ref: 'dev/gateway-key',
      added_at: Date.now(),
      last_connected_at: null,
    };
    addGateway(gateway);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={[styles.title, { color: tokens.text }]}>Pairing</Text>
      <Pressable onPress={addTestGateway} hitSlop={12}>
        <Text style={{ color: tokens.accent }}>Add test gateway (dev)</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
});
