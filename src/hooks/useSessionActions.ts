import { useCallback } from 'react';
import { useSessionsStore } from '@/store/sessions';
import type { GatewayAPI } from '@/services/gateway-api';

export type SessionActionsApi = Pick<
  GatewayAPI,
  'createSession' | 'renameSession' | 'deleteSession' | 'forkSession'
>;

/**
 * Sessions CRUD (KR-7). The api comes from the composition root
 * (useGatewayAPISafe) — never constructed inline (NFR-6). Null api (unpaired
 * / unknown gateway) surfaces as a thrown error on action invocation, exactly
 * like the previous store-helper path.
 */
export function useSessionActions(gatewayId: string, api: SessionActionsApi | null) {
  const { upsertSessions, removeSession, updateWatermark } = useSessionsStore();

  const requireApi = useCallback((): SessionActionsApi => {
    if (!api) throw new Error(`Gateway ${gatewayId} not found`);
    return api;
  }, [api, gatewayId]);

  const createSession = useCallback(async (title?: string) => {
    const session = await requireApi().createSession(title);
    upsertSessions([session]);
    updateWatermark(session.last_active);
    return session;
  }, [requireApi, upsertSessions, updateWatermark]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    // Optimistic update: update local immediately, reconcile on next sync
    const existing = useSessionsStore.getState().getSessionById(sessionId);
    if (existing) {
      upsertSessions([{ ...existing, title }]);
    }
    await requireApi().renameSession(sessionId, title);
  }, [requireApi, upsertSessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await requireApi().deleteSession(sessionId);
    removeSession(sessionId);
  }, [requireApi, removeSession]);

  const forkSession = useCallback(async (sessionId: string) => {
    const forked = await requireApi().forkSession(sessionId);
    upsertSessions([forked]);
    updateWatermark(forked.last_active);
    return forked;
  }, [requireApi, upsertSessions, updateWatermark]);

  return { createSession, renameSession, deleteSession, forkSession };
}
