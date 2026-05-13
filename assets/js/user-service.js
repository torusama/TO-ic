import { auth, db, hasFirebaseConfig } from "./firebase-app.js";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const defaultStats = { streak: 0, lessons: 0 };
const defaultLearning = { recentCourse: "None yet", recentLesson: "None yet" };

export function onUserChanged(callback) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
}

export async function signInWithGoogle() {
  if (!auth) return null;
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signOutUser() {
  if (!auth) return;
  await signOut(auth);
}

export async function ensureUserProfile(user) {
  if (!hasFirebaseConfig || !db || !user) return null;

  const ref = doc(db, "users", user.uid);
  const snapshot = await getDoc(ref);
  const stored = snapshot.exists() ? snapshot.data() : {};
  const profile = normalizeProfile(user, stored);

  await setDoc(
    ref,
    {
      uid: user.uid,
      displayName: profile.displayName,
      email: profile.email,
      photoURL: profile.photoURL,
      provider: "google.com",
      stats: profile.stats,
      learning: profile.learning,
      createdAt: stored.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return profile;
}

export function listenUserProfile(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    doc(db, "users", uid),
    (snapshot) => callback(snapshot.exists() ? normalizeProfile(null, snapshot.data()) : null),
    onError
  );
}

export function listenActivities(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  let activityItems = [];
  let backupItems = [];

  function emit() {
    callback(mergeActivities(activityItems, backupItems));
  }

  const unsubscribeBackup = onSnapshot(
    doc(db, "users", uid),
    (snapshot) => {
      backupItems = normalizeActivityBackup(snapshot.exists() ? snapshot.data().activityBackup : null);
      emit();
    },
    onError
  );

  const ref = query(collection(db, "users", uid, "activities"), orderBy("createdAt", "desc"), limit(50));
  const unsubscribeActivities = onSnapshot(
    ref,
    (snapshot) => {
      activityItems = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
      emit();
    },
    (error) => {
      console.warn("Could not listen to activity subcollection:", error);
      emit();
    }
  );

  return () => {
    unsubscribeBackup();
    unsubscribeActivities();
  };
}

export function listenCompletedLessons(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    collection(db, "users", uid, "completedLessons"),
    (snapshot) => callback(new Set(snapshot.docs.map((docSnap) => docSnap.id))),
    onError
  );
}

export async function completeLesson(user, lesson) {
  if (!db || !user || !lesson?.courseId || !lesson?.lessonId) return false;

  const lessonId = getCompletedLessonKey(lesson.courseId, lesson.lessonId);
  const userRef = doc(db, "users", user.uid);
  const completedRef = doc(db, "users", user.uid, "completedLessons", lessonId);
  const todayStr = getTodayKey();

  const changed = await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(completedRef);
    if (existing.exists()) return false;

    const userSnap = await transaction.get(userRef);
    const userData = userSnap.exists() ? userSnap.data() : {};
    const lastStreakDate = userData.stats?.lastStreakDate || "";
    const shouldBumpStreak = lastStreakDate !== todayStr;

    transaction.set(completedRef, {
      courseId: lesson.courseId,
      courseTitle: lesson.courseTitle || "",
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle || "",
      completedAt: serverTimestamp(),
    });

    const statsUpdate = {
      lessons: increment(1),
    };
    if (shouldBumpStreak) {
      statsUpdate.streak = increment(1);
      statsUpdate.lastStreakDate = todayStr;
    }

    transaction.set(
      userRef,
      {
        stats: statsUpdate,
        learning: {
          recentCourse: lesson.courseTitle || lesson.courseId,
          recentLesson: lesson.lessonTitle || lesson.lessonId,
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    return true;
  });

  if (changed) {
    recordLessonActivity(user, {
      type: "lesson-completed",
      title: "Lesson completed",
      body: lesson.lessonTitle || "",
      courseId: lesson.courseId,
      courseTitle: lesson.courseTitle || "",
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle || "",
    }).catch((error) => {
      console.warn("Could not record completion activity:", error);
    });
  }

  return changed;
}

export async function recordLessonActivity(user, activity) {
  if (!db || !user || !activity?.courseId) return false;

  const type = activity.type || "lesson-opened";
  const todayStr = getTodayKey();
  const createdAtMs = Date.now();
  const activityId = getActivityKey(type, activity.courseId, activity.lessonId || activity.itemId || "course", todayStr);
  const userRef = doc(db, "users", user.uid);
  const activityRef = doc(db, "users", user.uid, "activities", activityId);
  const activityPayload = {
    id: activityId,
    type,
    title: activity.title || "Learning activity",
    body: activity.body || activity.lessonTitle || "",
    courseId: activity.courseId,
    courseTitle: activity.courseTitle || "",
    lessonId: activity.lessonId || activity.itemId || "",
    lessonTitle: activity.lessonTitle || activity.body || "",
    createdDateKey: todayStr,
    createdAtMs,
    createdAtIso: new Date(createdAtMs).toISOString(),
  };

  try {
    await setDoc(
      activityRef,
      {
        ...activityPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("Could not write activity subcollection; using profile backup instead:", error);
  }

  await setDoc(
    userRef,
    {
      activityBackup: {
        [activityId]: activityPayload,
      },
      learning: {
        recentCourse: activity.courseTitle || activity.courseId,
        recentLesson: activity.lessonTitle || activity.body || activity.lessonId || activity.itemId || "",
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return true;
}

function getTodayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getActivityKey(type, courseId, itemId, dateKey) {
  return `${type}__${courseId || "course"}__${itemId || "item"}__${dateKey || "date"}`.replace(/[/.#[\]]/g, "-");
}

function normalizeActivityBackup(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([id, item]) => ({ id, ...item }));
}

function mergeActivities(primaryItems, backupItems) {
  const itemsById = new Map();
  [...backupItems, ...primaryItems].forEach((item) => {
    if (!item?.id) return;
    itemsById.set(item.id, item);
  });

  return [...itemsById.values()]
    .sort((a, b) => getActivityTime(b) - getActivityTime(a))
    .slice(0, 50);
}

function getActivityTime(item) {
  return Number(item.createdAtMs || item.createdAt?.toMillis?.() || Date.parse(item.createdAtIso || "") || 0);
}

export function getCompletedLessonKey(courseId, lessonId) {
  return `${courseId || "course"}__${lessonId || "lesson"}`.replace(/[/.#[\]]/g, "-");
}

export async function getTimerProgress(uid, lessonKey) {
  if (!db || !uid || !lessonKey) return { elapsed: 0, videoTime: 0 };
  try {
    const snap = await getDoc(doc(db, "users", uid, "timerProgress", lessonKey));
    if (!snap.exists()) return { elapsed: 0, videoTime: 0 };
    const stored = snap.data();
    return {
      elapsed: Number(stored.elapsed || 0),
      videoTime: Number(stored.videoTime || 0),
    };
  } catch (_) {
    return { elapsed: 0, videoTime: 0 };
  }
}

export async function saveTimerProgress(uid, lessonKey, progress) {
  if (!db || !uid || !lessonKey) return;
  try {
    const payload = typeof progress === "number" ? { elapsed: progress } : progress || {};
    await setDoc(
      doc(db, "users", uid, "timerProgress", lessonKey),
      {
        elapsed: Number(payload.elapsed || 0),
        videoTime: Number(payload.videoTime || 0),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (_) {}
}

export async function clearTimerProgress(uid, lessonKey) {
  if (!db || !uid || !lessonKey) return;
  try {
    const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
    await deleteDoc(doc(db, "users", uid, "timerProgress", lessonKey));
  } catch (_) {}
}

export function normalizeProfile(user, stored = {}) {
  return {
    displayName: stored.displayName || getGoogleName(user),
    email: stored.email || user?.email || "",
    photoURL: stored.photoURL || getGooglePhoto(user),
    stats: {
      streak: Number(stored.stats?.streak || defaultStats.streak),
      lessons: Number(stored.stats?.lessons || defaultStats.lessons),
    },
    learning: { ...defaultLearning, ...(stored.learning || {}) },
  };
}

function getGoogleName(user) {
  return user?.displayName || user?.providerData?.find((provider) => provider.providerId === "google.com")?.displayName || "TOEIC Learner";
}

function getGooglePhoto(user) {
  return user?.photoURL || user?.providerData?.find((provider) => provider.providerId === "google.com")?.photoURL || "";
}
