import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';

export function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** Scope reads and writes together so switching chats never overwrites another draft. */
export function useComposerDraft(scope: string) {
  const key = 'personal.draft.' + scope;
  const [state, setState] = useState(() => ({ key, text: readLocal(key, ''), saved: true }));
  const current = useRef(state); current.current = state;
  const text = state.key === key ? state.text : readLocal<string>(key, '');
  const setText = useCallback((value: SetStateAction<string>) => {
    const previous = current.current.key === key ? current.current.text : readLocal<string>(key, '');
    const next = typeof value === 'function' ? value(previous) : value;
    const saved = writeLocal(key, next); current.current = { key, text: next, saved }; setState(current.current);
  }, [key]);
  useEffect(() => { const restore = (event?: StorageEvent) => { if (event && event.key !== key && event.key !== null) return; const next = { key, text: readLocal<string>(key, ''), saved: true }; current.current = next; setState(next); };
    restore(); window.addEventListener('storage', restore); return () => window.removeEventListener('storage', restore);
  }, [key]);
  return [text, setText, state.key !== key || state.saved] as const;
}
