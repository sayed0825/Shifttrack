import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  Camera,
  Check,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
  Clock,
  ClipboardCheck,
  ClipboardList,
  Filter,
  History,
  Loader2,
  MapPin,
  Plus,
  Repeat,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { safeUuid } from '../lib/ids';
import { useRoles, type Role } from '../hooks/useRoles';
import { useManagedLocations } from '../hooks/useManagedLocations';
import { friendlyError } from '../lib/friendlyError';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import CollapsibleSection from './CollapsibleSection';
import FilterButton from './FilterButton';

// The item is the unit of work — submitted, reviewed, approved or
// rejected individually. task_templates/tasks are list containers: one
// title, one shared start/due time, one assignment, recurrence.
// task_template_items/task_items carry per-item title, description,
// is_required, requires_photo, max_photos, and (on task_items only)
// status/completion/review. Shared-pool semantics apply per item, against
// the list's own assignment.
type ItemStatus = 'pending' | 'submitted' | 'approved' | 'rejected';
type Recurrence = 'daily' | 'weekly';
type Target = 'role' | 'individual';

interface StaffLite {
  id: string;
  first_name: string | null;
  full_name: string | null;
}

interface TaskPhoto {
  id: string;
  storage_path: string;
}

interface NameRef {
  first_name: string | null;
  full_name: string | null;
}

// ---------------------------------------------------------------------------
// Item drafts — the create forms build one or more of these locally before
// they exist as rows, for both a template and a one-off list.
// ---------------------------------------------------------------------------

interface ItemDraft {
  key: string;
  title: string;
  description: string;
  isRequired: boolean;
  requiresPhoto: boolean;
  maxPhotos: number;
}

function newItemDraft(): ItemDraft {
  return { key: safeUuid(), title: '', description: '', isRequired: true, requiresPhoto: false, maxPhotos: 1 };
}

// ---------------------------------------------------------------------------
// Review queue — one row per submitted item, not per list.
// ---------------------------------------------------------------------------

interface SubmittedItem {
  id: string;
  title: string;
  description: string | null;
  completed_at: string | null;
  photos: TaskPhoto[];
  completer: NameRef | null;
  task: { title: string; locations: { name: string } | null } | null;
}

const REVIEW_FIELDS =
  'id, title, description, completed_at, ' +
  'completer:completed_by ( first_name, full_name ), ' +
  'photos:task_photos ( id, storage_path ), ' +
  'task:tasks ( title, locations ( name ) )';

// ---------------------------------------------------------------------------
// Templates — list-level fields, with their items embedded for display
// (item count, whether any item needs a photo).
// ---------------------------------------------------------------------------

interface TemplateItemLite {
  id: string;
  requires_photo: boolean;
}

interface TemplateRow {
  id: string;
  title: string;
  description: string | null;
  location_id: string | null;
  assigned_role: string | null;
  assigned_user_id: string | null;
  recurrence: Recurrence;
  weekdays: number[] | null;
  start_at: string;
  due_at: string;
  is_active: boolean;
  locations: { name: string } | null;
  assignee: StaffLite | null;
  items: TemplateItemLite[];
}

const TEMPLATE_FIELDS =
  'id, title, description, location_id, assigned_role, assigned_user_id, recurrence, weekdays, start_at, due_at, is_active, ' +
  'locations ( name ), assignee:assigned_user_id ( first_name, full_name ), ' +
  'items:task_template_items ( id, requires_photo )';

// ---------------------------------------------------------------------------
// History — one row per item, list context attached for display. Fetched
// as lists with items embedded (proven query shape, ordered/paginated at
// the list level) and flattened client-side, same place the existing role
// filter already happens client-side.
// ---------------------------------------------------------------------------

interface HistoryItem {
  id: string;
  title: string;
  status: ItemStatus;
  is_required: boolean;
  completed_at: string | null;
  reviewed_at: string | null;
  completer: NameRef | null;
  reviewer: NameRef | null;
  photos: TaskPhoto[];
}

interface HistoryTaskRow {
  id: string;
  title: string;
  task_day: string;
  assigned_role: string | null;
  locations: { name: string } | null;
  assignee: NameRef | null;
  items: HistoryItem[];
}

interface HistoryRow extends HistoryItem {
  task: HistoryTaskRow;
}

const HISTORY_PAGE_SIZE = 50;

const HISTORY_FIELDS =
  'id, title, task_day, assigned_role, locations ( name ), assignee:assigned_user_id ( first_name, full_name ), ' +
  'items:task_items ( id, title, status, is_required, completed_at, reviewed_at, ' +
  'completer:completed_by ( first_name, full_name ), reviewer:reviewed_by ( first_name, full_name ), ' +
  'photos:task_photos ( id, storage_path ) )';

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

function nameOf(p: NameRef | null): string {
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

function itemStatusClasses(status: ItemStatus): string {
  if (status === 'approved') return 'bg-success-bg text-success';
  if (status === 'rejected') return 'bg-danger-bg text-danger';
  if (status === 'submitted') return 'bg-warning-bg text-warning';
  return 'bg-bg text-ink/60';
}

export default function ManagerTasks({
  locations,
}: {
  locations: Array<{ id: string; name: string }>;
}): ReactNode {
  const [userId, setUserId] = useState<string | null>(null);
  const { locationIds: managedLocationIds } = useManagedLocations();
  const managedLocationSet = useMemo(() => new Set(managedLocationIds), [managedLocationIds]);
  // Never offer a location the database would reject the viewer for
  // choosing. An Administrator manages every org location, so this is a
  // no-op for them.
  const visibleLocations = useMemo(
    () => locations.filter((l) => managedLocationSet.has(l.id)),
    [locations, managedLocationSet]
  );

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
      <TaskSetupSection userId={userId} locations={visibleLocations} />
      <HistorySection locations={visibleLocations} />
    </div>
  );
}

// ===========================================================================
// Shared photo lightbox
// ===========================================================================

function PhotoLightbox({
  urls,
  initialIndex = 0,
  onClose,
}: {
  urls: string[];
  initialIndex?: number;
  onClose: () => void;
}): ReactNode {
  const [index, setIndex] = useState(Math.min(initialIndex, urls.length - 1));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (event.key === 'ArrowRight') setIndex((i) => Math.min(urls.length - 1, i + 1));
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, urls.length]);

  useEffect(() => resetDocumentScroll, []);

  if (urls.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="absolute right-4 top-4 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>

      {urls.length > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.max(0, i - 1));
            }}
            disabled={index === 0}
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 sm:left-4"
          >
            <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIndex((i) => Math.min(urls.length - 1, i + 1));
            }}
            disabled={index === urls.length - 1}
            aria-label="Next photo"
            className="absolute right-2 top-1/2 flex min-h-[44px] min-w-[44px] -translate-y-1/2 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/20 disabled:opacity-30 sm:right-4"
          >
            <ChevronRightIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-1 text-xs font-medium text-white">
            {index + 1} of {urls.length}
          </p>
        </>
      )}

      <img
        src={urls[index]}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

// ===========================================================================
// Section 1 — Review queue (per item)
// ===========================================================================

function ReviewSection({ userId }: { userId: string | null }): ReactNode {
  const [items, setItems] = useState<SubmittedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; comment: string; fault: string | null } | null>(
    null
  );
  const fetchedPaths = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    const { data, error: queryError } = await supabase
      .from('task_items')
      .select(REVIEW_FIELDS)
      .eq('status', 'submitted')
      .order('completed_at', { ascending: true })
      .returns<SubmittedItem[]>();

    if (queryError) setError('The review queue could not be loaded.');
    else setItems(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel('manager-tasks-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_items' }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  useEffect(() => {
    const toFetch = items
      .flatMap((t) => t.photos.map((p) => p.storage_path))
      .filter((p) => !fetchedPaths.current.has(p));
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
  }, [items]);

  const approve = async (item: SubmittedItem) => {
    if (!userId) return;
    setBusyId(item.id);
    setFault(null);
    const { error: updateError } = await supabase
      .from('task_items')
      .update({ status: 'approved', reviewed_by: userId, reviewed_at: new Date().toISOString() })
      .eq('id', item.id);
    if (updateError) setFault(friendlyError(updateError, 'Could not approve this item.'));
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

    // Comment first: if the status update then fails, the item is still
    // "submitted" rather than silently rejected with no explanation on record.
    const { error: commentError } = await supabase
      .from('task_comments')
      .insert({ task_item_id: rejecting.id, sender_id: userId, comment_text });
    if (commentError) {
      setRejecting({ ...rejecting, fault: friendlyError(commentError, 'Could not save the comment.') });
      setBusyId(null);
      return;
    }

    const { error: updateError } = await supabase
      .from('task_items')
      .update({ status: 'rejected', reviewed_by: userId, reviewed_at: new Date().toISOString() })
      .eq('id', rejecting.id);
    if (updateError) {
      setRejecting({
        ...rejecting,
        fault: 'The comment was saved, but the item could not be marked rejected. Try again.',
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
        items.length > 0 && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">
            {items.length}
          </span>
        )
      }
      defaultOpen={items.length > 0}
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
          ) : items.length === 0 ? (
            <p className="text-sm text-ink/60">Nothing waiting on review.</p>
          ) : (
            <ul className="space-y-3">
              {items.map((item) => {
                const isRejecting = rejecting?.id === item.id;
                const urls = item.photos.map((p) => signedUrls[p.storage_path]).filter((u): u is string => Boolean(u));
                const stillLoading = item.photos.length > 0 && urls.length === 0;

                return (
                  <li key={item.id} className="rounded-lg border border-border p-3">
                    <div className="flex items-start gap-3">
                      {item.photos.length > 0 && (
                        <button
                          type="button"
                          onClick={() => urls.length > 0 && setLightbox({ urls, index: 0 })}
                          disabled={urls.length === 0}
                          aria-label="View submitted photos"
                          className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-bg"
                        >
                          {stillLoading ? (
                            <Loader2 className="h-4 w-4 animate-spin text-ink/40" aria-hidden="true" />
                          ) : (
                            <img src={urls[0]} alt="" className="h-full w-full object-cover" />
                          )}
                          {item.photos.length > 1 && (
                            <span className="absolute bottom-0.5 right-0.5 rounded-full bg-black/60 px-1 text-[10px] font-semibold text-white">
                              {item.photos.length}
                            </span>
                          )}
                        </button>
                      )}

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">
                          {item.task ? `${item.task.title} — ${item.title}` : item.title}
                        </p>
                        <p className="mt-0.5 text-xs text-ink/60">
                          {nameOf(item.completer)} · {item.task?.locations?.name ?? 'No location'}
                        </p>
                        {item.completed_at && (
                          <p className="mt-0.5 text-xs text-ink/50">
                            Submitted {formatDateTime(item.completed_at)}
                          </p>
                        )}
                      </div>
                    </div>

                    {isRejecting ? (
                      <div className="mt-3 space-y-2 rounded-lg bg-bg p-3">
                        <label htmlFor={`reject-comment-${item.id}`} className="block text-xs font-medium text-ink/60">
                          What needs to change? (required)
                        </label>
                        <textarea
                          id={`reject-comment-${item.id}`}
                          value={rejecting.comment}
                          onChange={(e) => setRejecting({ ...rejecting, comment: e.target.value, fault: null })}
                          rows={2}
                          autoFocus
                          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        />
                        {rejecting.fault && <p className="text-xs text-danger">{rejecting.fault}</p>}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void confirmReject()}
                            disabled={busyId === item.id}
                            className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-danger px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
                          >
                            {busyId === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <X className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            Confirm rejection
                          </button>
                          <button
                            type="button"
                            onClick={() => setRejecting(null)}
                            disabled={busyId === item.id}
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
                          onClick={() => void approve(item)}
                          disabled={busyId === item.id || !userId}
                          className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                        >
                          {busyId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejecting({ id: item.id, comment: '', fault: null })}
                          disabled={busyId === item.id}
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

      {lightbox && (
        <PhotoLightbox urls={lightbox.urls} initialIndex={lightbox.index} onClose={() => setLightbox(null)} />
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
        // Someone who has not accepted their invite yet cannot sign in, so
        // cannot be assigned a task.
        .not('accepted_at', 'is', null)
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
    if (updateError) setFault(friendlyError(updateError, 'Could not update the template.'));
    else await loadTemplates();
    setBusyId(null);
  };

  const deleteTemplate = async (template: TemplateRow) => {
    setBusyId(template.id);
    setFault(null);
    const { error: deleteError } = await supabase.from('task_templates').delete().eq('id', template.id);
    if (deleteError) setFault(friendlyError(deleteError, 'Could not delete the template.'));
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
                  className={`rounded-lg border border-border p-3 ${template.is_active ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium text-ink">{template.title}</p>
                        {template.items.some((i) => i.requires_photo) && (
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
                        <span>·</span>
                        <span>{template.items.length} item{template.items.length === 1 ? '' : 's'}</span>
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
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
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
          className={`inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
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
            className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
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
            className="min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm disabled:cursor-not-allowed disabled:opacity-60"
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

// ===========================================================================
// Items editor — shared by the template and one-off forms. At least one
// item is required; the last remaining one can't be removed.
// ===========================================================================

function ItemsEditor({
  items,
  onChange,
}: {
  items: ItemDraft[];
  onChange: (items: ItemDraft[]) => void;
}): ReactNode {
  const update = (key: string, patch: Partial<ItemDraft>) =>
    onChange(items.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  const remove = (key: string) => onChange(items.filter((it) => it.key !== key));
  const add = () => onChange([...items, newItemDraft()]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-ink">Items</p>
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-dark"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add item
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {items.map((item, index) => (
          <div key={item.key} className="rounded-lg border border-border p-2.5">
            <div className="flex items-start gap-2">
              <span className="mt-2.5 shrink-0 text-xs tabular-nums text-ink/40">{index + 1}.</span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <input
                  type="text"
                  value={item.title}
                  onChange={(e) => update(item.key, { title: e.target.value })}
                  placeholder="Item title"
                  aria-label={`Item ${index + 1} title`}
                  className="min-h-[40px] w-full rounded-lg border border-border px-2.5 py-1.5 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <textarea
                  value={item.description}
                  onChange={(e) => update(item.key, { description: e.target.value })}
                  placeholder="Description (optional)"
                  aria-label={`Item ${index + 1} description`}
                  rows={1}
                  className="w-full rounded-lg border border-border px-2.5 py-1.5 text-base sm:text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => update(item.key, { isRequired: !item.isRequired })}
                    aria-pressed={item.isRequired}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                      item.isRequired
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-ink/60 hover:border-primary/40'
                    }`}
                  >
                    {item.isRequired ? 'Required' : 'Optional'}
                  </button>
                  <button
                    type="button"
                    onClick={() => update(item.key, { requiresPhoto: !item.requiresPhoto })}
                    aria-pressed={item.requiresPhoto}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition ${
                      item.requiresPhoto
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-ink/60 hover:border-primary/40'
                    }`}
                  >
                    <Camera className="h-3 w-3" aria-hidden="true" />
                    Photo{item.requiresPhoto ? ' required' : ''}
                  </button>
                  {item.requiresPhoto && (
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10}
                      value={item.maxPhotos}
                      onChange={(e) => {
                        const n = Math.round(Number(e.target.value));
                        if (Number.isFinite(n)) update(item.key, { maxPhotos: Math.min(10, Math.max(1, n)) });
                      }}
                      aria-label={`Item ${index + 1} max photos`}
                      className="w-14 rounded-lg border border-border px-1.5 py-1 text-[11px] tabular-nums"
                    />
                  )}
                </div>
              </div>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(item.key)}
                  aria-label={`Remove item ${index + 1}`}
                  className="mt-1 shrink-0 rounded-lg p-1.5 text-ink/40 hover:bg-danger-bg hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        ))}
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
  const [items, setItems] = useState<ItemDraft[]>(() => [newItemDraft()]);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    if (roles.length > 0 && !role) setRole(roles[0].name);
  }, [roles, role]);

  useEffect(() => {
    if (staff.length > 0 && !staffId) setStaffId(staff[0].id);
  }, [staff, staffId]);

  // Managed locations can still be loading when this modal opens, so the
  // initial useState default can miss them — backfill once they arrive
  // rather than leaving the picker stuck on no selection.
  useEffect(() => {
    if (locations.length > 0 && !locationId) setLocationId(locations[0].id);
  }, [locations, locationId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => resetDocumentScroll, []);

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
    if (items.some((it) => !it.title.trim())) return setFault('Every item needs a title.');
    if (!userId) return setFault('Your session has expired. Sign in again.');

    setSaving(true);

    const { data: template, error } = await supabase
      .from('task_templates')
      .insert({
        title: title.trim(),
        description: description.trim() || null,
        location_id: locationId,
        assigned_role: target === 'role' ? role : null,
        assigned_user_id: target === 'individual' ? staffId : null,
        recurrence,
        weekdays: recurrence === 'weekly' ? [...weekdays].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
        start_at: startAt,
        due_at: dueAt,
        is_active: true,
        created_by: userId,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !template) {
      setFault(friendlyError(error, 'Could not save the template.'));
      setSaving(false);
      return;
    }

    const { error: itemsError } = await supabase.from('task_template_items').insert(
      items.map((it, index) => ({
        template_id: template.id,
        title: it.title.trim(),
        description: it.description.trim() || null,
        sort_order: index,
        is_required: it.isRequired,
        requires_photo: it.requiresPhoto,
        max_photos: it.requiresPhoto ? it.maxPhotos : 1,
      }))
    );

    if (itemsError) {
      // Best-effort cleanup — a template with no items generates nothing
      // (see generate_task_instances), so leaving it behind is harmless
      // even if this delete itself fails, but worth trying.
      await supabase.from('task_templates').delete().eq('id', template.id);
      setFault(friendlyError(itemsError, 'Could not save the template items.'));
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
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <label htmlFor="tmpl-location" className="block text-sm font-medium text-ink">Location</label>
            <select
              id="tmpl-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
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
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums"
              />
            </div>
            <div>
              <label htmlFor="tmpl-due" className="block text-sm font-medium text-ink">Due</label>
              <input
                id="tmpl-due"
                type="time"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums"
              />
            </div>
          </div>

          <div>
            <label htmlFor="tmpl-recurrence" className="block text-sm font-medium text-ink">Repeats</label>
            <select
              id="tmpl-recurrence"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as Recurrence)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
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

          <ItemsEditor items={items} onChange={setItems} />

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
  const [items, setItems] = useState<ItemDraft[]>(() => [newItemDraft()]);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (roles.length > 0 && !role) setRole(roles[0].name);
  }, [roles, role]);

  useEffect(() => {
    if (staff.length > 0 && !staffId) setStaffId(staff[0].id);
  }, [staff, staffId]);

  // Managed locations can still be loading when this modal opens, so the
  // initial useState default can miss them — backfill once they arrive
  // rather than leaving the picker stuck on no selection.
  useEffect(() => {
    if (locations.length > 0 && !locationId) setLocationId(locations[0].id);
  }, [locations, locationId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => resetDocumentScroll, []);

  const handleSave = async () => {
    setFault(null);

    if (!title.trim()) return setFault('Enter a title.');
    if (!locationId) return setFault('Choose a location.');
    if (target === 'role' && !role) return setFault('Choose a role.');
    if (target === 'individual' && !staffId) return setFault('Choose a staff member.');
    if (!date) return setFault('Choose a date.');
    if (startTime >= dueTime) return setFault('Due time must be after the start time.');
    if (items.some((it) => !it.title.trim())) return setFault('Every item needs a title.');
    if (!userId) return setFault('Your session has expired. Sign in again.');

    setSaving(true);

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        template_id: null,
        title: title.trim(),
        description: description.trim() || null,
        location_id: locationId,
        assigned_role: target === 'role' ? role : null,
        assigned_user_id: target === 'individual' ? staffId : null,
        start_time: toUtcIso(date, startTime),
        due_time: toUtcIso(date, dueTime),
        created_by: userId,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !task) {
      setFault(friendlyError(error, 'Could not create the task.'));
      setSaving(false);
      return;
    }

    const { error: itemsError } = await supabase.from('task_items').insert(
      items.map((it, index) => ({
        task_id: task.id,
        template_item_id: null,
        title: it.title.trim(),
        description: it.description.trim() || null,
        sort_order: index,
        is_required: it.isRequired,
        requires_photo: it.requiresPhoto,
        max_photos: it.requiresPhoto ? it.maxPhotos : 1,
      }))
    );

    if (itemsError) {
      await supabase.from('tasks').delete().eq('id', task.id);
      setFault(friendlyError(itemsError, 'Could not create the task items.'));
      setSaving(false);
      return;
    }

    setSuccess(true);
    setSaving(false);
    setTitle('');
    setDescription('');
    setItems([newItemDraft()]);
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
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
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
                  className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
              </div>

              <div>
                <label htmlFor="oneoff-location" className="block text-sm font-medium text-ink">Location</label>
                <select
                  id="oneoff-location"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border bg-surface px-3 py-2 text-base sm:text-sm"
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
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-base sm:text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="oneoff-start" className="block text-sm font-medium text-ink">Start</label>
                  <input
                    id="oneoff-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-base sm:text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="oneoff-due" className="block text-sm font-medium text-ink">Due</label>
                  <input
                    id="oneoff-due"
                    type="time"
                    value={dueTime}
                    onChange={(e) => setDueTime(e.target.value)}
                    className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-2 py-2 text-base sm:text-sm tabular-nums"
                  />
                </div>
              </div>

              <ItemsEditor items={items} onChange={setItems} />

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

// ===========================================================================
// Section 3 — History (per item, list context attached)
// ===========================================================================

function formatTaskDay(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function defaultHistoryStart(): string {
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return localDateKey(d);
}

type HistoryStatusFilter = 'all' | 'completed' | 'not_completed';

function HistorySection({ locations }: { locations: Array<{ id: string; name: string }> }): ReactNode {
  const { roles, loading: rolesLoading } = useRoles();

  const [startDate, setStartDate] = useState(defaultHistoryStart);
  const [endDate, setEndDate] = useState(() => localDateKey(new Date()));
  const [selectedLocations, setSelectedLocations] = useState<Set<string>>(new Set());
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<HistoryStatusFilter>('all');

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [neverCompletedCount, setNeverCompletedCount] = useState(0);

  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const fetchedPaths = useRef<Set<string>>(new Set());

  // Both multi-selects default to everything, once their options load.
  useEffect(() => {
    setSelectedLocations(new Set(locations.map((l) => l.id)));
  }, [locations]);
  useEffect(() => {
    if (!rolesLoading) setSelectedRoles(new Set(roles.map((r) => r.name)));
  }, [roles, rolesLoading]);

  const load = useCallback(
    async (targetPage: number, append: boolean) => {
      if (!startDate || !endDate || rolesLoading) return;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      // Paginated and ordered at the LIST level (proven query shape,
      // same as before the item split) -- a list with several items
      // contributes more than one row per page once flattened below.
      let query = supabase
        .from('tasks')
        .select(HISTORY_FIELDS)
        .gte('task_day', startDate)
        .lte('task_day', endDate)
        .order('task_day', { ascending: false })
        .range(targetPage * HISTORY_PAGE_SIZE, targetPage * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE - 1);

      if (selectedLocations.size < locations.length) {
        query = query.in('location_id', Array.from(selectedLocations));
      }

      const { data, error: queryError } = await query.returns<HistoryTaskRow[]>();

      if (queryError) {
        setError('Task history could not be loaded.');
      } else {
        const fetched: HistoryTaskRow[] = data ?? [];
        const flattened: HistoryRow[] = fetched.flatMap((task: HistoryTaskRow) =>
          task.items.map((item: HistoryItem) => ({ ...item, task }))
        );
        // assigned_role is null for a person-targeted list — it has no
        // role dimension to filter on, so it stays regardless of role
        // selection. Status filtering is per item now, same client-side
        // pattern the role filter already used.
        const filtered = flattened.filter((row) => {
          if (selectedRoles.size < roles.length && row.task.assigned_role && !selectedRoles.has(row.task.assigned_role)) {
            return false;
          }
          if (statusFilter === 'completed' && !(row.status === 'approved' || row.status === 'submitted')) return false;
          if (statusFilter === 'not_completed' && !(row.status === 'pending' || row.status === 'rejected')) return false;
          return true;
        });
        setRows((prev) => (append ? [...prev, ...filtered] : filtered));
        setHasMore(fetched.length === HISTORY_PAGE_SIZE);
      }

      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [
      startDate,
      endDate,
      selectedLocations,
      selectedRoles,
      statusFilter,
      locations.length,
      roles.length,
      rolesLoading,
    ]
  );

  useEffect(() => {
    setPage(0);
    void load(0, false);
  }, [load]);

  // A separate, lighter query for the headline count: role filtering can't
  // be pushed server-side (see above), so this fetches just the columns
  // needed to apply it, rather than paying for a full head-count query
  // that couldn't apply the same filter anyway.
  useEffect(() => {
    if (rolesLoading) return;
    void (async () => {
      const nowIso = new Date().toISOString();
      let query = supabase
        .from('tasks')
        .select('assigned_role, items:task_items ( status, is_required )')
        .lt('due_time', nowIso)
        .gte('task_day', startDate)
        .lte('task_day', endDate);

      if (selectedLocations.size < locations.length) {
        query = query.in('location_id', Array.from(selectedLocations));
      }

      type NeverCompletedRow = { assigned_role: string | null; items: { status: ItemStatus; is_required: boolean }[] };
      const { data } = await query.returns<NeverCompletedRow[]>();
      const tasksInRange: NeverCompletedRow[] = data ?? [];
      const scopedTasks =
        selectedRoles.size >= roles.length
          ? tasksInRange
          : tasksInRange.filter((t: NeverCompletedRow) => !t.assigned_role || selectedRoles.has(t.assigned_role));
      const count = scopedTasks.reduce(
        (sum: number, t: NeverCompletedRow) => sum + t.items.filter((i) => i.is_required && i.status === 'pending').length,
        0
      );
      setNeverCompletedCount(count);
    })();
  }, [startDate, endDate, selectedLocations, selectedRoles, locations.length, roles.length, rolesLoading]);

  useEffect(() => {
    const toFetch = rows
      .flatMap((r) => r.photos.map((p) => p.storage_path))
      .filter((p) => !fetchedPaths.current.has(p));
    if (toFetch.length === 0) return;
    toFetch.forEach((p) => fetchedPaths.current.add(p));

    void (async () => {
      const results = await Promise.all(
        toFetch.map(async (path) => {
          const { data, error } = await supabase.storage.from('task-photos').createSignedUrl(path, 3600);
          return [path, error ? null : (data?.signedUrl ?? null)] as const;
        })
      );
      setSignedUrls((prev) => {
        const next = { ...prev };
        for (const [path, url] of results) next[path] = url;
        return next;
      });
    })();
  }, [rows]);

  const toggleLocation = (id: string) => {
    setSelectedLocations((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRole = (name: string) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const activeFilterCount =
    (selectedLocations.size < locations.length ? 1 : 0) +
    (selectedRoles.size < roles.length ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0);

  return (
    <CollapsibleSection title="History" icon={History}>
      <div className="flex flex-wrap items-center gap-3">
        <FilterButton activeCount={activeFilterCount}>
          <div>
            <p className="text-xs font-medium text-ink/60">Status</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(
                [
                  { value: 'all', label: 'All' },
                  { value: 'completed', label: 'Completed' },
                  { value: 'not_completed', label: 'Not completed' },
                ] as const
              ).map((option) => {
                const on = statusFilter === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setStatusFilter(option.value)}
                    aria-pressed={on}
                    className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                      on
                        ? 'border-primary bg-primary text-white'
                        : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden="true" />}
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="history-start" className="block text-xs font-medium text-ink/60">
              Start date
            </label>
            <input
              id="history-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div>
            <label htmlFor="history-end" className="block text-xs font-medium text-ink/60">
              End date
            </label>
            <input
              id="history-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          <div>
            <p className="text-xs font-medium text-ink/60">Locations</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {locations.map((loc) => {
                const on = selectedLocations.has(loc.id);
                return (
                  <button
                    key={loc.id}
                    type="button"
                    onClick={() => toggleLocation(loc.id)}
                    aria-pressed={on}
                    className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                      on
                        ? 'border-primary bg-primary text-white'
                        : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden="true" />}
                    {loc.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-ink/60">Roles</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {roles.map((r) => {
                const on = selectedRoles.has(r.name);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggleRole(r.name)}
                    aria-pressed={on}
                    className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                      on
                        ? 'border-primary bg-primary text-white'
                        : 'border-border text-ink hover:border-primary/40'
                    }`}
                  >
                    {on && <Check className="h-3 w-3" aria-hidden="true" />}
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
        </FilterButton>

        <div
          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
            neverCompletedCount > 0 ? 'bg-warning-bg text-warning' : 'bg-bg text-ink/60'
          }`}
        >
          {neverCompletedCount} never completed in this range
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading history…
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink/60">No tasks in this range for the selected filters.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => {
            const target = row.task.assigned_role ?? nameOf(row.task.assignee);
            const anyPending = row.photos.some((p) => signedUrls[p.storage_path] === undefined);
            const resolvedUrls = row.photos
              .map((p) => signedUrls[p.storage_path])
              .filter((u): u is string => Boolean(u));
            const noneStored = row.photos.length > 0 && !anyPending && resolvedUrls.length === 0;

            return (
              <li key={row.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start gap-3">
                  {row.photos.length > 0 &&
                    (anyPending && resolvedUrls.length === 0 ? (
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-bg">
                        <Loader2 className="h-4 w-4 animate-spin text-ink/40" aria-hidden="true" />
                      </div>
                    ) : resolvedUrls.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setLightbox({ urls: resolvedUrls, index: 0 })}
                        aria-label="View submitted photos"
                        className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-bg"
                      >
                        <img src={resolvedUrls[0]} alt="" className="h-full w-full object-cover" />
                        {row.photos.length > 1 && (
                          <span className="absolute bottom-0.5 right-0.5 rounded-full bg-black/60 px-1 text-[10px] font-semibold text-white">
                            {row.photos.length}
                          </span>
                        )}
                      </button>
                    ) : null)}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate text-sm font-medium text-ink">
                        {row.task.title} — {row.title}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${itemStatusClasses(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink/60">
                      {formatTaskDay(row.task.task_day)} · {row.task.locations?.name ?? 'No location'} · {target}
                      {!row.is_required && ' · Optional'}
                    </p>
                    {noneStored && (
                      <p className="mt-1 text-xs italic text-ink/40">
                        {row.photos.length === 1 ? 'Photo' : 'Photos'} no longer stored
                      </p>
                    )}
                    <p className="mt-1 text-xs text-ink/50">
                      {row.completer
                        ? `Completed by ${nameOf(row.completer)}${
                            row.completed_at ? ` · ${formatDateTime(row.completed_at)}` : ''
                          }`
                        : 'Not completed'}
                    </p>
                    {row.reviewer && (
                      <p className="text-xs text-ink/50">Reviewed by {nameOf(row.reviewer)}</p>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && !loading && (
        <button
          type="button"
          onClick={() => {
            const nextPage = page + 1;
            setPage(nextPage);
            void load(nextPage, true);
          }}
          disabled={loadingMore}
          className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink hover:bg-bg disabled:opacity-60"
        >
          {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Load more
        </button>
      )}

      {lightbox && (
        <PhotoLightbox urls={lightbox.urls} initialIndex={lightbox.index} onClose={() => setLightbox(null)} />
      )}
    </CollapsibleSection>
  );
}
