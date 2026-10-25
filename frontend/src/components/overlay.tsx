"use client";

import { useEffect, useRef, useState } from "react";

import { Icon, IconButton } from "./ui";

/** A slide-over from the right (a bottom sheet on phones). Built on <dialog>, so focus is trapped, Esc closes it
 * and focus goes back to whatever opened it. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start where the person will type, not on the close button.
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label={title}
      className="sheet m-0 ml-auto mt-auto h-[92dvh] max-h-none w-full max-w-none rounded-t-[24px] bg-page p-0 text-ink shadow-lift backdrop:bg-ink/25 backdrop:backdrop-blur-[2px] sm:mt-0 sm:h-dvh sm:w-[480px] sm:rounded-none sm:rounded-l-[24px]"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-4 px-6 pb-2 pt-5">
          <h2 className="text-[19px] font-semibold tracking-[-0.015em]">{title}</h2>
          <IconButton icon="close" label="Close" tip="left" onClick={onClose} />
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-8 pt-2">{open && children}</div>
      </div>
    </dialog>
  );
}

/** A small ⋯ menu for rare actions, so they're there when needed and out of sight otherwise. */
export function Menu({ label = "More", items }: { label?: string; items: { icon: string; label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <IconButton icon="more_horiz" label={label} tip="left" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)} />
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 min-w-[240px] rounded-2xl bg-card p-1.5 shadow-lift ring-1 ring-ink/[0.06]">
          {items.map((i) => (
            <button
              key={i.label}
              role="menuitem"
              autoFocus={i === items[0]}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
              className="flex w-full items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-left text-sm font-medium hover:bg-soft focus:bg-soft focus:outline-none"
            >
              <Icon name={i.icon} className="text-[18px] text-primary" /> {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
