export function safeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts and older Safari. Not
  // cryptographically strong, but these ids only need to be unique
  // within a storage path, never unguessable.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
