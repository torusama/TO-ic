const { sendWelcomeEmail, verifyFirebaseRequest } = require("./_lib/mail-automation.js");

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
    const result = await sendWelcomeEmail({ uid: decodedToken.uid });
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = Number(error.statusCode || 500);
    if (status >= 500) {
      console.error("Welcome email failed:", error);
    }
    response.status(status).json({ ok: false, error: error.message || "Could not send welcome email." });
  }
};

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
