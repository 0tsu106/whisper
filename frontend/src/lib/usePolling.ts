import { useEffect, useRef } from "react";

// タブが非表示の間は実行しない
export function usePolling(callback: () => void, intervalMs: number, enabled: boolean): void {
  const latest = useRef(callback);
  latest.current = callback;

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) latest.current();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
}
