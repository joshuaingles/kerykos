import { checkVersionCompatibility } from '../version';

describe('checkVersionCompatibility (§2.1 — version check protocol)', () => {
  it('pinned version returns proceed', () => {
    expect(checkVersionCompatibility('0.21.3')).toEqual({
      compatible: true,
      action: 'proceed',
    });
  });

  it('same major, older minor → warn but compatible', () => {
    const result = checkVersionCompatibility('0.20.0');
    expect(result.compatible).toBe(true);
    expect(result.action).toBe('warn');
    expect(result.message).toContain('older than tested');
  });

  it('same major, newer minor → proceed (no warning on forward minor)', () => {
    const result = checkVersionCompatibility('0.22.5');
    expect(result).toEqual({ compatible: true, action: 'proceed' });
    expect(result.message).toBeUndefined();
  });

  it('different major → not compatible, warn with breaking-changes copy', () => {
    const result = checkVersionCompatibility('1.0.0');
    expect(result.compatible).toBe(false);
    expect(result.action).toBe('warn');
    expect(result.message).toContain('breaking changes');
    expect(result.message).toContain('0.21.3');
  });

  it('malformed version → defaults applied, does not crash', () => {
    expect(() => checkVersionCompatibility('')).not.toThrow();
    const empty = checkVersionCompatibility('');
    expect(empty.action).toBe('warn'); // NaN-major → sMaj !== pMaj branch

    expect(() => checkVersionCompatibility('abc')).not.toThrow();
    const abc = checkVersionCompatibility('abc');
    // NaN !== 0 → breaking-changes branch
    expect(abc.compatible).toBe(false);
    expect(abc.action).toBe('warn');
  });
});
