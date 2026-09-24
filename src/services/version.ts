/**
 * Version Check Protocol (architecture §6/§8 — verification & currency).
 * Checked at pairing and on foreground resume (NFR-4).
 */
export function checkVersionCompatibility(serverVersion: string): {
  compatible: boolean;
  action: 'proceed' | 'warn' | 'block';
  message?: string;
} {
  const PINNED = '0.21.3';
  if (serverVersion === PINNED) return { compatible: true, action: 'proceed' };

  const [sMaj = 0, sMin = 0] = serverVersion.split('.').map(Number);
  const [pMaj = 0, pMin = 0] = PINNED.split('.').map(Number);

  if (sMaj !== pMaj) {
    return {
      compatible: false,
      action: 'warn',
      message: `Gateway version ${serverVersion} may have breaking changes vs tested ${PINNED}. Some features may not work.`,
    };
  }
  if (sMin < pMin) {
    return {
      compatible: true,
      action: 'warn',
      message: `Gateway v${serverVersion} is older than tested v${PINNED}. Some features may be unavailable.`,
    };
  }
  return { compatible: true, action: 'proceed' };
}
