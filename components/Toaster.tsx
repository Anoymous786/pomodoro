"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { TOAST_EVENT_NAME, ToastPayload, ToastKind } from "@/lib/toast";

const KIND_STYLES: Record<
  ToastKind,
  { border: string; icon: React.ReactNode }
> = {
  success: {
    border: "border-emerald-300 dark:border-emerald-700",
    icon: <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />,
  },
  error: {
    border: "border-red-300 dark:border-red-700",
    icon: <TriangleAlert className="h-5 w-5 text-red-600 dark:text-red-400" />,
  },
  info: {
    border: "border-sky-300 dark:border-sky-700",
    icon: <Info className="h-5 w-5 text-sky-600 dark:text-sky-400" />,
  },
};

/**
 * Renders toasts dispatched via showToast() from anywhere in the app.
 * Mounted once in the root layout. Errors are never silent anymore.
 */
export default function Toaster() {
  const [toasts, setToasts] = useState<ToastPayload[]>([]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail) return;
      setToasts((prev) => [...prev, detail]);
      // Auto-dismiss after 6s.
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== detail.id));
      }, 6000);
    };
    window.addEventListener(TOAST_EVENT_NAME, handler);
    return () => window.removeEventListener(TOAST_EVENT_NAME, handler);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((t) => {
        const style = KIND_STYLES[t.kind] ?? KIND_STYLES.info;
        return (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`animate-pop-in pointer-events-auto flex items-start gap-2 rounded-xl border ${style.border} bg-white p-3 shadow-lg dark:bg-gray-800`}
          >
            <span className="mt-0.5 shrink-0">{style.icon}</span>
            <p className="flex-1 text-sm text-gray-800 dark:text-gray-100">
              {t.message}
            </p>
            <button
              onClick={() =>
                setToasts((prev) => prev.filter((x) => x.id !== t.id))
              }
              aria-label="Dismiss notification"
              className="shrink-0 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
