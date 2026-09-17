import { useEffect, useRef, useState } from 'react';

// Throwaway diagnostic for the native nav drift bug. Always renders, on
// every screen, no trigger. Remove once the drift is diagnosed and fixed.

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
  scrollingElementScrollTop: number | null;
};

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

  useEffect(() => {
    const update = () => setMetrics(readMetrics(probeRef.current));
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
            `scrollingElement.scrollTop: ${metrics.scrollingElementScrollTop ?? 'n/a'}`,
          ].join('\n')
        : 'measuring…'}
    </div>
  );
}
