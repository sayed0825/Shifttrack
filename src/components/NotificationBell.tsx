import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Check, Clock, MapPin, UserCog, X } from 'lucide-react';
import { supabase } from '../supabaseClient';

export interface NotificationRow {
  id: string;
  type: 'shift_changed' | 'timesheet_edited' | 'location_changed' | 'role_changed';
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
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        className="relative rounded-lg p-2 text-ink/60 hover:bg-bg hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface shadow-lg"
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

          <div className="max-h-96 overflow-y-auto">
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
        </div>
      )}
    </div>
  );
}
