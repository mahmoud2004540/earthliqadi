'use client';

import type { WsServerMessage } from '@platform/shared';
import { useEffect, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface StreamSubscription {
  channel: 'book' | 'trades' | 'ticker' | 'candles' | 'orders';
  market: string;
  interval?: string;
}

/** Same-origin WebSocket through the edge proxy (/api/ws); overridable for local development. */
function streamUrl(): string {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/api/ws`;
}

/**
 * Subscribes to market-data channels and reconnects with exponential backoff
 * (1 s → 30 s). After a reconnect every subscription is re-sent, and the server
 * answers with fresh snapshots, so the client never stitches stale deltas.
 */
export function useMarketStream(
  subscriptions: StreamSubscription[],
  onMessage: (message: WsServerMessage) => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>('connecting');
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);
  const key = JSON.stringify(subscriptions);

  useEffect(() => {
    const subs = JSON.parse(key) as StreamSubscription[];
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = (initial: boolean) => {
      if (!initial) setState('connecting');
      socket = new WebSocket(streamUrl());
      socket.onopen = () => {
        retry = 0;
        setState('open');
        for (const s of subs) socket?.send(JSON.stringify({ op: 'subscribe', ...s }));
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          handler.current(JSON.parse(event.data) as WsServerMessage);
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        setState('closed');
        if (stopped) return;
        const delay = Math.min(30_000, 1000 * 2 ** retry++);
        timer = setTimeout(() => connect(false), delay);
      };
    };
    connect(true);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [key]);

  return state;
}
