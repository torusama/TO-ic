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
    const mode = getQueryValue(request, "mode") || "all";
    const result = await runMailWorker({ mode });
    response.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("Mail worker failed:", error);
    response.status(500).json({ ok: false, error: error.message });
  }
};

function getQueryValue(request, key) {
  if (request.query && request.query[key]) return String(request.query[key]);
  try {
    const url = new URL(request.url, "http://localhost");
    return url.searchParams.get(key);
  } catch (_) {
    return "";
  }
}
