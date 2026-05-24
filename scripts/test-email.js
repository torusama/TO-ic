/**
 * Test email sender — Gửi tất cả các case mẫu.
 */
const nodemailer = require("nodemailer");
const { renderEmailHtml } = require("../api/_lib/mail-automation.js");

const TO = "givemeaflower266@gmail.com";
const FROM_EMAIL = "azotatoeic@gmail.com";
const FROM_NAME = "AzoTa TOEIC";

const password = process.argv[2] || process.env.GMAIL_APP_PASSWORD;
if (!password) {
  console.error("❌ Thiếu GMAIL_APP_PASSWORD!");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: FROM_EMAIL, pass: password },
});

async function sendTestMail(type, subject, preview, body, ctaText) {
  const html = renderEmailHtml({
    type,
    ctaUrl: "https://to-ic.vercel.app/pages/hoc-phan.html",
    profileUrl: "https://to-ic.vercel.app/pages/ca-nhan.html",
    copy: { subject, preview, body, ctaText }
  });

  console.log(`📧 Đang gửi email test '${type}' đến:`, TO);
  await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
    to: TO,
    subject,
    text: body,
    html,
  });
}

async function main() {
  await sendTestMail(
    "milestone",
    "Kinh đấy! 30 ngày liên tiếp!",
    "Thành tích ấn tượng, nhưng liệu giữ được bao lâu?",
    "Chào Tân An,\n\nChúc mừng bạn đã sống sót qua 30 ngày học TOEIC cùng AzoTa. Thành tích ấn tượng đấy, nhưng thử xem bạn giữ được nó thêm bao lâu nữa? Kỷ lục là để phá vỡ!",
    "Học tiếp thôi"
  );

  await sendTestMail(
    "freeze",
    "Phép màu vừa cứu chuỗi của bạn...",
    "Bạn vừa dùng hết quyền trợ giúp đóng băng chuỗi rồi đó.",
    "Chào Tân An,\n\nBạn vừa bỏ lỡ buổi học hôm qua, nhưng may mắn là \"Đóng băng chuỗi\" đã kích hoạt và cứu chuỗi 12 ngày của bạn. Đừng lười nữa, không có lần 2 đâu!",
    "Học ngay"
  );

  await sendTestMail(
    "friend-streak-danger",
    "Tuấn Hưng đang chờ bạn kìa!",
    "Đừng làm đứt chuỗi chung của 2 người nhé.",
    "Chào Tân An,\n\nBạn và Tuấn Hưng đang giữ chuỗi học cùng nhau. Tuấn Hưng đang chờ bạn hoàn thành bài học hôm nay. Đừng trở thành kẻ tội đồ làm đứt chuỗi nhé!",
    "Cứu chuỗi team"
  );

  await sendTestMail(
    "friend-overtook",
    "Nhìn Tuấn Hưng mà học tập kìa!",
    "Tuấn Hưng vừa vượt lên rồi đó.",
    "Chào Tân An,\n\nTuấn Hưng vừa hoàn thành bài học hôm nay rồi đó. Bạn định ngồi im nhìn người ta vượt mặt mình thật sao? Trả đũa ngay bằng một bài TOEIC 5 phút nào!",
    "Học ngay cho nóng"
  );

  console.log("✅ Gửi thành công tất cả! Check inbox: " + TO);
}

main().catch(console.error);
