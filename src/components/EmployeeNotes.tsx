import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2, NotebookPen, Send, Trash2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { usePermissions } from '../hooks/usePermissions';

interface NoteRow {
  id: string;
  note_text: string;
  created_at: string;
  manager_id: string;
  deleted_at: string | null;
  deleted_by: string | null;
  author: { first_name: string | null; full_name: string | null } | null;
  remover: { first_name: string | null; full_name: string | null } | null;
}

const NOTE_FIELDS =
  'id, note_text, created_at, manager_id, deleted_at, deleted_by, ' +
  'author:manager_id ( first_name, full_name ), remover:deleted_by ( first_name, full_name )';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Manager-only notes on an employee's profile. Notes cannot be edited, and
 * there is no hard-delete policy for anyone — an Administrator can only
 * soft-delete a note (deleted_at/deleted_by), which leaves a tombstone in
 * place rather than removing the row. Never render this in EmployeeDashboard.
 */
export default function EmployeeNotes({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}): ReactNode {
  const { isAdmin } = usePermissions();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFault, setSaveFault] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

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
      deleted_at: null,
      deleted_by: null,
      author: null,
      remover: null,
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

  const handleRemove = async (id: string) => {
    setRemovingId(id);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setRemovingId(null);
      return;
    }

    const { data, error: removeError } = await supabase
      .from('employee_notes')
      .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
      .eq('id', id)
      .select(NOTE_FIELDS)
      .single<NoteRow>();

    if (!removeError && data) {
      setNotes((prev) => prev.map((n) => (n.id === id ? data : n)));
    }
    setRemovingId(null);
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
          Notes are visible to all managers and cannot be edited once saved. Only an
          administrator can remove one, which leaves a visible record that it existed. An
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
            {notes.map((n) =>
              n.deleted_at ? (
                <li key={n.id} className="relative">
                  <span
                    className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-border"
                    aria-hidden="true"
                  />
                  <p className="text-sm italic text-ink/50">
                    Note removed by{' '}
                    {n.remover?.full_name ?? n.remover?.first_name ?? 'an administrator'} on{' '}
                    {formatDate(n.deleted_at)}
                  </p>
                </li>
              ) : (
                <li key={n.id} className="relative">
                  <span
                    className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  <p className="whitespace-pre-wrap text-sm text-ink">{n.note_text}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink/50">
                    <p>
                      {n.author?.full_name ?? n.author?.first_name ?? 'Unknown manager'} ·{' '}
                      {formatDateTime(n.created_at)}
                    </p>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => void handleRemove(n.id)}
                        disabled={removingId === n.id}
                        className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-xs font-semibold text-danger hover:bg-danger-bg disabled:opacity-60"
                      >
                        {removingId === n.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        )}
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              )
            )}
          </ol>
        )}
      </div>
    </div>
  );
}
