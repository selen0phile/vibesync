import { useCallback, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { auth, googleProvider, firebaseConfigured } from '../lib/firebase.js';

const STORAGE_KEY = 'syncwatch_app_token';

export function useHostAuth() {
  const [appToken, setAppToken] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshMe = useCallback(async (token) => {
    const t = token || appToken;
    if (!t) {
      setUser(null);
      return;
    }
    const r = await fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!r.ok) {
      localStorage.removeItem(STORAGE_KEY);
      setAppToken('');
      setUser(null);
      return;
    }
    const data = await r.json();
    setUser(data.user);
  }, [appToken]);

  useEffect(() => {
    if (!firebaseConfigured || !auth) {
      setLoading(false);
      if (!firebaseConfigured) setError('Firebase is not configured (missing VITE_FIREBASE_* in .env)');
      return undefined;
    }
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (cancelled) return;
      if (!fbUser) {
        if (!appToken) setLoading(false);
        return;
      }
      try {
        const idToken = await fbUser.getIdToken(true);
        const r = await fetch('/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'session_failed');
        localStorage.setItem(STORAGE_KEY, data.token);
        setAppToken(data.token);
        setUser(data.user);
        setError(null);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    if (appToken) {
      refreshMe(appToken).finally(() => {
        if (!cancelled) setLoading(false);
      });
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!auth || !googleProvider) {
      setError('Firebase is not configured');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  const signOutAll = useCallback(async () => {
    localStorage.removeItem(STORAGE_KEY);
    setAppToken('');
    setUser(null);
    try {
      if (auth) await signOut(auth);
    } catch {
      /* */
    }
    await fetch('/api/auth/logout', { method: 'POST' });
  }, []);

  return {
    appToken,
    user,
    loading,
    error,
    signIn,
    signOut: signOutAll,
    isAuthenticated: Boolean(appToken && user),
  };
}
