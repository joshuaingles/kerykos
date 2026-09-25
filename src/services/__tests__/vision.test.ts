import { showVisionWarning } from '../vision';
import type { ModelOptionsResponse } from '../gateway-api';

const options: ModelOptionsResponse = {
  models: [
    { id: 'vision-model', vision: true },
    { id: 'text-only', vision: false },
    { id: 'no-vision-field' },          // entry without `vision` field
  ],
};

describe('showVisionWarning (§2.6 — KR-17, derived from /api/model/options — never hardcoded)', () => {
  it('known non-vision → true (warn)', () => {
    expect(showVisionWarning('text-only', options)).toBe(true);
  });

  it('known vision-capable → false', () => {
    expect(showVisionWarning('vision-model', options)).toBe(false);
  });

  it('model not in list → null (never warn)', () => {
    expect(showVisionWarning('unknown-model-xyz', options)).toBeNull();
  });

  it('vision undefined → null (no metadata entry)', () => {
    expect(showVisionWarning('no-vision-field', options)).toBeNull();
  });

  it('empty models list → null', () => {
    expect(showVisionWarning('anything', { models: [] })).toBeNull();
    expect(showVisionWarning('anything', {})).toBeNull();
  });
});
