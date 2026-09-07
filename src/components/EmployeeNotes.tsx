import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2, NotebookPen, Send } from 'lucide-react';
import { supabase } from '../supabaseClient';

interface NoteRow {
  id: string;
  note_text: string;
  created_at: string;
  manager_id: string;
  author: { first_name: string | null; full_name: string | null } | null;
}

const NOTE_FIELDS = 'id, note_text, created_at, manager_id, author:manager_id ( first_name, full_name )';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Manager-only notes on an employee's profile. Append-only by design: there
 * is no edit or delete control here, and the database has no policy
 * permitting either. Never render this in EmployeeDashboard.
 */
export default function EmployeeNotes({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}): ReactNode {
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFault, setSaveFault] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const { data, error: queryError } = await supabase
      .from('employee_notes')
      .select(NOTE_FIELDS)
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false })
      .returns<NoteRow[]>();

    if (queryError) setError('Notes could not be loaded.');
    else setNotes(data ?? []);
    setLoading(false);
  }, [employeeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    const note = draft.trim();
    if (!note) {
      setSaveFault('Write a note before saving.');
      return;
    }

    setSaving(true);
    setSaveFault(null);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaveFault('Your session has expired. Sign in again.');
      setSaving(false);
      return;
    }

    // Optimistic insert, reverted on failure.
    const tempId = `local-${Date.now()}`;
    const optimistic: NoteRow = {
      id: tempId,
      note_text: note,
      created_at: new Date().toISOString(),
      manager_id: user.id,
      author: null,
    };
    setNotes((prev) => [optimistic, ...prev]);
    setDraft('');

    const { data, error: insertError } = await supabase
      .from('employee_notes')
      .insert({ employee_id: employeeId, manager_id: user.id, note_text: note })
      .select(NOTE_FIELDS)
      .single<NoteRow>();

    if (insertError || !data) {
      setNotes((prev) => prev.filter((n) => n.id !== tempId));
      setDraft(note);
      setSaveFault(insertError?.message || 'Could not save the note.');
    } else {
      setNotes((prev) => prev.map((n) => (n.id === tempId ? data : n)));
    }
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <NotebookPen className="h-4 w-4 text-ink/50" aria-hidden="true" />
        <h4 className="text-xs font-semibold text-ink/60">
          Manager notes on {employeeName}
        </h4>
      </div>

      <div className="mt-3">
        <label htmlFor={`notes-draft-${employeeId}`} className="sr-only">
          Add a note about {employeeName}
        </label>
        <textarea
          id={`notes-draft-${employeeId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder={`Add a note about ${employeeName}…`}
          disabled={saving}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
        />

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !draft.trim()}
          className="mt-2 inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          Save note
        </button>

        {saveFault && <p className="mt-2 text-sm text-danger">{saveFault}</p>}

        <p className="mt-2 text-xs text-ink/50">
          Notes are visible to all managers, and cannot be edited or deleted once saved. An
          employee may be entitled to see notes about them if they make a data access request, so
          write accordingly.
        </p>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink/60">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading notes…
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-danger">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        ) : notes.length === 0 ? (
          <p className="text-sm text-ink/60">No notes yet.</p>
        ) : (
          <ol className="space-y-3 border-l border-border pl-4">
            {notes.map((n) => (
              <li key={n.id} className="relative">
                <span
                  className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <p className="whitespace-pre-wrap text-sm text-ink">{n.note_text}</p>
                <p className="mt-1 text-xs text-ink/50">
                  {n.author?.full_name ?? n.author?.first_name ?? 'Unknown manager'} ·{' '}
                  {formatDateTime(n.created_at)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
