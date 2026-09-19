import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, CheckSquare, Clock, MapPin, UserCog, X } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAnchoredPopoverPosition } from '../hooks/useAnchoredPopoverPosition';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';

const POPOVER_WIDTH = 320; // matches w-80

export interface NotificationRow {
  id: string;
  type: 'shift_changed' | 'timesheet_edited' | 'location_changed' | 'role_changed' | 'task';
  title: string;
  body: string | null;
  is_read: boolean;
  created_at: string;
}

const TYPE_ICONS: Record<NotificationRow['type'], typeof Bell> = {
  shift_changed: Clock,
  timesheet_edited: Clock,
  location_changed: MapPin,
  role_changed: UserCog,
  task: CheckSquare,
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function NotificationBell(): ReactNode {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const position = useAnchoredPopoverPosition({
    open,
    triggerRef: buttonRef,
    width: POPOVER_WIDTH,
    align: 'right',
  });

  // Native iOS build only — see resetDocumentScroll for why closing must
  // force the WKWebView's outer scroll view back to (0, 0).
  useEffect(() => {
    if (!open) resetDocumentScroll();
  }, [open]);

  const load = useCallback(async () => {
    const { data, error: queryError } = await supabase
      .from('notifications')
      .select('id, type, title, body, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(30);

    if (queryError) {
      setError('Could not load notifications.');
      setLoading(false);
      return;
    }
    setNotifications((data ?? []) as NotificationRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: new notifications appear live
  useEffect(() => {
    const channel = supabase
      .channel('notifications-bell')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        () => void load()
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  // Close dropdown when clicking outside, or on Escape. The dropdown is
  // portaled to document.body (see the render below), so this must check
  // popoverRef too — it's no longer a DOM descendant of the button.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  const markAllRead = useCallback(async () => {
    const unreadIds = notifications.filter((n) => !n.is_read).map((n) => n.id);
    if (unreadIds.length === 0) return;

    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));

    await supabase
      .from('notifications')
      .update({ is_read: true })
      .in('id', unreadIds);
  }, [notifications]);

  // Mark read on close, not on open — otherwise the unread styling
  // disappears before the user has read anything.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) void markAllRead();
    wasOpen.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Notifications"
            // Portaled to document.body and positioned in fixed coordinates
            // against the trigger's own bounding rect (see
            // useAnchoredPopoverPosition), same treatment as FilterButton —
            // clamped so it can never extend past either viewport edge, not
            // just right-anchored and hoping the width happens to fit.
            className="fixed z-[1200] flex w-80 max-w-[calc(100dvw-2rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
            style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-ink">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="inline-flex items-center gap-1 text-xs font-medium text-ink/60 hover:text-ink"
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                  Mark all read
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-ink/60">
                  <Bell className="h-4 w-4 animate-pulse" aria-hidden="true" />
                  Loading…
                </div>
              )}

              {!loading && error && (
                <div className="px-4 py-8 text-center text-sm text-danger">{error}</div>
              )}

              {!loading && !error && notifications.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-ink/60">
                  <Bell className="mx-auto mb-2 h-6 w-6 text-ink/40" aria-hidden="true" />
                  No notifications yet.
                </div>
              )}

              {!loading && !error && notifications.length > 0 && (
                <ul className="divide-y divide-border">
                  {notifications.map((n) => {
                    const Icon = TYPE_ICONS[n.type] ?? Bell;
                    return (
                      <li
                        key={n.id}
                        className={`flex gap-3 px-4 py-3 ${n.is_read ? 'bg-surface' : 'bg-primary/5'}`}
                      >
                        <div
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                            n.is_read ? 'bg-bg text-ink/50' : 'bg-secondary/20 text-secondary'
                          }`}
                        >
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-medium text-ink">{n.title}</p>
                            <span className="shrink-0 text-xs text-ink/50">{formatRelative(n.created_at)}</span>
                          </div>
                          {n.body && <p className="mt-0.5 text-xs text-ink/60">{n.body}</p>}
                          {!n.is_read && (
                            <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-secondary" aria-label="Unread" />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
