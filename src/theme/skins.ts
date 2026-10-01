// Skin NAMES verified against hermes_cli/skin_engine.py v0.21.3 — 9 skins only.
// ⚠️ Color values are PLACEHOLDERS — port the real values from
// hermes_cli/skin_engine.py at impl time before shipping any skin.
import type { SkinName, ThemeTokens } from './tokens';

export const SKIN_MAP: Record<SkinName, Partial<ThemeTokens>> = {
  default: {},
  ares: {},
  mono: {},
  slate: {},
  daylight: {},
  'warm-lightmode': {},
  poseidon: {},
  sisyphus: {},
  charizard: {},
};
