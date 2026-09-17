import { useEffect, useRef, useState } from 'react';
import { onDebugTapTriggered } from '../lib/debugTrigger';

// Temporary measurement tool for the native nav drift bug. Renders when the
// URL has ?debug=1 (web) or after 5 quick taps on the header org logo/name
// (native — there's no address bar to edit on device). Remove once the
// drift is diagnosed and fixed.

type DebugMetrics = {
  innerHeight: number;
  visualViewportHeight: number | null;
  docScrollHeight: number;
  docClientHeight: number;
  bodyScrollHeight: number;
  mainScrollHeight: number | null;
  mainClientHeight: number | null;
  safeAreaBottom: string;
  scrollY: number;
};

function readMetrics(safeAreaProbe: HTMLDivElement | null): DebugMetrics {
  const main = document.querySelector('main');
  return {
    innerHeight: window.innerHeight,
    visualViewportHeight: window.visualViewport ? window.visualViewport.height : null,
    docScrollHeight: document.documentElement.scrollHeight,
    docClientHeight: document.documentElement.clientHeight,
    bodyScrollHeight: document.body.scrollHeight,
    mainScrollHeight: main ? main.scrollHeight : null,
    mainClientHeight: main ? main.clientHeight : null,
    safeAreaBottom: safeAreaProbe ? getComputedStyle(safeAreaProbe).paddingBottom : 'n/a',
    scrollY: window.scrollY,
  };
}

function row(label: string, scrollH: number | null, clientH: number | null) {
  if (scrollH == null || clientH == null) return `${label}: n/a`;
  const diff = scrollH - clientH;
  const flag = diff > 0 ? `  <-- SCROLLS (+${diff}px)` : '';
  return `${label}: ${scrollH} / ${clientH}${flag}`;
}

export default function DebugOverlay() {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('debug') === '1';
  });
  const probeRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<DebugMetrics | null>(null);

  useEffect(() => onDebugTapTriggered(() => setEnabled(true)), []);

  useEffect(() => {
    if (!enabled) return;

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
  }, [enabled]);

  if (!enabled) return null;

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
            row('html  scrollH/clientH', metrics.docScrollHeight, metrics.docClientHeight),
            `body  scrollH: ${metrics.bodyScrollHeight}`,
            row('main  scrollH/clientH', metrics.mainScrollHeight, metrics.mainClientHeight),
            `safe-area-inset-bottom: ${metrics.safeAreaBottom}`,
            `window.scrollY: ${metrics.scrollY}`,
          ].join('\n')
        : 'measuring…'}
    </div>
  );
}
