import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  Clock,
  ClipboardCheck,
  ClipboardList,
  Loader2,
  Plus,
  Repeat,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useRoles, type Role } from '../hooks/useRoles';
import CollapsibleSection from './CollapsibleSection';

type TaskStatus = 'pending' | 'submitted' | 'approved' | 'rejected';
type Recurrence = 'daily' | 'weekly';
type Target = 'role' | 'individual';

interface StaffLite {
  id: string;
  first_name: string | null;
  full_name: string | null;
}

interface SubmittedTask {
  id: string;
  title: string;
  description: string | null;
  photo_path: string | null;
  completed_at: string | null;
  status: TaskStatus;
  locations: { name: string } | null;
  completer: { first_name: string | null; full_name: string | null } | null;
}

interface TemplateRow {
  id: string;
  title: string;
  description: string | null;
  location_id: string | null;
  assigned_role: string | null;
  assigned_user_id: string | null;
  requires_photo: boolean;
  recurrence: Recurrence;
  weekdays: number[] | null;
  start_at: string;
  due_at: string;
  is_active: boolean;
  locations: { name: string } | null;
  assignee: StaffLite | null;
}

const REVIEW_FIELDS =
  'id, title, description, photo_path, completed_at, status, locations ( name ), completer:completed_by ( first_name, full_name )';

const TEMPLATE_FIELDS =
  'id, title, description, location_id, assigned_role, assigned_user_id, requires_photo, recurrence, weekdays, start_at, due_at, is_active, locations ( name ), assignee:assigned_user_id ( first_name, full_name )';

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

function nameOf(p: { first_name: string | null; full_name: string | null } | null): string {
  return p?.full_name ?? p?.first_name ?? 'Unknown';
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatHhmm(value: string): string {
  return value.slice(0, 5);
}

function weekdayLabel(weekdays: number[] | null): string {
  if (!weekdays || weekdays.length === 0) return '';
  return WEEKDAYS.filter((w) => weekdays.includes(w.value))
    .map((w) => w.short)
    .join(', ');
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;
}

/** Built from calendar fields, not epoch arithmetic, so it stays correct across DST. */
function toUtcIso(dateKey: string, hhmm: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

export default function ManagerTasks({
  locations,
}: {
  locations: Array<{ id: string; name: string }>;
}): ReactNode {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setUserId(user?.id ?? null);
    })();
  }, []);

  return (
    <div className="space-y-4">
      <ReviewSection userId={userId} />
      <TaskSetupSection userId={userId} locations={locations} />
    </div>
  );
}

// ===========================================================================
// Section 1 — Review queue
// ===========================================================================

function ReviewSection({ userId }: { userId: string | null }): ReactNode {
  const [tasks, setTasks] = useState<SubmittedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; comment: string; fault: string | null } | null>(
    null
  );
  const fetchedPaths = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('tasks')
      .select(REVIEW_FIELDS)
      .eq('status', 'submitted')
      .order('completed_at', { ascending: true })
      .returns<SubmittedTask[]>();

    if (queryError) setError('The review queue could not be loaded.');
    else setTasks(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel('manager-tasks-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  useEffect(() => {
    const toFetch = tasks
      .map((t) => t.photo_path)
      .filter((p): p is string => Boolean(p) && !fetchedPaths.current.has(p));
    if (toFetch.length === 0) return;
    toFetch.forEach((p) => fetchedPaths.current.add(p));

    void (async () => {
      const results = await Promise.all(
        toFetch.map(async (path) => {
          const { data } = await supabase.storage.from('task-photos').createSignedUrl(path, 3600);
          return [path, data?.signedUrl ?? null] as const;
        })
      );
      setSignedUrls((prev) => {
        const next = { ...prev };
        for (const [path, url] of results) if (url) next[path] = url;
        return next;
      });
    })();
  }, [tasks]);

  useEffect(() => {
    if (!lightboxUrl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxUrl(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [lightboxUrl]);

  const approve = async (task: SubmittedTask) => {
    if (!userId) return;
    setBusyId(task.id);
    setFault(null);
    const { error: updateError } = await supabase
      .from('tasks')
      .update({ status: 'approved', reviewed_by: userId, reviewed_at: new Date().toISOString() })
      .eq('id', task.id);
    if (updateError) setFault(updateError.message || 'Could not approve this task.');
    else await load();
    setBusyId(null);
  };

  const confirmReject = async () => {
    if (!rejecting || !userId) return;
    const comment_text = rejecting.comment.trim();
    if (!comment_text) {
      setRejecting({ ...rejecting, fault: 'Explain what needs to change before rejecting.' });
      return;
    }

    setBusyId(rejecting.id);

    // Comment first: if the status update then fails, the task is still
    // "submitted" rather than silently rejected with no explanation on record.
    const { error: commentError } = await supabase
      .from('task_comments')
      .insert({ task_id: rejecting.id, sender_id: userId, comment_text });
    if (commentError) {
      setRejecting({ ...rejecting, fault: commentError.message || 'Could not save the comment.' });
      setBusyId(null);
      return;
    }

    const { error: updateError } = await supabase
      .from('tasks')
      .update({ status: 'rejected', reviewed_by: userId, reviewed_at: new Date().toISOString() })
      .eq('id', rejecting.id);
    if (updateError) {
      setRejecting({
        ...rejecting,
        fault: 'The comment was saved, but the task could not be marked rejected. Try again.',
      });
      setBusyId(null);
      return;
    }

    setRejecting(null);
    await load();
    setBusyId(null);
  };

  return (
    <div>
    <CollapsibleSection
      title="Review"
      icon={ClipboardCheck}
      count={
        tasks.length > 0 && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
            {tasks.length}
          </span>
        )
      }
      defaultOpen={tasks.length > 0}
    >
          {fault && <p className="mb-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-ink/60">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading submissions…
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-ink/60">Nothing waiting on review.</p>
          ) : (
            <ul className="space-y-3">
              {tasks.map((task) => {
                const isRejecting = rejecting?.id === task.id;
                const url = task.photo_path ? signedUrls[task.photo_path] : undefined;

                return (
                  <li key={task.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-start gap-3">
                      {task.photo_path && (
                        <button
                          type="button"
                          onClick={() => url && setLightboxUrl(url)}
                          disabled={!url}
                          aria-label="View submitted photo"
                          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-bg"
                        >
                          {url ? (
                            <img src={url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <Loader2 className="h-4 w-4 animate-spin text-ink/40" aria-hidden="true" />
                          )}
                        </button>
                      )}

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">{task.title}</p>
                        <p className="mt-0.5 text-xs text-ink/60">
                          {nameOf(task.completer)} · {task.locations?.name ?? 'No location'}
                        </p>
                        {task.completed_at && (
                          <p className="mt-0.5 text-xs text-ink/50">
                            Submitted {formatDateTime(task.completed_at)}
                          </p>
                        )}
                      </div>
                    </div>

                    {isRejecting ? (
                      <div className="mt-3 space-y-2 rounded-lg bg-bg p-3">
                        <label htmlFor={`reject-comment-${task.id}`} className="block text-xs font-medium text-ink/60">
                          What needs to change? (required)
                        </label>
                        <textarea
                          id={`reject-comment-${task.id}`}
                          value={rejecting.comment}
                          onChange={(e) => setRejecting({ ...rejecting, comment: e.target.value, fault: null })}
                          rows={2}
                          autoFocus
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                        {rejecting.fault && <p className="text-xs text-danger">{rejecting.fault}</p>}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void confirmReject()}
                            disabled={busyId === task.id}
                            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                          >
                            {busyId === task.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            Confirm rejection
                          </button>
                          <button
                            type="button"
                            onClick={() => setRejecting(null)}
                            disabled={busyId === task.id}
                            className="min-h-[44px] rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-surface"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => void approve(task)}
                          disabled={busyId === task.id || !userId}
                          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                        >
                          {busyId === task.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejecting({ id: task.id, comment: '', fault: null })}
                          disabled={busyId === task.id}
                          className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg disabled:opacity-60"
                        >
                          Request changes
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
    </CollapsibleSection>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            aria-label="Close photo"
            className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
          <img
            src={lightboxUrl}
            alt=""
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Section 2 — Task setup
// ===========================================================================

function TaskSetupSection({
  userId,
  locations,
}: {
  userId: string | null;
  locations: Array<{ id: string; name: string }>;
}): ReactNode {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);

  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [showOneOffForm, setShowOneOffForm] = useState(false);

  const loadTemplates = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('task_templates')
      .select(TEMPLATE_FIELDS)
      .order('title')
      .returns<TemplateRow[]>();

    if (queryError) setError('Task templates could not be loaded.');
    else setTemplates(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('id, first_name, full_name')
        .eq('is_active', true)
        .order('full_name')
        .returns<StaffLite[]>();
      setStaff(data ?? []);
      setStaffLoading(false);
    })();
  }, []);

  const toggleActive = async (template: TemplateRow) => {
    setBusyId(template.id);
    setFault(null);
    const { error: updateError } = await supabase
      .from('task_templates')
      .update({ is_active: !template.is_active })
      .eq('id', template.id);
    if (updateError) setFault(updateError.message || 'Could not update the template.');
    else await loadTemplates();
    setBusyId(null);
  };

  const deleteTemplate = async (template: TemplateRow) => {
    setBusyId(template.id);
    setFault(null);
    const { error: deleteError } = await supabase.from('task_templates').delete().eq('id', template.id);
    if (deleteError) setFault(deleteError.message || 'Could not delete the template.');
    else await loadTemplates();
    setConfirmDeleteId(null);
    setBusyId(null);
  };

  return (
    <div>
    <CollapsibleSection
      title="Task setup"
      icon={ClipboardList}
      count={<span className="text-xs text-ink/50">{templates.length}</span>}
    >
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowTemplateForm(true)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New template
            </button>
            <button
              type="button"
              onClick={() => setShowOneOffForm(true)}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink hover:bg-bg"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              One-off task
            </button>
          </div>

          {fault && <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>}

          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading templates…
            </div>
          ) : error ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </div>
          ) : templates.length === 0 ? (
            <p className="mt-4 text-sm text-ink/60">No task templates yet.</p>
          ) : (
            <ul className="mt-4 space-y-2">
              {templates.map((template) => (
                <li
                  key={template.id}
                  className={`rounded-xl border border-border p-3 ${template.is_active ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium text-ink">{template.title}</p>
                        {template.requires_photo && (
                          <Camera className="h-3.5 w-3.5 shrink-0 text-ink/40" aria-hidden="true" />
                        )}
                      </div>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-ink/60">
                        {template.assigned_role ? (
                          <span className="inline-flex items-center gap-1">
                            <Users className="h-3 w-3" aria-hidden="true" />
                            {template.assigned_role}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <User className="h-3 w-3" aria-hidden="true" />
                            {nameOf(template.assignee)}
                          </span>
                        )}
                        <span>·</span>
                        <span>{template.locations?.name ?? 'No location'}</span>
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs tabular-nums text-ink/50">
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        {formatHhmm(template.start_at)}–{formatHhmm(template.due_at)}
                        <Repeat className="ml-1.5 h-3 w-3" aria-hidden="true" />
                        {template.recurrence === 'daily' ? 'Daily' : weekdayLabel(template.weekdays) || 'Weekly'}
                      </p>
                    </div>
                  </div>

                  {confirmDeleteId === template.id ? (
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-danger-bg p-2">
                      <p className="flex-1 text-xs text-danger">Delete this template permanently?</p>
                      <button
                        type="button"
                        onClick={() => void deleteTemplate(template)}
                        disabled={busyId === template.id}
                        className="min-h-[36px] rounded-lg bg-danger px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        {busyId === template.id ? '…' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="min-h-[36px] rounded-lg px-2.5 py-1 text-xs font-medium text-ink/70 hover:bg-surface"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void toggleActive(template)}
                        disabled={busyId === template.id}
                        aria-pressed={template.is_active}
                        className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-60 ${
                          template.is_active
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-ink/60 hover:border-primary/40'
                        }`}
                      >
                        {busyId === template.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {template.is_active ? 'Active' : 'Paused'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(template.id)}
                        disabled={busyId === template.id}
                        aria-label={`Delete ${template.title}`}
                        className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg text-danger hover:bg-danger-bg disabled:opacity-60"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
    </CollapsibleSection>

      {showTemplateForm && (
        <TemplateFormModal
          userId={userId}
          locations={locations}
          staff={staff}
          staffLoading={staffLoading}
          onClose={() => setShowTemplateForm(false)}
          onSaved={async () => {
            setShowTemplateForm(false);
            await loadTemplates();
          }}
        />
      )}

      {showOneOffForm && (
        <OneOffFormModal
          userId={userId}
          locations={locations}
          staff={staff}
          staffLoading={staffLoading}
          onClose={() => setShowOneOffForm(false)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Shared target picker (role vs individual)
// ===========================================================================

function TargetPicker({
  target,
  onTargetChange,
  role,
  onRoleChange,
  roles,
  rolesLoading,
  staffId,
  onStaffChange,
  staff,
  staffLoading,
}: {
  target: Target;
  onTargetChange: (t: Target) => void;
  role: string;
  onRoleChange: (r: string) => void;
  roles: Role[];
  rolesLoading: boolean;
  staffId: string;
  onStaffChange: (id: string) => void;
  staff: StaffLite[];
  staffLoading: boolean;
}): ReactNode {
  return (
    <div>
      <p className="block text-sm font-medium text-ink">Assign to</p>
      <div className="mt-1.5 inline-flex rounded-lg border border-border p-0.5">
        <button
          type="button"
          onClick={() => onTargetChange('role')}
          aria-pressed={target === 'role'}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
            target === 'role' ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Role
        </button>
        <button
          type="button"
          onClick={() => onTargetChange('individual')}
          aria-pressed={target === 'individual'}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
            target === 'individual' ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          <User className="h-3.5 w-3.5" aria-hidden="true" />
          Individual
        </button>
      </div>

      <div className="mt-2">
        {target === 'role' ? (
          <select
            aria-label="Role"
            value={role}
            onChange={(e) => onRoleChange(e.target.value)}
            disabled={rolesLoading || roles.length === 0}
            className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.name}>{r.name}</option>
            ))}
          </select>
        ) : (
          <select
            aria-label="Staff member"
            value={staffId}
            onChange={(e) => onStaffChange(e.target.value)}
            disabled={staffLoading || staff.length === 0}
            className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.full_name ?? s.first_name ?? 'Unnamed'}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function WeekdayPicker({ selected, onToggle }: { selected: number[]; onToggle: (value: number) => void }): ReactNode {
  return (
    <div className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((day) => (
        <button
          key={day.value}
          type="button"
          onClick={() => onToggle(day.value)}
          aria-pressed={selected.includes(day.value)}
          className={`inline-flex min-h-[38px] min-w-[44px] items-center justify-center rounded-lg border px-2 text-xs font-semibold transition ${
            selected.includes(day.value)
              ? 'border-primary bg-primary text-white'
              : 'border-border text-ink/70 hover:border-primary/40'
          }`}
        >
          {day.short}
        </button>
      ))}
    </div>
  );
}

function PhotoToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): ReactNode {
  return (
    <div>
      <p className="block text-sm font-medium text-ink">Photo required</p>
      <div className="mt-1.5 inline-flex rounded-lg border border-border p-0.5">
        <button
          type="button"
          onClick={() => onChange(true)}
          aria-pressed={value}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
            value ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          <Camera className="h-3.5 w-3.5" aria-hidden="true" />
          Yes
        </button>
        <button
          type="button"
          onClick={() => onChange(false)}
          aria-pressed={!value}
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
            !value ? 'bg-primary text-white' : 'text-ink/70 hover:bg-bg'
          }`}
        >
          No
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Create template modal
// ===========================================================================

function TemplateFormModal({
  userId,
  locations,
  staff,
  staffLoading,
  onClose,
  onSaved,
}: {
  userId: string | null;
  locations: Array<{ id: string; name: string }>;
  staff: StaffLite[];
  staffLoading: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const { roles, loading: rolesLoading } = useRoles();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [target, setTarget] = useState<Target>('role');
  const [role, setRole] = useState('');
  const [staffId, setStaffId] = useState('');
  const [startAt, setStartAt] = useState('09:00');
  const [dueAt, setDueAt] = useState('17:00');
  const [recurrence, setRecurrence] = useState<Recurrence>('daily');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [requiresPhoto, setRequiresPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    if (roles.length > 0 && !role) setRole(roles[0].name);
  }, [roles, role]);

  useEffect(() => {
    if (staff.length > 0 && !staffId) setStaffId(staff[0].id);
  }, [staff, staffId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleWeekday = (value: number) => {
    setWeekdays((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const handleSave = async () => {
    setFault(null);

    if (!title.trim()) return setFault('Enter a title.');
    if (!locationId) return setFault('Choose a location.');
    if (target === 'role' && !role) return setFault('Choose a role.');
    if (target === 'individual' && !staffId) return setFault('Choose a staff member.');
    if (startAt >= dueAt) return setFault('Due time must be after the start time.');
    if (recurrence === 'weekly' && weekdays.length === 0) return setFault('Pick at least one day.');
    if (!userId) return setFault('Your session has expired. Sign in again.');

    setSaving(true);
    const { error } = await supabase.from('task_templates').insert({
      title: title.trim(),
      description: description.trim() || null,
      location_id: locationId,
      assigned_role: target === 'role' ? role : null,
      assigned_user_id: target === 'individual' ? staffId : null,
      requires_photo: requiresPhoto,
      recurrence,
      weekdays: recurrence === 'weekly' ? [...weekdays].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
      start_at: startAt,
      due_at: dueAt,
      is_active: true,
      created_by: userId,
    });

    if (error) {
      setFault(error.message || 'Could not save the template.');
      setSaving(false);
      return;
    }

    await onSaved();
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-modal-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="template-modal-title" className="text-base font-semibold text-ink">New task template</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <div>
            <label htmlFor="tmpl-title" className="block text-sm font-medium text-ink">Title</label>
            <input
              id="tmpl-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <label htmlFor="tmpl-description" className="block text-sm font-medium text-ink">
              Description <span className="font-normal text-ink/50">(optional)</span>
            </label>
            <textarea
              id="tmpl-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <label htmlFor="tmpl-location" className="block text-sm font-medium text-ink">Location</label>
            <select
              id="tmpl-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <TargetPicker
            target={target}
            onTargetChange={setTarget}
            role={role}
            onRoleChange={setRole}
            roles={roles}
            rolesLoading={rolesLoading}
            staffId={staffId}
            onStaffChange={setStaffId}
            staff={staff}
            staffLoading={staffLoading}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="tmpl-start" className="block text-sm font-medium text-ink">Start</label>
              <input
                id="tmpl-start"
                type="time"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="tmpl-due" className="block text-sm font-medium text-ink">Due</label>
              <input
                id="tmpl-due"
                type="time"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums"
              />
            </div>
          </div>

          <div>
            <label htmlFor="tmpl-recurrence" className="block text-sm font-medium text-ink">Repeats</label>
            <select
              id="tmpl-recurrence"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as Recurrence)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          {recurrence === 'weekly' && (
            <div>
              <p className="block text-sm font-medium text-ink">On these days</p>
              <div className="mt-1.5">
                <WeekdayPicker selected={weekdays} onToggle={toggleWeekday} />
              </div>
            </div>
          )}

          <PhotoToggle value={requiresPhoto} onChange={setRequiresPhoto} />

          {fault && (
            <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
              <p className="text-danger">{fault}</p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-border px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Save template
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Create one-off task modal
// ===========================================================================

function OneOffFormModal({
  userId,
  locations,
  staff,
  staffLoading,
  onClose,
}: {
  userId: string | null;
  locations: Array<{ id: string; name: string }>;
  staff: StaffLite[];
  staffLoading: boolean;
  onClose: () => void;
}): ReactNode {
  const { roles, loading: rolesLoading } = useRoles();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [target, setTarget] = useState<Target>('role');
  const [role, setRole] = useState('');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(() => localDateKey(new Date()));
  const [startTime, setStartTime] = useState('09:00');
  const [dueTime, setDueTime] = useState('17:00');
  const [requiresPhoto, setRequiresPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (roles.length > 0 && !role) setRole(roles[0].name);
  }, [roles, role]);

  useEffect(() => {
    if (staff.length > 0 && !staffId) setStaffId(staff[0].id);
  }, [staff, staffId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleSave = async () => {
    setFault(null);

    if (!title.trim()) return setFault('Enter a title.');
    if (!locationId) return setFault('Choose a location.');
    if (target === 'role' && !role) return setFault('Choose a role.');
    if (target === 'individual' && !staffId) return setFault('Choose a staff member.');
    if (!date) return setFault('Choose a date.');
    if (startTime >= dueTime) return setFault('Due time must be after the start time.');
    if (!userId) return setFault('Your session has expired. Sign in again.');

    setSaving(true);
    const { error } = await supabase.from('tasks').insert({
      template_id: null,
      title: title.trim(),
      description: description.trim() || null,
      location_id: locationId,
      assigned_role: target === 'role' ? role : null,
      assigned_user_id: target === 'individual' ? staffId : null,
      start_time: toUtcIso(date, startTime),
      due_time: toUtcIso(date, dueTime),
      requires_photo: requiresPhoto,
      status: 'pending',
      created_by: userId,
    });

    if (error) {
      setFault(error.message || 'Could not create the task.');
      setSaving(false);
      return;
    }

    setSuccess(true);
    setSaving(false);
    setTitle('');
    setDescription('');
  };

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="oneoff-modal-title"
        className="flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="oneoff-modal-title" className="text-base font-semibold text-ink">One-off task</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink/50 hover:bg-bg hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {success ? (
          <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success-bg">
              <Check className="h-6 w-6 text-success" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-ink">Task created</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setSuccess(false)}
                className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink hover:bg-bg"
              >
                Add another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              <div>
                <label htmlFor="oneoff-title" className="block text-sm font-medium text-ink">Title</label>
                <input
                  id="oneoff-title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>

              <div>
                <label htmlFor="oneoff-description" className="block text-sm font-medium text-ink">
                  Description <span className="font-normal text-ink/50">(optional)</span>
                </label>
                <textarea
                  id="oneoff-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>

              <div>
                <label htmlFor="oneoff-location" className="block text-sm font-medium text-ink">Location</label>
                <select
                  id="oneoff-location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              </div>

              <TargetPicker
                target={target}
                onTargetChange={setTarget}
                role={role}
                onRoleChange={setRole}
                roles={roles}
                rolesLoading={rolesLoading}
                staffId={staffId}
                onStaffChange={setStaffId}
                staff={staff}
                staffLoading={staffLoading}
              />

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="oneoff-date" className="block text-sm font-medium text-ink">Date</label>
                  <input
                    id="oneoff-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="oneoff-start" className="block text-sm font-medium text-ink">Start</label>
                  <input
                    id="oneoff-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="oneoff-due" className="block text-sm font-medium text-ink">Due</label>
                  <input
                    id="oneoff-due"
                    type="time"
                    value={dueTime}
                    onChange={(e) => setDueTime(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-sm tabular-nums"
                  />
                </div>
              </div>

              <PhotoToggle value={requiresPhoto} onChange={setRequiresPhoto} />

              {fault && (
                <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                  <p className="text-danger">{fault}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-border px-5 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                Create task
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
