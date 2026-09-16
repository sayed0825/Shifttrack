import { useEffect, useState, type RefObject } from 'react';

export interface AnchoredPosition {
  top: number;
  left: number;
  maxHeight: number;
}

interface UseAnchoredPopoverPositionOptions {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  /** Popover width in px — must match the rendered element's own width. */
  width: number;
  /** Which edge of the trigger the popover's left edge aligns with before
   *  clamping. 'left' matches the trigger's left edge (FilterButton);
   *  'right' matches the trigger's right edge, i.e. the popover hangs off
   *  to the left of the trigger (NotificationBell's old `right: 0`). */
  align?: 'left' | 'right';
  viewportMargin?: number;
  gap?: number;
  minHeight?: number;
}

/**
 * Shared positioning math for a trigger-anchored popover that must be
 * portaled to document.body: computed from the trigger's own bounding
 * rect, clamped so it never extends past either viewport edge, and flipped
 * above the trigger when there isn't room below. Extracted from
 * FilterButton so every anchored popover in the app (FilterButton,
 * NotificationBell) clamps the same way instead of each reimplementing it.
 */
export function useAnchoredPopoverPosition({
  open,
  triggerRef,
  width,
  align = 'left',
  viewportMargin = 16,
  gap = 8,
  minHeight = 160,
}: UseAnchoredPopoverPositionOptions): AnchoredPosition | null {
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const naturalLeft = align === 'right' ? rect.right - width : rect.left;
      const left = Math.max(
        viewportMargin,
        Math.min(naturalLeft, window.innerWidth - width - viewportMargin)
      );

      const spaceBelow = window.innerHeight - rect.bottom - viewportMargin;
      const spaceAbove = rect.top - viewportMargin;

      if (spaceBelow >= minHeight || spaceBelow >= spaceAbove) {
        setPosition({
          top: rect.bottom + gap,
          left,
          maxHeight: Math.max(minHeight, spaceBelow - gap),
        });
      } else {
        const maxHeight = Math.max(minHeight, spaceAbove - gap);
        setPosition({ top: rect.top - gap - maxHeight, left, maxHeight });
      }
    };

    updatePosition();

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, triggerRef, width, align, viewportMargin, gap, minHeight]);

  return position;
}
