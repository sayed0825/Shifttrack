import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Loader2, Mail, MapPin, User, UserCog, X } from 'lucide-react';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../supabaseClient';

export const STAFF_ROLES = [
  'Driver',
  'FOH',
  'KA',
  'Head Chef',
  'Second Chef',
  'Cook',
  'Tandoori Chef',
  'Kitchen Porter',
  'Manager',
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

interface LocationRow {
  id: string;
  name: string;
}

export default function InviteStaffModal({
  locations,
  onClose,
  onInvited,
}: {
  locations: LocationRow[];
  onClose: () => void;
  onInvited: () => Promise<void>;
}): ReactNode {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<StaffRole>('Driver');
  const [primaryLocationId, setPrimaryLocationId] = useState('');
  const [additionalLocationIds, setAdditionalLocationIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (locations.length > 0 && !primaryLocationId) {
      setPrimaryLocationId(locations[0].id);
    }
  }, [locations, primaryLocationId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleAdditional = (id: string) => {
    setAdditionalLocationIds((prev) =>
      prev.includes(id) ? prev.filter((l) => l !== id) : [...prev, id]
    );
  };

  const handleInvite = async () => {
    if (!email.includes('@')) {
      setFault('Enter a valid email address.');
      return;
    }

    setBusy(true);
    setFault(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Your session has expired. Sign in again.');
      const response = await fetch(
        `${SUPABASE_URL}/functions/v1/invite-staff`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            email,
            role,
            firstName,
            fullName,
            primaryLocationId: primaryLocationId || null,
            additionalLocationIds: additionalLocationIds.filter(
              (id) => id !== primaryLocationId
            ),
            redirectBase: window.location.origin,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to send invite');
      }

      setSuccess(true);
      setTimeout(async () => {
        await onInvited();
        onClose();
      }, 1500);
    } catch (err) {
      setFault(err instanceof Error ? err.message : 'Could not send invite.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-ink/70" aria-hidden="true" />
            <h2 id="invite-modal-title" className="text-base font-semibold text-ink">
              Invite staff member
            </h2>
          </div>
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
            <p className="text-sm font-semibold text-ink">Invite sent to {email}</p>
            <p className="text-xs text-ink/60">
              They'll receive an email to set their password and complete their profile.
            </p>
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
              {/* Email */}
              <div>
                <label htmlFor="invite-email" className="block text-sm font-medium text-ink">
                  Email address
                </label>
                <div className="relative mt-1.5">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50" aria-hidden="true" />
                  <input
                    id="invite-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
              </div>

              {/* Name */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="invite-first-name" className="block text-sm font-medium text-ink">
                    First name
                  </label>
                  <div className="relative mt-1.5">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/50" aria-hidden="true" />
                    <input
                      id="invite-first-name"
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      placeholder="Jane"
                      className="w-full rounded-lg border border-border py-2 pl-9 pr-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="invite-full-name" className="block text-sm font-medium text-ink">
                    Full name
                  </label>
                  <input
                    id="invite-full-name"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Smith"
                    className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  />
                </div>
              </div>

              {/* Role */}
              <div>
                <label htmlFor="invite-role" className="block text-sm font-medium text-ink">
                  Role / Position
                </label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as StaffRole)}
                  className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  {STAFF_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              {/* Locations */}
              <div>
                <p className="text-sm font-medium text-ink">Locations</p>
                <p className="mt-0.5 text-xs text-ink/60">Select all sites this person works at, and mark one as primary.</p>
                <div className="mt-3 space-y-2">
                  {locations.map((loc) => {
                    const isPrimary = loc.id === primaryLocationId;
                    const isAdditional = additionalLocationIds.includes(loc.id);
                    const isChecked = isPrimary || isAdditional;
                    return (
                      <div
                        key={loc.id}
                        className={`flex items-center justify-between rounded-lg border p-3 transition ${
                          isChecked ? 'border-primary/40 bg-primary/5' : 'border-border'
                        }`}
                      >
                        <label className="flex flex-1 items-center gap-2.5 cursor-pointer min-h-[44px]">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                if (!isPrimary) toggleAdditional(loc.id);
                              } else {
                                if (isPrimary) setPrimaryLocationId('');
                                else toggleAdditional(loc.id);
                              }
                            }}
                            className="h-4 w-4 rounded border-border text-primary focus-visible:outline-primary"
                          />
                          <span className="text-sm font-medium text-ink">{loc.name}</span>
                          {isPrimary && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">primary</span>
                          )}
                        </label>
                        {isChecked && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isPrimary) {
                                setPrimaryLocationId('');
                                if (!isAdditional) toggleAdditional(loc.id);
                              } else {
                                setPrimaryLocationId(loc.id);
                                if (isAdditional) toggleAdditional(loc.id);
                              }
                            }}
                            className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink/80 hover:bg-bg min-h-[44px]"
                          >
                            Make primary
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {fault && (
                <div className="flex gap-2 rounded-lg bg-danger-bg p-3 text-sm">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                  <p className="text-danger">{fault}</p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-border px-5 py-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-sm font-medium text-ink/80 hover:bg-bg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleInvite()}
                disabled={busy || !email.includes('@')}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-border disabled:text-ink/60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="h-4 w-4" aria-hidden="true" />}
                Send invite
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
