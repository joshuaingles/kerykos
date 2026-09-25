/**
 * §5.1 Integration — Pairing flow (KR-1 / KR-2 / KR-5).
 *
 * Real PairingScreen + real GatewayAPI/probeAndCache over the hand-rolled
 * fetch mock; SecureStore + MMKV are the in-memory fakes. PF-01…PF-06.
 */
import React from 'react';
import { fireEvent, waitFor, act } from '@testing-library/react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import PairingScreen from '@/app/PairingScreen';
import { renderThemeProvider, createFetchMock, resetMMKV, resetSecureStore, type FetchCall } from '@/test/helpers';
import { useGatewayStore } from '@/store/gateway';
import { AuthService } from '@/services/auth';
import { getSetting } from '@/services/storage';

// The setup-file jest.mock('uuid') factory is plain CJS, so `import * as`
// yields a babel interop COPY — spying on it would not affect PairingScreen's
// live `uuidv4` binding. Pin the real mock module exports instead.
type UuidMock = { v4: jest.Mock; __counter: () => number };
const uuidMock = jest.requireMock('uuid') as UuidMock;

// PairingScreen generates its gateway id via uuid v4 — pinned so tests can
// pre-seed the SecureStore key the GatewayAPI probe resolves (the probe
// authenticates against the typed key before the screen persists it).
const GATEWAY_ID = '00000000-0000-4000-8000-000000000042';
jest.spyOn(uuidMock, 'v4').mockReturnValue(GATEWAY_ID);

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

// Dummy route the screen navigates to after successful pairing.
function MainStub(): null {
  return null;
}

// Wraps PairingScreen in the real navigator stack (Pairing → Main) so any
// useNavigation() calls inside the screen resolve without throwing.
async function renderWithNav(ui: React.ReactElement): Promise<Screen> {
  const Stack = createNativeStackNavigator<{ Pairing: undefined; Main: undefined }>();
  return await renderThemeProvider(
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Pairing">
        <Stack.Screen name="Pairing">{() => ui}</Stack.Screen>
        <Stack.Screen name="Main" component={MainStub} />
      </Stack.Navigator>
    </NavigationContainer>,
  );
}

function calls(): FetchCall[] {
  return (globalThis.fetch as unknown as { calls: FetchCall[] }).calls;
}

const FULL_CAPS = {
  run_submission: true,
  run_status: true,
  run_events_sse: true,
  run_stop: true,
  run_steer: true,
  run_approval_response: true,
  tool_progress_events: true,
  approval_events: true,
  session_chat: true,
  session_chat_streaming: true,
  session_fork: true,
  model_options: true,
  skills_api: true,
  admin_config_rw: false,
  jobs_admin: false,
  memory_write_api: false,
  audio_api: false,
  realtime_voice: false,
};

describe('§5.1 Pairing flow integration', () => {
  beforeEach(async () => {
    resetSecureStore();
    resetMMKV();
    useGatewayStore.setState({ gateways: [], activeGatewayId: null });
    createFetchMock([]);
    jest.clearAllMocks();
    jest.spyOn(uuidMock, 'v4').mockReturnValue(GATEWAY_ID);
    // GatewayAPI resolves the key from SecureStore at request time — seed the
    // probe credential under the id the screen will generate.
    await AuthService.storeKey(GATEWAY_ID, 'sk-test-key');
  });

  const seed = async (screen: Screen): Promise<void> => {
    await fireEvent.changeText(
      screen.getByPlaceholderText('http://192.168.1.5:8642'),
      'https://gw.example.com:8642',
    );
    await fireEvent.changeText(screen.getByPlaceholderText('API_SERVER_KEY'), 'sk-test-key');
  };

  const pairUntilErrorOrSuccess = async (screen: Screen): Promise<void> => {
    await fireEvent.press(screen.getByText('Pair Gateway'));
  };

  it('PF-01 health fail (network) → unreachable copy', async () => {
    createFetchMock([]); // no routes → every request rejected (unhandled)

    const screen = await renderThemeProvider(<PairingScreen />);
    await seed(screen);
    await act(async () => { await fireEvent.press(screen.getByText('Pair Gateway')); });await act(async () => { await fireEvent.press(screen.getByText('Pair Gateway')); });

    await waitFor(() => expect(screen.getByText('Unreachable')).toBeTruthy());
    expect(screen.getByText(/Cannot reach the gateway\. Check the URL and ensure the API server is running\./)).toBeTruthy();
    // fail-safe: nothing paired, nothing stored
    expect(useGatewayStore.getState().gateways).toHaveLength(0);
    // fail-safe: the pre-seeded probe credential is untouched (nothing re-stored)
    expect(AuthService.getKey(GATEWAY_ID)).resolves.toBe('sk-test-key');
  });

  it('PF-02 health 500 → gateway-down copy', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 500, text: 'boom' } },
    ]);

    const screen = await renderThemeProvider(<PairingScreen />);
    await seed(screen);
    await act(async () => { await fireEvent.press(screen.getByText('Pair Gateway')); });

    await waitFor(() => expect(screen.getByText('Gateway down')).toBeTruthy());
    expect(screen.getByText(/Gateway returned an unexpected error\. It may be starting up\./)).toBeTruthy();
    expect(useGatewayStore.getState().gateways).toHaveLength(0);
  });

  it('PF-03 capabilities 401 → bad-key copy, key NOT stored (KR-5)', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 401, json: { error: 'gateway_auth_failed' } } },
    ]);

    const screen = await renderWithNav(<PairingScreen />);
    await seed(screen);
    const storeKeySpy = jest.spyOn(AuthService, 'storeKey');
    await act(async () => { await pairUntilErrorOrSuccess(screen); });

    await waitFor(() => expect(screen.getByText('Bad key')).toBeTruthy());
    expect(screen.getByText(/The API key was rejected\. Check your API_SERVER_KEY in ~\/\.hermes\/\.env/)).toBeTruthy();
    // KR-5 fail-safe: the rejected key is never persisted
    expect(storeKeySpy).not.toHaveBeenCalled();
    expect(useGatewayStore.getState().gateways).toHaveLength(0);
  });

  it('PF-04 happy path → storeKey persisted + addGateway with label "Hermes v0.21.3"', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 200, json: FULL_CAPS } },
    ]);

    const screen = await renderWithNav(<PairingScreen />);
    await seed(screen);
    const storeKeySpy = jest.spyOn(AuthService, 'storeKey');
    await act(async () => { await pairUntilErrorOrSuccess(screen); });

    expect(storeKeySpy).toHaveBeenCalledWith(GATEWAY_ID, 'sk-test-key');
    await waitFor(() => expect(useGatewayStore.getState().gateways).toHaveLength(1));
    const gateway = useGatewayStore.getState().gateways[0]!;
    expect(gateway.label).toMatch(/Hermes v0\.21\.3/);
    expect(gateway.base_url).toBe('https://gw.example.com:8642');
    expect(gateway.key_ref).toBe(`gw_key_${GATEWAY_ID}`);
  });

  it('PF-05 http URL → unencrypted warning modal; "Pair anyway" proceeds (KR-2)', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 200, json: FULL_CAPS } },
    ]);

    const screen = await renderWithNav(<PairingScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('http://192.168.1.5:8642'), 'http://192.168.1.5:8642');
    await fireEvent.changeText(screen.getByPlaceholderText('API_SERVER_KEY'), 'sk-test-key');
    await fireEvent.press(screen.getByText('Pair Gateway'));

    await waitFor(() => expect(screen.getByText('Unencrypted connection')).toBeTruthy());
    expect(screen.getByText(/Your credentials and chats will travel unencrypted/)).toBeTruthy();
    // modal blocks pairing — nothing hit the wire yet
    expect(calls()).toHaveLength(0);

    await act(async () => { await fireEvent.press(screen.getByText('Pair anyway')); });
    await waitFor(() => expect(useGatewayStore.getState().gateways).toHaveLength(1));
    expect(calls()).toHaveLength(3); // health + probe health + capabilities
  });

  it('PF-05b dismissed http warning persists — second pairing skips the modal (KR-2)', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 200, json: FULL_CAPS } },
    ]);

    const screen = await renderWithNav(<PairingScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('http://192.168.1.5:8642'), 'http://192.168.1.5:8642');
    await fireEvent.changeText(screen.getByPlaceholderText('API_SERVER_KEY'), 'sk-test-key');
    await fireEvent.press(screen.getByText('Pair Gateway'));
    await waitFor(() => expect(screen.getByText('Unencrypted connection')).toBeTruthy());

    // dismiss without proceeding
    await act(async () => { await fireEvent.press(screen.getByText('Edit URL')); });
    expect(screen.queryByText('Unencrypted connection')).toBeNull();
    expect(useGatewayStore.getState().gateways).toHaveLength(0);
    expect(calls()).toHaveLength(0);

    // dismissal was persisted to MMKV, keyed on the URL
    expect(getSetting<string | null>('http_warn_http://192.168.1.5:8642', null))
      .toBe('http://192.168.1.5:8642');

    // second press skips the modal and pairs straight through
    await act(async () => { await fireEvent.press(screen.getByText('Pair Gateway')); });
    expect(screen.queryByText('Unencrypted connection')).toBeNull();
    await waitFor(() => expect(useGatewayStore.getState().gateways).toHaveLength(1));
  });

  it('PF-06 trailing slashes stripped from the paired URL', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 200, json: FULL_CAPS } },
    ]);

    const screen = await renderWithNav(<PairingScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('http://192.168.1.5:8642'), 'https://gw.example.com:8642///');
    await fireEvent.changeText(screen.getByPlaceholderText('API_SERVER_KEY'), 'sk-test-key');
    await act(async () => { await fireEvent.press(screen.getByText('Pair Gateway')); });

    await waitFor(() => expect(useGatewayStore.getState().gateways).toHaveLength(1));
    const gateway = useGatewayStore.getState().gateways[0]!;
    expect(gateway.base_url).toBe('https://gw.example.com:8642');
    // the probe itself hit the stripped URL
    expect(calls()[0]!.url).toBe('https://gw.example.com:8642/v1/health');
    expect(gateway.label).toMatch(/Hermes v0\.21\.3/);
  });

  it('empty URL or key → no-op (no pairing attempted)', async () => {
    createFetchMock([
      { path: '/v1/health', handler: { status: 200, json: { status: 'ok', platform: 'hermes-agent', version: '0.21.3' } } },
      { path: '/v1/capabilities', handler: { status: 200, json: FULL_CAPS } },
    ]);

    const screen = await renderThemeProvider(<PairingScreen />);

    // nothing filled
    await fireEvent.press(screen.getByText('Pair Gateway'));
    // URL filled, key empty
    await fireEvent.changeText(screen.getByPlaceholderText('http://192.168.1.5:8642'), 'https://gw.example.com:8642');
    await fireEvent.press(screen.getByText('Pair Gateway'));

    expect(calls()).toHaveLength(0);
    expect(useGatewayStore.getState().gateways).toHaveLength(0);
    expect(screen.queryByText(/API key was rejected|Unreachable|Gateway down/)).toBeNull();
  });
});
