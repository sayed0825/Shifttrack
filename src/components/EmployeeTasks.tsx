import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  CheckSquare,
  Loader2,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { safeUuid } from '../lib/ids';
import type { Profile } from './ManagerDashboard';

type TaskStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  assigned_role: string | null;
  assigned_user_id: string | null;
  start_time: string;
  due_time: string;
  requires_photo: boolean;
  photo_path: string | null;
  status: TaskStatus;
  completed_by: string | null;
  completed_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  task_day: string;
}

interface CommentRow {
  id: string;
  comment_text: string;
  created_at: string;
  sender_id: string;
  sender: { first_name: string | null; full_name: string | null } | null;
}

const TASK_FIELDS =
  'id, title, description, assigned_role, assigned_user_id, start_time, due_time, requires_photo, photo_path, status, completed_by, completed_at, reviewed_by, reviewed_at, task_day';

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

  // A role-assigned task is a shared pool — a colleague may complete one
  // while this screen is open, so it needs to stay live rather than go stale.
  useEffect(() => {
    const channel = supabase
      .channel(`employee-tasks-${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load, profile.id]);

  const applyTaskUpdate = useCallback((updated: TaskRow) => {
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }, []);

  const selected = useMemo(() => tasks.find((t) => t.id === selectedId) ?? null, [tasks, selectedId]);

  // If a refetch drops the selected task (someone else completed a shared
  // one, or it's no longer in today's list), close the sheet rather than
  // show stale detail.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  const now = Date.now();

  const { dueNow, upcoming, done } = useMemo(() => {
    const actionable = tasks.filter((t) => t.status === 'pending' || t.status === 'rejected');
    return {
      dueNow: actionable.filter((t) => new Date(t.start_time).getTime() <= now),
      upcoming: actionable.filter((t) => new Date(t.start_time).getTime() > now),
      done: tasks.filter((t) => t.status === 'submitted' || t.status === 'approved'),
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
      <h2 className="text-lg font-semibold text-ink">Tasks</h2>

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
          onCompleted={(updated) => {
            applyTaskUpdate(updated);
            setNotice('Task submitted.');
            void load();
          }}
          onConflict={() => setNotice('Someone else already completed this task.')}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Task list
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
  const overdue = task.status === 'pending' && new Date(task.due_time).getTime() < Date.now();
  const rejected = task.status === 'rejected';

  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      className={`flex min-h-[44px] w-full items-start gap-3 rounded-lg border p-3 text-left transition ${
        overdue || rejected ? 'border-danger/40 bg-danger-bg/30' : 'border-border bg-surface hover:border-primary/30'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-sm font-medium text-ink">{task.title}</p>
          {task.requires_photo && <Camera className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-hidden="true" />}
        </div>
        {task.description && <p className="mt-0.5 truncate text-xs text-ink/60">{task.description}</p>}
        <p className="mt-1 text-xs tabular-nums text-ink/50">
          {formatClock(task.start_time)} – {formatClock(task.due_time)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {overdue && (
          <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger">
            Overdue
          </span>
        )}
        {rejected && (
          <span className="rounded-full bg-danger-bg px-2 py-0.5 text-[11px] font-semibold text-danger">
            Rejected
          </span>
        )}
        {task.status === 'submitted' && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-semibold text-warning">
            Waiting review
          </span>
        )}
        {task.status === 'approved' && (
          <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-semibold text-success">
            Approved
          </span>
        )}
      </div>
    </button>
  );
}

// ===========================================================================
// Detail bottom sheet
// ===========================================================================

function TaskDetailSheet({
  task,
  profile,
  onClose,
  onCompleted,
  onConflict,
}: {
  task: TaskRow;
  profile: Profile;
  onClose: () => void;
  onCompleted: (updated: TaskRow) => void;
  onConflict: () => void;
}): ReactNode {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [completing, setCompleting] = useState(false);
  const [completeFault, setCompleteFault] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadComments = useCallback(async () => {
    setCommentsError(null);
    const { data, error } = await supabase
      .from('task_comments')
      .select(COMMENT_FIELDS)
      .eq('task_id', task.id)
      .order('created_at', { ascending: true })
      .returns<CommentRow[]>();

    if (error) setCommentsError('Comments could not be loaded.');
    else setComments(data ?? []);
    setCommentsLoading(false);
  }, [task.id]);

  useEffect(() => {
    void loadComments();
  }, [loadComments]);

  // So a manager's comment shows up here without the employee refreshing.
  useEffect(() => {
    const channel = supabase
      .channel(`task-comments-${task.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'task_comments', filter: `task_id=eq.${task.id}` },
        () => void loadComments()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [task.id, loadComments]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleSendComment = async () => {
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
      .insert({ task_id: task.id, sender_id: profile.id, comment_text });

    if (error) {
      setComments((prev) => prev.filter((c) => c.id !== tempId));
      setDraft(comment_text);
      setCommentsError('Could not send. Try again.');
    } else {
      await loadComments();
    }
    setSending(false);
  };

  const canAct = task.status === 'pending' || task.status === 'rejected';
  const readyToComplete = !task.requires_photo || photoFile !== null;

  const handleComplete = async () => {
    setCompleteFault(null);

    if (task.requires_photo && !photoFile) {
      setCompleteFault('Attach a photo first.');
      return;
    }

    setCompleting(true);

    try {
      let photoPath: string | null = null;

      if (task.requires_photo && photoFile) {
        photoPath = `${task.id}/${safeUuid()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from('task-photos')
          .upload(photoPath, photoFile, { contentType: photoFile.type || 'image/jpeg' });
        if (uploadError) throw uploadError;
      }

      const { data, error: updateError } = await supabase
        .from('tasks')
        .update({
          status: 'submitted',
          completed_by: profile.id,
          completed_at: new Date().toISOString(),
          ...(photoPath ? { photo_path: photoPath } : {}),
        })
        .eq('id', task.id)
        .in('status', ['pending', 'rejected'])
        .select(TASK_FIELDS)
        .maybeSingle<TaskRow>();

      if (updateError) throw updateError;

      if (data) {
        onCompleted(data);
        onClose();
        return;
      }

      // Zero rows matched — either someone else in the shared pool completed
      // it first, or this is a stale retry of a submit that already went
      // through for this same user (e.g. a double tap before the UI caught
      // up). Re-read the row to tell the two apart before reporting a loss.
      const { data: current, error: refetchError } = await supabase
        .from('tasks')
        .select(TASK_FIELDS)
        .eq('id', task.id)
        .maybeSingle<TaskRow>();

      if (refetchError) throw refetchError;

      if (current && current.completed_by === profile.id) {
        onCompleted(current);
        onClose();
        return;
      }

      onConflict();
    } catch (err) {
      setCompleteFault(err instanceof Error ? err.message : 'Could not submit the task.');
    } finally {
      setCompleting(false);
    }
  };

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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {task.status === 'rejected' && (
            <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <p className="text-danger">This task was rejected. Check the comments below, then redo it.</p>
            </div>
          )}
          {task.status === 'submitted' && (
            <div className="rounded-lg bg-warning-bg p-3 text-sm text-warning">
              Submitted{task.completed_at ? ` ${formatDateTime(task.completed_at)}` : ''} — waiting for a
              manager to review it.
            </div>
          )}
          {task.status === 'approved' && (
            <div className="rounded-lg bg-success-bg p-3 text-sm text-success">
              Approved{task.reviewed_at ? ` ${formatDateTime(task.reviewed_at)}` : ''}.
            </div>
          )}

          {task.description && <p className="whitespace-pre-wrap text-sm text-ink/80">{task.description}</p>}

          {canAct && (
            <div className="space-y-2 rounded-lg border border-border bg-bg p-3">
              {task.requires_photo && (
                <div>
                  <label htmlFor="task-photo-input" className="block text-xs font-medium text-ink/60">
                    Photo required
                  </label>
                  <input
                    id="task-photo-input"
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                    className="mt-1.5 block w-full text-xs text-ink/70 file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-primary-dark"
                  />
                  {photoFile && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-success">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {photoFile.name}
                    </p>
                  )}
                </div>
              )}

              {completeFault && <p className="text-sm text-danger">{completeFault}</p>}

              <button
                type="button"
                onClick={() => void handleComplete()}
                disabled={completing || !readyToComplete}
                className="inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
              >
                {completing ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                Mark done
              </button>
            </div>
          )}

          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-ink/50">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              Comments
            </h3>

            {commentsLoading ? (
              <div className="mt-2 flex items-center gap-2 text-sm text-ink/60">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading…
              </div>
            ) : commentsError ? (
              <p className="mt-2 text-sm text-danger">{commentsError}</p>
            ) : comments.length === 0 ? (
              <p className="mt-2 text-sm text-ink/60">No comments yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {comments.map((c) => (
                  <li key={c.id} className="rounded-lg bg-bg px-3 py-2">
                    <p className="text-sm text-ink">{c.comment_text}</p>
                    <p className="mt-0.5 text-xs text-ink/50">
                      {c.sender?.full_name ?? c.sender?.first_name ?? 'Unknown'} · {formatDateTime(c.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <label htmlFor="task-comment-input" className="sr-only">
            Add a comment
          </label>
          <input
            id="task-comment-input"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSendComment();
            }}
            placeholder="Add a comment"
            className="min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
          <button
            type="button"
            onClick={() => void handleSendComment()}
            disabled={sending || !draft.trim()}
            aria-label="Send comment"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
