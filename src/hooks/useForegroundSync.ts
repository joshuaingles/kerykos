import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

export function useForegroundSync(syncFn: () => Promise<void>) {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appState.current.match(/background|inactive/) && nextState === 'active') {
        syncFn(); // KR-20: incremental sync on foreground
      }
      appState.current = nextState;
    });

    return () => sub.remove();
  }, [syncFn]);
}
