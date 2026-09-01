import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Clock, Loader2, X } from 'lucide-react';
import { supabase } from '../supabaseClient';

interface ClaimRow {
  id: string;
  claimed_clock_in: string | null;
  claimed_clock_out: string | null;
  reason: string | null;
  profiles: { first_name: string | null; full_name: string | null; role: string } | null;
  time_logs: { clock_in: string; clock_out: string | null } | null;
}

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function extraMinutes(claim: ClaimRow): number {
  const log = claim.time_logs;
  if (!log) return 0;
  let ms = 0;
  if (claim.claimed_clock_in) {
    ms += new Date(log.clock_in).getTime() - new Date(claim.claimed_clock_in).getTime();
  }
  if (claim.claimed_clock_out && log.clock_out) {
    ms += new Date(claim.claimed_clock_out).getTime() - new Date(log.clock_out).getTime();
  }
  return Math.round(ms / 60_000);
}

export default function OvertimeApprovals(): ReactNode {
  const [claims, setClaims] = useState<ClaimRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('overtime_claims')
      .select(
        'id, claimed_clock_in, claimed_clock_out, reason, profiles:user_id ( first_name, full_name, role ), time_logs:time_log_id ( clock_in, clock_out )'
      )
      .eq('status', 'pending')
      .order('created_at');

    setClaims((data ?? []) as unknown as ClaimRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, approve: boolean) => {
    setBusyId(id);
    setFault(null);
    const { error } = await supabase.rpc('decide_overtime_claim', {
      p_claim_id: id,
      p_approve: approve,
    });
    if (error) setFault(error.message);
    else await load();
    setBusyId(null);
  };

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <Clock className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Overtime claims</h3>
        {claims.length > 0 && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
            {claims.length}
          </span>
        )}
      </div>

      {fault && <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : claims.length === 0 ? (
        <p className="mt-3 text-sm text-ink/60">No claims waiting.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {claims.map((claim) => {
            const extra = extraMinutes(claim);
            return (
              <li key={claim.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {claim.profiles?.full_name ?? claim.profiles?.first_name ?? 'Unknown'}
                    </p>
                    <p className="text-xs text-ink/60">
                      {claim.profiles?.role} · {dayOf(claim.time_logs?.clock_in ?? null)}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-secondary/10 px-2.5 py-1 text-xs font-semibold tabular-nums text-secondary">
                    +{extra} min
                  </span>
                </div>

                {/* Recorded against claimed, so the change is visible at a glance. */}
                <dl className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/60">Recorded</dt>
                    <dd className="tabular-nums text-ink">
                      {clockOf(claim.time_logs?.clock_in ?? null)}–{clockOf(claim.time_logs?.clock_out ?? null)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink/60">Claimed</dt>
                    <dd className="font-medium tabular-nums text-ink">
                      {clockOf(claim.claimed_clock_in ?? claim.time_logs?.clock_in ?? null)}–
                      {clockOf(claim.claimed_clock_out ?? claim.time_logs?.clock_out ?? null)}
                    </dd>
                  </div>
                </dl>

                {claim.reason && <p className="mt-2 text-xs italic text-ink/60">{claim.reason}</p>}

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={busyId === claim.id}
                    onClick={() => void decide(claim.id, true)}
                    className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === claim.id}
                    onClick={() => void decide(claim.id, false)}
                    className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg disabled:opacity-60"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    Decline
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
