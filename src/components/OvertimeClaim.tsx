import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Clock, Loader2, Send } from 'lucide-react';
import { supabase } from '../supabaseClient';

interface ClaimRow {
  id: string;
  claimed_clock_in: string | null;
  claimed_clock_out: string | null;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  time_logs: { clock_in: string; clock_out: string | null } | null;
}

interface RecentLog {
  id: string;
  clock_in: string;
  clock_out: string | null;
  shifts: { start_time: string; end_time: string } | null;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function OvertimeClaim({ profileId }: { profileId: string }): ReactNode {
  const [logs, setLogs] = useState<RecentLog[]>([]);
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [logId, setLogId] = useState('');
  const [actualIn, setActualIn] = useState('');
  const [actualOut, setActualOut] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    const since = new Date();
    since.setDate(since.getDate() - 14);

    const [logRes, claimRes] = await Promise.all([
      supabase
        .from('time_logs')
        .select('id, clock_in, clock_out, shifts:shift_id ( start_time, end_time )')
        .eq('user_id', profileId)
        .gte('clock_in', since.toISOString())
        .order('clock_in', { ascending: false })
        .limit(20),
      supabase
        .from('overtime_claims')
        .select('id, claimed_clock_in, claimed_clock_out, reason, status, time_logs:time_log_id ( clock_in, clock_out )')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    setLogs((logRes.data ?? []) as unknown as RecentLog[]);
    setClaims((claimRes.data ?? []) as unknown as ClaimRow[]);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Prefill from the recorded times so the employee edits rather than types.
  useEffect(() => {
    const log = logs.find((l) => l.id === logId);
    setActualIn(toLocalInput(log?.clock_in ?? null));
    setActualOut(toLocalInput(log?.clock_out ?? null));
  }, [logId, logs]);

  const selected = logs.find((l) => l.id === logId);
  const inIso = fromLocalInput(actualIn);
  const outIso = fromLocalInput(actualOut);

  // Only submit what actually differs — an unchanged field stays null so
  // the approval never overwrites a correct time with the same value.
  const changedIn = selected && inIso && inIso !== selected.clock_in ? inIso : null;
  const changedOut = selected && outIso && outIso !== selected.clock_out ? outIso : null;
  const nothingChanged = !changedIn && !changedOut;
  const badOrder = Boolean(inIso && outIso && new Date(outIso) <= new Date(inIso));

  const submit = async () => {
    if (!logId || nothingChanged) {
      setFault('Adjust a start or finish time before submitting.');
      return;
    }
    if (badOrder) {
      setFault('Finish time must be later than start time.');
      return;
    }

    setSaving(true);
    setFault(null);

    const { error } = await supabase.from('overtime_claims').insert({
      user_id: profileId,
      time_log_id: logId,
      claimed_clock_in: changedIn,
      claimed_clock_out: changedOut,
      reason: reason.trim() || null,
    });

    setSaving(false);

    if (error) {
      setFault('Could not submit the claim. Try again.');
      return;
    }

    setDone(true);
    setLogId('');
    setReason('');
    await load();
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Clock className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Overtime</h3>
      </div>
      <p className="mt-2 text-sm text-ink/60">
        If you started before or finished after your scheduled hours, claim it here. Your manager
        approves it before it reaches your timesheet.
      </p>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="ot-log" className="block text-sm font-medium text-ink">
              Which shift
            </label>
            <select
              id="ot-log"
              value={logId}
              onChange={(e) => {
                setLogId(e.target.value);
                setDone(false);
              }}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="">Choose a shift</option>
              {logs.map((log) => (
                <option key={log.id} value={log.id}>
                  {dayOf(log.clock_in)} · {clockOf(log.clock_in)}–{clockOf(log.clock_out)}
                </option>
              ))}
            </select>
            {logs.length === 0 && (
              <p className="mt-1.5 text-xs text-ink/60">No shifts recorded in the last two weeks.</p>
            )}
          </div>

          {selected && (
            <>
              {selected.shifts && (
                <p className="rounded-lg bg-bg px-3 py-2 text-xs text-ink/60">
                  Scheduled {clockOf(selected.shifts.start_time)}–{clockOf(selected.shifts.end_time)} ·
                  recorded {clockOf(selected.clock_in)}–{clockOf(selected.clock_out)}
                </p>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ot-in" className="block text-sm font-medium text-ink">
                    Actually started
                  </label>
                  <input
                    id="ot-in"
                    type="datetime-local"
                    value={actualIn}
                    onChange={(e) => setActualIn(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="ot-out" className="block text-sm font-medium text-ink">
                    Actually finished
                  </label>
                  <input
                    id="ot-out"
                    type="datetime-local"
                    value={actualOut}
                    onChange={(e) => setActualOut(e.target.value)}
                    className={`mt-1.5 min-h-[44px] w-full rounded-lg border px-2 py-2 text-sm tabular-nums ${
                      badOrder ? 'border-danger' : 'border-border'
                    }`}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="ot-reason" className="block text-sm font-medium text-ink">
                  Reason
                </label>
                <input
                  id="ot-reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. covered the close"
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
              </div>
            </>
          )}

          {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}
          {done && !fault && <p className="text-sm text-success">Claim sent to your manager.</p>}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !logId || nothingChanged || badOrder}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            Submit claim
          </button>
        </div>
      )}

      {claims.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-border pt-4">
          {claims.map((claim) => (
            <li key={claim.id} className="flex items-center gap-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate text-ink">
                  {claim.time_logs ? dayOf(claim.time_logs.clock_in) : 'Shift'}
                </p>
                <p className="truncate text-xs text-ink/60">
                  {claim.claimed_clock_in && `Start ${clockOf(claim.claimed_clock_in)}`}
                  {claim.claimed_clock_in && claim.claimed_clock_out && ' · '}
                  {claim.claimed_clock_out && `Finish ${clockOf(claim.claimed_clock_out)}`}
                </p>
              </div>
              <span
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                  claim.status === 'approved'
                    ? 'bg-success-bg text-success'
                    : claim.status === 'denied'
                      ? 'bg-danger-bg text-danger'
                      : 'bg-warning-bg text-warning'
                }`}
              >
                {claim.status}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 flex gap-2 text-xs text-ink/50">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Your timesheet keeps the recorded times until a claim is approved.
      </p>
    </div>
  );
}
