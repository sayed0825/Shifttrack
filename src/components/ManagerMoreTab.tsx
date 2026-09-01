import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CalendarX,
  Check,
  Clock,
  Loader2,
  MapPin,
  User,
  UserCog,
  UserPlus,
  X,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import InviteStaffModal from './InviteStaffModal';
import type { Profile } from './ManagerDashboard';

interface LocationRow {
  id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

export default function ManagerMoreTab({ profile }: { profile: Profile }): ReactNode {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ProfileSettingsCard profile={profile} />
      <ChangePasswordCard />
      <UnavailabilityApprovalsCard managerId={profile.id} />
      <InviteStaffCard />
      <LocationsCard />
    </div>
  );
}

// ===========================================================================
// Section 1 — Profile settings
// ===========================================================================

function ProfileSettingsCard({ profile }: { profile: Profile }): ReactNode {
  const [firstName, setFirstName] = useState(profile.first_name ?? '');
  const [fullName, setFullName] = useState(profile.full_name ?? '');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) setEmail(user.email);
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setFault(null);

    const { error: profileError } = await supabase
      .from('profiles')
      .update({ first_name: firstName.trim() || null, full_name: fullName.trim() || null })
      .eq('id', profile.id);

    if (profileError) {
      setFault('Could not save profile. Try again.');
      setSaving(false);
      return;
    }

    if (email) {
      const { error: emailError } = await supabase.auth.updateUser({ email });
      if (emailError) {
        setFault('Profile saved, but email could not be updated.');
        setSaving(false);
        return;
      }
    }

    setSaved(true);
    setSaving(false);
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <User className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Profile settings</h3>
      </div>

      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="more-first-name" className="block text-sm font-medium text-ink">First name</label>
            <input
              id="more-first-name"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div>
            <label htmlFor="more-full-name" className="block text-sm font-medium text-ink">Full name</label>
            <input
              id="more-full-name"
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
        </div>
        <div>
          <label htmlFor="more-email" className="block text-sm font-medium text-ink">Email</label>
          <input
            id="more-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
          <span className="text-ink/60">Role:</span>
          <span className="font-medium text-ink">{profile.role}</span>
        </div>

        {fault && (
          <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>
        )}
        {saved && !fault && (
          <p className="text-sm text-success">Profile saved.</p>
        )}

        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
          Save profile
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Section 2 — Change password
// ===========================================================================

function ChangePasswordCard(): ReactNode {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const handleChange = async () => {
    setFault(null);
    if (newPassword.length < 6) {
      setFault('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setFault('Passwords do not match.');
      return;
    }

    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);

    if (error) {
      setFault(error.message);
    } else {
      setSaved(true);
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <UserCog className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Change password</h3>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="more-new-password" className="block text-sm font-medium text-ink">New password</label>
          <input
            id="more-new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
        </div>
        <div>
          <label htmlFor="more-confirm-password" className="block text-sm font-medium text-ink">Confirm new password</label>
          <input
            id="more-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          />
        </div>

        {fault && (
          <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{fault}</p>
        )}
        {saved && (
          <p className="text-sm text-success">Password updated.</p>
        )}

        <button
          type="button"
          onClick={() => void handleChange()}
          disabled={saving || !newPassword}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
          Update password
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Section 3 — Invite staff
// ===========================================================================

function InviteStaffCard(): ReactNode {
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from('locations')
        .select('id, name')
        .eq('is_active', true)
        .order('name');
      setLocations(data ?? []);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <UserPlus className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Invite staff</h3>
      </div>

      <p className="mt-2 text-sm text-ink/60">
        Send an email invite to a new team member. They'll set their own password on first login.
      </p>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark"
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite staff member
        </button>
      )}

      {inviteOpen && (
        <InviteStaffModal
          locations={locations}
          onClose={() => setInviteOpen(false)}
          onInvited={async () => setInviteOpen(false)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// Section 4 — Locations
// ===========================================================================

function LocationsCard(): ReactNode {
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<LocationRow | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: queryError } = await supabase
      .from('locations')
      .select('id, name, address, latitude, longitude, radius_meters')
      .order('name');

    if (queryError) {
      setError('Could not load locations.');
    } else {
      setLocations(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const startEdit = (loc: LocationRow) => {
    setEditingId(loc.id);
    setEditForm({ ...loc });
  };

  const handleSave = async () => {
    if (!editForm) return;
    setSaving(true);
    const { error: updateError } = await supabase
      .from('locations')
      .update({
        name: editForm.name,
        address: editForm.address,
        latitude: editForm.latitude,
        longitude: editForm.longitude,
        radius_meters: editForm.radius_meters,
      })
      .eq('id', editForm.id);

    setSaving(false);
    if (updateError) {
      setError('Could not save location.');
      return;
    }
    setEditingId(null);
    setEditForm(null);
    await load();
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Locations</h3>
        </div>
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading locations…
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <MapPin className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Locations</h3>
      </div>

      {error && (
        <div className="mt-3 flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <p className="text-danger">{error}</p>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {locations.map((loc) => (
          <div key={loc.id} className="rounded-xl border border-border">
            {editingId === loc.id && editForm ? (
              <div className="space-y-3 p-4">
                <div>
                  <label className="block text-xs font-medium text-ink/60">Name</label>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink/60">Address</label>
                  <input
                    type="text"
                    value={editForm.address ?? ''}
                    onChange={(e) => setEditForm({ ...editForm, address: e.target.value || null })}
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink/60">Latitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={editForm.latitude}
                      onChange={(e) => setEditForm({ ...editForm, latitude: parseFloat(e.target.value) || 0 })}
                      className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink/60">Longitude</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={editForm.longitude}
                      onChange={(e) => setEditForm({ ...editForm, longitude: parseFloat(e.target.value) || 0 })}
                      className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink/60">Geofence radius (m)</label>
                  <input
                    type="number"
                    min="10"
                    value={editForm.radius_meters}
                    onChange={(e) => setEditForm({ ...editForm, radius_meters: parseInt(e.target.value, 10) || 100 })}
                    className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => { setEditingId(null); setEditForm(null); }}
                    className="rounded-lg px-3 py-2 text-xs font-medium text-ink/80 hover:bg-bg"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between p-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{loc.name}</p>
                  {loc.address && <p className="mt-0.5 truncate text-xs text-ink/60">{loc.address}</p>}
                  <p className="mt-0.5 text-xs tabular-nums text-ink/50">
                    {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)} · {loc.radius_meters}m radius
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(loc)}
                  className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-ink/80 hover:bg-bg"
                >
                  Edit
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Section 6 — Unavailability approvals
// ===========================================================================

interface UnavailabilityRequestRow {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  status: string;
  created_at: string;
  profiles: { full_name: string | null; first_name: string | null } | null;
}

function UnavailabilityApprovalsCard({ managerId }: { managerId: string }): ReactNode {
  const [requests, setRequests] = useState<UnavailabilityRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('unavailability_requests')
      .select('id, user_id, start_date, end_date, reason, status, created_at, profiles ( full_name, first_name )')
      .order('created_at', { ascending: false });

    if (!error) {
      setRequests((data ?? []) as unknown as UnavailabilityRequestRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDecision = async (requestId: string, approved: boolean) => {
    setBusy(requestId);
    const { error } = await supabase
      .from('unavailability_requests')
      .update({
        status: approved ? 'approved' : 'denied',
        decided_by: managerId,
        decided_at: new Date().toISOString(),
      })
      .eq('id', requestId);

    if (!error) {
      const { data: req } = await supabase
        .from('unavailability_requests')
        .select('user_id, start_date, end_date')
        .eq('id', requestId)
        .single();
      if (req) {
        const dateRange = req.start_date === req.end_date
          ? new Date(req.start_date + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })
          : `${new Date(req.start_date + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(req.end_date + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
        await supabase.from('notifications').insert({
          user_id: req.user_id,
          type: 'shift_changed',
          title: `Unavailability ${approved ? 'approved' : 'denied'}`,
          body: `Your request for ${dateRange} has been ${approved ? 'approved' : 'denied'}.`,
        });
      }
      await load();
    }
    setBusy(null);
  };

  const pending = requests.filter((r) => r.status === 'pending');
  const decided = requests.filter((r) => r.status !== 'pending');

  const formatDateRange = (start: string, end: string) => {
    if (start === end) return new Date(start + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${new Date(start + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${new Date(end + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  };

  const statusBadge = (status: string) => {
    if (status === 'approved') return 'bg-success-bg text-success';
    if (status === 'denied') return 'bg-danger-bg text-danger';
    return 'bg-warning-bg text-warning';
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <CalendarX className="h-5 w-5 text-ink/50" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-ink">Unavailability requests</h3>
        </div>
        <div className="mt-4 flex items-center gap-2 text-sm text-ink/60">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <CalendarX className="h-5 w-5 text-ink/50" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-ink">Unavailability requests</h3>
        {pending.length > 0 && (
          <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning">{pending.length} pending</span>
        )}
      </div>

      {requests.length === 0 ? (
        <p className="mt-4 text-sm text-ink/60">No unavailability requests.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {pending.length > 0 && (
            <div className="space-y-2">
              {pending.map((req) => (
                <div key={req.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-ink">{req.profiles?.full_name ?? req.profiles?.first_name ?? 'Unknown'}</p>
                      <p className="text-xs text-ink/60">{formatDateRange(req.start_date, req.end_date)}</p>
                      {req.reason && <p className="mt-1 text-xs text-ink/50">{req.reason}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => void handleDecision(req.id, true)}
                        disabled={busy === req.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-success px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60 min-h-[44px]"
                      >
                        {busy === req.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDecision(req.id, false)}
                        disabled={busy === req.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60 min-h-[44px]"
                      >
                        {busy === req.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
                        Deny
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {decided.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-ink/50">Past requests</p>
              {decided.map((req) => (
                <div key={req.id} className="flex items-center justify-between rounded-xl border border-border p-3">
                  <div>
                    <p className="text-sm font-medium text-ink">{req.profiles?.full_name ?? req.profiles?.first_name ?? 'Unknown'}</p>
                    <p className="text-xs text-ink/60">{formatDateRange(req.start_date, req.end_date)}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(req.status)}`}>
                    {req.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
