/**
 * §3.5 ProUpgradePrompt — the payment surface (offerings load, purchase,
 * restore, unmount-mid-load guard).
 *
 * Re-mocks react-native-purchases at file level (jest.setup's mock lacks
 * setLogLevel) so the whole LicenseService surface works under test.
 */
import React from 'react';
import { fireEvent, waitFor, act } from '@testing-library/react-native';
import { renderThemeProvider } from '@/test/helpers';
import { ProUpgradePrompt } from '@/components/ProUpgradePrompt';
import PurchasesModule from 'react-native-purchases';

jest.mock('react-native-purchases', () => ({
  configure: jest.fn(async () => undefined),
  setLogLevel: jest.fn(),
  getCustomerInfo: jest.fn(async () => ({ entitlements: { active: {} } })),
  getOfferings: jest.fn(async () => ({ current: null })),
  purchasePackage: jest.fn(async () => ({ customerInfo: { entitlements: { active: { pro: {} } } } })),
  restorePurchases: jest.fn(async () => ({ entitlements: { active: { pro: {} } } })),
  addCustomerInfoUpdateListener: jest.fn(() => jest.fn()),
  removeCustomerInfoUpdateListener: jest.fn(),
  LOG_LEVEL: { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR' },
}));

const Purchases = PurchasesModule as unknown as {
  configure: jest.Mock;
  getOfferings: jest.Mock;
  purchasePackage: jest.Mock;
  restorePurchases: jest.Mock;
};

interface PackageLike {
  identifier: string;
  product: { title: string; priceString: string };
}

describe('§3.5 ProUpgradePrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const pkg: PackageLike = {
    identifier: 'monthly',
    product: { title: 'Pro Monthly', priceString: '$9.99' },
  };

  it('offerings load → package prices rendered with /mo (§3.5 test 1)', async () => {
    Purchases.getOfferings.mockResolvedValueOnce({ current: { availablePackages: [pkg] } });

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);

    expect(await screen.findByText('Pro Monthly — $9.99/mo')).toBeTruthy();
    expect(screen.getByText(/Unlock/)).toBeTruthy(); // feature named in the title row
    expect(screen.queryByText(/Packages unavailable/)).toBeNull();
  });

  it('offerings failure → "Packages unavailable" empty state (§3.5)', async () => {
    Purchases.getOfferings.mockImplementationOnce(async () => {
      throw new Error('network gone');
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);

    expect(await screen.findByText('Packages unavailable — check your connection.')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('Offerings returning no current → empty state too', async () => {
    Purchases.getOfferings.mockResolvedValueOnce({ current: null });

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);

    expect(await screen.findByText('Packages unavailable — check your connection.')).toBeTruthy();
  });

  it('purchase → calls the purchase path with the selected package (§3.5 test 2)', async () => {
    Purchases.getOfferings.mockResolvedValueOnce({ current: { availablePackages: [pkg] } });

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);
    const priceButton = await screen.findByText('Pro Monthly — $9.99/mo');
    await act(async () => {
      await fireEvent.press(priceButton);
    });

    expect(Purchases.purchasePackage).toHaveBeenCalledTimes(1);
    expect(Purchases.purchasePackage).toHaveBeenCalledWith(pkg);
    // Successful purchase must NOT render an error band
    expect(screen.queryByText('Purchase could not be completed.')).toBeNull();
  });

  it('purchase cancelled → error copy, no crash (§3.5)', async () => {
    Purchases.getOfferings.mockResolvedValueOnce({ current: { availablePackages: [pkg] } });
    Purchases.purchasePackage.mockRejectedValueOnce(new Error('user cancelled'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);
    const priceButton = await screen.findByText('Pro Monthly — $9.99/mo');
    await act(async () => {
      await fireEvent.press(priceButton);
    });

    expect(await screen.findByText('Purchase could not be completed.')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('restore → restore called (§3.5 test 3)', async () => {
    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);
    const restoreButton = await screen.findByText('Restore Purchases');
    await act(async () => {
      await fireEvent.press(restoreButton);
    });

    await waitFor(() => expect(Purchases.restorePurchases).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Restore failed. Please try again.')).toBeNull();
  });

  it('restore failure → error copy, no crash (§3.5)', async () => {
    Purchases.restorePurchases.mockRejectedValueOnce(new Error('App Store fell over'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);
    await act(async () => {
      await fireEvent.press(await screen.findByText('Restore Purchases'));
    });

    expect(await screen.findByText('Restore failed. Please try again.')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('unmount mid-load → no setState-after-unmount warning (§3.5 test 4)', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    let resolveOfferings: (v: unknown) => void = () => undefined;
    Purchases.getOfferings.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOfferings = resolve; }),
    );

    const screen = await renderThemeProvider(<ProUpgradePrompt feature="Analytics" />);
    await screen.unmount(); // offerings promise still pending

    // Settle AFTER unmount — the mounted-flag guard means setPackages never runs.
    resolveOfferings({ current: { availablePackages: [pkg] } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('unmounted'),
    );
    consoleError.mockRestore();
  });
});
