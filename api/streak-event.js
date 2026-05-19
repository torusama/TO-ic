const { sendRealtimeStreakEventReminder, verifyFirebaseRequest } = require("./_lib/mail-automation.js");

module.exports = async function handler(request, response) {
  setCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const decodedToken = await verifyFirebaseRequest(request);
    const body = await readJsonBody(request);
    const result = await sendRealtimeStreakEventReminder({
      actorUid: decodedToken.uid,
      eventType: String(body.type || "lesson-completed").trim() || "lesson-completed",
    });

    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    if (status >= 500) {
      console.error("Streak event reminder failed:", error);
    }
    response.status(status).json({ ok: false, error: error.message || "Could not process streak event." });
  }
};

function readJsonBody(request) {
  if (Buffer.isBuffer(request.body)) {
    try {
      return Promise.resolve(JSON.parse(request.body.toString("utf8") || "{}"));
    } catch (_) {
      return Promise.resolve({});
    }
  }
  if (request.body && typeof request.body === "object") return Promise.resolve(request.body);
  if (typeof request.body === "string") {
    try {
      return Promise.resolve(JSON.parse(request.body || "{}"));
    } catch (_) {
      return Promise.resolve({});
    }
  }

  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve({});
      }
    });
    request.on("error", () => resolve({}));
  });
}

function setCorsHeaders(request, response) {
  const origin = request.headers?.origin || "";
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://to-ic.vercel.app",
  ]);
  const appBaseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (appBaseUrl) allowedOrigins.add(appBaseUrl);

  if (allowedOrigins.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}
