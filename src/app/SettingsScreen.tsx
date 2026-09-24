import { Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import type { SkinName, ThemeMode } from '@/theme/tokens';

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

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={[styles.title, { color: tokens.text }]}>Settings</Text>
      <Pressable onPress={() => setTheme(nextOf(theme, THEME_ORDER))} hitSlop={8}>
        <Text style={{ color: tokens.accent }}>Theme: {theme} (tap to cycle)</Text>
      </Pressable>
      <Pressable onPress={() => setSkin(nextOf(skin, SKIN_ORDER))} hitSlop={8}>
        <Text style={{ color: tokens.accent }}>Skin: {skin} (tap to cycle)</Text>
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
