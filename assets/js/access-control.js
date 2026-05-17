import { auth } from "./firebase-app.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const allowedCourseEmails = [
  "2454112132tuyen@ou.edu.vn",
  "doyouknow.nis@gmail.com",
  "nguyentrthnhquynh2801@gmail.com",
  "nttthao006@gmail.com",
  "vtanfit001@gmail.com",
];

export function hasCourseAccess(user) {
  const email = String(user?.email || "").trim().toLowerCase();
  return allowedCourseEmails.includes(email);
}

export async function requireCourseAccess() {
  const user = await waitForSignedInUser();
  return {
    user,
    allowed: hasCourseAccess(user),
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

function waitForSignedInUser(timeoutMs = 5000) {
  if (!auth) return Promise.resolve(null);
  if (auth.currentUser) return Promise.resolve(auth.currentUser);

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

    function finish(user) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unsubscribe();
      resolve(user || null);
    }

    unsubscribe = onAuthStateChanged(auth, finish, () => finish(null));
  });
}
