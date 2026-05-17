const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const FROM_EMAIL = "azotatoeic@gmail.com";
const FROM_NAME = "AzoTa TOEIC";
const TIME_ZONE = "Asia/Bangkok";
const DEFAULT_AI_PROVIDER = "groq";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_APP_BASE_URL = "https://to-ic.vercel.app";
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
    starterReminders: null,
    reminders: null,
    announcements: null,
  };

  if (["starter", "starter-reminders", "early-reminders"].includes(normalizedMode)) {
    result.starterReminders = await sendStarterStudyReminders(todayKey);
  }

  if (["all", "reminders", "study-reminders"].includes(normalizedMode)) {
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

async function sendDailyStudyReminders(todayKey) {
  const candidates = await getEmailCandidates((user) => shouldSendStudyReminder(user, todayKey), {
    resetBrokenStreaks: true,
    todayKey,
  });
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `study-reminder__${todayKey}`,
    type: "study-reminder",
    copyFactory: (user) => createStudyReminderCopy(user, todayKey, { kind: "study-reminder" }),
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
      const ctaUrl = urlFactory(user, copy);
      await sendMail({
        to: user.data.email,
        copy,
        ctaUrl,
        type,
        user: user.data,
      });

      const notification = notificationFactory(copy);
      const now = admin.firestore.FieldValue.serverTimestamp();
      await Promise.all([
        deliveryRef.set(
          {
            type,
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

async function createStudyReminderCopy(user, todayKey, { kind = "study-reminder" } = {}) {
  const data = user.data;
  const streak = getActiveStreak(data.stats, todayKey);
  const firstName = getFirstName(data.displayName);
  const isStarter = kind === "starter-reminder";
  const fallback = isStarter
    ? {
        subject: "Mo streak TOEIC hom nay nha",
        preview: "Mot bai ngan la du bat nhip hoc dau tien roi.",
        body:
          `Chao ${firstName}, hom nay minh bat dau that nhe thoi: mo mot bai TOEIC ngan, hoc vai phut, roi de AzoTa ghi ngay dau tien cho ban. ` +
          "Khong can hoan hao dau, chi can co mat la chuoi streak bat dau chay.",
        ctaText: "Bat dau hoc",
      }
    : {
        subject: `Giu streak ${streak} ngay hom nay nha`,
        preview: "18h roi, streak cua ban dang cho mot bai ngan de duoc giu tiep.",
        body:
          `Chao ${firstName}, streak ${streak} ngay cua ban van con do. Hom nay chua ghi nhan bai hoc moi, nen lam mot bai TOEIC ngan truoc khi nghi nha. ` +
          "Vai phut thoi cung du giu nhip, dung de cong may ngay qua roi mat uong lam.",
        ctaText: "Giu streak",
      };

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

async function createAnnouncementCopy(user, announcement) {
  const data = user.data;
  const fallback = {
    subject: `Bài mới: ${announcement.lessonTitle}`,
    preview: `${announcement.courseTitle} vừa có bài mới.`,
    body:
      `Chào ${getFirstName(data.displayName)}, AzoTa TOEIC vừa đăng bài "${announcement.lessonTitle}" ` +
      `trong khóa ${announcement.courseTitle}. ${announcement.summary || "Vào học khi bạn sẵn sàng nhé."}`,
    ctaText: "Mở bài học",
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
    `Email settings: ${profileUrl}`,
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
    .map((paragraph) => `<p style="margin:0 0 14px;color:#4b4b4b;font-size:16px;font-weight:700;line-height:1.58;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const streak = Number(user.stats?.streak || 0);
  const lessons = Number(user.stats?.lessons || 0);
  const isAnnouncement = type === "announcement";
  const isStarter = type === "starter-reminder";
  const accent = isAnnouncement ? "#1cb0f6" : isStarter ? "#58cc02" : "#ff9600";
  const accentShadow = isAnnouncement ? "#1899d6" : isStarter ? "#61b800" : "#d87b00";
  const badge = isAnnouncement ? "NEW LESSON" : isStarter ? "START STREAK" : "STREAK RESCUE";
  const metricLabel = isAnnouncement ? "Update" : "Current streak";
  const metricValue = isAnnouncement ? "New" : String(streak);

  return `<!doctype html>
<html>
  <body style="margin:0;background:#fbfbfb;font-family:Arial,sans-serif;color:#4b4b4b;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(copy.preview)}</div>
    <main style="max-width:620px;margin:0 auto;padding:30px 14px;">
      <section style="overflow:hidden;background:#ffffff;border:2px solid #e5e5e5;border-radius:18px;box-shadow:0 8px 0 #e5e5e5;">
        <div style="padding:22px 24px;background:linear-gradient(135deg, rgba(88,204,2,0.16), rgba(255,255,255,1) 58%);border-bottom:2px solid #e5e5e5;">
          <p style="margin:0 0 12px;color:#58cc02;font-size:12px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;">AzoTa TOEIC</p>
          <span style="display:inline-block;margin:0 0 12px;border-radius:999px;background:${accent};color:#ffffff;padding:6px 12px;font-size:11px;font-weight:900;letter-spacing:.7px;text-transform:uppercase;">${badge}</span>
          <h1 style="margin:0;color:#100f3e;font-size:28px;line-height:1.18;font-weight:900;">${escapeHtml(copy.subject)}</h1>
        </div>
        <div style="padding:24px;">
          <div style="display:table;width:100%;border-spacing:0 0;margin:0 0 22px;">
            <div style="display:table-cell;width:50%;padding:0 6px 0 0;">
              <div style="border:2px solid #e5e5e5;border-radius:14px;padding:14px;background:#ffffff;">
                <p style="margin:0 0 4px;color:#afafaf;font-size:11px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;">${metricLabel}</p>
                <strong style="display:block;color:${accent};font-size:30px;font-weight:900;line-height:1;">${escapeHtml(metricValue)}</strong>
              </div>
            </div>
            <div style="display:table-cell;width:50%;padding:0 0 0 6px;">
              <div style="border:2px solid #e5e5e5;border-radius:14px;padding:14px;background:#ffffff;">
                <p style="margin:0 0 4px;color:#afafaf;font-size:11px;font-weight:900;letter-spacing:.8px;text-transform:uppercase;">Lessons</p>
                <strong style="display:block;color:#1cb0f6;font-size:30px;font-weight:900;line-height:1;">${lessons}</strong>
              </div>
            </div>
          </div>
          ${paragraphs}
          <p style="margin:24px 0 0;">
            <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${accent};box-shadow:0 4px 0 ${accentShadow};color:#ffffff;text-decoration:none;font-size:15px;font-weight:900;border-radius:12px;padding:14px 20px;text-transform:uppercase;">${escapeHtml(copy.ctaText)}</a>
          </p>
        </div>
      </section>
      <p style="margin:16px 4px 0;color:#777777;font-size:12px;line-height:1.5;">
        You are receiving this because your TOEIC account has email reminders enabled.
        Manage email settings in your <a href="${escapeHtml(profileUrl)}" style="color:#1cb0f6;">profile</a>.
      </p>
    </main>
  </body>
</html>`;
}

function getAiProvider() {
  const provider = String(process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER).trim().toLowerCase();
  return provider === "gemini" ? "gemini" : "groq";
}

function getEmailCopySystemPrompt() {
  return [
    "You write short Vietnamese emails for AzoTa TOEIC learners.",
    "Brand voice: Duolingo-inspired but original: playful, meme-aware, a little dramatic, warm, and fast to understand.",
    "Write like a tiny TOEIC coach with a clipboard is poking the learner, not like a corporate newsletter.",
    "Use natural Vietnamese with light Gen Z flavor only when it fits. One witty jab is welcome; keep it affectionate.",
    "Personalize from context: streak, lessons, recentCourse, recentLesson, courseTitle, lessonTitle, and sendTime.",
    "If kind is study-reminder and streak is above 0, create playful urgency about saving the streak before midnight.",
    "If kind is starter-reminder, make the first step feel tiny, easy, and oddly satisfying.",
    "If kind is new-lesson, make the lesson feel fresh and worth opening now.",
    "Avoid copying Duolingo lines. Do not mention Duo, owls, threats, stalking, guilt, shame, grades guaranteed, discounts, or that you are AI.",
    "Subject: max 58 chars, punchy, curiosity + action. Preview: max 95 chars.",
    "Body: 45-85 Vietnamese words, 1-2 short paragraphs, one clear CTA.",
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
  runMailWorker,
};
