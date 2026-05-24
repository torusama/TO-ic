import { auth, authPersistenceReady } from "./firebase-app.js";
import {
  onAuthStateChanged,
  signOut,
} from "firebase/auth";

const SESSION_STARTED_PREFIX = "azota.authSessionStartedAt";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_483_647;

let isSigningOutExpiredSession = false;
let sessionExpiryTimer = 0;

export function onValidAuthStateChanged(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }

  return onAuthStateChanged(
    auth,
    async (user) => {
      await authPersistenceReady;
      callback(await getValidUser(user));
    },
    () => callback(null)
  );
}

export async function getValidSignedInUser(timeoutMs = 5000) {
  if (!auth) return null;
  await authPersistenceReady;

  if (auth.currentUser) {
    return getValidUser(auth.currentUser);
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    async function finish(user) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe();
      resolve(await getValidUser(user));
    }

    unsubscribe = onAuthStateChanged(auth, finish, () => finish(null));
  });
}

export function markAuthSessionStarted(user, startedAt = Date.now()) {
  if (!user?.uid) return;

  try {
    window.localStorage.setItem(getSessionKey(user.uid), String(startedAt));
  } catch (error) {
    console.warn("Could not save auth session start:", error);
  }
}

export async function signOutWithSessionClear() {
  if (!auth) return;
  clearAuthSession(auth.currentUser);
  await signOut(auth);
}

async function getValidUser(user) {
  if (!user) {
    clearSessionExpiryTimer();
    return null;
  }

  const startedAt = readAuthSessionStartedAt(user);
  if (!startedAt) {
    const now = Date.now();
    markAuthSessionStarted(user, now);
    scheduleSessionExpiryCheck(now);
    return user;
  }

  if (Date.now() - startedAt <= SESSION_MAX_AGE_MS) {
    scheduleSessionExpiryCheck(startedAt);
    return user;
  }

  clearSessionExpiryTimer();
  clearAuthSession(user);
  if (!isSigningOutExpiredSession) {
    isSigningOutExpiredSession = true;
    try {
      await signOut(auth);
    } catch (error) {
      console.warn("Could not sign out expired auth session:", error);
    } finally {
      isSigningOutExpiredSession = false;
    }
  }

  return null;
}

function readAuthSessionStartedAt(user) {
  if (!user?.uid) return 0;

  try {
    const raw = window.localStorage.getItem(getSessionKey(user.uid));
    const startedAt = Number(raw);
    return Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0;
  } catch (error) {
    console.warn("Could not read auth session start:", error);
    return Date.now();
  }
}

function clearAuthSession(user) {
  if (!user?.uid) return;

  try {
    window.localStorage.removeItem(getSessionKey(user.uid));
  } catch (error) {
    console.warn("Could not clear auth session start:", error);
  }
}

function scheduleSessionExpiryCheck(startedAt) {
  clearSessionExpiryTimer();

  const remainingMs = SESSION_MAX_AGE_MS - (Date.now() - startedAt);
  if (remainingMs <= 0) return;

  sessionExpiryTimer = window.setTimeout(() => {
    sessionExpiryTimer = 0;
    getValidUser(auth?.currentUser || null);
  }, Math.min(remainingMs + 1000, MAX_TIMEOUT_MS));
}

function clearSessionExpiryTimer() {
  if (!sessionExpiryTimer) return;
  window.clearTimeout(sessionExpiryTimer);
  sessionExpiryTimer = 0;
}

function getSessionKey(uid) {
  return `${SESSION_STARTED_PREFIX}.${uid}`;
}
