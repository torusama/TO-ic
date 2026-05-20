const { recordEmailClick } = require("./_lib/mail-automation.js");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const url = new URL(request.url, "http://localhost");
    const target = await recordEmailClick({
      uid: url.searchParams.get("uid") || "",
      deliveryId: url.searchParams.get("delivery") || "",
      type: url.searchParams.get("type") || "",
      target: url.searchParams.get("target") || "",
      sig: url.searchParams.get("sig") || "",
    });

    response.writeHead(302, { Location: target });
    response.end();
  } catch (error) {
    const fallback = `${String(process.env.APP_BASE_URL || "https://to-ic.vercel.app").replace(/\/+$/, "")}/pages/hoc-phan.html`;
    if (Number(error.statusCode || 500) >= 500) {
      console.error("Email click tracking failed:", error);
    }
    response.writeHead(302, { Location: fallback });
    response.end();
  }
};
