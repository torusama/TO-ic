import { auth, authPersistenceReady, db, hasFirebaseConfig } from "./firebase-app.js";
import {
  markAuthSessionStarted,
  onValidAuthStateChanged,
  signOutWithSessionClear,
} from "./auth-session.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
  orderBy,
  where,
} from "firebase/firestore";

const defaultStats = { streak: 0, lessons: 0 };
const defaultLearning = { recentCourse: "None yet", recentLesson: "None yet" };
const defaultEmailPreferences = { studyReminders: true, newLessonAlerts: true, reminderIntensity: "dramatic" };
const animationFields = {
  header: "streakHeaderAnimatedDate",
  profile: "streakProfileAnimatedDate",
};

export function onUserChanged(callback) {
  return onValidAuthStateChanged(callback);
}

export async function signInWithGoogle() {
  if (!auth) return null;
  await authPersistenceReady;
  const result = await signInWithPopup(auth, new GoogleAuthProvider());
  markAuthSessionStarted(result.user);
  return result;
}

export async function signOutUser() {
  if (!auth) return;
  await signOutWithSessionClear();
}

export async function updateEmailPreferences(uid, preferences = {}) {
  if (!db || !uid) return false;

  await setDoc(
    doc(db, "users", uid),
    {
      emailPreferences: normalizeEmailPreferences(preferences),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  return true;
}

export async function ensureUserProfile(user) {
  if (!hasFirebaseConfig || !db || !user) return null;

  const ref = doc(db, "users", user.uid);
  const snapshot = await getDoc(ref);

  if (snapshot.exists()) {
    const stored = snapshot.data();
    touchUserEngagement(user.uid, stored).catch((error) => {
      console.warn("Could not update user engagement:", error);
    });
    return normalizeProfile(user, stored);
  }

  const profile = normalizeProfile(user, {});
  const todayStr = getTodayKey();
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
      emailPreferences: profile.emailPreferences,
      engagement: {
        lastSeenDate: todayStr,
        lastSeenAt: serverTimestamp(),
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  await setDoc(doc(db, "publicProfiles", user.uid), getPublicProfilePayload(user.uid, profile), { merge: true });

  queueWelcomeEmail(user, { keepalive: true }).catch((error) => {
    console.warn("Could not send welcome email:", error);
  });

  return profile;
}

async function touchUserEngagement(uid, stored = {}) {
  if (!db || !uid) return;
  const todayStr = getTodayKey();
  if (stored.engagement?.lastSeenDate === todayStr) return;

  await setDoc(
    doc(db, "users", uid),
    {
      engagement: {
        lastSeenDate: todayStr,
        lastSeenAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function updateUserProfile(user, updates = {}) {
  if (!db || !user) return false;

  const displayName = cleanDisplayName(updates.displayName) || "TOEIC Learner";
  const photoURL = cleanPhotoUrl(updates.photoURL);
  const ref = doc(db, "users", user.uid);
  const snapshot = await getDoc(ref);
  const stored = snapshot.exists() ? snapshot.data() : {};
  const profile = normalizeProfile(user, {
    ...stored,
    displayName,
    photoURL: photoURL || stored.photoURL || user.photoURL || "",
  });

  await Promise.all([
    setDoc(
      ref,
      {
        displayName: profile.displayName,
        photoURL: profile.photoURL,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    ),
    setDoc(doc(db, "publicProfiles", user.uid), getPublicProfilePayload(user.uid, profile), { merge: true }),
  ]);

  return true;
}

export function listenFollowing(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    collection(db, "users", uid, "following"),
    (snapshot) => callback(new Set(snapshot.docs.map((docSnap) => docSnap.id))),
    onError
  );
}

export function listenFollowingProfiles(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    collection(db, "users", uid, "following"),
    (snapshot) => callback(snapshot.docs.map((docSnap) => normalizeConnectionProfile(docSnap.id, docSnap.data(), "following"))),
    onError
  );
}

export function listenFollowerProfiles(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  return onSnapshot(
    collection(db, "users", uid, "followers"),
    (snapshot) => callback(snapshot.docs.map((docSnap) => normalizeConnectionProfile(docSnap.id, docSnap.data(), "followers"))),
    onError
  );
}

export async function listSuggestedProfiles(uid) {
  if (!db || !uid) return [];
  const snapshot = await getDocs(query(collection(db, "publicProfiles"), orderBy("updatedAt", "desc"), limit(30)));
  return snapshot.docs.map((docSnap) => normalizePublicProfile(docSnap.id, docSnap.data())).filter((profile) => profile.uid !== uid);
}

export async function searchPublicProfiles(term, uid) {
  if (!db || !uid) return [];
  const needle = normalizeSearchName(term);
  const snapshot = await getDocs(query(collection(db, "publicProfiles"), orderBy("updatedAt", "desc"), limit(60)));
  return snapshot.docs
    .map((docSnap) => normalizePublicProfile(docSnap.id, docSnap.data()))
    .filter((profile) => profile.uid !== uid)
    .filter((profile) => !needle || profile.searchName.includes(needle) || profile.displayName.toLowerCase().includes(String(term || "").toLowerCase()))
    .slice(0, 20);
}

export async function getPublicProfile(uid) {
  if (!db || !uid) return null;
  try {
    const snap = await getDoc(doc(db, "publicProfiles", uid));
    if (!snap.exists()) return null;
    return normalizePublicProfile(snap.id, snap.data());
  } catch (error) {
    console.warn("Could not fetch public profile:", error);
    return null;
  }
}

export async function followUser(user, targetProfile, followerProfile = {}) {
  if (!db || !user || !targetProfile?.uid || user.uid === targetProfile.uid) return false;

  const now = serverTimestamp();
  const followerDisplayName = cleanDisplayName(followerProfile.displayName) || cleanDisplayName(user.displayName) || "TOEIC Learner";
  const followerPhotoURL = cleanPhotoUrl(followerProfile.photoURL) || cleanPhotoUrl(user.photoURL);
  const batch = writeBatch(db);
  batch.set(
    doc(db, "users", user.uid, "following", targetProfile.uid),
    {
      targetUid: targetProfile.uid,
      displayName: targetProfile.displayName || "TOEIC Learner",
      photoURL: targetProfile.photoURL || "",
      followedAt: now,
      updatedAt: now,
    },
    { merge: true }
  );
  batch.set(
    doc(db, "users", targetProfile.uid, "followers", user.uid),
    {
      followerUid: user.uid,
      displayName: followerDisplayName,
      photoURL: followerPhotoURL,
      followedAt: now,
      updatedAt: now,
    },
    { merge: true }
  );
  batch.set(
    doc(db, "users", targetProfile.uid, "notifications", `follow_${user.uid}`),
    {
      title: "New Follower",
      body: `${followerDisplayName} started following you.`,
      unread: true,
      createdAt: now,
      updatedAt: now,
    },
    { merge: true }
  );
  batch.set(doc(db, "users", user.uid), { stats: { followingCount: increment(1) } }, { merge: true });
  batch.set(doc(db, "publicProfiles", user.uid), { stats: { followingCount: increment(1) } }, { merge: true });
  batch.set(doc(db, "users", targetProfile.uid), { stats: { followersCount: increment(1) } }, { merge: true });
  batch.set(doc(db, "publicProfiles", targetProfile.uid), { stats: { followersCount: increment(1) } }, { merge: true });
  await batch.commit();
  return true;
}

export async function recordProfileView(viewerUser, targetUid, viewerProfile = {}) {
  if (!db || !viewerUser || !targetUid || viewerUser.uid === targetUid) return false;

  const viewerDisplayName = cleanDisplayName(viewerProfile.displayName) || cleanDisplayName(viewerUser.displayName) || "Someone";
  const now = serverTimestamp();

  try {
    await setDoc(
      doc(db, "users", targetUid, "notifications", `view_${viewerUser.uid}`),
      {
        title: "Profile View",
        body: `${viewerDisplayName} recently viewed your profile.`,
        unread: true,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );
    return true;
  } catch (error) {
    console.warn("Could not record profile view:", error);
    return false;
  }
}

export async function unfollowUser(uid, targetUid) {
  if (!db || !uid || !targetUid || uid === targetUid) return false;

  const batch = writeBatch(db);
  batch.delete(doc(db, "users", uid, "following", targetUid));
  batch.delete(doc(db, "users", targetUid, "followers", uid));
  batch.set(doc(db, "users", uid), { stats: { followingCount: increment(-1) } }, { merge: true });
  batch.set(doc(db, "publicProfiles", uid), { stats: { followingCount: increment(-1) } }, { merge: true });
  batch.set(doc(db, "users", targetUid), { stats: { followersCount: increment(-1) } }, { merge: true });
  batch.set(doc(db, "publicProfiles", targetUid), { stats: { followersCount: increment(-1) } }, { merge: true });
  await batch.commit();
  return true;
}

export async function getMutualFollowers(uid) {
  if (!db || !uid) return [];
  try {
    const followingSnap = await getDocs(collection(db, "users", uid, "following"));
    const followingIds = new Set(followingSnap.docs.map((d) => d.id));
    if (followingIds.size === 0) return [];

    const followersSnap = await getDocs(collection(db, "users", uid, "followers"));
    return followersSnap.docs
      .filter((d) => followingIds.has(d.id))
      .map((d) => normalizeConnectionProfile(d.id, d.data(), "mutual"));
  } catch (error) {
    console.warn("Could not get mutual followers:", error);
    return [];
  }
}

export async function sendStreakInvite(user, targetUid) {
  if (!db || !user || !targetUid) return false;
  const now = serverTimestamp();
  try {
    // Fetch custom display name and avatar from database to get the most accurate details
    const myDoc = await getDoc(doc(db, "users", user.uid));
    const myData = myDoc.exists() ? myDoc.data() : {};
    const displayName = cleanDisplayName(myData.displayName) || cleanDisplayName(user.displayName) || "A friend";
    const photoURL = cleanPhotoUrl(myData.photoURL) || cleanPhotoUrl(user.photoURL) || "";

    const pairId = [user.uid, targetUid].sort().join("_");

    await Promise.all([
      setDoc(
        doc(db, "users", targetUid, "notifications", `streak_invite_${user.uid}`),
        {
          title: "Streak Society Invite",
          body: `${displayName} invited you to maintain a streak together!`,
          unread: true,
          createdAt: now,
          updatedAt: now,
          type: "streak_invite",
          inviterUid: user.uid,
          inviterName: displayName,
          inviterPhotoURL: photoURL,
        },
        { merge: true }
      ),
      setDoc(
        doc(db, "pair_streaks", pairId),
        {
          uids: [user.uid, targetUid],
          status: "pending",
          invitedBy: user.uid,
          createdAt: now,
        },
        { merge: true }
      )
    ]);

    return true;
  } catch (error) {
    console.warn("Could not send streak invite:", error);
    return false;
  }
}

export async function getPairStreaks(uid) {
  if (!db || !uid) return [];
  try {
    const q = query(collection(db, "pair_streaks"), where("uids", "array-contains", uid));
    const snapshot = await getDocs(q);
    return normalizePairStreakSnapshot(snapshot, uid);
  } catch (err) {
    console.warn("Could not get pair streaks:", err);
    return [];
  }
}

export function listenPairStreaks(uid, callback, onError = console.warn) {
  if (!db || !uid) return () => {};
  const q = query(collection(db, "pair_streaks"), where("uids", "array-contains", uid));
  return onSnapshot(
    q,
    (snapshot) => callback(normalizePairStreakSnapshot(snapshot, uid)),
    onError
  );
}

export async function acceptPairStreak(user, targetUid) {
  if (!db || !user || !targetUid) return false;
  const pairId = [user.uid, targetUid].sort().join("_");

  try {
    await setDoc(doc(db, "pair_streaks", pairId), {
      uids: [user.uid, targetUid],
      streak: 0,
      lastUpdateDate: "",
      [`${user.uid}_lastUpdate`]: "",
      [`${targetUid}_lastUpdate`]: "",
      status: "active",
    }, { merge: true });

    // Fetch custom display name from database to get the most accurate name
    const myDoc = await getDoc(doc(db, "users", user.uid));
    const myData = myDoc.exists() ? myDoc.data() : {};
    const displayName = cleanDisplayName(myData.displayName) || cleanDisplayName(user.displayName) || "A friend";

    const now = serverTimestamp();
    await setDoc(
      doc(db, "users", targetUid, "notifications", `streak_accept_${user.uid}`),
      {
        title: "Streak Society Accepted",
        body: `${displayName} accepted your streak invite! Let's maintain it together!`,
        unread: true,
        createdAt: now,
        updatedAt: now,
        type: "streak_accept",
        partnerUid: user.uid,
      },
      { merge: true }
    );

    await updateActivePairStreaks(user.uid);

    return true;
  } catch (err) {
    console.warn("Could not accept pair streak:", err);
    return false;
  }
}

export async function rejectPairStreak(user, targetUid) {
  if (!db || !user || !targetUid) return false;
  const pairId = [user.uid, targetUid].sort().join("_");
  try {
    await deleteDoc(doc(db, "pair_streaks", pairId));
    return true;
  } catch (err) {
    console.warn("Could not reject pair streak:", err);
    return false;
  }
}

export async function sendPairStreakNudgeReminder(user, partnerUid, options = {}) {
  if (!user || !partnerUid) throw new Error("Missing pair streak reminder target.");
  const token = await user.getIdToken();
  const response = await fetch("/api/pair-streak-nudge", {
    method: "POST",
    keepalive: Boolean(options.keepalive),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      partnerUid,
    }),
  });
  const bodyText = await response.text().catch(() => "");
  const data = parseJsonBody(bodyText);
  if (!response.ok || data.ok === false) {
    if (response.status === 404) {
      throw new Error("API reminder is not running here. Use Vercel dev or deploy before testing email sending.");
    }
    throw new Error(data.error || bodyText || `Could not send pair streak reminder (${response.status}).`);
  }
  return data;
}

export async function queueStreakEventReminder(user, event = {}, options = {}) {
  if (!user) throw new Error("Missing streak event user.");
  const token = await user.getIdToken();
  const response = await fetch("/api/streak-event", {
    method: "POST",
    keepalive: Boolean(options.keepalive),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: event.type || "lesson-completed",
      courseId: event.courseId || "",
      lessonId: event.lessonId || "",
    }),
  });
  const bodyText = await response.text().catch(() => "");
  const data = parseJsonBody(bodyText);
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || bodyText || `Could not queue streak event reminder (${response.status}).`);
  }
  return data;
}

async function queueWelcomeEmail(user, options = {}) {
  if (!user) throw new Error("Missing welcome email user.");
  const token = await user.getIdToken();
  const response = await fetch("/api/welcome-mail", {
    method: "POST",
    keepalive: Boolean(options.keepalive),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const bodyText = await response.text().catch(() => "");
  const data = parseJsonBody(bodyText);
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || bodyText || `Could not send welcome email (${response.status}).`);
  }
  return data;
}

export async function claimStreakAnimation(uid, target = "header") {
  if (!db || !uid) return { shouldAnimate: false, from: 0, to: 0 };

  const field = animationFields[target] || animationFields.header;
  const todayStr = getTodayKey();
  const userRef = doc(db, "users", uid);

  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userRef);
    const data = snapshot.exists() ? snapshot.data() : {};
    const stats = data.stats || {};
    const streak = Number(stats.streak || 0);
    const lastStreakDate = stats.lastStreakDate || "";

    if (streak <= 0 || lastStreakDate !== todayStr || stats[field] === todayStr) {
      return { shouldAnimate: false, from: streak, to: streak };
    }

    transaction.update(userRef, {
      stats: {
        ...stats,
        [field]: todayStr,
      },
      updatedAt: serverTimestamp(),
    });

    return {
      shouldAnimate: true,
      from: Math.max(0, streak - 1),
      to: streak,
    };
  });
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
    const currentStats = normalizeStats(userData.stats || {});
    const lastStreakDate = currentStats.lastStreakDate || "";
    const shouldBumpStreak = lastStreakDate !== todayStr;
    const nextStreak = getNextStreakValue(currentStats, todayStr);

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
      statsUpdate.streak = nextStreak;
      statsUpdate.lastStreakDate = todayStr;
      statsUpdate.lastStreakUpdatedAt = serverTimestamp();
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

    transaction.set(
      doc(db, "publicProfiles", user.uid),
      {
        uid: user.uid,
        stats: {
          streak: shouldBumpStreak ? nextStreak : Number(currentStats.streak || 0),
          lessons: increment(1),
          lastStreakDate: shouldBumpStreak ? todayStr : currentStats.lastStreakDate || "",
        },
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
    updateActivePairStreaks(user.uid).catch(console.warn);
    queueStreakEventReminder(
      user,
      {
        type: "lesson-completed",
        courseId: lesson.courseId,
        lessonId: lesson.lessonId,
      },
      { keepalive: true }
    ).catch((error) => {
      console.warn("Could not queue streak event reminder:", error);
    });
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

function getPublicProfilePayload(uid, profile) {
  return {
    uid,
    displayName: cleanDisplayName(profile.displayName) || "TOEIC Learner",
    searchName: normalizeSearchName(profile.displayName),
    email: profile.email || "",
    photoURL: cleanPhotoUrl(profile.photoURL),
    stats: {
      streak: Number(profile.stats?.streak || 0),
      lessons: Number(profile.stats?.lessons || 0),
      followersCount: Number(profile.stats?.followersCount || 0),
      followingCount: Number(profile.stats?.followingCount || 0),
      lastStreakDate: profile.stats?.lastStreakDate || "",
    },
    learning: {
      recentCourse: profile.learning?.recentCourse || defaultLearning.recentCourse,
      recentLesson: profile.learning?.recentLesson || defaultLearning.recentLesson,
    },
    updatedAt: serverTimestamp(),
  };
}

function normalizePublicProfile(id, data = {}) {
  return {
    uid: data.uid || id,
    displayName: cleanDisplayName(data.displayName) || "TOEIC Learner",
    searchName: data.searchName || normalizeSearchName(data.displayName),
    email: data.email || "",
    photoURL: cleanPhotoUrl(data.photoURL),
    stats: normalizeStats(data.stats || {}),
    learning: { ...defaultLearning, ...(data.learning || {}) },
  };
}

function normalizeConnectionProfile(id, data = {}, type = "following") {
  const uid = data.targetUid || data.followerUid || data.uid || id;
  return {
    uid,
    displayName: cleanDisplayName(data.displayName) || "TOEIC Learner",
    photoURL: cleanPhotoUrl(data.photoURL),
    type,
    updatedAt: data.updatedAt || data.followedAt || null,
  };
}

function normalizePairStreakSnapshot(snapshot, uid) {
  const nowTime = new Date().getTime();
  return snapshot.docs
    .map((docSnap) => normalizePairStreakDoc(docSnap, uid, nowTime));
}

function normalizePairStreakDoc(docSnap, uid, nowTime = new Date().getTime()) {
  const data = docSnap.data() || {};
  const uids = Array.isArray(data.uids) ? data.uids : [];
  const lastUpdateStr = data.lastUpdateDate || "";
  const lastTime = lastUpdateStr ? new Date(lastUpdateStr).getTime() : nowTime;
  const diffDays = lastUpdateStr ? Math.floor((nowTime - lastTime) / 86400000) : 0;
  const status = data.status || "active";
  const streak = Number(data.streak || 0);
  const isExpired = status === "active" && streak > 0 && diffDays >= 3;
  const normalizedStatus = isExpired ? "broken" : status;

  return {
    id: docSnap.id,
    partnerUid: uids.find((item) => item !== uid) || "",
    streak: normalizedStatus === "broken" ? 0 : streak,
    lastUpdateDate: lastUpdateStr,
    isBroken: normalizedStatus === "broken",
    status: normalizedStatus,
    invitedBy: data.invitedBy || "",
    brokenFromStreak: Number(data.brokenFromStreak || streak || 0),
  };
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
    // deleteDoc is already imported at the top of this file
    await deleteDoc(doc(db, "users", uid, "timerProgress", lessonKey));
  } catch (_) {}
}

export function normalizeProfile(user, stored = {}) {
  const stats = normalizeStats(stored.stats || {});
  return {
    displayName: stored.displayName || getGoogleName(user),
    email: stored.email || user?.email || "",
    photoURL: stored.photoURL || getGooglePhoto(user),
    stats,
    learning: { ...defaultLearning, ...(stored.learning || {}) },
    emailPreferences: normalizeEmailPreferences(stored.emailPreferences),
    notificationsSeeded: Boolean(stored.notificationsSeeded),
    notificationsVersion: stored.notificationsVersion || "",
  };
}

function normalizeStats(stats = {}, date = new Date()) {
  const todayStr = getTodayKey(date);
  const lastStreakDate = stats.lastStreakDate || "";
  const shouldReset = shouldResetStreak(lastStreakDate, todayStr);

  return {
    ...stats,
    streak: shouldReset ? 0 : Number(stats.streak || defaultStats.streak),
    lessons: Number(stats.lessons || defaultStats.lessons),
    lastStreakDate,
  };
}

function getNextStreakValue(stats, todayStr) {
  if (stats.lastStreakDate === todayStr) return Number(stats.streak || 0);
  if (isYesterdayKey(stats.lastStreakDate, todayStr)) return Number(stats.streak || 0) + 1;
  return 1;
}

function shouldResetStreak(lastStreakDate, todayStr) {
  if (!lastStreakDate) return false;
  return lastStreakDate !== todayStr && !isYesterdayKey(lastStreakDate, todayStr);
}

function isYesterdayKey(dateKey, todayStr) {
  if (!dateKey || !todayStr) return false;

  const today = parseDateKey(todayStr);
  const previous = parseDateKey(dateKey);
  if (!today || !previous) return false;

  const diffDays = Math.round((today.getTime() - previous.getTime()) / 86400000);
  return diffDays === 1;
}

function parseDateKey(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function normalizeEmailPreferences(value = {}) {
  const reminderIntensity = ["gentle", "normal", "dramatic"].includes(value.reminderIntensity)
    ? value.reminderIntensity
    : defaultEmailPreferences.reminderIntensity;

  return {
    studyReminders: value.studyReminders !== false && defaultEmailPreferences.studyReminders,
    newLessonAlerts: value.newLessonAlerts !== false && defaultEmailPreferences.newLessonAlerts,
    reminderIntensity,
  };
}

function cleanDisplayName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 48);
}

function cleanPhotoUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("data:image/")) return text.slice(0, 850000);
  if (/^https?:\/\//i.test(text)) return text.slice(0, 2000);
  return "";
}

function parseJsonBody(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch (_) {
    return {};
  }
}

function normalizeSearchName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getGoogleName(user) {
  return user?.displayName || user?.providerData?.find((provider) => provider.providerId === "google.com")?.displayName || "TOEIC Learner";
}

function getGooglePhoto(user) {
  return user?.photoURL || user?.providerData?.find((provider) => provider.providerId === "google.com")?.photoURL || "";
}

export async function updateActivePairStreaks(uid) {
  if (!db || !uid) return;
  const todayStr = getTodayKey();

  try {
    const q = query(collection(db, "pair_streaks"), where("uids", "array-contains", uid));
    const snapshot = await getDocs(q);
    const userRef = doc(db, "users", uid);
    const userSnap = await getDoc(userRef);
    const userData = userSnap.exists() ? userSnap.data() : {};
    const userStats = userData.stats || {};

    if (userStats.lastStreakDate !== todayStr) return;

    for (const d of snapshot.docs) {
      const pairRef = doc(db, "pair_streaks", d.id);

      await runTransaction(db, async (transaction) => {
        const pairSnap = await transaction.get(pairRef);
        if (!pairSnap.exists()) return;

        const data = pairSnap.data();
        const uids = Array.isArray(data.uids) ? data.uids : [];
        const partnerUid = uids.find((item) => item !== uid);
        if (!partnerUid || (data.status || "active") !== "active") return;

        if (shouldBreakPairStreak(data, todayStr)) {
          transaction.set(
            pairRef,
            {
              status: "broken",
              streak: 0,
              brokenDate: todayStr,
              brokenFromStreak: Number(data.streak || 0),
              brokenReason: "three_days_without_pair_progress",
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          );
          return;
        }

        if (data.lastUpdateDate === todayStr) return;

        const partnerSnap = await transaction.get(doc(db, "publicProfiles", partnerUid));
        const partnerStats = partnerSnap.exists() ? partnerSnap.data().stats || {} : {};
        const partnerStudiedToday = partnerStats.lastStreakDate === todayStr;
        const partnerMarkedToday = data[`${partnerUid}_lastUpdate`] === todayStr;
        const update = {
          [`${uid}_lastUpdate`]: todayStr,
          updatedAt: serverTimestamp(),
        };

        if (partnerStudiedToday || partnerMarkedToday) {
          const previousPairDate = data.lastUpdateDate || "";
          const nextStreak = isYesterdayKey(previousPairDate, todayStr) ? Number(data.streak || 0) + 1 : 1;
          transaction.set(
            pairRef,
            {
              ...update,
              ...(partnerStudiedToday ? { [`${partnerUid}_lastUpdate`]: todayStr } : {}),
              streak: nextStreak,
              lastUpdateDate: todayStr,
            },
            { merge: true }
          );
          return;
        }

        transaction.set(pairRef, update, { merge: true });
      });
    }
  } catch (err) {
    console.warn("Failed to update active pair streaks:", err);
  }
}

function shouldBreakPairStreak(data = {}, todayStr) {
  const streak = Number(data.streak || 0);
  if (streak <= 0 || !data.lastUpdateDate) return false;
  const diffDays = getDaysBetweenDateKeys(data.lastUpdateDate, todayStr);
  return Number.isFinite(diffDays) && diffDays >= 3;
}

function getDaysBetweenDateKeys(fromKey, toKey) {
  const fromDate = parseDateKey(fromKey);
  const toDate = parseDateKey(toKey);
  if (!fromDate || !toDate) return Number.NaN;
  return Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
}
