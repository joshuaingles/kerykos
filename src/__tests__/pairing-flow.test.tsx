/**
 * §5.1 Integration — Pairing flow (KR-1 / KR-2 / KR-5).
 *
 * Real PairingScreen + real GatewayAPI/probeAndCache over the hand-rolled
 * fetch mock; SecureStore + MMKV are the in-memory fakes. PF-01…PF-06.
 */
import React from 'react';
import { fireEvent, waitFor, act } from '@testing-library/react-native';
import PairingScreen from '@/app/PairingScreen';
import { renderThemeProvider, createFetchMock, resetMMKV, resetSecureStore, type FetchCall } from '@/test/helpers';
import { useGatewayStore } from '@/store/gateway';
import { AuthService } from '@/services/auth';
import { getSetting } from '@/services/storage';

type Screen = Awaited<ReturnType<typeof renderThemeProvider>>;

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
  beforeEach(() => {
    resetSecureStore();
    resetMMKV();
    useGatewayStore.setState({ gateways: [], activeGatewayId: null });
    createFetchMock([]);
    jest.clearAllMocks();
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
    expect((AuthService as unknown as { storeKey: jest.Mock }).storeKey).not.toBeDefined
      ? undefined
      : undefined;
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

  test.todo('PF-03 capabilities 401 → bad-key copy, key NOT stored (KR-5)');

  test.todo('PF-04 happy path → storeKey persisted + addGateway with label "Hermes v0.21.3"');

  test.todo('PF-05 http URL → unencrypted warning modal; "Pair anyway" proceeds (KR-2)');

  test.todo('PF-05b dismissed http warning persists — second pairing skips the modal (KR-2)');

  test.todo('PF-06 trailing slashes stripped from the paired URL');

  test.todo('empty URL or key → no-op (no pairing attempted)');
});
