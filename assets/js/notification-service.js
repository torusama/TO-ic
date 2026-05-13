import { db } from "./firebase-app.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const defaultNotifications = [
  { id: "welcome", title: "Welcome back", body: "Your learning profile is ready to sync.", unread: true },
  { id: "daily-goal", title: "Today goal", body: "Complete at least one TOEIC lesson to keep your rhythm.", unread: true },
  { id: "docs", title: "Documents", body: "Downloaded materials will be recorded in your profile.", unread: false },
];
const defaultNotificationVersion = "en-v1";

export async function ensureDefaultNotifications(user) {
  if (!db || !user) return;

  const userRef = doc(db, "users", user.uid);
  const snapshot = await getDoc(userRef);
  const stored = snapshot.exists() ? snapshot.data() : {};
  if (stored.notificationsSeeded && stored.notificationsVersion === defaultNotificationVersion) return;

  const source = stored.notificationsVersion ? normalizeNotifications(stored.notifications) || defaultNotifications : defaultNotifications;
  const batch = writeBatch(db);

  source.forEach((item) => {
    batch.set(
      doc(db, "users", user.uid, "notifications", item.id),
      {
        title: item.title,
        body: item.body,
        unread: Boolean(item.unread),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });

  batch.set(userRef, { notificationsSeeded: true, notificationsVersion: defaultNotificationVersion, updatedAt: serverTimestamp() }, { merge: true });
  await batch.commit();
}

export function listenNotifications(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  const ref = query(collection(db, "users", uid, "notifications"), orderBy("createdAt", "desc"));
  return onSnapshot(
    ref,
    (snapshot) =>
      callback(
        snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }))
      ),
    onError
  );
}

export async function markNotificationRead(uid, notificationId) {
  if (!db || !uid || !notificationId) return;
  await updateDoc(doc(db, "users", uid, "notifications", notificationId), {
    unread: false,
    readAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteNotification(uid, notificationId) {
  if (!db || !uid || !notificationId) return;
  await deleteDoc(doc(db, "users", uid, "notifications", notificationId));
}

export async function markAllNotificationsRead(uid, notifications) {
  if (!db || !uid) return;
  const unread = notifications.filter((item) => item.unread);
  if (!unread.length) return;

  const batch = writeBatch(db);
  unread.forEach((item) => {
    batch.update(doc(db, "users", uid, "notifications", item.id), {
      unread: false,
      readAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
  await batch.commit();
}

export async function clearNotifications(uid, notifications) {
  if (!db || !uid || !notifications.length) return;

  const batch = writeBatch(db);
  notifications.forEach((item) => batch.delete(doc(db, "users", uid, "notifications", item.id)));
  await batch.commit();
}

function normalizeNotifications(items) {
  if (!Array.isArray(items)) return null;
  return items
    .filter((item) => item?.title)
    .map((item, index) => ({
      id: item.id || `${slugify(item.title)}-${index}`,
      title: item.title,
      body: item.body || "",
      unread: Boolean(item.unread),
    }));
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "notification";
}
