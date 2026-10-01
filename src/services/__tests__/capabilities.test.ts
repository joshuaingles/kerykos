import {
  parseCapabilities,
  selectChatTransport,
  cacheCapabilities,
  loadCapabilities,
  type GatewayCapabilities,
} from '../capabilities';
import type { CapabilitiesResponse } from '../gateway-api';
import { resetMMKV } from '@/test/helpers';

function caps(overrides: Partial<CapabilitiesResponse> = {}): CapabilitiesResponse {
  return {
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
    ...overrides,
  };
}

describe('parseCapabilities (§2.2 — capability matrix rules)', () => {
  it('full caps → all supported', () => {
    const result = parseCapabilities(caps(), '0.21.3');
    expect(result).toEqual({
      runsSupported: true,
      sessionChatSupported: true,
      approvalsSupported: true,
      steerStopSupported: true,
      skillsApiSupported: true,
      modelOptionsSupported: true,
      version: '0.21.3',
    });
  });

  it('runsSupported requires all three flags (run_submission + run_status + run_events_sse)', () => {
    expect(parseCapabilities(caps({ run_events_sse: false }), 'v').runsSupported).toBe(false);
    expect(parseCapabilities(caps({ run_status: false }), 'v').runsSupported).toBe(false);
    expect(parseCapabilities(caps({ run_submission: false }), 'v').runsSupported).toBe(false);
  });

  it('steerStop requires BOTH run_steer and run_stop', () => {
    expect(parseCapabilities(caps({ run_steer: false }), 'v').steerStopSupported).toBe(false);
    expect(parseCapabilities(caps({ run_stop: false }), 'v').steerStopSupported).toBe(false);
  });

  it('sessionChatSupported requires BOTH session_chat and session_chat_streaming', () => {
    expect(parseCapabilities(caps({ session_chat: false }), 'v').sessionChatSupported).toBe(false);
    expect(parseCapabilities(caps({ session_chat_streaming: false }), 'v').sessionChatSupported).toBe(false);
  });

  it('keeps version alongside the matrix', () => {
    expect(parseCapabilities(caps({ model_options: false }), '9.9.9').version).toBe('9.9.9');
    expect(parseCapabilities(caps({ model_options: false }), '9.9.9').modelOptionsSupported).toBe(false);
  });
});

describe('selectChatTransport (§2.2 — KR-3)', () => {
  it('transport: runs when runsSupported', () => {
    expect(selectChatTransport(parseCapabilities(caps(), 'v'))).toBe('runs');
  });

  it('transport: session-chat fallback for old gateway (runsSupported false)', () => {
    const oldGateway = parseCapabilities(caps({ run_events_sse: false }), '0.20.0');
    expect(oldGateway.runsSupported).toBe(false);
    expect(selectChatTransport(oldGateway)).toBe('session-chat');
  });
});

describe('cacheCapabilities / loadCapabilities (§2.2 — MMKV roundtrip)', () => {
  beforeEach(() => {
    resetMMKV();
  });

  it('roundtrips parsed capabilities through the settings store, isolated per gateway', () => {
    const capsA = parseCapabilities(caps(), '0.21.3');
    const capsB = parseCapabilities(caps({ run_events_sse: false }), '0.20.0');

    cacheCapabilities('gw-a', capsA);
    cacheCapabilities('gw-b', capsB);

    expect(loadCapabilities('gw-a')).toEqual(capsA);
    expect(loadCapabilities('gw-b')).toEqual(capsB);
  });

  it('unknown gateway → null', () => {
    expect(loadCapabilities('gw-unknown')).toBeNull();
  });

  it('parses a stored caps object shape (version field survives JSON roundtrip)', () => {
    const capsA: GatewayCapabilities = {
      runsSupported: true,
      sessionChatSupported: false,
      approvalsSupported: true,
      steerStopSupported: false,
      skillsApiSupported: false,
      modelOptionsSupported: true,
      version: '0.21.3',
    };
    cacheCapabilities('gw-c', capsA);
    const loaded = loadCapabilities('gw-c');
    expect(loaded?.runsSupported).toBe(true);
    expect(loaded?.sessionChatSupported).toBe(false);
  });
});
