const { isAuthorizedRequest, runMailWorker } = require("./_lib/mail-automation.js");

module.exports = async function handler(request, response) {
  if (!["GET", "POST"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST");
    response.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  if (!isAuthorizedRequest(request)) {
    response.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }

  try {
    const result = await runMailWorker({ mode: "starter-reminders" });
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("Starter mail worker failed:", error);
    response.status(500).json({ ok: false, error: error.message });
  }
};
