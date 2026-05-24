const admin = require("firebase-admin");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const FROM_EMAIL = "azotatoeic@gmail.com";
const FROM_NAME = "AzoTa TOEIC";
const TIME_ZONE = "Asia/Bangkok";
const DEFAULT_AI_PROVIDER = "groq";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_APP_BASE_URL = "https://to-ic.vercel.app";
const MAX_PAIR_CONTEXTS = 8;
const MAX_FRIEND_CONTEXTS = 8;
const EMAIL_COPY_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Email subject, max 90 characters." },
    preview: { type: "string", description: "Inbox preview text, max 140 characters." },
    body: { type: "string", description: "Vietnamese email body, under 110 words." },
    ctaText: { type: "string", description: "Short call-to-action label." },
  },
  required: ["subject", "preview", "body", "ctaText"],
};

let mailTransporter;
let cachedDb;

async function runMailWorker({ mode = "all" } = {}) {
  const runDate = new Date();
  const todayKey = getDateKeyInTimeZone(runDate, TIME_ZONE);
  const reminderSlot = getReminderSlot(runDate);
  const normalizedMode = String(mode || "all").toLowerCase();
  const result = {
    todayKey,
    reminderSlot,
    pairBreaks: null,
    starterReminders: null,
    reminders: null,
    announcements: null,
  };

  if (["starter", "starter-reminders", "early-reminders"].includes(normalizedMode)) {
    result.starterReminders = await sendStarterStudyReminders(todayKey, { slot: reminderSlot });
  }

  if (["all", "reminders", "study-reminders"].includes(normalizedMode)) {
    result.pairBreaks = await expireBrokenPairStreaks(todayKey);
    result.reminders = await sendDailyStudyReminders(todayKey, { slot: reminderSlot });
  }

  if (["all", "announcements", "new-lessons"].includes(normalizedMode)) {
    result.announcements = await sendReadyAnnouncements();
  }

  return result;
}

function isAuthorizedRequest(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authHeader = request.headers?.authorization || request.headers?.Authorization || "";
  if (authHeader === `Bearer ${secret}`) return true;

  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get("secret") === secret;
  } catch (_) {
    return false;
  }
}

async function verifyFirebaseRequest(request) {
  const authHeader = request.headers?.authorization || request.headers?.Authorization || "";
  const match = String(authHeader).match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw createHttpError(401, "Missing Firebase auth token.");
  }

  getDb();
  try {
    return await admin.auth().verifyIdToken(match[1]);
  } catch (error) {
    throw createHttpError(401, "Invalid Firebase auth token.");
  }
}

async function sendWelcomeEmail({ uid }) {
  if (!uid) {
    throw createHttpError(400, "Missing welcome email user.");
  }

  const db = getDb();
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw createHttpError(404, "User profile not found.");
  }

  const userData = userSnap.data() || {};
  const notification = getWelcomeNotificationCopy();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const notificationRef = userRef.collection("notifications").doc("welcome");
  const notificationSnap = await notificationRef.get();
  await notificationRef.set(
    notificationSnap.exists
      ? {
          ...notification,
          updatedAt: now,
          type: "welcome",
        }
      : {
          ...notification,
          unread: true,
          createdAt: now,
          updatedAt: now,
          type: "welcome",
        },
    { merge: true }
  );

  if (!userData.email) {
    return { sent: false, skipped: 1, reason: "missing-email" };
  }

  const deliveryRef = userRef.collection("emailDeliveries").doc("welcome");
  const shouldSend = await db.runTransaction(async (transaction) => {
    const deliverySnap = await transaction.get(deliveryRef);
    const deliveryData = deliverySnap.exists ? deliverySnap.data() || {} : {};
    if (deliverySnap.exists && deliveryData.status !== "failed") return false;
    const deliveryClaim = {
      type: "welcome",
      to: userData.email,
      status: "sending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (deliverySnap.exists) {
      deliveryClaim.error = admin.firestore.FieldValue.delete();
    }
    transaction.set(
      deliveryRef,
      deliveryClaim,
      { merge: true }
    );
    return true;
  });

  if (!shouldSend) {
    return { sent: false, skipped: 1, alreadySent: true };
  }

  const copy = createWelcomeEmailCopy(userData);
  try {
    await sendMail({
      to: userData.email,
      copy,
      ctaUrl: `${getAppBaseUrl()}/pages/hoc-phan.html`,
      type: "welcome",
      user: userData,
      tracking: { uid, deliveryId: "welcome", type: "welcome" },
    });
  } catch (error) {
    await deliveryRef.set(
      {
        status: "failed",
        error: limitText(error.message, 240),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw error;
  }

  const sentAt = admin.firestore.FieldValue.serverTimestamp();
  await Promise.all([
    deliveryRef.set(
      {
        type: "welcome",
        to: userData.email,
        subject: copy.subject,
        status: "sent",
        sentAt,
      },
      { merge: true }
    ),
    userRef.set(
      {
        emailState: {
          welcomeEmailSentAt: sentAt,
          lastEmailSentAt: sentAt,
        },
        updatedAt: sentAt,
      },
      { merge: true }
    ),
  ]);

  return { sent: true, skipped: 0 };
}

async function sendPairStreakNudge({ requesterUid, partnerUid }) {
  if (!requesterUid || !partnerUid || requesterUid === partnerUid) {
    throw createHttpError(400, "Invalid pair streak reminder target.");
  }

  const db = getDb();
  const todayKey = getDateKeyInTimeZone(new Date(), TIME_ZONE);
  const pairId = [requesterUid, partnerUid].sort().join("_");
  const pairRef = db.collection("pair_streaks").doc(pairId);
  const requesterRef = db.collection("users").doc(requesterUid);
  const partnerRef = db.collection("users").doc(partnerUid);
  const [pairSnap, requesterSnap, partnerSnap] = await Promise.all([pairRef.get(), requesterRef.get(), partnerRef.get()]);

  if (!pairSnap.exists) {
    throw createHttpError(404, "Pair streak not found.");
  }

  const pairData = pairSnap.data() || {};
  const pairUids = Array.isArray(pairData.uids) ? pairData.uids : [];
  if (!pairUids.includes(requesterUid) || !pairUids.includes(partnerUid) || (pairData.status || "active") !== "active") {
    throw createHttpError(403, "This pair streak is not active.");
  }

  if (shouldBreakPairStreak(pairData, todayKey)) {
    await pairRef.set(
      {
        status: "broken",
        streak: 0,
        brokenDate: todayKey,
        brokenAt: admin.firestore.FieldValue.serverTimestamp(),
        brokenFromStreak: Number(pairData.streak || 0),
        brokenReason: "three_days_without_pair_progress",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    throw createHttpError(409, "This pair streak has ended.");
  }

  const requesterData = requesterSnap.exists ? requesterSnap.data() || {} : {};
  const partnerData = partnerSnap.exists ? partnerSnap.data() || {} : {};
  const requesterStats = requesterData.stats || {};
  const partnerStats = partnerData.stats || {};

  if (requesterStats.lastStreakDate !== todayKey) {
    throw createHttpError(409, "Finish a lesson today before nudging your partner.");
  }

  if (partnerStats.lastStreakDate === todayKey || pairData.lastUpdateDate === todayKey) {
    throw createHttpError(409, "This pair streak is already safe today.");
  }

  if (partnerData.emailPreferences?.studyReminders === false) {
    throw createHttpError(409, "Your partner has disabled study reminder emails.");
  }

  if (!partnerData.email) {
    throw createHttpError(409, "Your partner does not have an email address.");
  }

  const nudgeId = toDocId(`${requesterUid}-${partnerUid}-${todayKey}`);
  const nudgeRef = pairRef.collection("nudges").doc(nudgeId);
  const existingNudge = await nudgeRef.get();
  if (existingNudge?.exists) {
    return {
      sent: false,
      alreadySent: true,
      partnerName: cleanDisplayName(partnerData.displayName) || "bạn học của bạn",
      todayKey,
    };
  }

  const copy = await createPairStreakNudgeCopy({
    requesterData,
    partnerData,
    pairData,
    todayKey,
  });
  const now = admin.firestore.FieldValue.serverTimestamp();

  await sendMail({
    to: partnerData.email,
    copy,
    ctaUrl: `${getAppBaseUrl()}/pages/hoc-phan.html`,
    type: "pair-streak-nudge",
    user: partnerData,
    tracking: { uid: partnerUid, deliveryId: `pair-streak-nudge__${requesterUid}__${todayKey}`, type: "pair-streak-nudge" },
  });

  await Promise.all([
    nudgeRef.set(
      {
        fromUid: requesterUid,
        toUid: partnerUid,
        toEmail: partnerData.email,
        subject: copy.subject,
        sentAt: now,
      },
      { merge: true }
    ),
    partnerRef.collection("notifications").doc(`pair_streak_nudge_${requesterUid}_${todayKey}`).set(
      {
        title: "Pair streak reminder",
        body: `${cleanDisplayName(requesterData.displayName) || "Your study partner"} is waiting for you to study today.`,
        unread: true,
        createdAt: now,
        updatedAt: now,
        type: "pair_streak_nudge",
        partnerUid: requesterUid,
      },
      { merge: true }
    ),
  ]);

  return {
    sent: true,
    alreadySent: false,
    partnerName: cleanDisplayName(partnerData.displayName) || "your study partner",
    todayKey,
  };
}

async function sendRealtimeStreakEventReminder({ actorUid, eventType = "lesson-completed" }) {
  if (!actorUid) {
    throw createHttpError(400, "Missing streak event actor.");
  }

  const db = getDb();
  const todayKey = getDateKeyInTimeZone(new Date(), TIME_ZONE);
  const actorSnap = await db.collection("users").doc(actorUid).get();
  const actorData = actorSnap.exists ? actorSnap.data() || {} : {};

  if (!hasStudiedToday(actorData.stats, todayKey)) {
    return { todayKey, eventType, sent: 0, skipped: 1, failed: 0, reason: "actor-not-studied-today" };
  }

  await expireBrokenPairStreaks(todayKey);

  const pairSnapshot = await db
    .collection("pair_streaks")
    .where("uids", "array-contains", actorUid)
    .limit(getNumberEnv("MAX_REALTIME_PAIR_REMINDERS", 5))
    .get();

  const result = { todayKey, eventType, sent: 0, skipped: 0, failed: 0 };

  for (const docSnap of pairSnapshot.docs) {
    const pairData = docSnap.data() || {};
    const partnerUid = getPairPartnerUid(pairData, actorUid);
    if (!partnerUid || (pairData.status || "active") !== "active" || pairData.lastUpdateDate === todayKey) {
      result.skipped += 1;
      continue;
    }

    try {
      const partnerSnap = await db.collection("users").doc(partnerUid).get();
      const partnerData = partnerSnap.exists ? partnerSnap.data() || {} : {};
      if (!partnerData.email || partnerData.emailPreferences?.studyReminders === false || hasStudiedToday(partnerData.stats, todayKey)) {
        result.skipped += 1;
        continue;
      }

      const sendResult = await sendPairStreakNudge({ requesterUid: actorUid, partnerUid });
      if (sendResult.sent) {
        result.sent += 1;
      } else {
        result.skipped += 1;
      }
    } catch (error) {
      const status = Number(error.statusCode || 500);
      if (status === 409 || status === 403 || status === 404) {
        result.skipped += 1;
      } else {
        result.failed += 1;
        console.error("Realtime streak event reminder failed:", {
          actorUid,
          partnerUid,
          message: error.message,
        });
      }
    }
  }

  return result;
}

async function expireBrokenPairStreaks(todayKey) {
  const db = getDb();
  const maxPairs = getNumberEnv("MAX_PAIR_BREAKS_PER_RUN", 30);
  const snapshot = await db.collection("pair_streaks").where("status", "in", ["active", "broken"]).limit(maxPairs * 3).get();
  const result = { scanned: snapshot.size, broken: 0, sent: 0, skipped: 0, failed: 0 };

  for (const docSnap of snapshot.docs) {
    if (result.broken >= maxPairs) break;

    const pairData = docSnap.data() || {};
    const alreadyBroken = (pairData.status || "active") === "broken";
    if (!alreadyBroken && !shouldBreakPairStreak(pairData, todayKey)) {
      result.skipped += 1;
      continue;
    }

    const uids = Array.isArray(pairData.uids) ? pairData.uids.filter(Boolean).slice(0, 2) : [];
    if (uids.length < 2) {
      result.skipped += 1;
      continue;
    }

    const breakDate = alreadyBroken && pairData.brokenDate ? pairData.brokenDate : todayKey;
    const pairStreak = Number(pairData.brokenFromStreak || pairData.streak || 0);
    const deliveryId = `pair-streak-broken__${breakDate}`;
    const deliveryRef = docSnap.ref.collection("emailDeliveries").doc(deliveryId);
    const deliverySnap = await deliveryRef.get();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const brokenUpdate = alreadyBroken
      ? {
          status: "broken",
          streak: 0,
          ...(pairData.brokenFromStreak ? {} : { brokenFromStreak: pairStreak }),
          updatedAt: now,
        }
      : {
          status: "broken",
          streak: 0,
          brokenDate: breakDate,
          brokenAt: now,
          brokenFromStreak: pairStreak,
          brokenReason: "three_days_without_pair_progress",
          updatedAt: now,
        };

    await docSnap.ref.set(brokenUpdate, { merge: true });

    if (!alreadyBroken) result.broken += 1;

    if (deliverySnap.exists) {
      result.skipped += 1;
      continue;
    }

    try {
      const userSnaps = await Promise.all(uids.map((uid) => db.collection("users").doc(uid).get()));
      const users = userSnaps.map((snap, index) => ({
        uid: uids[index],
        ref: db.collection("users").doc(uids[index]),
        data: snap.exists ? snap.data() || {} : {},
      }));
      let sentForPair = 0;

      for (const user of users) {
        if (!user.data.email) {
          result.skipped += 1;
          continue;
        }

        const partner = users.find((item) => item.uid !== user.uid) || { data: {} };
        const copy = await createPairStreakBrokenCopy({
          userData: user.data,
          partnerData: partner.data,
          pairData: {
            ...pairData,
            streak: pairStreak,
            brokenFromStreak: pairStreak,
          },
          todayKey,
        });

        await sendMail({
          to: user.data.email,
          copy,
          ctaUrl: `${getAppBaseUrl()}/pages/hoc-phan.html`,
          type: "pair-streak-broken",
          user: user.data,
          tracking: { uid: user.uid, deliveryId: `${deliveryId}__${docSnap.id}`, type: "pair-streak-broken" },
        });

        await Promise.all([
          user.ref.collection("emailDeliveries").doc(`${deliveryId}__${docSnap.id}`).set(
            {
              type: "pair-streak-broken",
              to: user.data.email,
              subject: copy.subject,
              pairId: docSnap.id,
              sentAt: now,
            },
            { merge: true }
          ),
          user.ref.collection("notifications").doc(`pair_streak_broken_${docSnap.id}_${breakDate}`).set(
            {
              title: "Team streak ended",
              body: `Your streak with ${cleanDisplayName(partner.data.displayName) || "your study partner"} ended after 3 days without progress.`,
              unread: true,
              createdAt: now,
              updatedAt: now,
              type: "pair_streak_broken",
              partnerUid: partner.uid || "",
              pairId: docSnap.id,
            },
            { merge: true }
          ),
        ]);

        result.sent += 1;
        sentForPair += 1;
      }

      await deliveryRef.set(
        {
          type: "pair-streak-broken",
          sentCount: sentForPair,
          subject: "Chuỗi học nhóm đã kết thúc",
          sentAt: now,
        },
        { merge: true }
      );
    } catch (error) {
      result.failed += 1;
      console.error("Pair streak break email failed:", {
        pairId: docSnap.id,
        message: error.message,
      });
    }
  }

  return result;
}

async function sendDailyStudyReminders(todayKey, { slot = "daily" } = {}) {
  const candidates = await getEmailCandidates((user) => shouldSendStudyReminder(user, todayKey, { slot }), {
    resetBrokenStreaks: true,
    todayKey,
  });
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `study-reminder__${todayKey}__${slot}`,
    type: (user, copy) => copy.kind || "study-reminder",
    copyFactory: (user) => createContextualStudyReminderCopy(user, todayKey, { slot }),
    urlFactory: () => `${getAppBaseUrl()}/pages/hoc-phan.html`,
    notificationFactory: (copy) => createStudyReminderNotification(copy, todayKey, slot),
    afterSend: (user, copy) => user.ref.update(buildReminderEmailStateUpdate(user.data, todayKey, slot, copy.kind || "study-reminder", copy.templateKey)),
  });

  return result;
}

async function sendStarterStudyReminders(todayKey, { slot = "morning" } = {}) {
  const candidates = await getEmailCandidates((user) => shouldSendStarterReminder(user, todayKey, { slot }), {
    resetBrokenStreaks: true,
    todayKey,
  });
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `starter-reminder__${todayKey}__${slot}`,
    type: "starter-reminder",
    copyFactory: (user) => createStudyReminderCopy(user, todayKey, { kind: "starter-reminder", slot }),
    urlFactory: () => `${getAppBaseUrl()}/pages/hoc-phan.html`,
    notificationFactory: () => createStarterReminderNotification(todayKey, slot),
    afterSend: (user, copy) =>
      user.ref.update({
        ...buildReminderEmailStateUpdate(user.data, todayKey, slot, "starter-reminder", copy.templateKey || "starter"),
        "emailState.lastStarterReminderDate": todayKey,
        "emailState.lastStarterReminderSlot": slot,
      }),
  });

  return result;
}

async function sendReadyAnnouncements() {
  const db = getDb();
  const queuedLessons = await queueReadyLessonAnnouncements();
  const maxAnnouncements = getNumberEnv("MAX_ANNOUNCEMENTS_PER_RUN", 10);
  const [readySnapshot, legacySnapshot] = await Promise.all([
    db.collection("announcements").where("status", "in", ["ready", "queued"]).limit(maxAnnouncements).get(),
    db.collection("announcements").limit(maxAnnouncements).get(),
  ]);
  const announcementDocs = new Map();
  [...readySnapshot.docs, ...legacySnapshot.docs].forEach((docSnap) => {
    announcementDocs.set(docSnap.id, docSnap);
  });
  const announcements = [...announcementDocs.values()]
    .map((docSnap) => ({ ref: docSnap.ref, id: docSnap.id, data: docSnap.data() || {} }))
    .filter((item) => shouldSendAnnouncementDoc(item.data))
    .slice(0, maxAnnouncements);
  const results = [];

  for (const item of announcements) {
    const announcement = normalizeAnnouncement(item.data, item.id);
    await item.ref.set(
      {
        status: "sending",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const candidates = await getEmailCandidates((user) => shouldSendAnnouncement(user));
    const deliveryResult = await deliverToCandidates({
      candidates,
      deliveryId: `announcement__${item.id}`,
      type: "announcement",
      copyFactory: (user) => createAnnouncementCopy(user, announcement),
      urlFactory: () => announcement.lessonUrl,
      notificationFactory: () => createAnnouncementNotification(item.id),
      afterSend: (user) =>
        user.ref.set(
          {
            emailState: {
              lastAnnouncementId: item.id,
              lastAnnouncementSentAt: admin.firestore.FieldValue.serverTimestamp(),
              lastEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        ),
    });

    const announcementStatus = deliveryResult.failed > 0 ? "sent-with-errors" : "sent";

    await item.ref.set(
      {
        status: announcementStatus,
        sentCount: deliveryResult.sent,
        skippedCount: deliveryResult.skipped,
        failedCount: deliveryResult.failed,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await updateAnnouncementSourceLesson(announcement, announcementStatus, deliveryResult, item.id);
    results.push({ id: item.id, ...deliveryResult });
  }

  return {
    queuedLessons,
    processed: results.length,
    results,
  };
}

function getWelcomeNotificationCopy() {
  return {
    title: "Welcome to AzoTa TOEIC",
    body: "Your account is ready. Start with one short TOEIC lesson when you are ready.",
  };
}

function createStudyReminderNotification(copy, todayKey, slot) {
  const kind = String(copy?.kind || "study-reminder");
  const variants = {
    "pair-streak-nudge": {
      title: "Your pair streak is waiting",
      body: "Complete a TOEIC lesson today so your team streak can keep growing.",
    },
    "pair-streak-both-idle": {
      title: "Your team streak needs a starter",
      body: "Be the first to complete a TOEIC lesson today and get the team moving.",
    },
    "friend-overtook": {
      title: "Your friends studied today",
      body: "Keep pace with your friends with one short TOEIC lesson.",
    },
    "streak-rookie": {
      title: "Your TOEIC streak has started",
      body: "Keep the early flame alive with one lesson today.",
    },
    "streak-vip": {
      title: "Protect your long TOEIC streak",
      body: "That streak took time to build. Complete one lesson today to keep it safe.",
    },
    "streak-last-call": {
      title: "Last call for your streak",
      body: "Finish one TOEIC lesson before today ends.",
    },
    "weekend-streak": {
      title: "Weekend streak check",
      body: "Do one short TOEIC lesson so the weekend does not break your rhythm.",
    },
    "morning-check-in": {
      title: "Morning TOEIC check-in",
      body: "Start the day with one short lesson and keep your streak steady.",
    },
    "midday-rescue": {
      title: "Midday streak rescue",
      body: "A quick TOEIC lesson now keeps your streak from waiting all day.",
    },
    "comeback-reminder": {
      title: "Restart your TOEIC rhythm",
      body: "One short lesson is enough to get back on track today.",
    },
    "dormant-warning": {
      title: "AzoTa is still waiting",
      body: "You have been away for a few days. One short TOEIC lesson can bring your rhythm back.",
    },
    milestone: {
      title: "You reached a streak milestone",
      body: "Your consistency is building. Keep it going with another lesson.",
    },
    freeze: {
      title: "Streak freeze activated",
      body: "Your streak has been saved. Complete a lesson today to protect it.",
    },
    "study-reminder": {
      title: "Keep your TOEIC streak",
      body: "Complete a TOEIC lesson today before your streak resets.",
    },
  };

  return {
    id: `study-reminder__${todayKey}__${slot}`,
    ...(variants[kind] || variants["study-reminder"]),
  };
}

function createStarterReminderNotification(todayKey, slot) {
  return {
    id: `starter-reminder__${todayKey}__${slot}`,
    title: "Start your TOEIC habit",
    body: "Complete one short lesson today to create your first streak.",
  };
}

function createAnnouncementNotification(announcementId) {
  return {
    id: `announcement__${announcementId}`,
    title: "New TOEIC lesson",
    body: "A new lesson is ready in your course list.",
  };
}

async function queueReadyLessonAnnouncements() {
  const db = getDb();
  const maxLessons = getNumberEnv("MAX_LESSON_ANNOUNCEMENTS_PER_RUN", 10);
  const lessonEntries = await getLessonsMarkedForAnnouncement(db, maxLessons);
  const result = { scanned: lessonEntries.length, queued: 0, skipped: 0, failed: 0 };

  for (const entry of lessonEntries) {
    const { lessonSnap, courseId, course } = entry;
    try {
      const lesson = lessonSnap.data() || {};
      const courseRef = lessonSnap.ref.parent.parent;
      if (!courseRef || lesson.published === false) {
        result.skipped += 1;
        continue;
      }

      const lessonId = lessonSnap.id;
      const announcementId = toDocId(`lesson-${courseId}-${lessonId}`);
      const announcementRef = db.collection("announcements").doc(announcementId);
      const announcementSnap = await announcementRef.get();
      const announcementData = announcementSnap.exists ? announcementSnap.data() || {} : {};

      if (isTerminalAnnouncementStatus(announcementData.status)) {
        await lessonSnap.ref.set(
          {
            notifyNewLesson: false,
            announcementId,
            announcementStatus: announcementData.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        result.skipped += 1;
        continue;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      await announcementRef.set(
        {
          ...(announcementSnap.exists ? {} : { createdAt: now }),
          type: "new-lesson",
          status: "ready",
          sendEmail: true,
          courseId,
          lessonId,
          courseTitle: course.title || courseId,
          lessonTitle: lesson.title || lessonId,
          lessonUrl: buildLessonUrl(courseId, lessonId),
          summary: lesson.description || lesson.status || lesson.type || "",
          source: "course-lesson",
          sourcePath: lessonSnap.ref.path,
          updatedAt: now,
        },
        { merge: true }
      );

      await lessonSnap.ref.set(
        {
          notifyNewLesson: false,
          announcementId,
          announcementStatus: "queued",
          announcementQueuedAt: now,
          updatedAt: now,
        },
        { merge: true }
      );

      result.queued += 1;
    } catch (error) {
      result.failed += 1;
      console.error("Could not queue lesson announcement:", {
        path: lessonSnap.ref.path,
        message: error.message,
      });
    }
  }

  return result;
}

async function getLessonsMarkedForAnnouncement(db, maxLessons) {
  const courseSnapshot = await db.collection("courses").limit(100).get();
  const lessons = [];

  for (const courseSnap of courseSnapshot.docs) {
    if (lessons.length >= maxLessons) break;

    const lessonSnapshot = await courseSnap.ref
      .collection("lessons")
      .where("notifyNewLesson", "==", true)
      .limit(maxLessons - lessons.length)
      .get();

    lessonSnapshot.docs.forEach((lessonSnap) => {
      lessons.push({
        lessonSnap,
        courseId: courseSnap.id,
        course: courseSnap.data() || {},
      });
    });
  }

  return lessons;
}

async function updateAnnouncementSourceLesson(announcement, status, deliveryResult, announcementId) {
  if (!announcement.sourcePath) return;

  try {
    await getDb().doc(announcement.sourcePath).set(
      {
        announcementId,
        announcementStatus: status,
        announcementSentCount: deliveryResult.sent,
        announcementFailedCount: deliveryResult.failed,
        announcementCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    console.warn("Could not update source lesson announcement state:", {
      sourcePath: announcement.sourcePath,
      message: error.message,
    });
  }
}

async function getEmailCandidates(predicate, options = {}) {
  const maxEmails = getNumberEnv("MAX_EMAILS_PER_RUN", 40);
  const snapshot = await getDb().collection("users").limit(maxEmails * 3).get();
  const candidates = [];

  for (const docSnap of snapshot.docs) {
    if (candidates.length >= maxEmails) break;

    const user = { ref: docSnap.ref, id: docSnap.id, data: docSnap.data() || {} };
    if (options.resetBrokenStreaks) {
      await resetBrokenStreakIfNeeded(user, options.todayKey);
    }
    if (Boolean(user.data.email) && predicate(user)) {
      candidates.push(user);
    }
  }

  return candidates;
}

async function resetBrokenStreakIfNeeded(user, todayKey) {
  const stats = user.data.stats || {};
  const streak = Number(stats.streak || 0);
  if (streak <= 0 || !shouldResetStreak(stats.lastStreakDate, todayKey)) return;

  const nextStats = {
    ...stats,
    streak: 0,
    streakResetDate: todayKey,
    streakBrokenAfterDate: stats.lastStreakDate || "",
  };
  user.data.stats = nextStats;

  await user.ref.set(
    {
      stats: {
        streak: 0,
        streakResetDate: todayKey,
        streakBrokenAfterDate: stats.lastStreakDate || "",
        lastStreakResetAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function deliverToCandidates(options) {
  const { candidates, deliveryId, type, copyFactory, urlFactory, notificationFactory, afterSend } = options;
  const delayMs = getNumberEnv("EMAIL_SEND_DELAY_MS", 900);
  const result = { sent: 0, skipped: 0, failed: 0 };

  for (const user of candidates) {
    const deliveryRef = user.ref.collection("emailDeliveries").doc(deliveryId);
    const deliverySnap = await deliveryRef.get();
    if (deliverySnap.exists) {
      result.skipped += 1;
      continue;
    }

    try {
      const copy = await copyFactory(user);
      const deliveryType = typeof type === "function" ? type(user, copy) : type;
      const ctaUrl = urlFactory(user, copy);
      await sendMail({
        to: user.data.email,
        copy,
        ctaUrl,
        type: deliveryType,
        user: user.data,
        tracking: { uid: user.id, deliveryId, type: deliveryType },
      });

      const notification = notificationFactory(copy);
      const now = admin.firestore.FieldValue.serverTimestamp();
      await Promise.all([
        deliveryRef.set(
          {
            type: deliveryType,
            to: user.data.email,
            subject: copy.subject,
            sentAt: now,
          },
          { merge: true }
        ),
        user.ref.collection("notifications").doc(notification.id).set(
          {
            title: notification.title,
            body: notification.body,
            unread: true,
            createdAt: now,
            updatedAt: now,
          },
          { merge: true }
        ),
        afterSend(user, copy),
      ]);

      result.sent += 1;
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      result.failed += 1;
      console.error("Email delivery failed:", {
        uid: user.id,
        email: user.data.email,
        deliveryId,
        message: error.message,
      });
    }
  }

  return result;
}

function shouldSendStudyReminder(user, todayKey, { slot = "daily" } = {}) {
  const data = user.data;
  if (data.emailPreferences?.studyReminders === false) return false;
  if (hasStudiedToday(data.stats, todayKey)) return false;
  if (!canSendReminderInSlot(data, todayKey, slot)) return false;
  return true;
}

function shouldSendStarterReminder(user, todayKey, { slot = "morning" } = {}) {
  const data = user.data;
  if (data.emailPreferences?.studyReminders === false) return false;
  if (hasStudiedToday(data.stats, todayKey)) return false;
  if (getActiveStreak(data.stats, todayKey) > 0) return false;
  if (!canSendReminderInSlot(data, todayKey, slot)) return false;
  return true;
}

function shouldSendAnnouncement(user) {
  return user.data.emailPreferences?.newLessonAlerts !== false;
}

function canSendReminderInSlot(data = {}, todayKey, slot) {
  const maxPerDay = getMaxStudyRemindersPerDay(data);
  const state = getReminderState(data, todayKey);
  if (state.count >= maxPerDay) return false;
  if (state.slots[slot]) return false;
  return true;
}

function getMaxStudyRemindersPerDay(data = {}) {
  const userMax = {
    gentle: 1,
    normal: 2,
    dramatic: 4,
  }[getReminderIntensity(data)] || 2;
  const globalMax = getNumberEnv("MAX_STUDY_REMINDERS_PER_DAY", userMax);
  return Math.min(userMax, globalMax);
}

function getReminderIntensity(data = {}) {
  const value = String(data.emailPreferences?.reminderIntensity || "dramatic").toLowerCase();
  return ["gentle", "normal", "dramatic"].includes(value) ? value : "dramatic";
}

function getReminderTone({ isStarter = false, reminderIntensity = "dramatic", reminderCountToday = 0 } = {}) {
  if (reminderIntensity === "gentle") {
    return isStarter
      ? "nhắc nhẹ, ấm, không gây áp lực; chỉ cần một bài nhỏ để bắt đầu"
      : "nhắc nhẹ và cụ thể, ưu tiên cảm giác dễ quay lại";
  }
  if (reminderIntensity === "normal") {
    return isStarter
      ? "vui, hơi chọc nhẹ chuyện streak bằng 0, nhưng vẫn dễ thương"
      : "vui, gọn, có chút áp lực bạn bè hoặc deadline hôm nay";
  }
  const escalation = reminderCountToday > 0
    ? "vì đây không phải nhắc lần đầu trong ngày, được phép gắt hơn một nấc"
    : "gắt nhẹ kiểu coach đang sốt ruột";
  return isStarter
    ? `AzoTa dramatic: chọc quê số 0/streak trống, hơi lầy, ${escalation}, không xúc phạm người học`
    : `AzoTa dramatic: dí dỏm, bám dai, châm chọc streak/dashboard/habit, ${escalation}, giống Duolingo-style nhưng không dùng lời lẽ công kích cá nhân`;
}

function getReminderState(data = {}, todayKey) {
  const emailState = data.emailState || {};
  const sameDay = emailState.studyReminderDay === todayKey;
  const slots = sameDay && emailState.studyReminderSlots && typeof emailState.studyReminderSlots === "object"
    ? emailState.studyReminderSlots
    : {};

  return {
    count: sameDay ? Number(emailState.studyReminderCount || 0) : 0,
    slots,
  };
}

function buildReminderEmailStateUpdate(data = {}, todayKey, slot, kind, templateKey = "") {
  const state = getReminderState(data, todayKey);
  const update = {
    "emailState.studyReminderDay": todayKey,
    "emailState.studyReminderCount": state.count + 1,
    "emailState.studyReminderSlots": {
      ...state.slots,
      [slot]: true,
    },
    "emailState.lastStudyReminderDate": todayKey,
    "emailState.lastStudyReminderSlot": slot,
    "emailState.lastStudyReminderKind": kind,
    "emailState.lastEmailSentAt": admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (templateKey) {
    update["emailState.lastReminderTemplateKey"] = templateKey;
    update["emailState.recentReminderTemplates"] = getNextRecentReminderTemplates(data, templateKey);
  }
  return update;
}

function shouldSendAnnouncementDoc(data = {}) {
  if (data.sendEmail === false) return false;
  if (data.status === "draft") return false;
  if (isTerminalAnnouncementStatus(data.status)) return false;
  return true;
}

function isTerminalAnnouncementStatus(status) {
  return ["sending", "sent", "sent-with-errors"].includes(String(status || "").toLowerCase());
}

async function createContextualStudyReminderCopy(user, todayKey, { slot = "daily" } = {}) {
  const context = await getStudyReminderContext(user, todayKey, { slot });
  let copy;

  if (context.kind === "pair-streak-waiting") {
    copy = await createPairStreakNudgeCopy({
      requesterData: context.partnerData,
      partnerData: user.data,
      pairData: context.pairData,
      todayKey,
    });
    return { ...copy, kind: "pair-streak-nudge" };
  }

  if (context.kind === "pair-streak-both-idle") {
    copy = await createPairStreakBothIdleCopy(user, todayKey, context);
    return { ...copy, kind: context.kind };
  }

  if (context.kind === "friend-overtook") {
    copy = await createSocialEmailCopy(user, context.friendData, "friend-overtook");
    return { ...copy, kind: context.kind };
  }

  if (context.kind === "comeback-reminder") {
    copy = await createComebackReminderCopy(user, todayKey, context);
    return { ...copy, kind: context.kind };
  }

  copy = await createStudyReminderCopy(user, todayKey, { ...context, slot });
  return { ...copy, kind: context.kind };
}

async function getStudyReminderContext(user, todayKey, { slot = "daily" } = {}) {
  const pairContext = await getPairStreakReminderContext(user, todayKey);
  if (pairContext) return pairContext;

  const friendContext = await getFriendActivityReminderContext(user, todayKey);
  if (friendContext) return friendContext;

  const activeStreak = getActiveStreak(user.data.stats, todayKey);
  if (activeStreak > 0) {
    return {
      kind: getActiveStreakReminderKind(user.data, todayKey, { slot, activeStreak }),
      streak: activeStreak,
    };
  }

  const daysSinceLastEngagement = getDaysSinceLastEngagement(user.data, todayKey);
  const dormantWarningDays = getNumberEnv("DORMANT_WARNING_DAYS", 5);
  if (Number.isFinite(daysSinceLastEngagement) && daysSinceLastEngagement >= dormantWarningDays) {
    return { kind: "dormant-warning", daysSinceLastEngagement };
  }

  const daysSinceLastStudy = getDaysBetweenDateKeys(user.data.stats?.lastStreakDate, todayKey);
  if (Number.isFinite(daysSinceLastStudy) && daysSinceLastStudy >= 2) {
    return { kind: "comeback-reminder", daysSinceLastStudy };
  }

  return { kind: "starter-reminder" };
}

function getActiveStreakReminderKind(data = {}, todayKey, { slot = "daily", activeStreak = 0 } = {}) {
  const state = getReminderState(data, todayKey);
  const isLateSlot = slot === "evening" || slot === "night";
  const isWeekend = isWeekendDateKey(todayKey);

  if (isMilestoneStreak(activeStreak)) return "milestone";
  if (isLateSlot && state.count > 0) return "streak-last-call";
  if (activeStreak >= getNumberEnv("LONG_STREAK_REMINDER_DAYS", 30)) return "streak-vip";
  if (activeStreak <= 3) return "streak-rookie";
  if (isWeekend) return "weekend-streak";
  if (slot === "morning") return "morning-check-in";
  if (slot === "midday") return "midday-rescue";
  return "study-reminder";
}

async function getPairStreakReminderContext(user, todayKey) {
  const snapshot = await getDb()
    .collection("pair_streaks")
    .where("uids", "array-contains", user.id)
    .limit(MAX_PAIR_CONTEXTS)
    .get();
  const contexts = [];

  for (const docSnap of snapshot.docs) {
    const pairData = docSnap.data() || {};
    const partnerUid = getPairPartnerUid(pairData, user.id);
    const pairStreak = getActivePairStreak(pairData, todayKey);

    if (!partnerUid || pairStreak <= 0 || (pairData.status || "active") !== "active" || pairData.lastUpdateDate === todayKey) {
      continue;
    }

    const partnerData = await getProfileForReminder(partnerUid);
    const partnerStudiedToday = hasStudiedToday(partnerData.stats, todayKey) || pairData[`${partnerUid}_lastUpdate`] === todayKey;
    const kind = partnerStudiedToday ? "pair-streak-waiting" : "pair-streak-both-idle";

    contexts.push({
      kind,
      pairData,
      partnerData,
      partnerUid,
      pairStreak,
      partnerName: cleanDisplayName(partnerData.displayName) || "bạn học của bạn",
    });
  }

  contexts.sort((a, b) => {
    const priorityA = a.kind === "pair-streak-waiting" ? 2 : 1;
    const priorityB = b.kind === "pair-streak-waiting" ? 2 : 1;
    return priorityB - priorityA || b.pairStreak - a.pairStreak;
  });

  return contexts[0] || null;
}

async function getFriendActivityReminderContext(user, todayKey) {
  const [followingSnap, followersSnap] = await Promise.all([
    user.ref.collection("following").limit(MAX_FRIEND_CONTEXTS * 2).get(),
    user.ref.collection("followers").limit(80).get(),
  ]);
  const followerIds = new Set(followersSnap.docs.map((docSnap) => docSnap.id));
  const followingIds = followingSnap.docs.map((docSnap) => docSnap.id);
  const mutualIds = followingIds.filter((uid) => followerIds.has(uid));
  const candidateIds = (mutualIds.length ? mutualIds : followingIds).slice(0, MAX_FRIEND_CONTEXTS);

  if (!candidateIds.length) return null;

  const profileSnaps = await Promise.all(candidateIds.map((uid) => getDb().collection("publicProfiles").doc(uid).get()));
  const activeFriends = profileSnaps
    .filter((snap) => snap.exists)
    .map((snap) => ({ uid: snap.id, ...(snap.data() || {}) }))
    .filter((profile) => hasStudiedToday(profile.stats, todayKey))
    .sort((a, b) => Number(b.stats?.streak || 0) - Number(a.stats?.streak || 0));

  const friend = activeFriends[0];
  if (!friend) return null;

  return {
    kind: "friend-overtook",
    friendData: {
      uid: friend.uid,
      displayName: cleanDisplayName(friend.displayName) || "Your friend",
      streak: Number(friend.stats?.streak || 0),
    },
  };
}

async function getProfileForReminder(uid) {
  const db = getDb();
  const [userSnap, publicSnap] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("publicProfiles").doc(uid).get(),
  ]);
  const publicData = publicSnap.exists ? publicSnap.data() || {} : {};
  const userData = userSnap.exists ? userSnap.data() || {} : {};

  return {
    ...publicData,
    ...userData,
    stats: {
      ...(publicData.stats || {}),
      ...(userData.stats || {}),
    },
  };
}

function createWelcomeEmailCopy(userData = {}) {
  const firstName = getFirstName(userData.displayName);
  return {
    subject: "Chào mừng đến với AzoTa TOEIC",
    preview: "Tài khoản đã sẵn sàng. Bắt đầu bằng một bài TOEIC ngắn nhé.",
    body: `Chào ${firstName},\n\nChào mừng bạn đến với AzoTa TOEIC. Hồ sơ, streak, thông báo và tiến độ bài học của bạn đã sẵn sàng để đồng bộ trên tài khoản.\n\nHãy bắt đầu bằng một bài ngắn hôm nay và tạo streak TOEIC đầu tiên.`,
    ctaText: "Bắt đầu học",
  };
}

async function createStudyReminderCopy(user, todayKey, { kind = "study-reminder", slot = "" } = {}) {
  const data = user.data;
  const streak = getActiveStreak(data.stats, todayKey);
  const firstName = getFirstName(data.displayName);
  const isStarter = kind === "starter-reminder";
  const reminderState = getReminderState(data, todayKey);
  const recentTemplates = getRecentReminderTemplates(data);
  const reminderIntensity = getReminderIntensity(data);
  const daysSinceLastEngagement = getDaysSinceLastEngagement(data, todayKey);
  const daysSinceLastStudy = getDaysBetweenDateKeys(data.stats?.lastStreakDate, todayKey);
  let fallback;
  if (kind === "starter-reminder") {
    fallback = pickTemplate(
      [
        {
          templateKey: "starter-zero-rent",
          subject: "Streak vẫn đang ở số 0",
          preview: "Một bài TOEIC nhỏ là sửa được ngay.",
          body: `Chào ${firstName},\n\nStreak của bạn vẫn đang nằm yên ở số 0. Một bài TOEIC ngắn hôm nay là đủ để kéo nó dậy.`,
          ctaText: "Bắt đầu học",
        },
        {
          templateKey: "starter-empty-streak",
          subject: "AzoTa thấy streak còn trống",
          preview: "Năm phút là đủ để bắt đầu.",
          body: `Chào ${firstName},\n\nBộ đếm streak vẫn còn trống. Làm nhanh một bài TOEIC để AzoTa khỏi nhìn chằm chằm vào số 0 nữa.`,
          ctaText: "Vào bài học",
        },
        {
          templateKey: "starter-zero-tenant",
          subject: "Số 0 đang thuê nhà hơi lâu",
          preview: "Một bài TOEIC là đủ đuổi nó đi.",
          body: `Chào ${firstName},\n\nSố 0 trên streak đang ở lâu đến mức AzoTa muốn thu tiền thuê nhà. Làm một bài TOEIC ngắn hôm nay để nó dọn đi.`,
          ctaText: "Đuổi số 0",
        },
        {
          templateKey: "starter-dashboard-stare",
          subject: "Dashboard đang nhìn bạn đó",
          preview: "Nó chỉ cần một bài để bớt trống.",
          body: `Chào ${firstName},\n\nDashboard đang trống đến mức nghe được tiếng gió. Một bài TOEIC ngắn là đủ để AzoTa thôi nhìn cảnh này.`,
          ctaText: "Làm một bài",
        },
        {
          templateKey: "starter-first-spark",
          subject: "Châm lửa streak đầu tiên",
          preview: "Chưa cần hoành tráng, chỉ cần bắt đầu.",
          body: `Chào ${firstName},\n\nStreak đầu tiên không tự xuất hiện đâu, nó đang đợi một cú châm lửa nhỏ. Mở một bài TOEIC ngắn và cho bộ đếm có việc làm.`,
          ctaText: "Châm lửa",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${reminderState.count}`,
      recentTemplates
    );
  } else if (kind === "milestone") {
    fallback = pickTemplate(
      [
        {
          templateKey: "milestone-protect",
          subject: `${streak} ngày liên tiếp`,
          preview: "Chuỗi này đáng để giữ tiếp.",
          body: `Chào ${firstName},\n\nBạn đã giữ streak TOEIC được ${streak} ngày. Hoàn thành thêm một bài hôm nay để kỷ lục tiếp tục tăng.`,
          ctaText: "Học tiếp",
        },
        {
          templateKey: "milestone-flame-contract",
          subject: `${streak} ngày rồi, đừng phá kèo`,
          preview: "Streak này đang có phong độ.",
          body: `Chào ${firstName},\n\n${streak} ngày liên tiếp là một cái kèo đẹp. Đừng để hôm nay là ngày AzoTa phải ghi biên bản sự cố.`,
          ctaText: "Giữ kèo",
        },
        {
          templateKey: "milestone-scoreboard",
          subject: `Bảng điểm đang thích số ${streak}`,
          preview: "Cho nó thêm một ngày nữa đi.",
          body: `Chào ${firstName},\n\nBảng streak đang khoe ${streak} ngày khá tự hào. Một bài TOEIC hôm nay là đủ để nó tiếp tục lên mặt.`,
          ctaText: "Tăng streak",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "freeze") {
    fallback = pickTemplate(
      [
        {
          templateKey: "freeze-save",
          subject: "Đóng băng streak vừa cứu bạn",
          preview: "Streak đã sống sót, nhưng hôm nay vẫn cần học.",
          body: `Chào ${firstName},\n\nĐóng băng streak đã bảo vệ chuỗi ${streak} ngày của bạn. Hoàn thành một bài TOEIC hôm nay để không cần thêm pha cứu nguy nữa.`,
          ctaText: "Học ngay",
        },
        {
          templateKey: "freeze-last-ticket",
          subject: "Streak vừa dùng vé cứu mạng",
          preview: "Đừng bắt nó dùng thêm pha nào nữa.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày vừa được kéo khỏi mép vực. Một bài TOEIC hôm nay sẽ giúp AzoTa cất còi báo động đi.`,
          ctaText: "Ổn định lại",
        },
        {
          templateKey: "freeze-ice-crack",
          subject: "Lớp băng đang nứt nhẹ",
          preview: "Một bài hôm nay là khóa lại ngay.",
          body: `Chào ${firstName},\n\nFreeze đã cứu streak, nhưng nó không phải phép màu vô hạn. Học một bài TOEIC ngắn để chuỗi này khỏi run tiếp.`,
          ctaText: "Khóa streak",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "dormant-warning") {
    const daysAway = Number.isFinite(daysSinceLastEngagement) ? daysSinceLastEngagement : 5;
    fallback = pickTemplate(
      [
        {
          templateKey: "dormant-worry",
          subject: "Còn ở đây không đó?",
          preview: `${daysAway} ngày vắng mặt. Một bài TOEIC là khởi động lại được.`,
          body: `Chào ${firstName},\n\n${daysAway} ngày không ghé web và không học bài nào. AzoTa bắt đầu thấy mình hơi đơn độc trong kế hoạch học này rồi, nhưng vẫn sửa được.`,
          ctaText: "Học một bài",
        },
        {
          templateKey: "dormant-life-check",
          subject: "AzoTa đang kiểm tra tín hiệu",
          preview: `${daysAway} ngày im ắng. Một bài nhỏ là hết im.`,
          body: `Chào ${firstName},\n\n${daysAway} ngày không vào web, không streak, không bài TOEIC. Làm một bài nhỏ hôm nay đi, AzoTa sẽ bớt làm quá.`,
          ctaText: "Làm một bài",
        },
        {
          templateKey: "dormant-dashboard-dust",
          subject: "Dashboard bắt đầu có bụi",
          preview: `${daysAway} ngày vắng mặt, nhìn hơi căng rồi.`,
          body: `Chào ${firstName},\n\n${daysAway} ngày không học làm dashboard trông như phòng bỏ trống. Mở một bài TOEIC ngắn để AzoTa khỏi phải phủi bụi tiếp.`,
          ctaText: "Phủi bụi",
        },
        {
          templateKey: "dormant-where-did-you-go",
          subject: "Bạn biến mất hơi lâu rồi",
          preview: "Một bài ngắn là phát tín hiệu lại.",
          body: `Chào ${firstName},\n\nAzoTa không hoảng, nhưng ${daysAway} ngày im lặng là đủ để streak viết đơn tìm người. Vào làm một bài TOEIC ngắn cho nó yên tâm.`,
          ctaText: "Báo có mặt",
        },
        {
          templateKey: "dormant-signal-low",
          subject: "Tín hiệu học tập yếu quá",
          preview: "Cứu bằng một bài TOEIC nhỏ.",
          body: `Chào ${firstName},\n\nTín hiệu học tập đang chập chờn sau ${daysAway} ngày vắng mặt. Một bài TOEIC ngắn hôm nay là đủ để AzoTa bắt sóng lại.`,
          ctaText: "Bắt sóng",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${daysAway}`,
      recentTemplates
    );
  } else if (kind === "streak-rookie") {
    fallback = pickTemplate(
      [
        {
          templateKey: "rookie-flame-small",
          subject: "Ngọn lửa mới chớm thôi đó",
          preview: `Streak ${streak} ngày còn nhỏ, đừng để gió thổi tắt.`,
          body: `Chào ${firstName},\n\nStreak ${streak} ngày mới nhóm lửa, nhìn cưng nhưng chưa đủ đô chống gió. Thêm một bài TOEIC hôm nay để nó đứng vững.`,
          ctaText: "Thêm lửa",
        },
        {
          templateKey: "rookie-plant",
          subject: "Streak non cần tưới nước",
          preview: "Một bài TOEIC là tưới vừa đủ.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày đang như cây mầm. Bỏ qua hôm nay là AzoTa phải đặt nó vào khu chăm sóc đặc biệt.`,
          ctaText: "Tưới streak",
        },
        {
          templateKey: "rookie-dont-ghost",
          subject: "Đừng ghost streak mới quen",
          preview: "Mới vài ngày mà biến mất là kỳ lắm.",
          body: `Chào ${firstName},\n\nBạn với streak ${streak} ngày mới làm quen thôi. Ghost nó ngay hôm nay thì hơi phũ, mở một bài TOEIC đi.`,
          ctaText: "Không ghost",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "streak-vip") {
    fallback = pickTemplate(
      [
        {
          templateKey: "vip-streak-security",
          subject: `Streak ${streak} ngày cần vệ sĩ`,
          preview: "Một bài TOEIC là lớp bảo vệ hôm nay.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày không còn là tài sản nhỏ nữa. AzoTa đề nghị bạn ký một bài TOEIC để gia hạn bảo vệ.`,
          ctaText: "Bảo vệ streak",
        },
        {
          templateKey: "vip-streak-museum",
          subject: "Chuỗi này đáng đưa vào tủ kính",
          preview: `Đừng để streak ${streak} ngày rơi khỏi kệ.`,
          body: `Chào ${firstName},\n\n${streak} ngày là hàng trưng bày rồi. Một bài TOEIC hôm nay là lớp kính chống va đập cho nó.`,
          ctaText: "Khóa tủ kính",
        },
        {
          templateKey: "vip-streak-board-meeting",
          subject: "AzoTa triệu tập họp khẩn",
          preview: `Agenda: bảo vệ streak ${streak} ngày.`,
          body: `Chào ${firstName},\n\nCuộc họp hôm nay chỉ có một mục: đừng để streak ${streak} ngày bị mất vì thiếu một bài TOEIC. Biên bản kết thúc khi bạn học xong.`,
          ctaText: "Chốt biên bản",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "streak-last-call") {
    fallback = pickTemplate(
      [
        {
          templateKey: "last-call-door",
          subject: "Streak sắp đóng cửa rồi",
          preview: "Một bài TOEIC trước khi hết ngày.",
          body: `Chào ${firstName},\n\nCửa streak ${streak} ngày đang kéo xuống từ từ. Chen một bài TOEIC ngắn vào trước khi AzoTa tắt đèn.`,
          ctaText: "Chen vào",
        },
        {
          templateKey: "last-call-owl-desk",
          subject: "AzoTa trực ca cuối",
          preview: "Ca này chỉ nhận một bài TOEIC nhanh.",
          body: `Chào ${firstName},\n\nAzoTa đang trực ca cuối với hồ sơ streak ${streak} ngày trên bàn. Ký bằng một bài TOEIC để hồ sơ khỏi chuyển sang mục đáng tiếc.`,
          ctaText: "Ký hồ sơ",
        },
        {
          templateKey: "last-call-countdown",
          subject: "Đếm ngược cho streak",
          preview: "Nó chưa mất, nhưng đồng hồ không đùa.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày vẫn cứu được, nhưng đồng hồ đang làm vẻ mặt rất khó chịu. Một bài TOEIC ngắn là đủ.`,
          ctaText: "Cứu ngay",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}:${reminderState.count}`,
      recentTemplates
    );
  } else if (kind === "weekend-streak") {
    fallback = pickTemplate(
      [
        {
          templateKey: "weekend-couch",
          subject: "Cuối tuần đừng để streak ngủ quên",
          preview: "Một bài TOEIC rồi quay lại nghỉ tiếp.",
          body: `Chào ${firstName},\n\nCuối tuần được nghỉ, nhưng streak ${streak} ngày không hiểu khái niệm nghỉ phép. Làm một bài TOEIC ngắn rồi quay lại sofa.`,
          ctaText: "Học nhanh",
        },
        {
          templateKey: "weekend-treaty",
          subject: "Hiệp ước cuối tuần",
          preview: "Năm phút học, phần còn lại để chill.",
          body: `Chào ${firstName},\n\nAzoTa đề xuất hiệp ước: bạn học một bài TOEIC, streak ${streak} ngày ngừng làm phiền, cuối tuần tiếp tục yên ổn.`,
          ctaText: "Ký hiệp ước",
        },
        {
          templateKey: "weekend-flame-picnic",
          subject: "Mang streak đi cuối tuần",
          preview: "Đừng bỏ nó ở nhà một mình.",
          body: `Chào ${firstName},\n\nBạn có thể đi chơi, nhưng đừng bỏ streak ${streak} ngày ở nhà không ai trông. Một bài TOEIC ngắn là gửi nó theo an toàn.`,
          ctaText: "Dắt streak đi",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "morning-check-in") {
    fallback = pickTemplate(
      [
        {
          templateKey: "morning-first-win",
          subject: "Lấy điểm sớm cho streak",
          preview: "Xong một bài là cả ngày nhẹ hơn.",
          body: `Chào ${firstName},\n\nBuổi sáng là lúc streak ${streak} ngày còn lịch sự. Cho nó một bài TOEIC sớm để tối khỏi nghe AzoTa càm ràm.`,
          ctaText: "Lấy điểm sớm",
        },
        {
          templateKey: "morning-coffee",
          subject: "Cà phê cho não, TOEIC cho streak",
          preview: "Một bài ngắn trước khi ngày cuốn đi.",
          body: `Chào ${firstName},\n\nTrước khi ngày hôm nay kéo bạn đi lung tung, cho streak ${streak} ngày một bài TOEIC nhỏ. Nó ăn ít lắm.`,
          ctaText: "Cho ăn",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else if (kind === "midday-rescue") {
    fallback = pickTemplate(
      [
        {
          templateKey: "midday-half-day",
          subject: "Nửa ngày rồi đó",
          preview: "Streak vẫn đang chờ phần của nó.",
          body: `Chào ${firstName},\n\nNửa ngày đã trôi qua, streak ${streak} ngày vẫn ngồi ở sảnh chờ. Một bài TOEIC ngắn là gọi nó vào ngay.`,
          ctaText: "Gọi vào",
        },
        {
          templateKey: "midday-lunch-break",
          subject: "Nghỉ trưa cứu streak",
          preview: "Một bài TOEIC nhỏ, không cần nghi lễ.",
          body: `Chào ${firstName},\n\nNếu có vài phút nghỉ trưa, streak ${streak} ngày đang xin được chen lịch. Làm một bài TOEIC để chiều khỏi nợ.`,
          ctaText: "Chen lịch",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${streak}`,
      recentTemplates
    );
  } else {
    fallback = pickTemplate(
      [
        {
          templateKey: "streak-nervous",
          subject: "Streak của bạn đang run nhẹ",
          preview: `Chuỗi ${streak} ngày cần một bài hôm nay.`,
          body: `Chào ${firstName},\n\nChuỗi ${streak} ngày của bạn đang nhìn đồng hồ hơi căng. Một bài TOEIC ngắn hôm nay là giữ được nó.`,
          ctaText: "Giữ streak",
        },
        {
          templateKey: "streak-beg",
          subject: "Đừng để streak phải năn nỉ",
          preview: `Một bài TOEIC cứu ${streak} ngày cố gắng.`,
          body: `Chào ${firstName},\n\n${streak} ngày cố gắng đang chờ một pha cứu nguy năm phút. Mở một bài trước khi bộ đếm bắt đầu làm quá nhé.`,
          ctaText: "Cứu streak",
        },
        {
          templateKey: "streak-clock-stare",
          subject: "Streak đang nhìn đồng hồ",
          preview: "Nó không giỏi kiên nhẫn lắm đâu.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày đang nhìn đồng hồ với thái độ rất phán xét. Một bài TOEIC ngắn hôm nay là đủ để nó thôi căng.`,
          ctaText: "Trấn an nó",
        },
        {
          templateKey: "streak-fire-warning",
          subject: "Lửa streak sắp yếu rồi",
          preview: "Thêm một bài trước khi nó tắt ngang.",
          body: `Chào ${firstName},\n\nNgọn lửa ${streak} ngày vẫn còn đó, nhưng AzoTa thấy nó đang nhỏ giọng cầu cứu. Học một bài TOEIC để tiếp thêm oxy.`,
          ctaText: "Tiếp lửa",
        },
        {
          templateKey: "streak-attendance",
          subject: "AzoTa mở sổ điểm danh",
          preview: `Tên bạn còn thiếu trong streak ${streak} ngày.`,
          body: `Chào ${firstName},\n\nSổ điểm danh hôm nay đang thiếu một dấu tích. Đừng để streak ${streak} ngày phải đứng ngoài hành lang.`,
          ctaText: "Điểm danh",
        },
        {
          templateKey: "streak-mini-ultimatum",
          subject: "Tối hậu thư mini từ streak",
          preview: "Năm phút học, hoặc nó sẽ dỗi.",
          body: `Chào ${firstName},\n\nStreak ${streak} ngày nhắn rằng nó không đòi nhiều, chỉ đòi một bài TOEIC ngắn. Không làm là nó dỗi thật đó.`,
          ctaText: "Dỗ streak",
        },
      ],
      `${data.email}:${kind}:${todayKey}:${reminderState.count}`,
      recentTemplates
    );
  }

  return createAiEmailCopy(
    {
      kind,
      displayName: data.displayName,
      firstName,
      streak,
      lessons: Number(data.stats?.lessons || 0),
      recentCourse: data.learning?.recentCourse || "",
      recentLesson: data.learning?.recentLesson || "",
      todayKey,
      reminderSlot: slot,
      reminderIntensity,
      reminderCountToday: reminderState.count,
      maxReminderCountToday: getMaxStudyRemindersPerDay(data),
      daysSinceLastEngagement,
      daysSinceLastStudy: Number.isFinite(daysSinceLastStudy) ? daysSinceLastStudy : null,
      sendTime: getSlotSendTime(slot),
      recentReminderTemplates: recentTemplates,
      tone: getReminderTone({ isStarter, reminderIntensity, reminderCountToday: reminderState.count }),
    },
    fallback
  );
}

async function createSocialEmailCopy(user, friendData, kind) {
  const data = user.data || {};
  const firstName = getFirstName(data.displayName);
  const friendName = friendData.displayName || "your friend";
  const streak = Number(data.stats?.streak || 0);
  const recentTemplates = getRecentReminderTemplates(data);

  let fallback;
  if (kind === "friend-streak-danger") {
    fallback = pickTemplate(
      [
        {
          templateKey: "friend-waiting-basic",
          subject: `${friendName} đang chờ bạn`,
          preview: "Giữ nhịp học chung của hai người.",
          body: `Chào ${firstName},\n\n${friendName} đang chờ bạn hoàn thành một bài TOEIC hôm nay. Một buổi học ngắn là đủ để giữ nhịp học chung.`,
          ctaText: "Cứu streak",
        },
        {
          templateKey: "friend-waiting-side-eye",
          subject: `${friendName} xong phần rồi đó`,
          preview: "Giờ tới lượt bạn, đừng để người ta chờ.",
          body: `Chào ${firstName},\n\n${friendName} đã giữ nhịp rồi, còn streak đang liếc qua phía bạn. Một bài TOEIC ngắn là đủ để không ai phải nhìn nhau khó xử.`,
          ctaText: "Tới lượt bạn",
        },
        {
          templateKey: "friend-waiting-receipt",
          subject: "AzoTa có biên nhận chờ",
          preview: `${friendName} đang đợi một dấu tích từ bạn.`,
          body: `Chào ${firstName},\n\nAzoTa ghi nhận ${friendName} đang chờ bạn lên bài hôm nay. Đừng để streak nhóm phải mở cuộc họp khẩn.`,
          ctaText: "Lên bài",
        },
      ],
      `${data.email}:${kind}:${friendName}:${streak}`,
      recentTemplates
    );
  } else if (kind === "friend-overtook") {
    fallback = pickTemplate(
      [
        {
          templateKey: "friend-overtook-basic",
          subject: `${friendName} đã học hôm nay`,
          preview: "Theo kịp bằng một bài TOEIC nhanh.",
          body: `Chào ${firstName},\n\n${friendName} đã hoàn thành một bài hôm nay rồi. Theo nhịp bằng một buổi TOEIC ngắn nhé.`,
          ctaText: "Học ngay",
        },
        {
          templateKey: "friend-overtook-scoreboard",
          subject: `${friendName} vừa vượt lên`,
          preview: "Bảng nhịp học đang nghiêng nhẹ.",
          body: `Chào ${firstName},\n\n${friendName} vừa thêm một dấu tích hôm nay. AzoTa không nói là bạn bị bỏ lại, nhưng bảng theo dõi đang cười hơi rõ.`,
          ctaText: "Bắt kịp",
        },
        {
          templateKey: "friend-overtook-return",
          subject: "Có người đã mở bài trước",
          preview: `${friendName} xong rồi, bạn phản công nhẹ nhé.`,
          body: `Chào ${firstName},\n\n${friendName} đã học hôm nay. Mở một bài TOEIC ngắn để streak thấy bạn vẫn còn trong trận.`,
          ctaText: "Phản công",
        },
      ],
      `${data.email}:${kind}:${friendName}:${streak}`,
      recentTemplates
    );
  } else {
    fallback = pickTemplate(
      [
        {
          templateKey: "friend-finished-basic",
          subject: `${friendName} vừa xong một bài`,
          preview: "Giờ đến lượt bạn giữ nhịp.",
          body: `Chào ${firstName},\n\n${friendName} vừa hoàn thành một bài TOEIC hôm nay. Bạn cũng có thể bắt kịp bằng một bài nhanh.`,
          ctaText: "Học ngay",
        },
        {
          templateKey: "friend-finished-baton",
          subject: `${friendName} chuyền baton rồi`,
          preview: "Một bài TOEIC là nhận lượt ngay.",
          body: `Chào ${firstName},\n\n${friendName} đã chạy xong lượt học hôm nay. Baton đang nằm trước mặt bạn, đừng để nó nằm lạnh quá.`,
          ctaText: "Nhận lượt",
        },
      ],
      `${data.email}:${kind}:${friendName}:${streak}`,
      recentTemplates
    );
  }

  return createAiEmailCopy(
    {
      kind,
      displayName: data.displayName,
      firstName,
      streak,
      friendName,
      friendStreak: friendData.streak || 0,
    },
    fallback
  );
}

async function createPairStreakBothIdleCopy(user, todayKey, context = {}) {
  const data = user.data || {};
  const firstName = getFirstName(data.displayName);
  const partnerName = context.partnerName || "bạn học của bạn";
  const pairStreak = Number(context.pairStreak || context.pairData?.streak || 0);
  const fallback = pickTemplate(
    [
      {
        templateKey: "pair-idle-starter",
        subject: `Streak nhóm ${pairStreak} ngày đang chờ`,
        preview: `${partnerName} cũng chưa học. Bạn mở màn trước nhé.`,
        body: `Chào ${firstName},\n\nBạn và ${partnerName} đều chưa học hôm nay. Hoàn thành một bài TOEIC ngắn để chuỗi học nhóm có cơ hội tăng tiếp.`,
        ctaText: "Mở màn",
      },
      {
        templateKey: "pair-idle-first-spark",
        subject: "Ai đó phải châm lửa trước",
        preview: `${partnerName} cũng đang im. Bạn cứu nhịp đi.`,
        body: `Chào ${firstName},\n\nStreak đôi đang đứng giữa phòng chờ, còn cả bạn và ${partnerName} đều chưa bấm học. Một bài TOEIC của bạn là tín hiệu mở màn.`,
        ctaText: "Châm lửa",
      },
      {
        templateKey: "pair-idle-two-silent",
        subject: "Hai người im quá rồi",
        preview: `Streak ${pairStreak} ngày cần một người ra tay.`,
        body: `Chào ${firstName},\n\nBạn và ${partnerName} đều chưa học, nên streak nhóm đang nhìn hai người như xem phim chậm. Mở một bài ngắn để kéo nhịp lên.`,
        ctaText: "Ra tay",
      },
    ],
    `${data.email}:pair-idle:${partnerName}:${todayKey}:${pairStreak}`,
    getRecentReminderTemplates(data)
  );

  return createAiEmailCopy(
    {
      kind: "pair-streak-both-idle",
      displayName: data.displayName,
      firstName,
      friendName: partnerName,
      pairStreak,
      todayKey,
      context: `Cả hai bạn trong streak đôi đều chưa học hôm nay. Nhắc ${firstName} mở màn trước để ${partnerName} dễ theo sau và chuỗi học nhóm được giữ lại.`,
    },
    fallback
  );
}

async function createPairStreakBrokenCopy({ userData = {}, partnerData = {}, pairData = {}, todayKey }) {
  const firstName = getFirstName(userData.displayName);
  const partnerName = cleanDisplayName(partnerData.displayName) || "bạn học của bạn";
  const pairStreak = Number(pairData.brokenFromStreak || pairData.streak || 0);
  const fallback = pickTemplate(
    [
      {
        templateKey: "pair-broken-clear",
        subject: "Chuỗi học nhóm đã kết thúc",
        preview: `Chuỗi ${pairStreak} ngày với ${partnerName} đã về 0.`,
        body: `Chào ${firstName},\n\nChuỗi học cùng ${partnerName} đã kết thúc sau 3 ngày không có tiến độ. Một bài TOEIC ngắn là đủ để bắt đầu lại.`,
        ctaText: "Bắt đầu lại",
      },
      {
        templateKey: "pair-broken-restart",
        subject: "Streak đôi vừa rớt về 0",
        preview: "Buồn nhẹ thôi, vẫn dựng lại được.",
        body: `Chào ${firstName},\n\nChuỗi ${pairStreak} ngày với ${partnerName} đã dừng lại. AzoTa không mở phiên tòa, chỉ đề nghị một bài TOEIC ngắn để khởi động lại.`,
        ctaText: "Dựng lại",
      },
    ],
    `${userData.email}:pair-broken:${partnerName}:${todayKey}:${pairStreak}`
  );

  return createAiEmailCopy(
    {
      kind: "pair-streak-broken",
      displayName: userData.displayName,
      firstName,
      friendName: partnerName,
      pairStreak,
      todayKey,
      context: `Chuỗi học đôi với ${partnerName} đã kết thúc vì 3 ngày không tăng tiến độ. Báo rõ cho người học, không đổ lỗi cho ai, và mời họ bắt đầu lại bằng một bài TOEIC ngắn.`,
    },
    fallback
  );
}

async function createComebackReminderCopy(user, todayKey, context = {}) {
  const data = user.data || {};
  const firstName = getFirstName(data.displayName);
  const daysSinceLastStudy = Number(context.daysSinceLastStudy || 0);
  const recentTemplates = getRecentReminderTemplates(data);
  const fallback = pickTemplate(
    [
      {
        templateKey: "comeback-streak-message",
        subject: "Streak để lại lời nhắn",
        preview: "Nó bảo một bài ngắn là cứu được.",
        body: `Chào ${firstName},\n\nĐã ${daysSinceLastStudy || "vài"} ngày từ bài học gần nhất. Streak hơi dỗi rồi, nhưng một bài TOEIC vẫn kéo nó về được.`,
        ctaText: "Kéo lại streak",
      },
      {
        templateKey: "comeback-too-quiet",
        subject: "AzoTa thấy hơi im ắng",
        preview: "Một bài TOEIC nhanh là phá im lặng.",
        body: `Chào ${firstName},\n\n${daysSinceLastStudy || "Vài"} ngày không học bài nào nghe hơi đáng ngờ rồi. Làm một buổi TOEIC ngắn để dashboard bớt trống nhé.`,
        ctaText: "Học một bài",
      },
      {
        templateKey: "comeback-cobweb",
        subject: "Gỡ mạng nhện cho streak",
        preview: "Một bài ngắn là đủ dọn lại nhịp.",
        body: `Chào ${firstName},\n\nStreak không hoạt động mấy ngày rồi, AzoTa bắt đầu thấy mạng nhện trong góc dashboard. Một bài TOEIC ngắn là dọn sạch ngay.`,
        ctaText: "Dọn streak",
      },
      {
        templateKey: "comeback-small-restart",
        subject: "Bắt đầu lại không đau đâu",
        preview: "Một bài TOEIC nhỏ là đủ quay về đường đua.",
        body: `Chào ${firstName},\n\nKhông cần làm lễ trở lại hoành tráng. Mở một bài TOEIC ngắn hôm nay là đủ để AzoTa ghi nhận bạn còn trong cuộc.`,
        ctaText: "Quay lại",
      },
    ],
    `${data.email}:comeback:${todayKey}:${daysSinceLastStudy}`,
    recentTemplates
  );

  return createAiEmailCopy(
    {
      kind: "comeback-reminder",
      displayName: data.displayName,
      firstName,
      lessons: Number(data.stats?.lessons || 0),
      daysSinceLastStudy,
      recentCourse: data.learning?.recentCourse || "",
      recentLesson: data.learning?.recentLesson || "",
      todayKey,
      context: "Người học hiện không có streak đang hoạt động. Nhắc họ bắt đầu lại nhẹ nhàng bằng một bài TOEIC ngắn, không làm họ thấy nản.",
    },
    fallback
  );
}

async function createPairStreakNudgeCopy({ requesterData = {}, partnerData = {}, pairData = {}, todayKey }) {
  const requesterName = cleanDisplayName(requesterData.displayName) || "Bạn học của bạn";
  const partnerName = cleanDisplayName(partnerData.displayName) || "bạn";
  const firstName = getFirstName(partnerName);
  const pairStreak = Number(pairData.streak || 0);
  const fallback = getPairStreakNudgeFallback({
    requesterName,
    firstName,
    pairStreak,
    todayKey,
  });

  return createAiEmailCopy(
    {
      kind: "pair-streak-nudge",
      displayName: partnerName,
      firstName,
      friendName: requesterName,
      requesterName,
      pairStreak,
      todayKey,
      context: `${requesterName} đã hoàn thành một bài hôm nay. ${partnerName} chưa học, nên streak đôi chưa thể tăng cho đến khi ${partnerName} hoàn thành một bài trong hôm nay.`,
    },
    fallback
  );
}

function getPairStreakNudgeFallback({ requesterName, firstName, pairStreak, todayKey }) {
  const templates = [
    {
      templateKey: "pair-nudge-waiting",
      subject: `${requesterName} đang chờ bạn`,
      preview: "Bài học của bạn là bước còn thiếu cho streak hôm nay.",
      body: `Chào ${firstName},\n\n${requesterName} đã học hôm nay rồi. Hoàn thành một bài TOEIC để chuỗi học nhóm ${pairStreak} ngày tiếp tục chạy.`,
      ctaText: "Học ngay",
    },
    {
      templateKey: "pair-nudge-team-needs-you",
      subject: "Streak nhóm cần bạn",
      preview: `${requesterName} xong lượt rồi. Giờ đến bạn.`,
      body: `Chào ${firstName},\n\n${requesterName} đã xong bài hôm nay. Bạn hoàn thành thêm một bài là chuỗi học nhóm có thể tăng tiếp.`,
      ctaText: "Học ngay",
    },
    {
      templateKey: "pair-nudge-dont-freeze",
      subject: `${requesterName} đã học hôm nay`,
      preview: "Đừng để streak đôi đứng yên.",
      body: `Chào ${firstName},\n\n${requesterName} đã hoàn thành một bài hôm nay. Nếu bạn cũng học một bài, streak nhóm sẽ tiếp tục.`,
      ctaText: "Mở bài học",
    },
    {
      templateKey: "pair-nudge-missing-piece",
      subject: "Còn thiếu đúng lượt bạn",
      preview: `${requesterName} đã góp lửa, bạn thêm một bài nữa.`,
      body: `Chào ${firstName},\n\n${requesterName} đã châm lửa hôm nay rồi. Streak ${pairStreak} ngày đang đợi bạn thổi thêm một bài TOEIC ngắn.`,
      ctaText: "Thêm lửa",
    },
    {
      templateKey: "pair-nudge-side-eye",
      subject: "Streak đôi đang liếc bạn",
      preview: `${requesterName} xong rồi, đừng để nó quê.`,
      body: `Chào ${firstName},\n\n${requesterName} đã học, còn streak đôi đang đứng chờ phần bạn với ánh mắt rất khó tả. Một bài TOEIC là hết cảnh đó.`,
      ctaText: "Cứu cảnh",
    },
  ];
  return templates[hashText(`${requesterName}:${firstName}:${todayKey}`) % templates.length];
}

async function createAnnouncementCopy(user, announcement) {
  const data = user.data;
  const firstName = getFirstName(data.displayName);
  const fallback = {
    templateKey: "announcement-new-lesson",
    subject: "Có bài TOEIC mới",
    preview: "Một bài mới đã sẵn sàng trong khóa học của bạn.",
    body: `Chào ${firstName},\n\nMột bài mới đã sẵn sàng trong ${announcement.courseTitle}: "${announcement.lessonTitle}". Mở bài khi bạn sẵn sàng cho buổi TOEIC tiếp theo nhé.`,
    ctaText: "Mở bài học",
  };

  return createAiEmailCopy(
    {
      kind: "new-lesson",
      displayName: data.displayName,
      firstName,
      streak: Number(data.stats?.streak || 0),
      lessons: Number(data.stats?.lessons || 0),
      courseTitle: announcement.courseTitle,
      lessonTitle: announcement.lessonTitle,
      summary: announcement.summary,
    },
    fallback
  );
}

async function createAiEmailCopy(context, fallback) {
  const provider = getAiProvider();
  const apiKey = getAiApiKey(provider);
  if (!apiKey) {
    console.warn("AI email copy fallback used: missing AI API key.", { provider });
    return fallback;
  }

  try {
    const copy =
      provider === "gemini"
        ? await createGeminiEmailCopy(context, apiKey)
        : await createGroqEmailCopy(context, apiKey);

    return sanitizeEmailCopy(copy, fallback);
  } catch (error) {
    console.warn("AI email copy fallback used:", {
      provider,
      message: error.message,
    });
    return fallback;
  }
}

async function createGeminiEmailCopy(context, apiKey) {
  const model = process.env.AI_MODEL || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: getEmailCopyPrompt(context) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: EMAIL_COPY_SCHEMA,
        temperature: 0.9,
        topP: 0.92,
      },
    }),
  });

  const data = await readAiJsonResponse(response, "Gemini");
  const text = (data.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
  return parseAiJson(text);
}

async function createGroqEmailCopy(context, apiKey) {
  const model = process.env.AI_MODEL || process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: getEmailCopySystemPrompt(),
        },
        {
          role: "user",
          content: JSON.stringify(context),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.92,
      max_completion_tokens: 700,
    }),
  });

  const data = await readAiJsonResponse(response, "Groq");
  return parseAiJson(data.choices?.[0]?.message?.content || "");
}

async function sendMail({ to, copy, ctaUrl, type, user, tracking = null }) {
  const profileUrl = `${getAppBaseUrl()}/pages/ca-nhan.html`;
  const trackedCtaUrl = createEmailTrackingUrl(ctaUrl, tracking);
  const html = renderEmailHtml({ copy, ctaUrl: trackedCtaUrl, profileUrl, type, user });
  const text = [
    copy.preview,
    "",
    copy.body,
    "",
    `${copy.ctaText}: ${trackedCtaUrl}`,
    "",
    `Cài đặt email hoặc hủy nhận: ${profileUrl}`,
  ].join("\n");

  await getMailTransporter().sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject: copy.subject,
    text,
    html,
  });
}

async function recordEmailClick({ uid, deliveryId, type = "", target = "", sig = "" }) {
  const targetUrl = normalizeClickTarget(target);
  if (!uid || !deliveryId || !targetUrl) {
    throw createHttpError(400, "Invalid email click.");
  }
  if (!isValidEmailClickSignature(uid, deliveryId, targetUrl, sig)) {
    throw createHttpError(403, "Invalid email click signature.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  const userRef = getDb().collection("users").doc(uid);
  const deliveryRef = userRef.collection("emailDeliveries").doc(deliveryId);
  const clickRef = userRef.collection("emailClicks").doc(toDocId(`${deliveryId}-${Date.now()}`));

  await Promise.all([
    deliveryRef.set(
      {
        ...(type ? { type } : {}),
        clickedAt: now,
        clickCount: admin.firestore.FieldValue.increment(1),
        lastClickTarget: targetUrl,
      },
      { merge: true }
    ),
    clickRef.set(
      {
        deliveryId,
        type,
        target: targetUrl,
        clickedAt: now,
      },
      { merge: true }
    ),
  ]);

  return targetUrl;
}

function createEmailTrackingUrl(targetUrl, tracking) {
  const normalizedTarget = normalizeClickTarget(targetUrl);
  if (!tracking?.uid || !tracking?.deliveryId || !normalizedTarget || !process.env.CRON_SECRET) {
    return normalizedTarget || targetUrl;
  }

  const query = new URLSearchParams({
    uid: tracking.uid,
    delivery: tracking.deliveryId,
    type: tracking.type || "",
    target: normalizedTarget,
    sig: signEmailClick(tracking.uid, tracking.deliveryId, normalizedTarget),
  });
  return `${getAppBaseUrl()}/api/email-click?${query.toString()}`;
}

function normalizeClickTarget(value) {
  try {
    const target = new URL(value, getAppBaseUrl());
    const appBase = new URL(getAppBaseUrl());
    if (target.origin !== appBase.origin) return `${appBase.origin}/pages/hoc-phan.html`;
    return target.href;
  } catch (_) {
    return `${getAppBaseUrl()}/pages/hoc-phan.html`;
  }
}

function signEmailClick(uid, deliveryId, targetUrl) {
  return crypto
    .createHmac("sha256", process.env.CRON_SECRET || "")
    .update(`${uid}|${deliveryId}|${targetUrl}`)
    .digest("hex")
    .slice(0, 32);
}

function isValidEmailClickSignature(uid, deliveryId, targetUrl, signature) {
  if (!process.env.CRON_SECRET || !signature) return false;
  const expected = signEmailClick(uid, deliveryId, targetUrl);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch (_) {
    return false;
  }
}

function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!password) {
    throw new Error("Missing GMAIL_APP_PASSWORD environment variable.");
  }

  mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: FROM_EMAIL,
      pass: password,
    },
  });

  return mailTransporter;
}

function getDb() {
  if (cachedDb) return cachedDb;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getFirebaseServiceAccount()),
    });
  }
  cachedDb = admin.firestore();
  return cachedDb;
}

function getFirebaseServiceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const raw = encoded
    ? Buffer.from(encoded, "base64").toString("utf8")
    : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!raw) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_B64 environment variable.");
  }

  const serviceAccount = JSON.parse(raw);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  return serviceAccount;
}

function normalizeAnnouncement(data = {}, id) {
  const courseTitle = String(data.courseTitle || data.course || "TOEIC").trim();
  const lessonTitle = String(data.lessonTitle || data.title || id).trim();
  const lessonUrl = toAbsoluteUrl(data.lessonUrl || data.url || "/pages/hoc-phan.html");

  return {
    status: data.status || "ready",
    sendEmail: data.sendEmail !== false,
    courseTitle,
    lessonTitle,
    lessonUrl,
    summary: String(data.summary || data.description || "").trim(),
    sourcePath: String(data.sourcePath || "").trim(),
  };
}

function buildLessonUrl(courseId, lessonId) {
  const query = new URLSearchParams({
    course: courseId,
    lesson: lessonId,
  });
  return toAbsoluteUrl(`/pages/hoc-phan-chi-tiet.html?${query.toString()}`);
}

function sanitizeEmailCopy(value, fallback) {
  return {
    subject: limitText(cleanText(value.subject), 90) || fallback.subject,
    preview: limitText(cleanText(value.preview), 140) || fallback.preview,
    body: limitText(cleanText(value.body), 1200) || fallback.body,
    ctaText: limitText(cleanText(value.ctaText), 32) || fallback.ctaText,
    templateKey: limitText(cleanText(value.templateKey), 64) || fallback.templateKey || "",
  };
}

function renderEmailHtml({ copy, ctaUrl, profileUrl, type, user = {} }) {
  const paragraphs = cleanText(copy.body)
    .split(/\n{2,}/)
    .map((p) => `<tr><td style="padding:0 0 16px;color:#4b4b4b;font-size:17px;font-weight:500;line-height:1.6;text-align:center;">${escapeHtml(p).replace(/\n/g, "<br>")}</td></tr>`)
    .join("");

  const isAnnouncement = type === "announcement";
  const isStarter = type === "starter-reminder";
  const isMilestone = type === "milestone";
  const isFreeze = type === "freeze";
  const isPairBroken = type === "pair-streak-broken";
  const isSocial =
    type === "friend-streak-danger" ||
    type === "friend-overtook" ||
    type === "pair-streak-nudge" ||
    type === "pair-streak-both-idle" ||
    isPairBroken;

  let accent = "#ff9600";
  let accentShadow = "#d87b00";
  let heroIcon = getEmailHeroIcon("flame");

  if (isAnnouncement) {
    accent = "#1cb0f6"; accentShadow = "#1899d6"; heroIcon = getEmailHeroIcon("book");
  } else if (isStarter) {
    accent = "#ff4b4b"; accentShadow = "#cc3c3c"; heroIcon = getEmailHeroIcon("spark-flame");
  } else if (isMilestone) {
    accent = "#ffc800"; accentShadow = "#cc9f00"; heroIcon = getEmailHeroIcon("flame");
  } else if (isFreeze) {
    accent = "#2b70c9"; accentShadow = "#1e5299"; heroIcon = getEmailHeroIcon("freeze-flame");
  } else if (isPairBroken) {
    accent = "#94a3b8"; accentShadow = "#64748b"; heroIcon = getEmailHeroIcon("broken-flame");
  } else if (isSocial) {
    accent = "#ce82ff"; accentShadow = "#a568cc"; heroIcon = getEmailHeroIcon(type === "friend-overtook" ? "spark-flame" : "pair-flame");
  }

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${escapeHtml(copy.subject)}</title><!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(copy.preview)}${"&#847;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;"><tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;border-radius:16px;overflow:hidden;background:#ffffff;box-shadow:0 4px 12px rgba(0,0,0,0.05);">

<tr><td style="padding:48px 32px 32px;text-align:center;">
<div style="width:76px;height:76px;margin:0 auto 24px;border-radius:22px;background:${accent};box-shadow:0 6px 0 ${accentShadow};font-size:0;line-height:0;text-align:center;">${heroIcon}</div>
<p style="margin:0 0 16px;color:#100f3e;font-size:26px;font-weight:900;line-height:1.3;letter-spacing:0;">${escapeHtml(copy.subject)}</p>
</td></tr>

<tr><td style="padding:0 32px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${paragraphs}</table></td></tr>

<tr><td style="padding:16px 32px 48px;" align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:12px;background:${accent};box-shadow:0 4px 0 ${accentShadow};"><a href="${escapeHtml(ctaUrl)}" style="display:block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:900;letter-spacing:0;text-transform:uppercase;text-align:center;">${escapeHtml(copy.ctaText)}</a></td></tr></table></td></tr>

<tr><td style="padding:24px 32px 32px;text-align:center;border-top:2px solid #e5e5e5;">
<p style="margin:0 0 8px;color:#afafaf;font-size:14px;line-height:1.5;">Bạn nhận email này vì thông báo tài khoản<br>TOEIC đang được bật.</p>
<p style="margin:0 0 16px;"><a href="${escapeHtml(profileUrl)}" style="color:#1cb0f6;font-size:14px;text-decoration:underline;">Quản lý cài đặt email</a></p>
<p style="margin:0;color:#c0c0c0;font-size:13px;">&copy; AzoTa TOEIC</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function getEmailHeroIcon(kind = "flame") {
  if (kind === "book") {
    return `<svg width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Lesson" style="display:block;margin:14px auto 0;">
<path fill="#ffffff" d="M12 9.5h15.2c4.2 0 7.6 3.4 7.6 7.6v21.4H17.4A8.4 8.4 0 0 1 9 30.1V12.5c0-1.7 1.3-3 3-3Z"/>
<path fill="#bfeaff" d="M14.5 32.3h20.3v6.2H16.7c-2.7 0-4.9-1.9-4.9-4.1 0-1.2 1.2-2.1 2.7-2.1Z"/>
<path fill="#1cb0f6" d="M28.4 9.5h4.6v13.2l-2.3-1.7-2.3 1.7V9.5Z"/>
</svg>`;
  }

  if (kind === "pair-flame") {
    return `<svg width="52" height="52" viewBox="0 0 52 52" role="img" aria-label="Pair streak" style="display:block;margin:12px auto 0;">
<g transform="translate(3 10) scale(1.45)" opacity="0.86">
<path fill="#ffffff" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>
<path fill="#f4ddff" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z"/>
</g>
<g transform="translate(20 5) scale(1.65)">
<path fill="#ffffff" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>
<path fill="#f4ddff" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z"/>
</g>
</svg>`;
  }

  if (kind === "broken-flame") {
    return `<svg width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Broken streak" style="display:block;margin:14px auto 0;">
<g transform="translate(7 4) scale(1.45)">
<path fill="#ffffff" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>
<path fill="#dbe3ec" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z"/>
</g>
<path d="M13 35 35 13" fill="none" stroke="#64748b" stroke-width="5" stroke-linecap="round"/>
</svg>`;
  }

  if (kind === "freeze-flame") {
    return `<svg width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Protected streak" style="display:block;margin:14px auto 0;">
<path fill="#ffffff" d="M24 6 37 11v10c0 9.4-5.5 16.5-13 20-7.5-3.5-13-10.6-13-20V11l13-5Z"/>
<g transform="translate(12 11) scale(1)">
<path fill="#2b70c9" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>
<path fill="#b9dcff" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z"/>
</g>
</svg>`;
  }

  const core = kind === "spark-flame" ? "#ffe8a3" : "#fff2b8";
  return `<svg width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Streak flame" style="display:block;margin:14px auto 0;">
<g transform="translate(7 4) scale(1.45)">
<path fill="#ffffff" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>
<path fill="${core}" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z"/>
</g>
${kind === "spark-flame" ? '<path fill="#ffffff" d="M35 7l1.6 3.6L40 12l-3.4 1.4L35 17l-1.6-3.6L30 12l3.4-1.4L35 7Z"/>' : ""}
</svg>`;
}

function getAiProvider() {
  const provider = String(process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER).trim().toLowerCase();
  return provider === "gemini" ? "gemini" : "groq";
}

function getAiApiKey(provider) {
  if (process.env.AI_API_KEY) return process.env.AI_API_KEY;
  if (provider === "gemini") return process.env.GEMINI_API_KEY || "";
  return process.env.GROQ_API_KEY || "";
}

function getEmailCopySystemPrompt() {
  return [
    "You are 'AzoTa TOEIC', a Duolingo-style TOEIC study reminder with comic urgency: witty, clingy, nosy, slightly dramatic, but still useful.",
    "Write extremely short Vietnamese emails that feel handcrafted for the learner. Avoid generic phrases such as 'Hãy cùng bắt đầu hành trình', 'Mở khóa tiềm năng', 'nâng cao kỹ năng', or 'Đừng ngần ngại'.",
    "Every email must contain one specific hook based on the context: streak count, days away, reminder slot, friendName, pair streak, recent lesson, or no-streak status.",
    "Respect reminderIntensity: gentle is calm and low pressure, normal is playful, dramatic is allowed to lightly scold, roast the streak/dashboard/habit, and sound clingy or meme-like.",
    "For dramatic, do not be bland. Use one vivid jab such as the streak judging them, the dashboard collecting dust, the zero paying rent, or AzoTa opening attendance. Keep it funny, not cruel.",
    "Never attack identity, intelligence, appearance, family, health, or protected traits. Do not use slurs. The joke targets the missed lesson, the streak, or the dashboard, not the learner as a person.",
    "If kind is 'study-reminder' with a streak: make the streak feel like it is in danger and needs one lesson today. Be funny, not cruel.",
    "If kind is 'streak-rookie': the streak is only 1-3 days old. Treat it like a small flame or baby habit that needs one easy lesson.",
    "If kind is 'streak-vip': the streak is long and valuable. Make the loss feel expensive or bureaucratically dramatic.",
    "If kind is 'streak-last-call': this is a late-day reminder. Make it urgent and countdown-like without sounding scary.",
    "If kind is 'weekend-streak': connect the reminder to weekend laziness, sofa time, or going out, but keep it light.",
    "If kind is 'morning-check-in': make it a quick early win before the day gets busy.",
    "If kind is 'midday-rescue': make it a lunch-break or half-day rescue.",
    "If kind is 'starter-reminder': make the empty streak feel awkward and easy to fix with one tiny lesson.",
    "If kind is 'dormant-warning': this is only for learners with at least 5 days without visiting/studying/streak progress. Be more dramatic, like 'are you still there?', but do not claim emails will stop unless the context says so.",
    "If kind is 'milestone': celebrate the streak milestone and invite the learner to keep it going.",
    "If kind is 'freeze': explain that a streak freeze protected them and they should complete a lesson today.",
    "If kind is 'friend-streak-danger': use friendly peer accountability. Mention that friendName is waiting.",
    "If kind is 'friend-overtook': use light competitiveness because friendName studied today.",
    "If kind is 'announcement' or 'new-lesson': clearly announce the new lesson and ask them to open it.",
    "Personalize naturally from context. Do not repeat metrics mechanically. Do not reuse the same sentence shape as the fallback or recentReminderTemplates.",
    "Avoid repeating these tired structures: 'Hoàn thành một bài...', 'Một bài TOEIC ngắn là đủ...', 'Hãy bắt đầu...'. You may use the idea, but rewrite the shape.",
    "Keep the email minimal: 2-3 short sentences maximum. Get to the point.",
    "Subject: punchy, specific, max 50 characters. Preview: max 80 characters. CTA: 2-4 words, action-oriented.",
    "If kind is 'pair-streak-nudge': write as a direct reminder from friendName/requesterName. They already studied today; the recipient must finish one lesson today so the pair/team streak can increase. Keep it short, playful, and contextual.",
    "If kind is 'pair-streak-both-idle': both partners have not studied today. Ask the recipient to be the first one to save the team streak. Keep it social, urgent, and not too guilty.",
    "If kind is 'pair-streak-broken': the pair/team streak has ended after 3 days without progress. Be clear, calm, and invite them to restart with one short lesson.",
    "If kind is 'comeback-reminder': the learner has no active streak or has been away for multiple days. Make restarting feel easy with one short TOEIC lesson.",
    "All subject, preview, body, and ctaText values must be in Vietnamese.",
    "Return only a JSON object with these keys: subject, preview, body, ctaText.",
  ].join("\n");
}

function getEmailCopyPrompt(context) {
  return `${getEmailCopySystemPrompt()}\n\nLearner/context JSON:\n${JSON.stringify(context)}`;
}

async function readAiJsonResponse(response, provider) {
  const bodyText = await response.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {
    data = { raw: bodyText };
  }

  if (!response.ok) {
    const message = data.error?.message || data.message || bodyText || `${provider} request failed`;
    throw new Error(`${provider} API ${response.status}: ${message}`);
  }

  return data;
}

function parseAiJson(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("AI response was empty.");

  try {
    return JSON.parse(text);
  } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI response did not contain JSON.");
    return JSON.parse(match[0]);
  }
}

function getFirstName(displayName) {
  const cleanName = String(displayName || "bạn").trim();
  return cleanName.split(/\s+/)[0] || "bạn";
}

function hasStudiedToday(stats = {}, todayKey) {
  return stats?.lastStreakDate === todayKey;
}

function getActiveStreak(stats = {}, todayKey) {
  if (!stats || shouldResetStreak(stats.lastStreakDate, todayKey)) return 0;
  return Number(stats.streak || 0);
}

function getActivePairStreak(pairData = {}, todayKey) {
  const streak = Number(pairData.streak || 0);
  if (streak <= 0 || shouldBreakPairStreak(pairData, todayKey)) return 0;
  return streak;
}

function shouldBreakPairStreak(pairData = {}, todayKey) {
  const streak = Number(pairData.streak || 0);
  if (streak <= 0 || !pairData.lastUpdateDate) return false;
  const diffDays = getDaysBetweenDateKeys(pairData.lastUpdateDate, todayKey);
  return Number.isFinite(diffDays) && diffDays >= 3;
}

function getPairPartnerUid(pairData = {}, uid) {
  const uids = Array.isArray(pairData.uids) ? pairData.uids : [];
  return uids.find((item) => item && item !== uid) || "";
}

function shouldResetStreak(lastStreakDate, todayKey) {
  if (!lastStreakDate) return false;
  return lastStreakDate !== todayKey && !isYesterdayKey(lastStreakDate, todayKey);
}

function isYesterdayKey(dateKey, todayKey) {
  if (!dateKey || !todayKey) return false;

  const today = parseDateKey(todayKey);
  const previous = parseDateKey(dateKey);
  if (!today || !previous) return false;

  const diffDays = Math.round((today.getTime() - previous.getTime()) / 86400000);
  return diffDays === 1;
}

function isMilestoneStreak(streak) {
  const value = Number(streak || 0);
  if (value <= 0) return false;
  if ([7, 14, 30, 50, 75, 100].includes(value)) return true;
  return value >= 150 && value % 50 === 0;
}

function isWeekendDateKey(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) return false;
  const day = date.getDay();
  return day === 0 || day === 6;
}

function parseDateKey(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function getDaysBetweenDateKeys(fromKey, toKey) {
  const fromDate = parseDateKey(fromKey);
  const toDate = parseDateKey(toKey);
  if (!fromDate || !toDate) return Number.NaN;
  return Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
}

function getDaysSinceLastEngagement(data = {}, todayKey) {
  const lastKey = getLastEngagementDateKey(data);
  if (!lastKey) return Number.NaN;
  return getDaysBetweenDateKeys(lastKey, todayKey);
}

function getLastEngagementDateKey(data = {}) {
  const keys = [
    data.engagement?.lastSeenDate,
    data.stats?.lastStreakDate,
    getDateKeyFromValue(data.createdAt),
  ].filter(Boolean);

  return keys.sort().at(-1) || "";
}

function getDateKeyFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : getDateKeyInTimeZone(parsed, TIME_ZONE);
  }
  if (value instanceof Date) return getDateKeyInTimeZone(value, TIME_ZONE);
  if (typeof value.toDate === "function") return getDateKeyInTimeZone(value.toDate(), TIME_ZONE);
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : getDateKeyInTimeZone(parsed, TIME_ZONE);
  }
  return "";
}

function getDateKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getReminderSlot(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date)
  );

  if (hour < 10) return "morning";
  if (hour < 15) return "midday";
  if (hour < 20) return "evening";
  return "night";
}

function getSlotSendTime(slot) {
  return {
    morning: "buổi sáng theo giờ Asia/Bangkok",
    midday: "buổi trưa theo giờ Asia/Bangkok",
    evening: "buổi tối theo giờ Asia/Bangkok",
    night: "đêm muộn theo giờ Asia/Bangkok",
  }[slot] || "khung giờ nhắc học theo giờ Asia/Bangkok";
}

function toAbsoluteUrl(url) {
  try {
    return new URL(url, getAppBaseUrl()).href;
  } catch (_) {
    return `${getAppBaseUrl()}/pages/hoc-phan.html`;
  }
}

function getAppBaseUrl() {
  return String(process.env.APP_BASE_URL || DEFAULT_APP_BASE_URL).replace(/\/+$/, "");
}

function getNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanText(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanDisplayName(value) {
  return limitText(cleanText(value), 60);
}

function getRecentReminderTemplates(data = {}) {
  const items = data.emailState?.recentReminderTemplates;
  return Array.isArray(items) ? items.filter(Boolean).map((item) => String(item).slice(0, 64)).slice(0, 8) : [];
}

function getNextRecentReminderTemplates(data = {}, templateKey = "") {
  const cleanKey = String(templateKey || "").trim().slice(0, 64);
  if (!cleanKey) return getRecentReminderTemplates(data);
  return [cleanKey, ...getRecentReminderTemplates(data).filter((item) => item !== cleanKey)].slice(0, 8);
}

function pickTemplate(templates, key, recentTemplates = []) {
  if (!Array.isArray(templates) || templates.length === 0) return {};
  const freshTemplates = templates.filter((template) => !recentTemplates.includes(template.templateKey));
  const pool = freshTemplates.length ? freshTemplates : templates;
  return pool[hashText(key) % pool.length] || pool[0];
}

function hashText(value) {
  return Math.abs(
    String(value || "").split("").reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
  );
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function limitText(value, maxLength) {
  if (!value) return "";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trim()}...` : value;
}

function toDocId(value) {
  return String(value || "item")
    .trim()
    .replace(/[/.#[\]]/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  isAuthorizedRequest,
  verifyFirebaseRequest,
  runMailWorker,
  sendWelcomeEmail,
  recordEmailClick,
  sendPairStreakNudge,
  sendRealtimeStreakEventReminder,
  renderEmailHtml,
};
