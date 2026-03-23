import { useEffect, useReducer, useRef, useState, useCallback } from 'react';
import { getToken } from './auth';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4001';

export interface BattleEvent {
  type: string;
  timestamp: string;
  challengeId?: string;
  [key: string]: unknown;
}

interface WSState {
  connected: boolean;
  viewerCount: number;
  events: BattleEvent[];
}

type WSAction =
  | { type: 'CONNECTED'; viewerCount: number }
  | { type: 'DISCONNECTED' }
  | { type: 'EVENT'; event: BattleEvent }
  | { type: 'VIEWER_COUNT'; count: number };

function wsReducer(state: WSState, action: WSAction): WSState {
  switch (action.type) {
    case 'CONNECTED':
      return { ...state, connected: true, viewerCount: action.viewerCount };
    case 'DISCONNECTED':
      return { ...state, connected: false };
    case 'EVENT':
      return { ...state, events: [...state.events, action.event] };
    case 'VIEWER_COUNT':
      return { ...state, viewerCount: action.count };
    default:
      return state;
  }
}

export function useWebSocket(challengeId: string | undefined) {
  const [state, dispatch] = useReducer(wsReducer, {
    connected: false,
    viewerCount: 0,
    events: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const maxRetries = 5;

  const connect = useCallback(() => {
    if (!challengeId) return;

    const token = getToken();
    if (!token) return;

    const ws = new WebSocket(`${WS_URL}?token=${token}&challengeId=${challengeId}`);
    wsRef.current = ws;

    ws.onopen = () => {
      retriesRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as BattleEvent;

        switch (data.type) {
          case 'CONNECTED':
            dispatch({ type: 'CONNECTED', viewerCount: (data.viewerCount as number) || 0 });
            break;
          case 'VIEWER_COUNT':
            dispatch({ type: 'VIEWER_COUNT', count: (data.count as number) || 0 });
            break;
          default:
            dispatch({ type: 'EVENT', event: data });
            break;
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      dispatch({ type: 'DISCONNECTED' });
      wsRef.current = null;

      // Reconnect with exponential backoff
      if (retriesRef.current < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retriesRef.current), 30000);
        retriesRef.current++;
        setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [challengeId]);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return state;
}
