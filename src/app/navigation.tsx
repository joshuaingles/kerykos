import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useMemo } from 'react';
import { useForegroundProbe } from '@/hooks/useForegroundProbe';
import ChatHeader from '@/components/ChatHeader';
import SessionDetailScreen from '@/components/SessionDetailScreen';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore } from '@/store/gateway';
import ChatScreen from './ChatScreen';
import PairingScreen from './PairingScreen';
import SessionsScreen from './SessionsScreen';
import AnalyticsScreen from './AnalyticsScreen';
import SettingsScreen from './SettingsScreen';

// Stack types
export type RootStackParamList = {
  Pairing: undefined;
  Main: undefined;
  Chat: { sessionId: string; gatewayId: string };
  SessionDetail: { sessionId: string; gatewayId: string };
};

export type MainTabParamList = {
  Sessions: undefined;
  Analytics: undefined;  // Phase 5
  Settings: undefined;   // Phase 6 (or v1.1)
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

export function RootNavigator() {
  useForegroundProbe();
  const hasGateway = useGatewayStore((s) => s.gateways.length > 0);
  const { tokens } = useTheme();

  const navTheme = useMemo(
    () => ({
      ...DefaultTheme,
      colors: {
        ...DefaultTheme.colors,
        background: tokens.background,
        card: tokens.card,
        text: tokens.text,
        border: tokens.border,
        primary: tokens.accent,
        notification: tokens.warning,
      },
    }),
    [tokens],
  );

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator>
        {!hasGateway ? (
          <Stack.Screen name="Pairing" component={PairingScreen} />
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={{ headerTitle: () => <ChatHeader title="Chat" model="—" cost="$0.00" /> }}
            />
            <Stack.Screen
              name="SessionDetail"
              component={SessionDetailScreen}
              options={{ title: 'Session Detail' }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Sessions" component={SessionsScreen} />
      <Tab.Screen name="Analytics" component={AnalyticsScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}
