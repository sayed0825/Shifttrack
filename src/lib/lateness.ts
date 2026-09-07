/**
 * Lateness is never stored — it's derived from a time log's clock_in against
 * its shift's start_time, which lives in a different table. A log with no
 * linked shift (shift_id null, or the join came back empty) was never late,
 * since there was no scheduled start to be late against.
 */
export function isLate(
  clockIn: string,
  shiftStart: string | null | undefined,
  graceMinutes: number
): boolean {
  if (!shiftStart) return false;
  const allowed = new Date(shiftStart).getTime() + graceMinutes * 60_000;
  return new Date(clockIn).getTime() > allowed;
}

export function minutesLate(clockIn: string, shiftStart: string): number {
  return Math.round((new Date(clockIn).getTime() - new Date(shiftStart).getTime()) / 60_000);
}
