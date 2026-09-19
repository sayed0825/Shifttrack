/**
 * Forces the WKWebView's viewport zoom back to 1 by briefly adding
 * `maximum-scale=1` to the viewport meta tag, then removing it again.
 *
 * The real fix for the zoom is that every form field is now
 * `text-base sm:text-sm` (16px below `sm`, where iOS Safari/WKWebView
 * auto-zooms a focused field under 16px) — see the `@layer utilities`
 * rule in index.css. This is only the safety net for whatever still
 * slips through: the zoom this bug produces does not reliably clear
 * itself when the field blurs or its modal closes, so the app is left
 * zoomed and scrollable in both directions until reload.
 *
 * This must NOT be done by leaving `maximum-scale=1` (or
 * `user-scalable=no`) in the viewport meta permanently — that disables
 * pinch-zoom outright, an accessibility failure. Adding it and removing
 * it on the same tick snaps the current zoom back to 1 without leaving
 * pinch-zoom disabled afterwards — confirmed on-device.
 */
export function resetViewportZoom(): void {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  const original = meta.getAttribute('content');
  if (!original) return;

  meta.setAttribute('content', `${original}, maximum-scale=1`);
  requestAnimationFrame(() => {
    meta.setAttribute('content', original);
  });
}

/**
 * The document must never scroll horizontally (or at all — see the
 * `html, body { overflow: hidden }` rule in index.css). But in the native
 * iOS build, `overflow: hidden` only stops the *page's own* CSS scrolling;
 * it does not reset an offset the WKWebView's native outer scroll view
 * already picked up. If any element is briefly wider than the viewport
 * during a transition (a modal or popover animating in/out, a layout
 * pass before a clamp effect runs), that native scroll view can register
 * a horizontal pan for that one frame and keep the offset after the
 * element is gone — Mobile Safari does not have this behavior, so it only
 * shows up on-device.
 *
 * Also resets viewport zoom (see resetViewportZoom above) — a stray zoom
 * and a stray scroll offset are the same class of bug (a WKWebView
 * viewport transform that outlived the thing that caused it), and every
 * call site that needs one needs the other. Call this after any tab
 * change or modal/popover close, and once on app load.
 */
export function resetDocumentScroll(): void {
  window.scrollTo(0, 0);
  resetViewportZoom();
}
