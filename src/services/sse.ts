export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

export type SSEEventHandler = (event: SSEEvent) => void;
export type SSEErrorHandler = (error: Error) => void;
export type SSECloseHandler = () => void;

/**
 * SSE stream consumer (KR-18). The Hermes API server emits `:` comment lines
 * as keepalive every 10s — the parser must skip them.
 *
 * Supports both surfaces:
 * - GET /v1/runs/{id}/events (via connect())
 * - The response BODY of POST /api/sessions/{id}/chat/stream (via
 *   consumeResponse()) — the fallback's SSE stream rides the POST's response
 *   body, so the URL is never re-requested.
 */
export class SSEParser {
  private abortController: AbortController | null = null;

  /**
   * Connect to an SSE endpoint and stream events.
   * Skips ':' comment lines (keepalive, KR-18).
   * Returns a disconnection function.
   */
  async connect(
    url: string,
    headers: Record<string, string>,
    onEvent: SSEEventHandler,
    onError: SSEErrorHandler,
    onClose: SSECloseHandler,
  ): Promise<() => void> {
    this.abortController = new AbortController();

    try {
      const response = await fetch(url, {
        headers: { ...headers, 'Accept': 'text/event-stream' },
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      return this.consumeResponse(response, onEvent, onError, onClose);
    } catch (err) {
      // Ignore aborts triggered by our own disconnect()
      if ((err as Error).name !== 'AbortError') {
        onError(err as Error);
      }
      return () => {};
    }
  }

  /**
   * Consume an already-open streaming Response — GET /v1/runs/{id}/events,
   * OR the body of a POST /api/sessions/{id}/chat/stream response:
   * the SSE stream rides that POST's response body, so never re-request the URL.
   */
  consumeResponse(
    response: Response,
    onEvent: SSEEventHandler,
    onError: SSEErrorHandler,
    onClose: SSECloseHandler,
  ): () => void {
    const reader = response.body?.getReader?.();
    if (!reader) {
      onError(new Error('No response body'));
      return () => {};
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let settled = false;
    let disconnected = false;

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? ''; // keep incomplete line

          for (const line of lines) {
            // Skip empty lines and keepalive comments (KR-18)
            if (!line.trim() || line.startsWith(':')) continue;

            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6);
              try {
                const event = JSON.parse(jsonStr) as SSEEvent;
                onEvent(event);
              } catch {
                // Non-JSON data line — skip
              }
            }
          }
        }
        if (!settled) {
          settled = true;
          onClose();
        }
      } catch (err) {
        if (!settled && (err as Error).name !== 'AbortError' && !disconnected) {
          settled = true;
          onError(err as Error);
        }
      }
    };

    read();

    return () => {
      settled = true;
      disconnected = true;
      this.abortController?.abort();
      void reader.cancel().catch(() => {});
    };
  }

  disconnect() {
    this.abortController?.abort();
  }
}
