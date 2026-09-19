import { useEffect, useRef, useState } from 'react';

// Throwaway diagnostic for the native nav drift bug, now extended for the
// native horizontal-scroll-drift bug (Schedule tab and friends: WKWebView's
// outer scroll view registers a horizontal pan during a transiently-wide
// modal/popover frame and keeps the offset after). Always renders, on every
// screen, no trigger. Remove this whole file, its two render sites in
// App.tsx, and the import, once both drifts are confirmed fixed on-device —
// do not ship this to production.

type DebugMetrics = {
  innerHeight: number;
  visualViewportHeight: number | null;
  visualViewportOffsetTop: number | null;
  docScrollHeight: number;
  docClientHeight: number;
  bodyScrollHeight: number;
  mainScrollHeight: number | null;
  mainClientHeight: number | null;
  safeAreaBottom: string;
  scrollY: number;
  scrollX: number;
  scrollingElementScrollTop: number | null;
};

/**
 * Walks every element on the page and finds the one extending furthest
 * past the right edge of the viewport, so a console log of a stray
 * scrollX can point at a specific element instead of just the symptom.
 * O(n) over the whole DOM — only ever called right after scrollX is
 * observed to be nonzero, never on a timer.
 */
function findWidestOffender(): { description: string; rightEdge: number } | null {
  const viewportWidth = document.documentElement.clientWidth;
  let worst: { description: string; rightEdge: number } | null = null;

  for (const el of document.body.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const overshoot = rect.right - viewportWidth;
    if (overshoot > 1 && (!worst || rect.right > worst.rightEdge)) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && typeof el.className === 'string'
        ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
        : '';
      worst = { description: `${tag}${id}${cls}`, rightEdge: rect.right };
    }
  }

  return worst;
}

function readMetrics(safeAreaProbe: HTMLDivElement | null): DebugMetrics {
  const main = document.querySelector('main');
  return {
    innerHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport ? window.visualViewport.height : null,
    visualViewportOffsetTop: window.visualViewport ? window.visualViewport.offsetTop : null,
    docScrollHeight: document.documentElement.scrollHeight,
    docClientHeight: document.documentElement.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    mainScrollHeight: main ? main.scrollHeight : null,
    mainClientHeight: main ? main.clientHeight : null,
    safeAreaBottom: safeAreaProbe ? getComputedStyle(safeAreaProbe).paddingBottom : 'n/a',
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    scrollingElementScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
  };
}

function row(label: string, scrollH: number | null, clientH: number | null) {
  if (scrollH == null || clientH == null) return `${label}: n/a`;
  const diff = scrollH - clientH;
  const flag = diff > 0 ? `  <-- SCROLLS (+${diff}px)` : '';
  return `${label}: ${scrollH} / ${clientH}${flag}`;
}

export default function DebugOverlay() {
  const probeRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<DebugMetrics | null>(null);
  const wasScrollXZero = useRef(true);

  useEffect(() => {
    const update = () => {
      const next = readMetrics(probeRef.current);
      setMetrics(next);

      // Log only on the 0 -> nonzero transition, not every tick, so a
      // stuck offset doesn't spam the console once a second.
      const isZero = next.scrollX === 0;
      if (!isZero && wasScrollXZero.current) {
        const offender = findWidestOffender();
        console.warn(
          `[scrollX drift] window.scrollX=${next.scrollX} — widest element past the right edge:`,
          offender ? `${offender.description} (right edge ${Math.round(offender.rightEdge)}px)` : 'none found (offset may have already cleared)'
        );
      }
      wasScrollXZero.current = isZero;
    };
    update();

    const interval = setInterval(update, 250);
    window.addEventListener('scroll', update, { passive: true, capture: true });
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);

    return () => {
      clearInterval(interval);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, []);

  return (
    <div
      ref={probeRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 999999,
        pointerEvents: 'none',
        paddingBottom: 'env(safe-area-inset-bottom)',
        fontFamily: 'monospace',
        fontSize: 11,
        lineHeight: 1.5,
        color: '#7CFC00',
        background: 'rgba(0,0,0,0.85)',
        padding: '6px 8px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {metrics
        ? [
            `innerHeight: ${metrics.innerHeight}   visualViewport.h: ${metrics.visualViewportHeight ?? 'n/a'}`,
            `visualViewport.offsetTop: ${metrics.visualViewportOffsetTop ?? 'n/a'}${
              metrics.visualViewportOffsetTop ? '  <-- NONZERO' : ''
            }`,
            row('html  scrollH/clientH', metrics.docScrollHeight, metrics.docClientHeight),
            `body  scrollH: ${metrics.bodyScrollHeight}`,
            row('main  scrollH/clientH', metrics.mainScrollHeight, metrics.mainClientHeight),
            `safe-area-inset-bottom: ${metrics.safeAreaBottom}`,
            `window.scrollY: ${metrics.scrollY}`,
            `window.scrollX: ${metrics.scrollX}${metrics.scrollX !== 0 ? '  <-- NONZERO, see console' : ''}`,
            `scrollingElement.scrollTop: ${metrics.scrollingElementScrollTop ?? 'n/a'}`,
          ].join('\n')
        : 'measuring…'}
    </div>
  );
}
