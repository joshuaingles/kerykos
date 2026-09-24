import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore, type Gateway } from '@/store/gateway';
import { AuthService } from '@/services/auth';
import { GatewayAPI, GatewayError, type HealthResponse } from '@/services/gateway-api';
import { probeAndCache } from '@/services/capabilities';
import { checkVersionCompatibility } from '@/services/version';
import { getSetting, setSetting } from '@/services/storage';

// === KR-5: distinct error states ===

type PairErrorState =
  | 'unreachable'     // healthCheck network error
  | 'gateway-down'    // healthCheck HTTP error
  | 'bad-key'         // capabilities 401
  | 'connection-lost' // capabilities network error
  | null;

const ERROR_COPY: Record<Exclude<PairErrorState, null>, string> = {
  'unreachable':
    'Cannot reach the gateway. Check the URL and ensure the API server is running.',
  'gateway-down':
    'Gateway returned an unexpected error. It may be starting up.',
  'bad-key':
    'The API key was rejected. Check your API_SERVER_KEY in ~/.hermes/.env',
  'connection-lost':
    'Lost connection during pairing. Try again.',
};

const ERROR_LABEL: Record<Exclude<PairErrorState, null>, string> = {
  'unreachable': 'Unreachable',
  'gateway-down': 'Gateway down',
  'bad-key': 'Bad key',
  'connection-lost': 'Connection lost',
};

// === KR-2: plain HTTP handling ===

function shouldShowHttpWarning(url: string): boolean {
  return url.startsWith('http://');
}

export default function PairingScreen() {
  const { tokens } = useTheme();
  const addGateway = useGatewayStore((s) => s.addGateway);

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<null | 'checking' | 'verifying'>(null);
  const [errorState, setErrorState] = useState<PairErrorState>(null);
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  const [warningModalVisible, setWarningModalVisible] = useState(false);
  const [httpWarningSeen, setHttpWarningSeen] = useState(false);

  const proceedToPair = async () => {
    const url = baseUrl.trim().replace(/\/+$/, '');
    if (!url || !apiKey) return;
    setBusy('checking');
    setErrorState(null);
    try {
      const gatewayId = uuidv4();
      const api = new GatewayAPI(url, gatewayId);

      // Step 1: unauthed liveness check (KR-1)
      let health: HealthResponse;
      try {
        health = await api.healthCheck();
      } catch (err) {
        setBusy(null);
        if (err instanceof GatewayError) {
          setErrorState('gateway-down');
        } else {
          setErrorState('unreachable');
        }
        return;
      }

      // Step 2: authed credential probe (KR-1, KR-3)
      setBusy('verifying');
      try {
        await probeAndCache(api);
      } catch (err) {
        setBusy(null);
        if (err instanceof GatewayError && err.status === 401) {
          // 401 is never retried automatically (KR-5)
          setErrorState('bad-key');
        } else if (err instanceof GatewayError) {
          setErrorState('gateway-down');
        } else {
          setErrorState('connection-lost');
        }
        return;
      }

          // Version check (NFR-4) — non-blocking warning only
          const compat = checkVersionCompatibility(health.version);
          if (compat.action === 'warn' && compat.message) {
            setVersionWarning(compat.message);
          }

      // Success: store key (NFR-1), register gateway, navigate via navigator switch
      await AuthService.storeKey(gatewayId, apiKey);

      const gateway: Gateway = {
        id: gatewayId,
        label: health.version ? `Hermes v${health.version}` : 'Hermes Gateway',
        base_url: url,
        key_ref: `gw_key_${gatewayId}`,
        added_at: Date.now(),
        last_connected_at: Date.now(),
      };
      addGateway(gateway);
    } finally {
      setBusy(null);
    }
  };

  const onPairPress = () => {
    const url = baseUrl.trim();
    if (!url || !apiKey) return;
    setErrorState(null);
    if (shouldShowHttpWarning(url)) {
      const seen = getSetting<string | null>(`http_warn_${url}`, null);
      if (!seen) {
        setWarningModalVisible(true);
        return;
      }
    }
    void proceedToPair();
  };

  const onDismissHttpWarning = (proceed: boolean) => {
    setWarningModalVisible(false);
    setHttpWarningSeen(true);
    const url = baseUrl.trim();
    if (url) {
      setSetting(`http_warn_${url}`, url);
    }
    if (proceed) void proceedToPair();
  };

  const busyLabel =
    busy === 'checking' ? 'Checking connection…' :
    busy === 'verifying' ? 'Verifying key…' :
    null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]}>
      <Text style={[styles.title, { color: tokens.text }]}>Pair your gateway</Text>
      <Text style={[styles.subtitle, { color: tokens.muted }]}>
        Enter your Hermes API server URL and API_SERVER_KEY.
      </Text>

      <TextInput
        style={[styles.input, { backgroundColor: tokens.card, borderColor: tokens.border, color: tokens.text }]}
        placeholder="http://192.168.1.5:8642"
        placeholderTextColor={tokens.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={baseUrl}
        onChangeText={(t) => { setBaseUrl(t); setHttpWarningSeen(false); }}
      />
      <TextInput
        style={[styles.input, { backgroundColor: tokens.card, borderColor: tokens.border, color: tokens.text }]}
        placeholder="API_SERVER_KEY"
        placeholderTextColor={tokens.muted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        value={apiKey}
        onChangeText={setApiKey}
      />

      {httpWarningSeen && shouldShowHttpWarning(baseUrl.trim()) && (
        <Text style={[styles.httpHint, { color: tokens.warning }]}>
          Plain HTTP: credentials and chats will travel unencrypted. Use Tailscale or an HTTPS proxy outside your home network.
        </Text>
      )}

      {busyLabel ? (
        <Text style={{ color: tokens.accent }}>{busyLabel}</Text>
      ) : (
        <Pressable
          style={[styles.pairButton, { backgroundColor: tokens.accent }]}
          onPress={onPairPress}
        >
          <Text style={[styles.pairButtonText, { color: tokens.background }]}>Pair Gateway</Text>
        </Pressable>
      )}

      {errorState && (
        <View style={[styles.errorBox, { borderColor: tokens.error }]}>
          <Text style={{ color: tokens.error, fontWeight: '600' }}>
            {ERROR_LABEL[errorState]}
          </Text>
          <Text style={{ color: tokens.muted }}>{ERROR_COPY[errorState]}</Text>
        </View>
      )}

      {versionWarning && !errorState && (
        <Text style={[styles.httpHint, { color: tokens.warning }]}>{versionWarning}</Text>
      )}

      {warningModalVisible && (
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: tokens.card, borderColor: tokens.border }]}>
            <Text style={{ color: tokens.warning, fontWeight: '600', fontSize: 16 }}>
              Unencrypted connection
            </Text>
            <Text style={{ color: tokens.text }}>
              Your credentials and chats will travel unencrypted. Use Tailscale or an HTTPS proxy outside your home network.
            </Text>
            <Pressable onPress={() => onDismissHttpWarning(true)} hitSlop={8}>
              <Text style={{ color: tokens.accent, marginTop: 12 }}>Pair anyway</Text>
            </Pressable>
            <Pressable onPress={() => onDismissHttpWarning(false)} hitSlop={8}>
              <Text style={{ color: tokens.muted, marginTop: 8 }}>Edit URL</Text>
            </Pressable>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  pairButton: {
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  pairButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  httpHint: {
    fontSize: 13,
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  modalOverlay: {
    ...StyleSheet.flatten([{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]),
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 20,
    gap: 8,
    width: '100%',
  },
});
