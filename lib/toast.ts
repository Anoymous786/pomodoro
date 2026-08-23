"use client";

/**
 * Tiny dependency-free toast bus.
 *
 * Any component can call `showToast("...", "error")` and the single
 * <Toaster /> mounted in the root layout will render it. Uses a CustomEvent
 * so no context/provider plumbing is needed across the tree.
 */

export type ToastKind = "success" | "error" | "info";

export interface ToastPayload {
  id: number;
  message: string;
  kind: ToastKind;
}

const TOAST_EVENT = "pomodoro:toast";

let counter = 0;

export function showToast(message: string, kind: ToastKind = "info"): void {
  if (typeof window === "undefined") return;
  const payload: ToastPayload = {
    id: ++counter,
    message,
    kind,
  };
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

export const TOAST_EVENT_NAME = TOAST_EVENT;
