import { useCallback } from 'react';
import { apiForGateway } from '@/store/gateway';
import { useSessionsStore } from '@/store/sessions';
import type { GatewayAPI } from '@/services/gateway-api';

export type SessionActionsApi = Pick<
  GatewayAPI,
  'createSession' | 'renameSession' | 'deleteSession' | 'forkSession'
>;

export function useSessionActions(gatewayId: string) {
  const { upsertSessions, removeSession, updateWatermark } = useSessionsStore();

  const createSession = useCallback(async (title?: string) => {
    const api = apiForGateway(gatewayId);
    if (!api) throw new Error(`Gateway ${gatewayId} not found`);
    const session = await api.createSession(title);
    upsertSessions([session]);
    updateWatermark(session.last_active);
    return session;
  }, [gatewayId, upsertSessions, updateWatermark]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const api = apiForGateway(gatewayId);
    if (!api) throw new Error(`Gateway ${gatewayId} not found`);
    // Optimistic update: update local immediately, reconcile on next sync
    const existing = useSessionsStore.getState().getSessionById(sessionId);
    if (existing) {
      upsertSessions([{ ...existing, title }]);
    }
    await api.renameSession(sessionId, title);
  }, [gatewayId, upsertSessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const api = apiForGateway(gatewayId);
    if (!api) throw new Error(`Gateway ${gatewayId} not found`);
    await api.deleteSession(sessionId);
    removeSession(sessionId);
  }, [gatewayId, removeSession]);

  const forkSession = useCallback(async (sessionId: string) => {
    const api = apiForGateway(gatewayId);
    if (!api) throw new Error(`Gateway ${gatewayId} not found`);
    const forked = await api.forkSession(sessionId);
    upsertSessions([forked]);
    updateWatermark(forked.last_active);
    return forked;
  }, [gatewayId, upsertSessions, updateWatermark]);

  return { createSession, renameSession, deleteSession, forkSession };
}
