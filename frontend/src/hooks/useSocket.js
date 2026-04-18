import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Shared Socket.IO singleton — one connection across the whole app so
 * multiple components can subscribe without opening duplicate sockets.
 */
let sharedSocket = null;
function getSharedSocket() {
  if (sharedSocket && sharedSocket.connected !== false) return sharedSocket;
  if (sharedSocket) return sharedSocket;
  const token = localStorage.getItem("polytrack_token") || "";
  sharedSocket = io({
    auth: { token },
    transports: ["websocket", "polling"],
  });
  return sharedSocket;
}

/**
 * Low-level hook — returns { connected, initData, on, off, emit } around
 * the shared socket. Use when a page needs custom event wiring.
 */
export function useSocket() {
  const socket = getSharedSocket();
  const [connected, setConnected] = useState(socket.connected);
  const [initData, setInitData] = useState(null);
  const listenersRef = useRef(new Map());

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onInit = (data) => setInitData(data);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("init", onInit);
    if (socket.connected) setConnected(true);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("init", onInit);
    };
  }, [socket]);

  function on(event, handler) {
    socket.on(event, handler);
    listenersRef.current.set(`${event}:${handler}`, { event, handler });
  }
  function off(event, handler) {
    socket.off(event, handler);
    listenersRef.current.delete(`${event}:${handler}`);
  }
  function emit(event, data) { socket.emit(event, data); }

  return { connected, initData, on, off, emit, socket };
}

/**
 * High-level hook — auto-invalidates relevant React Query caches on
 * server events so Dashboard/Trades/Risk stay live without polling.
 * Optional extra `handlers` map fires in addition to cache invalidation.
 *
 * Server events: scan:start, scan:wallet, scan:complete, scan:error,
 * wallet:update, markets, signals, trade:executed,
 * auto:status, auto:disabled, market:update, ws:status
 */
export function useLiveCache(handlers = {}) {
  const qc = useQueryClient();
  const socket = getSharedSocket();

  useEffect(() => {
    const defaults = {
      "wallet:update":  () => qc.invalidateQueries({ queryKey: ["wallets"] }),
      "signals":        () => qc.invalidateQueries({ queryKey: ["signals"] }),
      "markets":        () => qc.invalidateQueries({ queryKey: ["markets"] }),
      "trade:executed": () => {
        qc.invalidateQueries({ queryKey: ["trades"] });
        qc.invalidateQueries({ queryKey: ["health"] });
      },
      "scan:start":     () => qc.invalidateQueries({ queryKey: ["health"] }),
      "scan:complete":  () => {
        qc.invalidateQueries({ queryKey: ["health"] });
        qc.invalidateQueries({ queryKey: ["signals"] });
        qc.invalidateQueries({ queryKey: ["wallets"] });
      },
      "scan:error":     () => qc.invalidateQueries({ queryKey: ["health"] }),
      "auto:status":    () => qc.invalidateQueries({ queryKey: ["health"] }),
      "auto:disabled":  () => qc.invalidateQueries({ queryKey: ["health"] }),
    };

    const bound = [];
    const allEvents = new Set([...Object.keys(defaults), ...Object.keys(handlers)]);
    for (const event of allEvents) {
      const listener = (payload) => {
        defaults[event]?.(payload);
        handlers[event]?.(payload);
      };
      socket.on(event, listener);
      bound.push([event, listener]);
    }
    return () => {
      for (const [event, listener] of bound) socket.off(event, listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return socket;
}
