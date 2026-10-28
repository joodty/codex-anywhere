import { useCallback, useEffect, useRef, useState } from 'react';
import { initialModelSettings, modelConfigDraft, resolveModelSettings } from '../../src/shared/model-config';
import { loadEnvironmentValue, storeEnvironmentValue } from './execution-environments';
import { friendlyError } from './app-utils';
import type { BridgeRequest } from './bridge-request-manager';
import type { ModelConfigDraft, ModelOption, SessionModelConfig } from './app-types';

const PREFERENCE_KEY = 'bridge.newSessionModel.v1';
type State = { environmentId: string; config: SessionModelConfig | null; loading: boolean; error: string };

/** A local draft, independent of whichever existing conversation is displayed. */
export function useNewSessionModel({ environmentId, online, active, request }: {
  environmentId: string; online: boolean; active: boolean; request: BridgeRequest;
}) {
  const [state, setState] = useState<State>({ environmentId, config: null, loading: false, error: '' });
  const stateRef = useRef(state); stateRef.current = state;
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!online || !active) return;
    const abort = new AbortController(); let disposed = false;
    setState(previous => ({ environmentId, config: previous.environmentId === environmentId ? previous.config : null, loading: true, error: '' }));
    void request<{ models: ModelOption[] }>('models.list', {}, { signal: abort.signal, timeoutMs: 30_000 }).then(({ models }) => {
      if (disposed) return;
      let preference: unknown;
      try { preference = JSON.parse(loadEnvironmentValue(PREFERENCE_KEY, environmentId) || 'null'); } catch { preference = null; }
      const current = stateRef.current;
      const settings = initialModelSettings(models, current.environmentId === environmentId && current.config ? current.config : preference);
      setState({ environmentId, config: { ...settings, models }, loading: false, error: '' });
    }).catch(error => {
      if (!disposed) setState(previous => ({ environmentId, config: previous.environmentId === environmentId ? previous.config : null, loading: false, error: friendlyError(error) }));
    });
    return () => { disposed = true; abort.abort(); };
  }, [environmentId, online, active, request, attempt]);
  const config = online && state.environmentId === environmentId ? state.config : null;
  const save = useCallback(async (draft: ModelConfigDraft) => {
    const current = stateRef.current;
    if (!online || current.environmentId !== environmentId || !current.config) throw new Error('model_not_available');
    const settings = resolveModelSettings(current.config.models, draft);
    setState({ ...current, config: { ...settings, models: current.config.models }, error: '' });
    storeEnvironmentValue(PREFERENCE_KEY, environmentId, JSON.stringify(modelConfigDraft(settings)));
  }, [environmentId, online]);
  const snapshot = useCallback(() => {
    const current = stateRef.current;
    if (!online || current.environmentId !== environmentId || !current.config) throw new Error('model_not_available');
    return Object.freeze(modelConfigDraft(resolveModelSettings(current.config.models, current.config)));
  }, [environmentId, online]);
  return { config, loading: online && active && (state.environmentId !== environmentId || state.loading),
    error: state.environmentId === environmentId ? state.error : '', refresh, save, snapshot };
}
