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
  const ref = query(collection(db, "users", uid, "activities"), orderBy("createdAt", "desc"), limit(50));
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
  const activityRef = doc(collection(db, "users", user.uid, "activities"));

  const todayStr = getTodayKey();

  return runTransaction(db, async (transaction) => {
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

    transaction.set(activityRef, {
      type: "lesson-completed",
      title: "Lesson completed",
      body: lesson.lessonTitle || "",
      courseId: lesson.courseId,
      courseTitle: lesson.courseTitle || "",
      lessonId: lesson.lessonId,
      lessonTitle: lesson.lessonTitle || "",
      createdDateKey: todayStr,
      createdAt: serverTimestamp(),
    });

    return true;
  });
}

function getTodayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
