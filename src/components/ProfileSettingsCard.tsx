import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { resetDocumentScroll } from '../lib/resetDocumentScroll';
import type { Profile } from './ManagerDashboard';

/** Muted "No role" label for anywhere a role is displayed. */
function roleLabel(role: string | null | undefined): ReactNode {
  return role ?? <span className="italic text-ink/50">No role</span>;
}

export default function ProfileSettingsCard({ profile }: { profile: Profile }): ReactNode {
  const [firstName, setFirstName] = useState(profile.first_name ?? '');
  const [fullName, setFullName] = useState(profile.full_name ?? '');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordFault, setPasswordFault] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteFault, setDeleteFault] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) setEmail(user.email);
    })();
  }, []);

  // See resetDocumentScroll — this dialog toggles in place, so reset on
  // every close (deleteOpen going false).
  useEffect(() => {
    if (!deleteOpen) resetDocumentScroll();
  }, [deleteOpen]);

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

  const handleChangePassword = async () => {
    setPasswordFault(null);
    if (newPassword.length < 6) {
      setPasswordFault('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFault('Passwords do not match.');
      return;
    }

    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);

    if (error) {
      setPasswordFault(error.message);
    } else {
      setPasswordSaved(true);
      setNewPassword('');
      setConfirmPassword('');
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    setDeleteFault(null);

    const { error } = await supabase.rpc('delete_my_account');

    if (error) {
      // Surfaced verbatim: delete_my_account() raises a specific, actionable
      // message (e.g. "You are the only administrator...") that a generic
      // friendly-error mapping would otherwise swallow.
      setDeleteFault(error.message);
      setDeleting(false);
      return;
    }

    // The account (and its auth.users row) is gone at this point — sign out
    // locally so App.tsx's onAuthStateChange listener drops back to the
    // login screen instead of holding a session for a user that no longer
    // exists.
    await supabase.auth.signOut();
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface p-5">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="profile-first-name" className="block text-sm font-medium text-ink">First name</label>
              <input
                id="profile-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
            <div>
              <label htmlFor="profile-full-name" className="block text-sm font-medium text-ink">Full name</label>
              <input
                id="profile-full-name"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>
          </div>
          <div>
            <label htmlFor="profile-email" className="block text-sm font-medium text-ink">Email</label>
            <input
              id="profile-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-bg px-3 py-2 text-sm">
            <span className="text-ink/60">Role:</span>
            <span className="font-medium text-ink">{roleLabel(profile.role)}</span>
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
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Save profile
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-5">
        <h3 className="text-sm font-semibold text-ink">Change password</h3>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="profile-new-password" className="block text-sm font-medium text-ink">New password</label>
            <input
              id="profile-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div>
            <label htmlFor="profile-confirm-password" className="block text-sm font-medium text-ink">Confirm new password</label>
            <input
              id="profile-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>

          {passwordFault && (
            <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{passwordFault}</p>
          )}
          {passwordSaved && (
            <p className="text-sm text-success">Password updated.</p>
          )}

          <button
            type="button"
            onClick={() => void handleChangePassword()}
            disabled={savingPassword || !newPassword}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-dark disabled:opacity-60"
          >
            {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
            Update password
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-danger/40 bg-surface p-5">
        <h3 className="text-sm font-semibold text-danger">Delete account</h3>
        <p className="mt-2 text-sm text-ink/60">
          Your login and personal details are removed permanently. Hours you've worked are kept
          for payroll and legal reasons. This cannot be undone.
        </p>
        <button
          type="button"
          onClick={() => setDeleteOpen(true)}
          className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-danger px-4 py-2 text-sm font-semibold text-danger hover:bg-danger-bg"
        >
          Delete my account
        </button>
      </div>

      {deleteOpen && (
        <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-primary/40 sm:items-center sm:p-6">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-surface px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:rounded-2xl"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <h4 id="delete-account-title" className="text-base font-semibold text-ink">
                  Delete your account?
                </h4>
                <p className="mt-1 text-sm text-ink/60">
                  Your login and personal details (name, email) are removed permanently. Hours
                  you've worked are retained for payroll and legal reasons. This cannot be undone.
                </p>
              </div>
            </div>

            <div className="mt-4">
              <label htmlFor="delete-confirm-text" className="block text-sm font-medium text-ink">
                Type DELETE to confirm
              </label>
              <input
                id="delete-confirm-text"
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                className="mt-1.5 w-full rounded-lg border border-border px-3 py-2 text-base sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
              />
            </div>

            {deleteFault && (
              <p className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{deleteFault}</p>
            )}

            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => void handleDeleteAccount()}
                disabled={deleteConfirmText !== 'DELETE' || deleting}
                className="min-h-[44px] w-full rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteConfirmText('');
                  setDeleteFault(null);
                }}
                disabled={deleting}
                className="min-h-[44px] w-full rounded-lg px-4 py-2 text-sm font-medium text-ink/60 hover:bg-bg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
