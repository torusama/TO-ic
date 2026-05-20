const { runMailWorker, verifyFirebaseRequest } = require("./_lib/mail-automation.js");

const ADMIN_EMAILS = new Set(["vtanfit001@gmail.com"]);

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const token = await verifyFirebaseRequest(request);
    const email = String(token.email || "").trim().toLowerCase();
    if (!ADMIN_EMAILS.has(email)) {
      response.status(403).json({ ok: false, error: "Admin access required" });
      return;
    }

    const result = await runMailWorker({ mode: "new-lessons" });
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    console.error("Lesson announcement worker failed:", error);
    response.status(statusCode).json({ ok: false, error: error.message });
  }
};
