// iOS Safari can drop a backgrounded tab's whole JS context and reload it
// when the user switches back, resetting any in-memory tab state to its
// initial value. sessionStorage survives that (it's the same browsing
// context being reloaded, not a fresh one), so the active tab is restored
// instead of always landing back on the first tab.
export function loadPersistedTab<T extends string>(key: string, validIds: readonly T[]): T | null {
  try {
    const stored = sessionStorage.getItem(key);
    if (stored && (validIds as readonly string[]).includes(stored)) return stored as T;
  } catch {
    // Storage can be unavailable (private browsing, disabled site data) —
    // fall back to the caller's default.
  }
  return null;
}

export function savePersistedTab(key: string, tab: string): void {
  try {
    sessionStorage.setItem(key, tab);
  } catch {
    // Ignore — losing persistence is fine, losing the tab switch is not.
  }
}
