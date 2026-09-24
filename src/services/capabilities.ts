import type { CapabilitiesResponse, GatewayAPI, HealthResponse } from './gateway-api';
import { getSetting, setSetting } from './storage';

export interface GatewayCapabilities {
  runsSupported: boolean;       // run_submission + run_status + run_events_sse
  sessionChatSupported: boolean; // session_chat + session_chat_streaming
  approvalsSupported: boolean;   // run_approval_response
  steerStopSupported: boolean;   // run_steer + run_stop
  skillsApiSupported: boolean;   // skills_api (wire-verified: currently 500s upstream)
  modelOptionsSupported: boolean; // model_options
  version: string;               // from healthCheck
}

export function parseCapabilities(resp: CapabilitiesResponse, version: string): GatewayCapabilities {
  return {
    runsSupported: resp.run_submission && resp.run_status && resp.run_events_sse,
    sessionChatSupported: resp.session_chat && resp.session_chat_streaming,
    approvalsSupported: resp.run_approval_response,
    steerStopSupported: resp.run_steer && resp.run_stop,
    skillsApiSupported: resp.skills_api,
    modelOptionsSupported: resp.model_options,
    version,
  };
}

/** Which chat transport to use (KR-3). */
export function selectChatTransport(caps: GatewayCapabilities): 'runs' | 'session-chat' {
  return caps.runsSupported ? 'runs' : 'session-chat';
}

/** Load the cached capabilities for a gateway (set during pairing / re-probe). */
export function loadCapabilities(gatewayId: string): GatewayCapabilities | null {
  return getSetting<GatewayCapabilities | null>(`caps_${gatewayId}`, null);
}

/** Cache the parsed capabilities for a gateway (KR-3). */
export function cacheCapabilities(gatewayId: string, caps: GatewayCapabilities): void {
  setSetting(`caps_${gatewayId}`, caps);
}

/**
 * Full probe: health → capabilities → parse → cache.
 * Used at pairing and re-probed on app foreground (NFR-4).
 * Returns the parsed capabilities plus the health response's version.
 */
export async function probeAndCache(api: GatewayAPI): Promise<{
  caps: GatewayCapabilities;
  health: HealthResponse;
}> {
  const health = await api.healthCheck();
  const raw = await api.capabilities();
  const caps = parseCapabilities(raw, health.version);
  cacheCapabilities(api.gatewayId, caps);
  return { caps, health };
}
