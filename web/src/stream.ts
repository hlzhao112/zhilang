import { useEffect, useRef } from 'react';
import type { StreamMessage } from './types';

export function useProjectStream(id: string | undefined, onMessage: (message: StreamMessage) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(() => {
    if (!id) return;
    const source = new EventSource(`/api/projects/${id}/stream`);
    const listen = (event: Event) => {
      try {
        handler.current(JSON.parse((event as MessageEvent).data) as StreamMessage);
      } catch {
        /* 忽略不完整的推送帧 */
      }
    };
    source.addEventListener('update', listen);
    return () => source.close();
  }, [id]);
}
