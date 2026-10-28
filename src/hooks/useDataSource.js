import { useEffect, useState } from 'react';
import { getDataSource } from '../services/experienceService.js';

/** 'api' (Node server, editable), 'static' (static host, read-only) or null while checking. */
export function useDataSource() {
  const [source, setSource] = useState(null);
  useEffect(() => {
    let alive = true;
    getDataSource().then((s) => alive && setSource(s));
    return () => {
      alive = false;
    };
  }, []);
  return source;
}
