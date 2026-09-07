import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Filter } from 'lucide-react';

const POPOVER_WIDTH = 288; // matches w-72
const VIEWPORT_MARGIN = 16;

export default function FilterButton({
  label = 'Filter',
  activeCount = 0,
  children,
}: {
  label?: string;
  activeCount?: number;
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
      );
      setPosition({ top: rect.bottom + 8, left });
    };
    updatePosition();

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Filter className="h-4 w-4 text-ink/50" aria-hidden="true" />
        {label}
        {activeCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-white">
            {activeCount}
          </span>
        )}
      </button>

      {/*
       * Portaled to document.body rather than positioned relative to the
       * trigger. Some triggers sit inside an `isolation: isolate` wrapper
       * (the live map) — a stacking context traps z-index, so no z-index
       * value on an absolutely-positioned child could ever escape it. A
       * portal renders outside that subtree entirely, positioned in fixed
       * coordinates against the trigger's own bounding rect instead.
       */}
      {open &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`${label} options`}
            className="fixed z-[1200] w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
            style={{ top: position.top, left: position.left }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
