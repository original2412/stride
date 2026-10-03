import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList = []) {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const data = await fnRef.current();
      setState({ data, error: undefined, loading: false });
      return data;
    } catch (e) {
      setState((s) => ({ ...s, error: e as Error, loading: false }));
      return undefined;
    }
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), deps);

  const setData = useCallback((data: T) => setState({ data, error: undefined, loading: false }), []);

  return { ...state, reload, setData };
}
