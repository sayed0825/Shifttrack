import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Banknote, Loader2, Plus } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { friendlyError } from '../lib/friendlyError';
import { WAGE_RATE_FIELDS, formatHourlyRate, localDateKeyFromIso, type WageRateRow } from '../lib/wageRates';

function formatDate(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Administrator-only wage history for one staff member. The caller must
 * gate this on isAdmin before rendering it at all — same contract as
 * EmployeeNotes never appearing in EmployeeDashboard — but the database
 * enforces it independently too: staff_wage_rates RLS is is_admin()-only,
 * so a stray render here fails closed (an empty/error state) rather than
 * leaking a rate to whoever can see the page.
 */
export default function WageRatesPanel({
  profileId,
  profileName,
}: {
  profileId: string;
  profileName: string;
}): ReactNode {
  const [rates, setRates] = useState<WageRateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => localDateKeyFromIso(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const [saveFault, setSaveFault] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: queryError } = await supabase
      .from('staff_wage_rates')
      .select(WAGE_RATE_FIELDS)
      .eq('profile_id', profileId)
      .order('effective_from', { ascending: false })
      .returns<WageRateRow[]>();

    if (queryError) setError('Wage history could not be loaded.');
    else setRates(data ?? []);
    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  // `rates` is sorted most-recent-first, so the first row whose
  // effective_from isn't in the future is the one in effect today.
  const todayKey = localDateKeyFromIso(new Date().toISOString());
  const currentRow = rates.find((r) => r.effective_from <= todayKey) ?? null;

  const handleSave = async () => {
    const trimmed = amount.trim();
    const parsed = Number(trimmed);
    if (trimmed === '' || !Number.isFinite(parsed) || parsed < 0) {
      setSaveFault('Enter a valid hourly rate, zero or more.');
      return;
    }
    if (!effectiveFrom) {
      setSaveFault('Pick an effective date.');
      return;
    }

    setSaving(true);
    setSaveFault(null);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error: insertError } = await supabase.from('staff_wage_rates').insert({
      profile_id: profileId,
      hourly_rate: Math.round(parsed * 100) / 100,
      effective_from: effectiveFrom,
      created_by: user?.id ?? null,
    });

    if (insertError) {
      setSaveFault(
        insertError.code === '23505'
          ? 'A rate is already set for that date. Pick a different date.'
          : friendlyError(insertError, 'Could not save the rate.')
      );
    } else {
      setAmount('');
      await load();
    }
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <Banknote className="h-4 w-4 text-ink/50" aria-hidden="true" />
        <h4 className="text-xs font-semibold text-ink/60">Pay — {profileName}</h4>
      </div>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading pay history…
        </div>
      ) : error ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-danger">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      ) : (
        <>
          <p className="mt-3 text-lg font-semibold tabular-nums text-ink">
            {currentRow ? formatHourlyRate(currentRow.hourly_rate) : 'No rate set'}
          </p>
          {currentRow && (
            <p className="text-xs text-ink/50">Effective since {formatDate(currentRow.effective_from)}</p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={`wage-amount-${profileId}`} className="block text-xs font-medium text-ink/60">
                Hourly rate
              </label>
              <input
                id={`wage-amount-${profileId}`}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                disabled={saving}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums disabled:opacity-60"
              />
            </div>
            <div>
              <label htmlFor={`wage-date-${profileId}`} className="block text-xs font-medium text-ink/60">
                Effective from
              </label>
              <input
                id={`wage-date-${profileId}`}
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                disabled={saving}
                className="mt-1 min-h-[44px] w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm tabular-nums disabled:opacity-60"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            Add rate
          </button>

          {saveFault && <p className="mt-2 text-sm text-danger">{saveFault}</p>}

          <div className="mt-4 border-t border-border pt-3">
            <p className="text-xs font-medium text-ink/60">History</p>
            {rates.length === 0 ? (
              <p className="mt-1 text-sm text-ink/60">No rate has been set yet.</p>
            ) : (
              <ol className="mt-2 space-y-1.5">
                {rates.map((r) => (
                  <li key={r.id} className="flex items-center justify-between text-sm">
                    <span className="text-ink/80">{formatDate(r.effective_from)}</span>
                    <span className="font-medium tabular-nums text-ink">{formatHourlyRate(r.hourly_rate)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
