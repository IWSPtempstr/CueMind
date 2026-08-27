"use client";

// Center-screen drawer hosting the post-meeting follow-up chat.
// Reuses the SettingsModal overlay interaction: backdrop click + Escape to dismiss.

import { useEffect, type ReactElement, type ReactNode } from "react";

interface ChatPanelDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
}

export default function ChatPanelDrawer({ isOpen, onClose, children }: ChatPanelDrawerProps): ReactElement | null {
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="会后追问"
        className="flex h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-neutral-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-medium text-neutral-100">会后追问</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭会后追问"
            className="rounded-md border border-transparent px-2 py-1 text-neutral-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
      </div>
    </div>
  );
}
