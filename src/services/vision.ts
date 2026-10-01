import type { ModelOptionsResponse } from './gateway-api';

/**
 * KR-17: non-vision model warning.
 * ⚠️ NEVER hardcode a non-vision model list — derive from /api/model/options
 * vision metadata (ModelOptionsResponse). Returns:
 *   true  → model known to NOT support vision (show warning)
 *   false → model known vision-capable
 *   null  → unknown (no metadata) — don't warn
 */
export function showVisionWarning(
  model: string,
  modelOptions: ModelOptionsResponse,
): boolean | null {
  const entry = modelOptions.models?.find(m => m.id === model);
  if (!entry || entry.vision === undefined) return null; // unknown — don't warn
  return !entry.vision;
}
