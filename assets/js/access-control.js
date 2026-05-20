import { getValidSignedInUser } from "./auth-session.js";

const allowedCourseEmails = [
  "2454112132tuyen@ou.edu.vn",
  "doyouknow.nis@gmail.com",
  "nguyentrthnhquynh2801@gmail.com",
  "nttthao006@gmail.com",
  "vtanfit001@gmail.com",
];

const adminEmails = [
  "vtanfit001@gmail.com",
];

export function hasCourseAccess(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  return allowedCourseEmails.includes(email) || adminEmails.includes(email);
}

export function hasAdminAccess(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  return adminEmails.includes(email);
}

export async function requireCourseAccess() {
  const user = await getValidSignedInUser();
  return {
    user,
    allowed: hasCourseAccess(user),
  };
}

export async function requireAdminAccess() {
  const user = await getValidSignedInUser();
  return {
    user,
    allowed: hasAdminAccess(user),
  };
}

export function renderCourseUnavailable(root = document.querySelector("main")) {
  if (!root) return;

  root.classList.add("access-unavailable-shell");
  root.innerHTML = `
    <section class="access-unavailable" aria-live="polite">
      <strong>Khóa học không khả dụng</strong>
    </section>
  `;
}
