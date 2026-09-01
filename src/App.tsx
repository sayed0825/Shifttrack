import { useEffect, useState } from 'react';
import { Loader2, Lock, LogIn } from 'lucide-react';
import { supabase } from './supabaseClient';
import ManagerDashboard from './components/ManagerDashboard';
import EmployeeDashboard from './components/EmployeeDashboard';
import type { Profile } from './components/ManagerDashboard';

type Session = {
  userId: string;
  profile: Profile;
} | null;

export default function App() {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteMode, setInviteMode] = useState(() => {
    const hash = window.location.hash;
    return hash.includes('type=invite') || hash.includes('type=recovery');
  });

  useEffect(() => {
    let cancelled = false;

    async function resolveSession(authSession: { user: { id: string } | null } | null) {
      if (!authSession?.user) {
        setSession(null);
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('id, first_name, full_name, role')
        .eq('id', authSession.user.id)
        .maybeSingle();

      if (cancelled) return;
      const role = (profile?.role ?? 'Employee') as Profile['role'];
      setSession({
        userId: authSession.user.id,
        profile: {
          id: authSession.user.id,
          first_name: profile?.first_name ?? null,
          full_name: profile?.full_name ?? null,
          role,
        },
      });
    }

    // Resolve any existing session on first load.
    void (async () => {
      const {
        data: { session: existing },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      await resolveSession(existing);
    })();

    // The callback runs synchronously during event processing, so async work
    // must be deferred to an IIFE to avoid deadlocking the auth listener.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, authSession) => {
      void resolveSession(authSession);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const handleSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const timeoutId = setTimeout(() => {
      setBusy(false);
      setError('Sign in timed out — check your connection and try again.');
    }, 15000);

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      if (data.session) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, first_name, full_name, role')
          .eq('id', data.session.user.id)
          .maybeSingle();

        const role = (profile?.role ?? 'Employee') as Profile['role'];
        setSession({
          userId: data.session.user.id,
          profile: {
            id: data.session.user.id,
            first_name: profile?.first_name ?? null,
            full_name: profile?.full_name ?? null,
            role,
          },
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed — please try again.');
    } finally {
      clearTimeout(timeoutId);
      setBusy(false);
    }
  };

  const handleSetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });

      if (updateError) {
        const msg = updateError.message.toLowerCase();
        if (msg.includes('already been registered')) {
          setError('This invite has already been used. Try signing in instead, or ask your manager to send a new invite.');
        } else if (msg.includes('expired') || msg.includes('invalid')) {
          setError('This invite link has expired or already been used. Ask your manager to resend the invite.');
        } else {
          setError('Could not set your password. Please try again, or ask your manager to resend the invite.');
        }
        return;
      }

      window.history.replaceState(null, '', window.location.pathname);
      setInviteMode(false);
      setPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (inviteMode) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <div className="mb-5 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Lock className="h-6 w-6 text-primary" aria-hidden="true" />
            </div>
            <h1 className="text-xl font-semibold text-ink">Set your password</h1>
            <p className="mt-1 text-sm text-ink/60">Choose a password to finish setting up your account.</p>
          </div>

          <form onSubmit={handleSetPassword} className="space-y-4">
            <div>
              <label htmlFor="new-password" className="block text-sm font-medium text-ink">
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>

            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-ink">
                Confirm password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Lock className="h-4 w-4" aria-hidden="true" />
              )}
              Set password
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (session === undefined) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg text-primary">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  if (session === null) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <div className="mb-5 text-center">
            <h1 className="text-xl font-semibold text-ink">ShiftTrack</h1>
            <p className="mt-1 text-sm text-primary">Sign in to your account</p>
          </div>

          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-ink">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-ink">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              />
            </div>

            {error && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LogIn className="h-4 w-4" aria-hidden="true" />
              )}
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (session.profile.role === 'Manager') {
    return (
      <div className="h-dvh">
        <ManagerDashboard />
      </div>
    );
  }

  return (
    <div className="h-dvh">
      <EmployeeDashboard profile={session.profile} />
    </div>
  );
}
