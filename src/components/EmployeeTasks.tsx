import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  CheckSquare,
  ChevronDown,
  Loader2,
  MessageSquare,
  Send,
  X,
  XCircle,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { safeUuid } from '../lib/ids';
import { compressImage } from '../lib/compressImage';
import { friendlyError } from '../lib/friendlyError';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import type { Profile } from './ManagerDashboard';

// The item is the unit of work — submitted, reviewed, approved or
// rejected individually. The list (task) is the container: one title,
// one shared start/due time, one assignment. Shared-pool semantics
// (whoever completes an item first completes it for everyone with that
// role) apply per item, against the list's own assignment.
type ItemStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

interface ItemRow {
  id: string;
  title: string;
  description: string | null;
  is_required: boolean;
  requires_photo: boolean;
  max_photos: number;
  status: ItemStatus;
  completed_by: string | null;
  completed_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  assigned_role: string | null;
  assigned_user_id: string | null;
  start_time: string;
  due_time: string;
  task_day: string;
  items: ItemRow[];
}

interface CommentRow {
  id: string;
  comment_text: string;
  created_at: string;
  sender_id: string;
  sender: { first_name: string | null; full_name: string | null } | null;
}

const TASK_FIELDS =
  'id, title, description, assigned_role, assigned_user_id, start_time, due_time, task_day, ' +
  'items:task_items ( id, title, description, is_required, requires_photo, max_photos, status, completed_by, completed_at, reviewed_by, reviewed_at )';

const COMMENT_FIELDS = 'id, comment_text, created_at, sender_id, sender:sender_id ( first_name, full_name )';

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Actionable items — the ones this employee can still do something with. */
function isActionable(item: ItemRow): boolean {
  return item.status === 'pending' || item.status === 'rejected';
}

// ===========================================================================
// Root
// ===========================================================================

export default function EmployeeTasks({ profile }: { profile: Profile }): ReactNode {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const todayKey = localDateKey(new Date());

    // A role assignment is a shared pool; a personal one is exact. Two
    // separate queries (rather than one .or()) sidestep having to escape an
    // org-defined role name into a PostgREST filter string.
    const queries = profile.role
      ? [
          supabase.from('tasks').select(TASK_FIELDS).eq('task_day', todayKey).eq('assigned_user_id', profile.id),
          supabase.from('tasks').select(TASK_FIELDS).eq('task_day', todayKey).eq('assigned_role', profile.role),
        ]
      : [supabase.from('tasks').select(TASK_FIELDS).eq('task_day', todayKey).eq('assigned_user_id', profile.id)];

    const results = await Promise.all(queries.map((q) => q.returns<TaskRow[]>()));

    if (results.some((r) => r.error)) {
      setError('Tasks could not be loaded. Try again.');
      setLoading(false);
      return;
    }

    const merged = new Map<string, TaskRow>();
    for (const result of results) {
      for (const task of result.data ?? []) merged.set(task.id, task);
    }
    setTasks(Array.from(merged.values()).sort((a, b) => a.start_time.localeCompare(b.start_time)));
    setLoading(false);
  }, [profile.id, profile.role]);

  useEffect(() => {
    void load();
  }, [load]);

  // A role-assigned item is a shared pool — a colleague may complete one
  // while this screen is open, so it needs to stay live rather than go
  // stale. Item status lives on task_items now, not tasks, so both tables
  // are watched.
  useEffect(() => {
    const channel = supabase
      .channel(`employee-tasks-${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_items' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load, profile.id]);

  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) ?? null, [tasks, selectedId]);

  // If a refetch drops the selected list (no longer in today's list), close
  // the sheet rather than show stale detail.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  const now = Date.now();

  const { dueNow, upcoming, done } = useMemo(() => {
    const actionable = tasks.filter((t) => t.items.some(isActionable));
    return {
      dueNow: actionable.filter((t) => new Date(t.start_time).getTime() <= now),
      upcoming: actionable.filter((t) => new Date(t.start_time).getTime() > now),
      done: tasks.filter((t) => !t.items.some(isActionable)),
    };
  }, [tasks, now]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink/60">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading tasks…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger bg-danger-bg p-4 text-sm text-danger">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-display text-lg tracking-tight text-ink">Tasks</h2>

      {notice && (
        <div className="flex items-center gap-2 rounded-lg bg-secondary/10 px-3 py-2 text-sm text-secondary">
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="rounded-lg p-0.5 hover:bg-secondary/20"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {tasks.length === 0 && (
        <div className="rounded-2xl border border-border bg-surface py-12 text-center">
          <CheckSquare className="mx-auto h-8 w-8 text-ink/40" aria-hidden="true" />
          <p className="mt-2 text-sm text-ink/60">
            {profile.role
              ? 'No tasks for you today.'
              : "You don't have a role assigned, so only tasks given to you personally show here."}
          </p>
        </div>
      )}

      <TaskGroup title="Due now" tasks={dueNow} onSelect={setSelectedId} />
      <TaskGroup title="Upcoming" tasks={upcoming} onSelect={setSelectedId} />
      <TaskGroup title="Done today" tasks={done} onSelect={setSelectedId} />

      {selected && (
        <TaskDetailSheet
          task={selected}
          profile={profile}
          onClose={() => setSelectedId(null)}
          onItemSubmitted={() => {
            setNotice('Submitted.');
            void load();
          }}
          onConflict={() => setNotice('Someone else already completed that item.')}
        />
      )}
    </div>
  );
}

// ===========================================================================
// List (task) cards
// ===========================================================================

function TaskGroup({
  title,
  tasks,
  onSelect,
}: {
  title: string;
  tasks: TaskRow[];
  onSelect: (id: string) => void;
}): ReactNode {
  if (tasks.length === 0) return null;

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-ink/50">
        {title} <span className="text-ink/40">({tasks.length})</span>
      </h3>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskCard task={task} onSelect={onSelect} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function TaskCard({ task, onSelect }: { task: TaskRow; onSelect: (id: string) => void }): ReactNode {
  const pastDue = new Date(task.due_time).getTime() < Date.now();
  const requiredPending = task.items.filter((i) => i.is_required && isActionable(i)).length;
  const optionalPending = task.items.filter((i) => !i.is_required && isActionable(i)).length;
  const anyRejected = task.items.some((i) => i.status === 'rejected');
  const anySubmittedWaiting = task.items.some((i) => i.status === 'submitted');
  const allDone = task.items.length > 0 && task.items.every((i) => i.status === 'approved');
  const doneCount = task.items.filter((i) => i.status === 'submitted' || i.status === 'approved').length;

  // Optional means missing it isn't a failure — it never gets the
  // danger-styled Overdue treatment, just a neutral "Not done".
  const overdue = pastDue && requiredPending > 0;
  const missedOptional = pastDue && requiredPending === 0 && optionalPending > 0;

  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={`flex min-h-[44px] w-full items-start gap-3 rounded-lg border p-3 text-left transition ${
        overdue || anyRejected ? 'border-danger/40 bg-danger-bg/30' : 'border-border bg-surface hover:border-primary/30'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-ink">{task.title}</p>
          {task.items.some((i) => i.requires_photo) && (
            <Camera className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-hidden="true" />
          )}
        </div>
        {task.description && <p className="mt-0.5 truncate text-xs text-ink/60">{task.description}</p>}
        <p className="mt-1 text-xs tabular-nums text-ink/50">
          {formatClock(task.start_time)} – {formatClock(task.due_time)}
          {' · '}
          {doneCount} of {task.items.length} done
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {overdue && (
          <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger">
            Overdue
          </span>
        )}
        {!overdue && anyRejected && (
          <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger">
            Needs redo
          </span>
        )}
        {!overdue && !anyRejected && missedOptional && (
          <span className="rounded-full bg-bg px-2 py-0.5 text-[11px] font-semibold text-ink/50">
            Not done
          </span>
        )}
        {!overdue && !anyRejected && !missedOptional && anySubmittedWaiting && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-semibold text-warning">
            Waiting review
          </span>
        )}
        {!overdue && !anyRejected && allDone && (
          <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
            Approved
          </span>
        )}
      </div>
    </button>
  );
}

// ===========================================================================
// Detail sheet — the list's own info, then each item individually
// ===========================================================================

function TaskDetailSheet({
  task,
  profile,
  onClose,
  onItemSubmitted,
  onConflict,
}: {
  task: TaskRow;
  profile: Profile;
  onClose: () => void;
  onItemSubmitted: () => void;
  onConflict: () => void;
}): ReactNode {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => resetDocumentScroll, []);

  const sortedItems = useMemo(
    () => [...task.items].sort((a, b) => (isActionable(a) === isActionable(b) ? 0 : isActionable(a) ? -1 : 1)),
    [task.items]
  );

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="task-detail-title" className="text-base font-semibold text-ink">
              {task.title}
            </h2>
            <p className="mt-0.5 text-xs tabular-nums text-ink/60">
              {formatClock(task.start_time)} – {formatClock(task.due_time)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {task.description && <p className="whitespace-pre-wrap text-sm text-ink/80">{task.description}</p>}

          {sortedItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              profile={profile}
              onSubmitted={onItemSubmitted}
              onConflict={onConflict}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// One item — its own completion control and its own comment thread
// ===========================================================================

function itemStatusBadge(item: ItemRow): ReactNode {
  if (item.status === 'rejected') {
    return (
      <span className="shrink-0 rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger">
        Rejected
      </span>
    );
  }
  if (item.status === 'submitted') {
    return (
      <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-semibold text-warning">
        Waiting review
      </span>
    );
  }
  if (item.status === 'approved') {
    return (
      <span className="shrink-0 rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
        Approved
      </span>
    );
  }
  return null;
}

function ItemCard({
  item,
  profile,
  onSubmitted,
  onConflict,
}: {
  item: ItemRow;
  profile: Profile;
  onSubmitted: () => void;
  onConflict: () => void;
}): ReactNode {
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [completing, setCompleting] = useState(false);
  const [completeFault, setCompleteFault] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAct = isActionable(item);
  const readyToComplete = !item.requires_photo || photoFiles.length > 0;

  const handleComplete = async () => {
    setCompleteFault(null);

    if (item.requires_photo && photoFiles.length === 0) {
      setCompleteFault('Attach a photo first.');
      return;
    }

    setCompleting(true);

    try {
      // Upload before the conditional update below: a required photo must
      // exist before the item can ever be marked submitted, never after.
      // If the update below then loses a shared-pool race, these objects
      // are simply never referenced by a task_photos row and sit as
      // harmless orphans in storage.
      const storagePaths = await Promise.all(
        photoFiles.map(async (file) => {
          const compressed = await compressImage(file);
          const storagePath = `${item.id}/${safeUuid()}.jpg`;
          const { error: uploadError } = await supabase.storage
            .from('task-photos')
            .upload(storagePath, compressed, { contentType: compressed.type || 'image/jpeg' });
          if (uploadError) throw uploadError;
          return storagePath;
        })
      );

      const { data, error: updateError } = await supabase
        .from('task_items')
        .update({
          status: 'submitted',
          completed_by: profile.id,
          completed_at: new Date().toISOString(),
        })
        .eq('id', item.id)
        .in('status', ['pending', 'rejected'])
        .select('id, completed_by')
        .maybeSingle<{ id: string; completed_by: string | null }>();

      if (updateError) throw updateError;

      if (data) {
        if (storagePaths.length > 0) {
          const { error: photosError } = await supabase.from('task_photos').insert(
            storagePaths.map((storage_path) => ({ task_item_id: item.id, storage_path, uploaded_by: profile.id }))
          );
          if (photosError) throw photosError;
        }
        onSubmitted();
        return;
      }

      // Zero rows matched — either someone else in the shared pool
      // completed it first, or this is a stale retry of a submit that
      // already went through for this same user (e.g. a double tap before
      // the UI caught up). Re-read the row to tell the two apart.
      const { data: current, error: refetchError } = await supabase
        .from('task_items')
        .select('id, completed_by')
        .eq('id', item.id)
        .maybeSingle<{ id: string; completed_by: string | null }>();

      if (refetchError) throw refetchError;

      if (current && current.completed_by === profile.id) {
        onSubmitted();
        return;
      }

      onConflict();
    } catch (err) {
      setCompleteFault(friendlyError(err, 'Could not submit this item.'));
    } finally {
      setCompleting(false);
    }
  };

  return (
    <div className={`rounded-lg border p-3 ${item.status === 'rejected' ? 'border-danger/40 bg-danger-bg/20' : 'border-border bg-bg'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-ink">{item.title}</p>
            {item.requires_photo && <Camera className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-hidden="true" />}
            {!item.is_required && (
              <span className="shrink-0 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-ink/50">
                Optional
              </span>
            )}
          </div>
          {item.description && <p className="mt-0.5 text-xs text-ink/60">{item.description}</p>}
        </div>
        {itemStatusBadge(item)}
      </div>

      {item.status === 'rejected' && (
        <div className="mt-2 flex gap-2 rounded-lg bg-danger-bg p-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-danger">Rejected — check the comments below, then redo it.</p>
        </div>
      )}

      {canAct && (
        <div className="mt-2 space-y-2">
          {item.requires_photo && (
            <div>
              <label htmlFor={`item-photo-${item.id}`} className="block text-xs font-medium text-ink/60">
                Photo required ({photoFiles.length} of {item.max_photos})
              </label>
              {photoFiles.length < item.max_photos && (
                <input
                  id={`item-photo-${item.id}`}
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setPhotoFiles((prev) => [...prev, file]);
                    // Reset so choosing the same file again (a second photo
                    // from the same camera roll pick) still fires onChange.
                    e.target.value = '';
                  }}
                  className="mt-1.5 block w-full text-base sm:text-xs text-ink/70 file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary-dark"
                />
              )}
              {photoFiles.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {photoFiles.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="flex items-center gap-1.5 text-xs text-success">
                      <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{file.name}</span>
                      <button
                        type="button"
                        onClick={() => setPhotoFiles((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Remove ${file.name}`}
                        className="shrink-0 text-ink/40 hover:text-danger"
                      >
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {completeFault && <p className="text-xs text-danger">{completeFault}</p>}

          <button
            type="button"
            onClick={() => void handleComplete()}
            disabled={completing || !readyToComplete}
            className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {completing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Mark done
          </button>
        </div>
      )}

      {item.status === 'approved' && item.reviewed_at && (
        <p className="mt-1 text-xs text-ink/50">Approved {formatDateTime(item.reviewed_at)}</p>
      )}
      {item.status === 'submitted' && item.completed_at && (
        <p className="mt-1 text-xs text-ink/50">Submitted {formatDateTime(item.completed_at)}</p>
      )}

      <button
        type="button"
        onClick={() => setShowComments((v) => !v)}
        className="mt-2 flex items-center gap-1 text-xs font-medium text-ink/60 hover:text-ink"
      >
        <MessageSquare className="h-3 w-3" aria-hidden="true" />
        Comments
        <ChevronDown className={`h-3 w-3 transition-transform ${showComments ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {showComments && <ItemComments itemId={item.id} profile={profile} />}
    </div>
  );
}

// ===========================================================================
// One item's comment thread — loaded lazily, only while expanded
// ===========================================================================

function ItemComments({ itemId, profile }: { itemId: string; profile: Profile }): ReactNode {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const loadComments = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('task_comments')
      .select(COMMENT_FIELDS)
      .eq('task_item_id', itemId)
      .order('created_at', { ascending: true })
      .returns<CommentRow[]>();

    if (queryError) setError('Comments could not be loaded.');
    else setComments(data ?? []);
    setLoading(false);
  }, [itemId]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  useEffect(() => {
    const channel = supabase
      .channel(`item-comments-${itemId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'task_comments', filter: `task_item_id=eq.${itemId}` },
        () => void loadComments()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [itemId, loadComments]);

  const handleSend = async () => {
    const comment_text = draft.trim();
    if (!comment_text || sending) return;

    setSending(true);
    const tempId = `local-${Date.now()}`;
    const optimistic: CommentRow = {
      id: tempId,
      comment_text,
      created_at: new Date().toISOString(),
      sender_id: profile.id,
      sender: { first_name: profile.first_name, full_name: profile.full_name },
    };
    setComments((prev) => [...prev, optimistic]);
    setDraft('');

    const { error } = await supabase
      .from('task_comments')
      .insert({ task_item_id: itemId, sender_id: profile.id, comment_text });

    if (error) {
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      setDraft(comment_text);
      setError('Could not send. Try again.');
    } else {
      await loadComments();
    }
    setSending(false);
  };

  return (
    <div className="mt-2 rounded-lg bg-surface p-2">
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-ink/60">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-ink/60">No comments yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {comments.map((c) => (
            <li key={c.id} className="rounded-lg bg-bg px-2 py-1.5">
              <p className="text-xs text-ink">{c.comment_text}</p>
              <p className="mt-0.5 text-[11px] text-ink/50">
                {c.sender?.full_name ?? c.sender?.first_name ?? 'Unknown'} · {formatDateTime(c.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <label htmlFor={`comment-input-${itemId}`} className="sr-only">
          Add a comment
        </label>
        <input
          id={`comment-input-${itemId}`}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSend();
          }}
          placeholder="Add a comment"
          className="min-h-[36px] w-full rounded-lg border border-border px-2 py-1.5 text-base sm:text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || !draft.trim()}
          aria-label="Send comment"
          className="flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
