const admin = require("firebase-admin");
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
  const todayKey = getDateKeyInTimeZone(new Date(), TIME_ZONE);
  const normalizedMode = String(mode || "all").toLowerCase();
  const result = {
    todayKey,
    pairBreaks: null,
    starterReminders: null,
    reminders: null,
    announcements: null,
  };

  if (["starter", "starter-reminders", "early-reminders"].includes(normalizedMode)) {
    result.starterReminders = await sendStarterStudyReminders(todayKey);
  }

  if (["all", "reminders", "study-reminders"].includes(normalizedMode)) {
    result.pairBreaks = await expireBrokenPairStreaks(todayKey);
    result.reminders = await sendDailyStudyReminders(todayKey);
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
      partnerName: cleanDisplayName(partnerData.displayName) || "your partner",
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
        title: "Pair Streak Reminder",
        body: `${cleanDisplayName(requesterData.displayName) || "Your partner"} is waiting for you to study today.`,
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
    partnerName: cleanDisplayName(partnerData.displayName) || "your partner",
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
              body: `Your team streak with ${cleanDisplayName(partner.data.displayName) || "your partner"} ended after 3 days without progress.`,
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
          subject: "Team streak ended",
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

async function sendDailyStudyReminders(todayKey) {
  const candidates = await getEmailCandidates((user) => shouldSendStudyReminder(user, todayKey), {
    resetBrokenStreaks: true,
    todayKey,
  });
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `study-reminder__${todayKey}`,
    type: (user, copy) => copy.kind || "study-reminder",
    copyFactory: (user) => createContextualStudyReminderCopy(user, todayKey),
    urlFactory: () => `${getAppBaseUrl()}/pages/hoc-phan.html`,
    notificationFactory: (copy) => ({
      id: `study-reminder__${todayKey}`,
      title: copy.subject,
      body: copy.preview,
    }),
    afterSend: (userRef) =>
      userRef.set(
        {
          emailState: {
            lastStudyReminderDate: todayKey,
            lastStudyReminderKind: copy.kind || "study-reminder",
            lastEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      ),
  });

  return result;
}

async function sendStarterStudyReminders(todayKey) {
  const candidates = await getEmailCandidates((user) => shouldSendStarterReminder(user, todayKey), {
    resetBrokenStreaks: true,
    todayKey,
  });
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `starter-reminder__${todayKey}`,
    type: "starter-reminder",
    copyFactory: (user) => createStudyReminderCopy(user, todayKey, { kind: "starter-reminder" }),
    urlFactory: () => `${getAppBaseUrl()}/pages/hoc-phan.html`,
    notificationFactory: (copy) => ({
      id: `starter-reminder__${todayKey}`,
      title: copy.subject,
      body: copy.preview,
    }),
    afterSend: (userRef) =>
      userRef.set(
        {
          emailState: {
            lastStarterReminderDate: todayKey,
            lastStudyReminderDate: todayKey,
            lastEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      ),
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
      notificationFactory: (copy) => ({
        id: `announcement__${item.id}`,
        title: copy.subject,
        body: copy.preview,
      }),
      afterSend: (userRef) =>
        userRef.set(
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
        afterSend(user.ref, copy),
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

function shouldSendStudyReminder(user, todayKey) {
  const data = user.data;
  if (data.emailPreferences?.studyReminders === false) return false;
  if (data.emailState?.lastStudyReminderDate === todayKey) return false;
  if (hasStudiedToday(data.stats, todayKey)) return false;
  return true;
}

function shouldSendStarterReminder(user, todayKey) {
  const data = user.data;
  if (data.emailPreferences?.studyReminders === false) return false;
  if (data.emailState?.lastStarterReminderDate === todayKey) return false;
  if (data.emailState?.lastStudyReminderDate === todayKey) return false;
  if (hasStudiedToday(data.stats, todayKey)) return false;
  if (getActiveStreak(data.stats, todayKey) > 0) return false;
  return true;
}

function shouldSendAnnouncement(user) {
  return user.data.emailPreferences?.newLessonAlerts !== false;
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

async function createContextualStudyReminderCopy(user, todayKey) {
  const context = await getStudyReminderContext(user, todayKey);
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

  copy = await createStudyReminderCopy(user, todayKey, { kind: context.kind });
  return { ...copy, kind: context.kind };
}

async function getStudyReminderContext(user, todayKey) {
  const pairContext = await getPairStreakReminderContext(user, todayKey);
  if (pairContext) return pairContext;

  const friendContext = await getFriendActivityReminderContext(user, todayKey);
  if (friendContext) return friendContext;

  const activeStreak = getActiveStreak(user.data.stats, todayKey);
  if (activeStreak > 0) {
    return { kind: "study-reminder", streak: activeStreak };
  }

  const daysSinceLastStudy = getDaysBetweenDateKeys(user.data.stats?.lastStreakDate, todayKey);
  if (Number.isFinite(daysSinceLastStudy) && daysSinceLastStudy >= 2) {
    return { kind: "comeback-reminder", daysSinceLastStudy };
  }

  return { kind: "starter-reminder" };
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
      partnerName: cleanDisplayName(partnerData.displayName) || "your partner",
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

async function createStudyReminderCopy(user, todayKey, { kind = "study-reminder" } = {}) {
  const data = user.data;
  const streak = getActiveStreak(data.stats, todayKey);
  const firstName = getFirstName(data.displayName);
  const isStarter = kind === "starter-reminder";
  let fallback;
  if (kind === "starter-reminder") {
    fallback = {
      subject: "Những lời nhắc này có vẻ không hiệu quả...",
      preview: "AzoTa sẽ ngừng gửi email cho bạn từ bây giờ.",
      body: `Chào ${firstName},\n\nCó vẻ như bạn đã chọn cách từ bỏ tiếng Anh. AzoTa sẽ ngừng làm phiền bạn bằng những email này. Chúc bạn may mắn với quyết định của mình.`,
      ctaText: "Khoan, tôi vẫn muốn học",
    };
  } else if (kind === "milestone") {
    fallback = {
      subject: `Kinh đấy! ${streak} ngày liên tiếp!`,
      preview: "Thành tích ấn tượng, nhưng liệu giữ được bao lâu?",
      body: `Chào ${firstName},\n\nChúc mừng bạn đã sống sót qua ${streak} ngày học TOEIC cùng AzoTa. Thành tích ấn tượng đấy, nhưng thử xem bạn giữ được nó thêm bao lâu nữa? Kỷ lục là để phá vỡ!`,
      ctaText: "Học tiếp thôi",
    };
  } else if (kind === "freeze") {
    fallback = {
      subject: "Phép màu vừa cứu chuỗi của bạn...",
      preview: "Bạn vừa dùng hết quyền trợ giúp đóng băng chuỗi rồi đó.",
      body: `Chào ${firstName},\n\nBạn vừa bỏ lỡ buổi học hôm qua, nhưng may mắn là "Đóng băng chuỗi" đã kích hoạt và cứu chuỗi ${streak} ngày của bạn. Đừng lười nữa, không có lần 2 đâu!`,
      ctaText: "Học ngay",
    };
  } else {
    fallback = {
      subject: "Bạn làm AzoTa buồn rồi đó 😢",
      preview: `Bảo vệ chuỗi ${streak} ngày của bạn ngay!`,
      body: `Chào ${firstName},\n\nChuỗi ${streak} ngày học liên tiếp của bạn sắp tan thành mây khói rồi. Chỉ mất 5 phút thôi mà, bạn định để công sức đổ sông đổ biển thật sao?`,
      ctaText: "Giữ chuỗi ngay",
    };
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
      sendTime: isStarter ? "early morning Asia/Bangkok" : "18:00 Asia/Bangkok",
      tone: isStarter ? "gentle first-step nudge" : "earnest streak rescue before midnight, no guilt trip",
    },
    fallback
  );
}

async function createSocialEmailCopy(user, friendData, kind) {
  const data = user.data || {};
  const firstName = getFirstName(data.displayName);
  const friendName = friendData.displayName || "Bạn bè";
  const streak = Number(data.stats?.streak || 0);

  let fallback;
  if (kind === "friend-streak-danger") {
    fallback = {
      subject: `${friendName} đang chờ bạn kìa!`,
      preview: `Đừng làm đứt chuỗi chung của 2 người nhé.`,
      body: `Chào ${firstName},\n\nBạn và ${friendName} đang giữ chuỗi học cùng nhau. ${friendName} đang chờ bạn hoàn thành bài học hôm nay. Đừng trở thành kẻ tội đồ làm đứt chuỗi nhé!`,
      ctaText: "Cứu chuỗi team",
    };
  } else if (kind === "friend-overtook") {
    fallback = {
      subject: `Nhìn ${friendName} mà học tập kìa!`,
      preview: `${friendName} vừa vượt lên rồi đó.`,
      body: `Chào ${firstName},\n\n${friendName} vừa hoàn thành bài học hôm nay rồi đó. Bạn định ngồi im nhìn người ta vượt mặt mình thật sao? Trả đũa ngay bằng một bài TOEIC 5 phút nào!`,
      ctaText: "Học ngay cho nóng",
    };
  } else {
    fallback = {
      subject: `${friendName} vừa học xong`,
      preview: "Bạn cũng vào học đi nhé.",
      body: `Chào ${firstName},\n\n${friendName} vừa học xong bài hôm nay. Bạn cũng vào học đi nhé.`,
      ctaText: "Học bài",
    };
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
  const partnerName = context.partnerName || "your partner";
  const pairStreak = Number(context.pairStreak || context.pairData?.streak || 0);
  const fallback = {
    subject: `Team streak ${pairStreak} ngày đang chờ`,
    preview: `${partnerName} cũng chưa học hôm nay. Một người mở màn đi nào.`,
    body: `Chào ${firstName},\n\nBạn và ${partnerName} đều chưa học hôm nay. Team streak ${pairStreak} ngày sẽ không tự cứu mình đâu. Vào làm một bài TOEIC 5 phút để kéo cả đội dậy.`,
    ctaText: "Cứu team streak",
  };

  return createAiEmailCopy(
    {
      kind: "pair-streak-both-idle",
      displayName: data.displayName,
      firstName,
      friendName: partnerName,
      pairStreak,
      todayKey,
      context: `Both pair streak partners have not studied today. Ask ${firstName} to start first so ${partnerName} is more likely to follow and the team streak can survive.`,
    },
    fallback
  );
}

async function createPairStreakBrokenCopy({ userData = {}, partnerData = {}, pairData = {}, todayKey }) {
  const firstName = getFirstName(userData.displayName);
  const partnerName = cleanDisplayName(partnerData.displayName) || "your partner";
  const pairStreak = Number(pairData.brokenFromStreak || pairData.streak || 0);
  const fallback = {
    subject: "Team streak đã kết thúc",
    preview: `Chuỗi ${pairStreak} ngày với ${partnerName} đã về 0.`,
    body: `Chào ${firstName},\n\nTeam streak của bạn với ${partnerName} đã kết thúc vì 3 ngày liền không tăng chuỗi. Bộ đếm đã về 0, nhưng chỉ cần một bài TOEIC ngắn là có thể bắt đầu lại.`,
    ctaText: "Bắt đầu lại",
  };

  return createAiEmailCopy(
    {
      kind: "pair-streak-broken",
      displayName: userData.displayName,
      firstName,
      friendName: partnerName,
      pairStreak,
      todayKey,
      context: `The pair/team streak with ${partnerName} has ended because the pair did not increase it for 3 days. Notify the learner clearly, without blaming either person, and invite them to restart with one short TOEIC lesson.`,
    },
    fallback
  );
}

async function createComebackReminderCopy(user, todayKey, context = {}) {
  const data = user.data || {};
  const firstName = getFirstName(data.displayName);
  const daysSinceLastStudy = Number(context.daysSinceLastStudy || 0);
  const fallback = {
    subject: "Mất nhịp rồi đó",
    preview: "Quay lại bằng một bài TOEIC ngắn thôi.",
    body: `Chào ${firstName},\n\n${daysSinceLastStudy || "Mấy"} ngày rồi bạn chưa học lại. Không cần comeback hoành tráng đâu: một bài TOEIC 5 phút là đủ để AzoTa biết bạn vẫn còn trên đời.`,
    ctaText: "Học lại ngay",
  };

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
      context: "The learner has no active streak right now. Nudge them to restart gently with one short TOEIC lesson, without making it sound hopeless.",
    },
    fallback
  );
}

async function createPairStreakNudgeCopy({ requesterData = {}, partnerData = {}, pairData = {}, todayKey }) {
  const requesterName = cleanDisplayName(requesterData.displayName) || "Bạn đồng hành";
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
      context: `${requesterName} has completed a lesson today. ${partnerName} has not studied yet, so the pair streak cannot increase until ${partnerName} completes a lesson today.`,
    },
    fallback
  );
}

function getPairStreakNudgeFallback({ requesterName, firstName, pairStreak, todayKey }) {
  const templates = [
    {
      subject: `${requesterName} đang chờ bạn đó`,
      preview: "Còn thiếu lượt của bạn để tăng chuỗi team hôm nay.",
      body: `Chào ${firstName},\n\n${requesterName} đã học hôm nay rồi. Còn bạn nữa là chuỗi team ${pairStreak} ngày có thể tăng tiếp. Vào làm một bài TOEIC 5 phút đi, đừng để người ta chờ.`,
      ctaText: "Cứu chuỗi team",
    },
    {
      subject: "Chuỗi team đang nhìn bạn",
      preview: `${requesterName} xong lượt rồi, tới bạn đó.`,
      body: `Chào ${firstName},\n\n${requesterName} vừa giữ lời hứa với streak team hôm nay. Giờ quả bóng đang ở chân bạn: hoàn thành một bài để cả hai cùng lên chuỗi.`,
      ctaText: "Học ngay",
    },
    {
      subject: `${requesterName} học rồi kìa`,
      preview: "Đừng để pair streak đứng im hôm nay.",
      body: `Chào ${firstName},\n\n${requesterName} đã hoàn thành bài hôm nay. Nếu bạn học thêm một bài nữa, streak team sẽ được tính tiếp. Một bài thôi, đừng làm tụt mood đồng đội.`,
      ctaText: "Vào học bài",
    },
  ];
  return templates[hashText(`${requesterName}:${firstName}:${todayKey}`) % templates.length];
}

async function createAnnouncementCopy(user, announcement) {
  const data = user.data;
  const fallback = {
    subject: `Bạn có định ngó lơ bài học mới không?`,
    preview: `AzoTa vừa ra mắt bài: ${announcement.lessonTitle}`,
    body: `Chào ${firstName},\n\nTrong lúc bạn đang lướt mạng, AzoTa đã cập nhật xong bài "${announcement.lessonTitle}" thuộc khóa ${announcement.courseTitle}. Đừng để kiến thức mọc rêu nhé, vào xem ngay đi!`,
    ctaText: "Vào học ngay",
  };

  return createAiEmailCopy(
    {
      kind: "new-lesson",
      displayName: data.displayName,
      firstName: getFirstName(data.displayName),
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
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) return fallback;

  try {
    const provider = getAiProvider();
    const copy =
      provider === "gemini"
        ? await createGeminiEmailCopy(context, apiKey)
        : await createGroqEmailCopy(context, apiKey);

    return sanitizeEmailCopy(copy, fallback);
  } catch (error) {
    console.warn("AI email copy fallback used:", {
      provider: getAiProvider(),
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
      temperature: 0.7,
      max_completion_tokens: 700,
    }),
  });

  const data = await readAiJsonResponse(response, "Groq");
  return parseAiJson(data.choices?.[0]?.message?.content || "");
}

async function sendMail({ to, copy, ctaUrl, type, user }) {
  const profileUrl = `${getAppBaseUrl()}/pages/ca-nhan.html`;
  const html = renderEmailHtml({ copy, ctaUrl, profileUrl, type, user });
  const text = [
    copy.preview,
    "",
    copy.body,
    "",
    `${copy.ctaText}: ${ctaUrl}`,
    "",
    `Hủy đăng ký hoặc cài đặt email: ${profileUrl}`,
  ].join("\n");

  await getMailTransporter().sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to,
    subject: copy.subject,
    text,
    html,
  });
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
  return toAbsoluteUrl(`/pages/bai-hoc.html?${query.toString()}`);
}

function sanitizeEmailCopy(value, fallback) {
  return {
    subject: limitText(cleanText(value.subject), 90) || fallback.subject,
    preview: limitText(cleanText(value.preview), 140) || fallback.preview,
    body: limitText(cleanText(value.body), 1200) || fallback.body,
    ctaText: limitText(cleanText(value.ctaText), 32) || fallback.ctaText,
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
  let heroEmoji = "🔥";

  if (isAnnouncement) {
    accent = "#1cb0f6"; accentShadow = "#1899d6"; heroEmoji = "📖";
  } else if (isStarter) {
    accent = "#ff4b4b"; accentShadow = "#cc3c3c"; heroEmoji = "😭";
  } else if (isMilestone) {
    accent = "#ffc800"; accentShadow = "#cc9f00"; heroEmoji = "🎉";
  } else if (isFreeze) {
    accent = "#2b70c9"; accentShadow = "#1e5299"; heroEmoji = "🧊";
  } else if (isPairBroken) {
    accent = "#94a3b8"; accentShadow = "#64748b"; heroEmoji = "&#10005;";
  } else if (isSocial) {
    accent = "#ce82ff"; accentShadow = "#a568cc"; heroEmoji = type === "friend-overtook" ? "🥊" : "🚨";
  }

  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>${escapeHtml(copy.subject)}</title><!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif!important}</style><![endif]--></head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(copy.preview)}${"&#847;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;"><tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;border-radius:16px;overflow:hidden;background:#ffffff;box-shadow:0 4px 12px rgba(0,0,0,0.05);">

<tr><td style="padding:48px 32px 32px;text-align:center;">
<div style="font-size:72px;line-height:1;margin:0 0 24px;">${heroEmoji}</div>
<p style="margin:0 0 16px;color:#100f3e;font-size:26px;font-weight:900;line-height:1.3;letter-spacing:-0.5px;">${escapeHtml(copy.subject)}</p>
</td></tr>

<tr><td style="padding:0 32px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${paragraphs}</table></td></tr>

<tr><td style="padding:16px 32px 48px;" align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:12px;background:${accent};box-shadow:0 4px 0 ${accentShadow};"><a href="${escapeHtml(ctaUrl)}" style="display:block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:900;letter-spacing:1px;text-transform:uppercase;text-align:center;">${escapeHtml(copy.ctaText)}</a></td></tr></table></td></tr>

<tr><td style="padding:24px 32px 32px;text-align:center;border-top:2px solid #e5e5e5;">
<p style="margin:0 0 8px;color:#afafaf;font-size:14px;line-height:1.5;">Bạn nhận email này vì tài khoản TOEIC đã<br>bật nhắc nhở.</p>
<p style="margin:0 0 16px;"><a href="${escapeHtml(profileUrl)}" style="color:#1cb0f6;font-size:14px;text-decoration:underline;">Quản lý cài đặt email</a></p>
<p style="margin:0;color:#c0c0c0;font-size:13px;">&copy; AzoTa TOEIC</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function getAiProvider() {
  const provider = String(process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER).trim().toLowerCase();
  return provider === "gemini" ? "gemini" : "groq";
}

function getEmailCopySystemPrompt() {
  return [
    "Bạn là 'AzoTa TOEIC', một trợ lý nhắc nhở học tập với tính cách giống hệt cú xanh Duolingo: xéo xắt, hay dỗi, châm biếm nhẹ nhàng, nhưng sâu thẳm vẫn rất quan tâm học viên.",
    "Bạn viết email CỰC KỲ NGẮN, giống như người thật nhắn tin, tuyệt đối KHÔNG DÙNG văn phong robot/AI, không dùng các từ ngữ rập khuôn như 'Hãy cùng...', 'Đừng ngần ngại...'.",
    "Nếu kind là 'study-reminder' (có streak): Nhấn mạnh nỗi đau sắp mất streak. Hãy tỏ ra thất vọng nhẹ hoặc hù dọa đùa.",
    "Nếu kind là 'starter-reminder' (streak = 0): Dùng chiêu thao túng tâm lý: 'Những lời nhắc này có vẻ không hiệu quả. AzoTa sẽ ngừng gửi mail cho bạn.'",
    "Nếu kind là 'milestone': Khen ngợi thành tích đạt cột mốc streak, nhưng vẫn khịa nhẹ là 'xem giữ được bao lâu'.",
    "Nếu kind là 'freeze': Nhắc nhở nghiêm khắc là họ vừa thoát chết nhờ Streak Freeze, đừng lười nữa.",
    "Nếu kind là 'friend-streak-danger': Dùng áp lực đồng trang lứa. Nhắc rằng friendName đang chờ và họ sắp làm đứt chuỗi chung.",
    "Nếu kind là 'friend-overtook': Kích động lòng hiếu thắng vì friendName vừa học xong và vượt lên.",
    "Nếu kind là 'announcement' (bài mới): Tỏ ra hào hứng nhưng vẫn khịa nhẹ nếu họ lười học.",
    "Cá nhân hóa tự nhiên dựa vào context. KHÔNG được nhắc lại số liệu một cách thô cứng.",
    "Giữ email tối giản: Tối đa 2-3 câu ngắn. Không chào hỏi dài dòng. Vào thẳng vấn đề.",
    "Subject: Ngắn, giật tít, khơi gợi tò mò hoặc mang tính sát thương cao (max 50 chars). Preview: Max 80 chars.",
    "If kind is 'pair-streak-nudge': write as a direct reminder from friendName/requesterName. They already studied today; the recipient must finish one lesson today so the pair/team streak can increase. Keep it short, playful, and contextual.",
    "If kind is 'pair-streak-both-idle': both partners have not studied today. Ask the recipient to be the first one to save the team streak. Keep it social, urgent, and not too guilty.",
    "If kind is 'pair-streak-broken': the pair/team streak has ended after 3 days without progress. Be clear, calm, and invite them to restart with one short lesson.",
    "If kind is 'comeback-reminder': the learner has no active streak or has been away for multiple days. Make restarting feel easy with one short TOEIC lesson.",
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
  sendPairStreakNudge,
  sendRealtimeStreakEventReminder,
  renderEmailHtml,
};
