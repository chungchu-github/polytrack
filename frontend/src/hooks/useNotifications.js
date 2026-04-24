import { useEffect, useRef, useCallback } from "react";

export function useNotifications() {
  const permissionRef = useRef(typeof Notification !== "undefined" ? Notification.permission : "denied");

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return "denied";
    if (Notification.permission === "granted") {
      permissionRef.current = "granted";
      return "granted";
    }
    if (Notification.permission === "denied") return "denied";
    const result = await Notification.requestPermission();
    permissionRef.current = result;
    return result;
  }, []);

  const notify = useCallback((title, options = {}) => {
    if (permissionRef.current !== "granted") return null;
    if (typeof Notification === "undefined") return null;

    return new Notification(title, {
      icon: "/polytrack-icon.png",
      badge: "/polytrack-icon.png",
      tag: options.tag || "polytrack",
      ...options,
    });
  }, []);

  return { permission: permissionRef.current, requestPermission, notify };
}

export function useSignalNotifications(signals, { enabled = true } = {}) {
  const notifiedRef = useRef(new Set());
  const { notify, requestPermission } = useNotifications();

  useEffect(() => {
    if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
      requestPermission();
    }
  }, [enabled, requestPermission]);

  useEffect(() => {
    if (!enabled || !signals?.length) return;

    for (const sig of signals) {
      const key = `${sig.conditionId}-${sig.direction}`;
      if (sig.status === "NEW" && !notifiedRef.current.has(key)) {
        notifiedRef.current.add(key);
        notify(`New Signal: ${sig.direction}`, {
          body: `${sig.title}\n${sig.walletCount} wallets · strength ${sig.strength}`,
          tag: key,
        });
      }
    }
  }, [signals, enabled, notify]);
}
