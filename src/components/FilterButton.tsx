import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X } from 'lucide-react';
import { useAnchoredPopoverPosition } from '../hooks/useAnchoredPopoverPosition';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';

const POPOVER_WIDTH = 288; // matches w-72
const SM_BREAKPOINT = 640; // Tailwind's `sm`

export default function FilterButton({
  label = 'Filter',
  activeCount = 0,
  variant = 'default',
  children,
}: {
  label?: string;
  activeCount?: number;
  /** 'inverted' for use on the brand-green header bar; the popover itself is unaffected. */
  variant?: 'default' | 'inverted';
  children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [isSheet, setIsSheet] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Below sm: a full-width bottom sheet, own scroll, no position math
  // needed. From sm up: a popover clamped to the viewport (see the shared
  // hook below) — flipped above the trigger when there isn't room below,
  // with its own max-height and internal scroll so it's never taller than
  // the screen it's on.
  useEffect(() => {
    if (!open) return undefined;

    const mql = window.matchMedia(`(min-width: ${SM_BREAKPOINT}px)`);
    const updateIsSheet = () => setIsSheet(!mql.matches);
    updateIsSheet();

    mql.addEventListener('change', updateIsSheet);
    return () => mql.removeEventListener('change', updateIsSheet);
  }, [open]);

  const position = useAnchoredPopoverPosition({
    open: open && !isSheet,
    triggerRef: buttonRef,
    width: POPOVER_WIDTH,
    align: 'left',
  });

  // Native iOS build only: closing can leave the WKWebView's outer scroll
  // view offset sideways even though this popover animated back within
  // bounds — see resetDocumentScroll for why. Force it back on every close.
  useEffect(() => {
    if (!open) resetDocumentScroll();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          // Set synchronously so the very first paint already picks the
          // right layout, rather than flashing a popover before the
          // effect above corrects it to a sheet (or vice versa).
          setIsSheet(!window.matchMedia(`(min-width: ${SM_BREAKPOINT}px)`).matches);
          setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        aria-haspopup="true"
        className={`relative inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 ${
          variant === 'inverted'
            ? 'border-white/20 bg-white/10 text-white hover:bg-white/20 focus-visible:outline-white'
            : 'border-border bg-surface text-ink hover:bg-bg focus-visible:outline-primary'
        }`}
      >
        <Filter className={`h-4 w-4 ${variant === 'inverted' ? 'text-white/70' : 'text-ink/50'}`} aria-hidden="true" />
        {label}
        {activeCount > 0 && (
          <span
            className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold ${
              variant === 'inverted' ? 'bg-white text-primary' : 'bg-primary text-white'
            }`}
          >
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
        isSheet &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[1199] bg-black/40"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={`${label} options`}
              className="fixed inset-x-0 bottom-0 z-[1200] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border-t border-border bg-surface shadow-lg"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">{label}</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-ink/50 hover:bg-bg hover:text-ink"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div className="space-y-3 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3">
                {children}
              </div>
            </div>
          </>,
          document.body
        )}

      {open &&
        !isSheet &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={`${label} options`}
            className="fixed z-[1200] w-72 max-w-[calc(100dvw-2rem)] space-y-3 overflow-y-auto rounded-lg border border-border bg-surface p-3 shadow-lg"
            style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
}
