import { useEffect } from 'react';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { LicenseService } from '@/services/license';
import { ServicesProvider } from './composition';
import { RootNavigator } from './navigation';

export default function App() {
  // Phase 6: RevenueCat init once at app start (audit W1). Failure is
  // non-fatal — useFeature degrades to "not licensed" and ProUpgradePrompt
  // shows its "packages unavailable" state.
  useEffect(() => {
    void LicenseService.init().catch(() => {
      // RevenueCat unavailable (e.g. dev build without billing config)
    });
  }, []);

  return (
    <ThemeProvider>
      <ServicesProvider>
        <RootNavigator />
      </ServicesProvider>
    </ThemeProvider>
  );
}
