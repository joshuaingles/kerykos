import { SSEParser } from './sse';
import { GatewayAPI } from './gateway-api';

/**
 * Fallback chat via POST /api/sessions/{id}/chat/stream (SSE).
 * Used when:
 * (a) capabilities probe fails for runs (selectChatTransport → 'session-chat')
 * (b) older gateways (pre-runs)
 * Auto-selected via selectChatTransport() from Phase 1 (KR-3).
 *
 * ⚠️ Wire nuance: the SSE stream rides the POST's response body — there is
 * no separate GET to open. Consume response.body directly via
 * SSEParser.consumeResponse (never re-request the URL).
 *
 * ⚠️ Event schema UNVERIFIED on the wire (smoke tests only exercised runs):
 * event type names below (`message.delta`, `message.complete`) are assumed
 * from the runs surface. Verify actual event names against a live
 * session-chat stream at impl time per §9a before relying on them.
 */
export async function sendChatMessageFallback(
  api: GatewayAPI,
  sessionId: string,
  content: string,
  onDelta: (text: string) => void,
  onComplete: () => void,
  onError: (err: Error) => void,
): Promise<() => void> {
  const sse = new SSEParser();

  // Initial POST — returns the SSE stream in its response body
  let response: Response;
  try {
    response = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/chat/stream`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await api.getResolvedKey()}`,
        'Content-Type': 'application/json',
        // Session continuity headers per api-surface.md
        ...api.sessionHeaders(sessionId),
      },
      body: JSON.stringify({ message: content }),
    });
  } catch (err) {
    onError(err as Error);
    return () => {};
  }

  if (!response.ok) {
    onError(new Error(`Session chat stream failed: ${response.status}`));
    return () => {};
  }

  // Consume the POST's streaming body — do NOT re-fetch the URL
  return sse.consumeResponse(
    response,
    (event) => {
      // ⚠️ Event names assumed from runs — verify on live stream at impl time
      if (event.type === 'message.delta') {
        onDelta(event.delta as string);
      } else if (event.type === 'message.complete') {
        onComplete();
      }
    },
    onError,
    onComplete,
  );
}
