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
} from "firebase/firestore";

const defaultNotifications = [
  { id: "welcome", title: "Welcome to AzoTa TOEIC", body: "Your account is ready. Start with one short TOEIC lesson when you are ready.", unread: true },
  { id: "daily-goal", title: "Today goal", body: "Complete at least one TOEIC lesson to keep your rhythm.", unread: true },
  { id: "docs", title: "Documents", body: "Downloaded materials will be recorded in your profile.", unread: false },
];
const defaultNotificationVersion = "en-v1";
const legacyEnglishNotificationCopies = new Map([
  ["chao mung den voi azota toeic", { title: "Welcome to AzoTa TOEIC", body: "Your account is ready. Start with one short TOEIC lesson when you are ready." }],
  ["nhac hoc streak doi", { title: "Pair streak reminder", body: "Your study partner is waiting for you to study today." }],
  ["chuoi hoc nhom da ket thuc", { title: "Team streak ended", body: "Your streak with your study partner ended after 3 days without progress." }],
  ["streak doi dang cho ban", { title: "Your pair streak is waiting", body: "Complete a TOEIC lesson today so your team streak can keep growing." }],
  ["chuoi hoc nhom can nguoi mo man", { title: "Your team streak needs a starter", body: "Be the first to complete a TOEIC lesson today and get the team moving." }],
  ["ban be da hoc hom nay", { title: "Your friends studied today", body: "Keep pace with your friends with one short TOEIC lesson." }],
  ["khoi dong lai nhip hoc toeic", { title: "Restart your TOEIC rhythm", body: "One short lesson is enough to get back on track today." }],
  ["azota van dang doi", { title: "AzoTa is still waiting", body: "You have been away for a few days. One short TOEIC lesson can bring your rhythm back." }],
  ["ban vua cham moc streak", { title: "You reached a streak milestone", body: "Your consistency is building. Keep it going with another lesson." }],
  ["dong bang streak da kich hoat", { title: "Streak freeze activated", body: "Your streak has been saved. Complete a lesson today to protect it." }],
  ["giu streak toeic cua ban", { title: "Keep your TOEIC streak", body: "Complete a TOEIC lesson today before your streak resets." }],
  ["bat dau thoi quen toeic", { title: "Start your TOEIC habit", body: "Complete one short lesson today to create your first streak." }],
  ["co bai toeic moi", { title: "New TOEIC lesson", body: "A new lesson is ready in your course list." }],
]);

export async function ensureDefaultNotifications(user, userProfileData = null) {
  if (!db || !user) return;

  const userRef = doc(db, "users", user.uid);
  const stored = userProfileData || (await getDoc(userRef)).data() || {};
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
        sortNotifications(
          snapshot.docs.map((docSnap) => normalizeNotificationItem(docSnap.id, docSnap.data()))
        )
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
    .map((item, index) => {
      const id = item.id || `${slugify(item.title)}-${index}`;
      const normalized = normalizeNotificationItem(id, item);
      return {
        id: normalized.id,
        title: normalized.title,
        body: normalized.body || "",
        unread: Boolean(normalized.unread),
      };
    });
}

function normalizeNotificationItem(id, data = {}) {
  const item = { ...data, id: id || data.id || "" };
  const englishCopy = getEnglishNotificationCopy(item);
  return englishCopy ? { ...item, ...englishCopy } : item;
}

function getEnglishNotificationCopy(item = {}) {
  const id = String(item.id || "");
  const type = String(item.type || "");

  if (id === "welcome") {
    return legacyEnglishNotificationCopies.get("chao mung den voi azota toeic");
  }
  if (id.startsWith("starter-reminder__")) {
    return legacyEnglishNotificationCopies.get("bat dau thoi quen toeic");
  }
  if (id.startsWith("announcement__")) {
    if (item.lessonTitle || item.lessonId || item.courseId || item.lessonUrl || item.actionUrl) {
      return null;
    }
    return legacyEnglishNotificationCopies.get("co bai toeic moi");
  }
  if (type === "pair_streak_nudge" || id.startsWith("pair_streak_nudge_")) {
    const partnerName = formatStudyPartnerName(extractPairNudgeName(item.body));
    return {
      title: "Pair streak reminder",
      body: `${partnerName} is waiting for you to study today.`,
    };
  }
  if (type === "pair_streak_broken" || id.startsWith("pair_streak_broken_")) {
    const partnerName = formatStudyPartnerName(extractPairBrokenName(item.body));
    return {
      title: "Team streak ended",
      body: `Your streak with ${partnerName} ended after 3 days without progress.`,
    };
  }

  return legacyEnglishNotificationCopies.get(normalizeLookupText(item.title)) || null;
}

function extractPairNudgeName(body) {
  const value = String(body || "");
  const key = normalizeLookupText(value);
  const markers = [" is waiting for you to study today", " dang cho ban hoc hom nay"];
  const markerIndex = markers.map((marker) => key.indexOf(marker)).find((index) => index > 0);
  return markerIndex > 0 ? value.slice(0, markerIndex).trim() : "";
}

function extractPairBrokenName(body) {
  const value = String(body || "");
  const key = normalizeLookupText(value);
  const patterns = [
    { start: "your streak with ", end: " ended after 3 days without progress" },
    { start: "chuoi hoc cung ", end: " da ket thuc sau 3 ngay khong co tien do" },
  ];
  const pattern = patterns.find(({ start, end }) => key.startsWith(start) && key.includes(end, start.length));
  if (!pattern) return "";
  const endIndex = key.indexOf(pattern.end, pattern.start.length);
  return value.slice(pattern.start.length, endIndex).trim();
}

function formatStudyPartnerName(value) {
  const name = String(value || "").trim();
  if (!name || normalizeLookupText(name) === "ban hoc cua ban") return "your study partner";
  return name;
}

function normalizeLookupText(value) {
  return String(value || "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function sortNotifications(items) {
  return [...items].sort((a, b) => {
    const unreadDiff = Number(Boolean(b.unread)) - Number(Boolean(a.unread));
    if (unreadDiff) return unreadDiff;
    return getNotificationTime(b) - getNotificationTime(a);
  });
}

function getNotificationTime(item = {}) {
  const value = item.createdAt || item.updatedAt || item.readAt || 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "notification";
}
