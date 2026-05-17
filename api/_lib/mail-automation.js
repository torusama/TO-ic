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
    reminders: null,
    announcements: null,
  };

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
  const candidates = await getEmailCandidates((user) => shouldSendStudyReminder(user, todayKey));
  const result = await deliverToCandidates({
    candidates,
    deliveryId: `study-reminder__${todayKey}`,
    type: "study-reminder",
    copyFactory: (user) => createStudyReminderCopy(user, todayKey),
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

async function sendReadyAnnouncements() {
  const db = getDb();
  const snapshot = await db.collection("announcements").limit(getNumberEnv("MAX_ANNOUNCEMENTS_PER_RUN", 10)).get();
  const announcements = snapshot.docs
    .map((docSnap) => ({ ref: docSnap.ref, id: docSnap.id, data: docSnap.data() || {} }))
    .filter((item) => shouldSendAnnouncementDoc(item.data));
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

    await item.ref.set(
      {
        status: deliveryResult.failed > 0 ? "sent-with-errors" : "sent",
        sentCount: deliveryResult.sent,
        skippedCount: deliveryResult.skipped,
        failedCount: deliveryResult.failed,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    results.push({ id: item.id, ...deliveryResult });
  }

  return {
    processed: results.length,
    results,
  };
}

async function getEmailCandidates(predicate) {
  const maxEmails = getNumberEnv("MAX_EMAILS_PER_RUN", 40);
  const snapshot = await getDb().collection("users").limit(maxEmails * 3).get();
  return snapshot.docs
    .map((docSnap) => ({ ref: docSnap.ref, id: docSnap.id, data: docSnap.data() || {} }))
    .filter((user) => Boolean(user.data.email) && predicate(user))
    .slice(0, maxEmails);
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
  if (data.stats?.lastStreakDate === todayKey) return false;
  return true;
}

function shouldSendAnnouncement(user) {
  return user.data.emailPreferences?.newLessonAlerts !== false;
}

function shouldSendAnnouncementDoc(data = {}) {
  if (data.sendEmail === false) return false;
  if (data.status === "draft") return false;
  if (data.status === "sending") return false;
  if (data.status === "sent") return false;
  if (data.status === "sent-with-errors") return false;
  return true;
}

async function createStudyReminderCopy(user, todayKey) {
  const data = user.data;
  const fallback = {
    subject: "Giữ streak TOEIC hôm nay nha",
    preview: "Một bài ngắn hôm nay là đủ giữ nhịp học rồi.",
    body:
      `Chào ${getFirstName(data.displayName)}, hôm nay (${todayKey}) bạn chưa ghi nhận bài học mới. ` +
      `Làm một bài TOEIC ngắn để giữ streak ${Number(data.stats?.streak || 0)} ngày và quay lại nhịp học nhé.`,
    ctaText: "Học ngay",
  };

  return createAiEmailCopy(
    {
      kind: "study-reminder",
      displayName: data.displayName,
      firstName: getFirstName(data.displayName),
      streak: Number(data.stats?.streak || 0),
      lessons: Number(data.stats?.lessons || 0),
      recentCourse: data.learning?.recentCourse || "",
      recentLesson: data.learning?.recentLesson || "",
      todayKey,
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

async function sendMail({ to, copy, ctaUrl }) {
  const profileUrl = `${getAppBaseUrl()}/pages/ca-nhan.html`;
  const html = renderEmailHtml({ copy, ctaUrl, profileUrl });
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
  };
}

function sanitizeEmailCopy(value, fallback) {
  return {
    subject: limitText(cleanText(value.subject), 90) || fallback.subject,
    preview: limitText(cleanText(value.preview), 140) || fallback.preview,
    body: limitText(cleanText(value.body), 1200) || fallback.body,
    ctaText: limitText(cleanText(value.ctaText), 32) || fallback.ctaText,
  };
}

function renderEmailHtml({ copy, ctaUrl, profileUrl }) {
  const paragraphs = cleanText(copy.body)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f7f7f7;font-family:Arial,sans-serif;color:#4b4b4b;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(copy.preview)}</div>
    <main style="max-width:560px;margin:0 auto;padding:28px 16px;">
      <section style="background:#ffffff;border:1px solid #e5e5e5;border-radius:16px;padding:28px;">
        <p style="margin:0 0 8px;color:#58cc02;font-weight:800;letter-spacing:.04em;text-transform:uppercase;">AzoTa TOEIC</p>
        <h1 style="margin:0 0 18px;color:#100f3e;font-size:24px;line-height:1.25;">${escapeHtml(copy.subject)}</h1>
        <div style="font-size:16px;line-height:1.6;">${paragraphs}</div>
        <p style="margin:24px 0 0;">
          <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#58cc02;color:#ffffff;text-decoration:none;font-weight:800;border-radius:12px;padding:12px 18px;">${escapeHtml(copy.ctaText)}</a>
        </p>
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
    "Style: warm, lively, a little playful, similar to a friendly streak coach.",
    "Do not guilt-trip, threaten, overpromise scores, mention discounts, or say you are AI.",
    "Keep the body under 110 Vietnamese words.",
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
