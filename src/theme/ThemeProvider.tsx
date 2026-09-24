import { useColorScheme } from 'react-native';
import { useCallback, createContext, useContext, useMemo, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { SKIN_MAP } from './skins';
import { darkBase, lightBase } from './tokens';
import type { SkinName, ThemeMode, ThemeTokens } from './tokens';
import { getSetting, setSetting } from '@/services/storage';

interface ThemeContextValue {
  theme: ThemeMode;
  skin: SkinName;
  tokens: ThemeTokens;
  setTheme: (mode: ThemeMode) => void;
  setSkin: (name: SkinName) => void;
}

const ThemeContext = createContext<ThemeContextValue>(null!);
export const useTheme = () => useContext(ThemeContext);

export function resolveTokens(mode: ThemeMode, skin: SkinName, systemScheme: string | null): ThemeTokens {
  const effectiveDark = mode === 'system' ? systemScheme === 'dark' : mode === 'dark';
  const base = effectiveDark ? darkBase : lightBase;
  const overrides = SKIN_MAP[skin] ?? {};
  return { ...base, ...overrides };
}

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme() ?? null;
  const [theme, setThemeState] = useState<ThemeMode>(
    () => getSetting<ThemeMode>('theme.mode', 'system'),
  );
  const [skin, setSkinState] = useState<SkinName>(
    () => getSetting<SkinName>('theme.skin', 'default'),
  );

  const tokens = useMemo(
    () => resolveTokens(theme, skin, systemScheme),
    [theme, skin, systemScheme],
  );

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    setSetting('theme.mode', mode);
  }, []);

  const setSkin = useCallback((name: SkinName) => {
    setSkinState(name);
    setSetting('theme.skin', name);
  }, []);

  const value = useMemo(
    () => ({ theme, skin, tokens, setTheme, setSkin }),
    [theme, skin, tokens, setTheme, setSkin],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
