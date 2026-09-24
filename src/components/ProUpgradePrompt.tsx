import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PurchasesPackage } from 'react-native-purchases';
import { LicenseService } from '@/services/license';
import { useTheme } from '@/theme/ThemeProvider';

export function ProUpgradePrompt({ feature }: { feature: string }) {
  const { tokens } = useTheme();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    LicenseService.init()
      .then(() => LicenseService.getOfferings())
      .then((pkgs) => {
        if (mounted) setPackages(pkgs);
      })
      .catch(() => {
        if (mounted) setPackages([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const handlePurchase = async (pkg: PurchasesPackage) => {
    setError(null);
    try {
      await LicenseService.purchase(pkg);
    } catch {
      // Purchase cancelled or failed
      setError('Purchase could not be completed.');
    }
  };

  const handleRestore = async () => {
    setError(null);
    try {
      await LicenseService.restore();
    } catch {
      setError('Restore failed. Please try again.');
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: tokens.background }]}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <Text style={styles.icon}>🔒</Text>
        <Text style={[styles.title, { color: tokens.text }]}>
          Unlock {feature}
        </Text>
        <Text style={[styles.subtitle, { color: tokens.muted }]}>
          Upgrade to Kerykos Pro for advanced analytics, budget alerts, and
          more.
        </Text>
      </View>
      {packages.map((pkg) => (
        <Text
          key={pkg.identifier}
          style={[
            styles.button,
            { backgroundColor: tokens.accent, color: tokens.background },
          ]}
          onPress={() => handlePurchase(pkg)}
        >
          {pkg.product.title} — {pkg.product.priceString}/mo
        </Text>
      ))}
      {!packages.length && (
        <Text style={[styles.empty, { color: tokens.muted }]}>
          Packages unavailable — check your connection.
        </Text>
      )}
      <Text
        style={[
          styles.button,
          styles.secondary,
          { color: tokens.accent, borderColor: tokens.border },
        ]}
        onPress={handleRestore}
      >
        Restore Purchases
      </Text>
      {error && <Text style={[styles.error, { color: tokens.error }]}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 24 },
  icon: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 14, textAlign: 'center', marginBottom: 24 },
  button: {
    textAlign: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 12,
    overflow: 'hidden',
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  empty: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  error: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
});
