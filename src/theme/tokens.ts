export type ThemeMode = 'light' | 'dark' | 'system';
export type SkinName = 'default' | 'ares' | 'mono' | 'slate' | 'daylight'
  | 'warm-lightmode' | 'poseidon' | 'sisyphus' | 'charizard';

export interface ThemeTokens {
  background: string;
  text: string;
  accent: string;
  sidebar: string;
  border: string;
  muted: string;
  card: string;
  success: string;
  warning: string;
  error: string;
}

export const darkBase: ThemeTokens = {
  background: '#0d1117',
  text: '#e6edf3',
  accent: '#58a6ff',
  sidebar: '#161b22',
  border: '#30363d',
  muted: '#8b949e',
  card: '#161b22',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
};

export const lightBase: ThemeTokens = {
  background: '#ffffff',
  text: '#24292f',
  accent: '#0969da',
  sidebar: '#f6f8fa',
  border: '#d0d7de',
  muted: '#656d76',
  card: '#f6f8fa',
  success: '#1a7f37',
  warning: '#9a6700',
  error: '#cf222e',
};
