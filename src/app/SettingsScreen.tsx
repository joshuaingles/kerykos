import { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import type { SkinName, ThemeMode } from '@/theme/tokens';
import { useGatewayStore } from '@/store/gateway';
import { AuthService } from '@/services/auth';
import { useFeature } from '@/hooks/useFeature';
import { ProUpgradePrompt } from '@/components/ProUpgradePrompt';

const THEME_ORDER: readonly ThemeMode[] = ['light', 'dark', 'system'];
const SKIN_ORDER: readonly SkinName[] = [
  'default',
  'ares',
  'mono',
  'slate',
  'daylight',
  'warm-lightmode',
  'poseidon',
  'sisyphus',
  'charizard',
];

function nextOf<T>(current: T, order: readonly T[]): T {
  const idx = order.indexOf(current);
  const nextIndex = (idx + 1) % order.length;
  return order[nextIndex] ?? current;
}

export default function SettingsScreen() {
  const { theme, skin, setTheme, setSkin, tokens } = useTheme();
  // Phase 6: license status from the feature-flag system (audit W1) — the
  // flag set is all-Pro today, so any Pro feature name reflects license state.
  const isLicensed = useFeature('cost_dashboard');

  // Audit W4: unpair flow — AuthService.deleteKey finally has a caller.
  const activeGatewayId = useGatewayStore((s) => s.activeGatewayId);
  const activeGateway = useGatewayStore((s) =>
    s.gateways.find((g) => g.id === s.activeGatewayId),
  );
  const removeGateway = useGatewayStore((s) => s.removeGateway);

  const resetGateway = useCallback(async () => {
    if (!activeGatewayId) return;
    await AuthService.deleteKey(activeGatewayId);
    removeGateway(activeGatewayId);
    // RootNavigator switches back to Pairing automatically once the gateway
    // list empties — no explicit navigation needed.
  }, [activeGatewayId, removeGateway]);

  const confirmResetGateway = useCallback(() => {
    Alert.alert(
      'Reset gateway?',
      `"${activeGateway?.label ?? 'This gateway'}" and its stored API key will be removed. You will return to the Pairing screen.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reset', style: 'destructive', onPress: () => void resetGateway() },
      ],
    );
  }, [activeGateway, resetGateway]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={[styles.title, { color: tokens.text }]}>Settings</Text>
      <Pressable onPress={() => setTheme(nextOf(theme, THEME_ORDER))} hitSlop={8}>
        <Text style={{ color: tokens.accent }}>Theme: {theme} (tap to cycle)</Text>
      </Pressable>
      <Pressable onPress={() => setSkin(nextOf(skin, SKIN_ORDER))} hitSlop={8}>
        <Text style={{ color: tokens.accent }}>Skin: {skin} (tap to cycle)</Text>
      </Pressable>

      {/* Phase 6: license status (audit W1) */}
      <View style={styles.licenseSection}>
        <Text style={{ color: tokens.text }}>
          License: {isLicensed ? 'Pro' : 'Free'}
        </Text>
        {!isLicensed && (
          <Text style={{ color: tokens.muted }}>
            Pro features (cost analytics, budget alerts) are locked.
          </Text>
        )}
      </View>

      {!isLicensed && (
        <View style={styles.upgradeBox}>
          <ProUpgradePrompt feature="Cost Analytics" />
        </View>
      )}

      {/* Audit W4: unpair / switch-gateway affordance */}
      {activeGatewayId && (
        <Pressable onPress={confirmResetGateway} hitSlop={8}>
          <Text style={{ color: tokens.error }}>Reset Gateway ({activeGateway?.label ?? 'paired'})</Text>
        </Pressable>
      )}
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
  licenseSection: {
    alignItems: 'center',
    gap: 4,
  },
  upgradeBox: {
    flex: 1,
    alignSelf: 'stretch',
  },
});
