import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlashList } from '@shopify/flash-list';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '@/theme/ThemeProvider';
import { useGatewayStore } from '@/store/gateway';
import { useSessionsStore } from '@/store/sessions';
import type { SessionRow as SessionRowType } from '@/store/sessions';
import { SessionSyncEngine } from '@/services/session-sync';
import { useSessionActions } from '@/hooks/useSessionActions';
import { useForegroundSync } from '@/hooks/useForegroundSync';
import { SessionRow } from '@/components/SessionRow';
import type { RootStackParamList } from './navigation';

type SessionsNav = NativeStackNavigationProp<RootStackParamList>;

export default function SessionsScreen() {
  const { tokens } = useTheme();
  const navigation = useNavigation<SessionsNav>();
  const activeGatewayId = useGatewayStore((s) => s.activeGatewayId);
  const { loading, error, showArchived, setShowArchived, getVisibleSessions, upsertSessions, setLoading, setError, updateWatermark, lastSyncWatermark } =
    useSessionsStore();

  const api = useMemo(
    () => (activeGatewayId ? useGatewayStore.getState().gateways.find((g) => g.id === activeGatewayId) : null),
    [activeGatewayId],
  );

  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const sessions = getVisibleSessions();

  const runSync = useCallback(async () => {
    if (!api || !activeGatewayId) return;
    const { GatewayAPI } = await import('@/services/gateway-api');
    const client = new GatewayAPI(api.base_url, activeGatewayId);
    const engine = new SessionSyncEngine(client);
    setLoading(true);
    setError(null);
    try {
      const maxLastActive = (s: { last_active: number }) => s.last_active;
      if (!initialSyncDone) {
        const total = await engine.fullSync((batch) => upsertSessions(batch));
        void total;
        setInitialSyncDone(true);
      } else {
        await engine.incrementalSync(lastSyncWatermark, (batch) => upsertSessions(batch));
      }
      const all = useSessionsStore.getState();
      const newest = Array.from(all.sessions.values()).reduce(
        (acc, s) => Math.max(acc, maxLastActive(s)),
        all.lastSyncWatermark,
      );
      updateWatermark(newest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api, activeGatewayId, initialSyncDone, lastSyncWatermark, setLoading, setError, upsertSessions, updateWatermark]);

  useEffect(() => {
    // Defer so effect body doesn't trigger cascading renders (lint).
    queueMicrotask(() => void runSync());
    // Full sync once per gateway on first mount; foreground incremental sync
    // is handled by useForegroundSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGatewayId]);

  // KR-20: background → foreground triggers incremental sync.
  useForegroundSync(
    useCallback(
      () => (initialSyncDone ? runSync() : Promise.resolve()),
      [initialSyncDone, runSync],
    ),
  );

  const { createSession, renameSession, deleteSession, forkSession } = useSessionActions(activeGatewayId ?? '');

  const openChat = useCallback(
    (session: SessionRowType) => {
      if (!activeGatewayId) return;
      navigation.navigate('Chat', { sessionId: session.id, gatewayId: activeGatewayId });
    },
    [navigation, activeGatewayId],
  );

  const confirmDelete = useCallback(
    (session: SessionRowType) => {
      Alert.alert('Delete this session?', `"${session.title}" will be permanently removed.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void deleteSession(session.id),
        },
      ]);
    },
    [deleteSession],
  );

  const promptRename = useCallback(
    (session: SessionRowType) => {
      Alert.prompt(
        'Rename session',
        undefined,
        (text) => {
          if (text) void renameSession(session.id, text);
        },
        'plain-text',
        session.title,
      );
    },
    [renameSession],
  );

  const showContextMenu = useCallback(
    (session: SessionRowType) => {
      Alert.alert(session.title, undefined, [
        { text: 'Rename (KR-7)', onPress: () => promptRename(session) },
        {
          text: 'Fork (KR-7)',
          onPress: () => {
            void forkSession(session.id);
          },
        },
        { text: 'Delete (KR-7)', style: 'destructive', onPress: () => confirmDelete(session) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [promptRename, forkSession, confirmDelete],
  );

  const newSession = useCallback(() => {
    void createSession();
  }, [createSession]);

  const renderItem = useCallback(
    ({ item }: { item: SessionRowType }) => (
      <SessionRow session={item} onPress={openChat} onLongPress={showContextMenu} />
    ),
    [openChat, showContextMenu],
  );

  const keyExtractor = useCallback((s: SessionRowType) => s.id, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: tokens.background }]} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: tokens.border }]}>
        <Text style={[styles.title, { color: tokens.text }]}>Sessions</Text>
        <View style={styles.headerActions}>
          <Text
            onPress={() => setShowArchived(!showArchived)}
            style={[styles.filterToggle, { color: showArchived ? tokens.accent : tokens.muted }]}
            suppressHighlighting
          >
            {showArchived ? 'Archived: on' : 'Archived: off'}
          </Text>
          <Text onPress={newSession} style={[styles.filterToggle, { color: tokens.accent }]} suppressHighlighting>
            + New
          </Text>
        </View>
      </View>
      {error ? (
        <Text style={[styles.error, { color: tokens.error }]}>{error}</Text>
      ) : null}
      <FlashList
        data={sessions}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        onRefresh={runSync}
        refreshing={loading}
        ListEmptyComponent={
          loading ? null : (
            <Text style={[styles.empty, { color: tokens.muted }]}>No sessions yet.</Text>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 16,
  },
  filterToggle: {
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 12,
  },
  empty: {
    textAlign: 'center',
    marginTop: 32,
    fontSize: 13,
  },
});
