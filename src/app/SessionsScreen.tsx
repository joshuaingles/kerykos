import { Pressable, StyleSheet, Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore } from '@/store/gateway';
import type { RootStackParamList } from './navigation';

type SessionsNav = NativeStackNavigationProp<RootStackParamList>;

export default function SessionsScreen() {
  const { tokens } = useTheme();
  const navigation = useNavigation<SessionsNav>();
  const activeGatewayId = useGatewayStore((s) => s.activeGatewayId) ?? 'dev-gateway';

  const openChat = () =>
    navigation.navigate('Chat', { sessionId: 'dev-session', gatewayId: activeGatewayId });

  const openSessionDetail = () =>
    navigation.navigate('SessionDetail', { sessionId: 'dev-session', gatewayId: activeGatewayId });

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={[styles.title, { color: tokens.text }]}>Sessions</Text>
      <Pressable onPress={openChat} onLongPress={openSessionDetail} hitSlop={8}>
        <Text style={{ color: tokens.accent }}>Dev session row (tap: Chat · long-press: Detail)</Text>
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
