import { useEffect, useRef } from "react";
import clsx from "clsx";

export default function ConfirmDialog({ open, title, children, confirmLabel = "Confirm", danger = false, onConfirm, onCancel, loading = false }) {
  const dialogRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (open) {
      confirmRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    function handleKey(e) {
      if (e.key === "Escape" && open) onCancel?.();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-sm rounded-lg border border-surface-700 bg-surface-800 p-5 shadow-2xl animate-slide-in"
      >
        <h3 id="confirm-dialog-title" className="font-display text-sm font-bold uppercase tracking-wider text-surface-100">
          {title}
        </h3>
        <div className="mt-3 text-sm text-surface-300 leading-relaxed">
          {children}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="btn-ghost"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={loading}
            className={clsx(danger ? "btn-danger" : "btn-primary")}
          >
            {loading ? "Processing…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
