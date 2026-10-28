import { useCallback, useEffect, useRef, useState } from "react";

/** Authoritative reads with route isolation and one coalesced follow-up. */
export function useResource<T>(key: string, revision: string, read: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error?: string }>({ key, loading: true });
  const pending = useRef<AbortController | null>(null);
  const dirty = useRef(false);
  const mounted = useRef(false);
  const loader = useRef(read);
  const currentKey = useRef(key);
  loader.current = read;
  currentKey.current = key;
  const refresh = useCallback(function load() {
    dirty.current = true;
    if (!mounted.current || pending.current) return;
    dirty.current = false;
    const requestedKey = currentKey.current;
    const readNow = loader.current;
    const controller = new AbortController();
    pending.current = controller;
    setState(previous => ({ key: requestedKey, data: previous.key === requestedKey ? previous.data : undefined, loading: true }));
    Promise.resolve().then(() => readNow(controller.signal)).then(data => {
      if (!controller.signal.aborted && pending.current === controller && currentKey.current === requestedKey) setState({ key: requestedKey, data, loading: false });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && pending.current === controller && currentKey.current === requestedKey) {
        setState(previous => ({ ...previous, loading: false, error: cause instanceof Error ? cause.message : "Collector read failed" }));
      }
    }).finally(() => {
      if (pending.current !== controller) return;
      pending.current = null;
      if (mounted.current && dirty.current) load();
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; dirty.current = false; };
  }, [key]);
  useEffect(() => { refresh(); }, [key, revision, refresh]);
  return { data: state.key === key ? state.data : undefined, loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : undefined, refresh };
}
