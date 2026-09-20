import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2, Megaphone } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { friendlyError } from '../lib/friendlyError';

interface ReminderRow {
  id: string;
  title: string;
  body: string | null;
}

/**
 * Blocks the app until every reminder targeted at this person (by role or
 * individually) has been acknowledged. Mounted once at the employee
 * dashboard root, same shape as OwedOrdersModal: fires on login regardless
 * of which tab last persisted, and re-checked whenever `checkSignal`
 * changes (tapping a 'reminder' notification bumps it — see
 * NotificationBell's onReminderTap).
 */
export default function ReminderAcknowledgeModal({ checkSignal }: { checkSignal: number }): ReactNode {
  const [queue, setQueue] = useState<ReminderRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // RLS (reminders_select_targeted) already scopes this to reminders
    // that target this person by role or individually; the acknowledged
    // check is done client-side against a second, RLS-scoped-to-own-rows
    // query rather than a not-exists filter, since the JS query builder
    // has no clean way to express "not acknowledged by me" against a
    // related table.
    const [remindersRes, acksRes] = await Promise.all([
      supabase
        .from('reminders')
        .select('id, title, body')
        .order('send_at', { ascending: true })
        .returns<ReminderRow[]>(),
      supabase.from('reminder_acknowledgements').select('reminder_id'),
    ]);

    if (remindersRes.error || !remindersRes.data) return;

    const ackedIds = new Set((acksRes.data ?? []).map((row) => row.reminder_id));
    setQueue(remindersRes.data.filter((r) => !ackedIds.has(r.id)));
  }, []);

  useEffect(() => { void load(); }, [load, checkSignal]);

  const current = queue[0] ?? null;

  const handleAcknowledge = async () => {
    if (!current) return;
    setFault(null);
    setSaving(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      setFault('Your session has expired. Sign in again.');
      return;
    }

    const { error } = await supabase
      .from('reminder_acknowledgements')
      .insert({ reminder_id: current.id, profile_id: user.id });
    setSaving(false);

    if (error) {
      setFault(friendlyError(error, 'Could not save. Check your connection and try again.'));
      return;
    }

    setQueue((q) => q.slice(1));
  };

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-primary/60 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-ack-title"
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3">
          <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div>
            <h2 id="reminder-ack-title" className="text-base font-semibold text-ink">{current.title}</h2>
            {current.body && <p className="mt-1 text-sm text-ink/70">{current.body}</p>}
            {queue.length > 1 && (
              <p className="mt-2 text-xs text-ink/50">
                {queue.length} reminders need this — you'll go through them one at a time.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {fault && <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

          <button
            type="button"
            onClick={() => void handleAcknowledge()}
            disabled={saving}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Acknowledge
          </button>
        </div>
      </div>
    </div>
  );
}
