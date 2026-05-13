import { hasFirebaseConfig } from "./firebase-app.js";
import {
  clearNotifications,
  deleteNotification,
  ensureDefaultNotifications,
  listenNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notification-service.js";
import {
  ensureUserProfile,
  listenActivities,
  listenUserProfile,
  normalizeProfile,
  onUserChanged,
  signOutUser,
} from "./user-service.js";

const firebaseNotice = document.querySelector("#firebaseNotice");
const signOutBtn = document.querySelector("#signOutBtn");
const notificationList = document.querySelector("#notificationList");
const activityList = document.querySelector("#activityList");
const markAllReadBtn = document.querySelector("#markAllReadBtn");
const clearNotificationsBtn = document.querySelector("#clearNotificationsBtn");

let activeUser = null;
let activeProfile = normalizeProfile(null, {});
let activeNotifications = [];
let activeActivities = [];
let activeActivityError = "";
let unsubscribers = [];

setAuthState("signed-out");

if (!hasFirebaseConfig) {
  firebaseNotice.hidden = false;
} else {
  onUserChanged(async (user) => {
    cleanupListeners();
    activeUser = user;
    activeNotifications = [];
    activeActivities = [];
    activeActivityError = "";

    if (!user) {
      activeProfile = normalizeProfile(null, {});
      setAuthState("signed-out");
      resetProfile();
      renderProfile();
      return;
    }

    setAuthState("signed-in");
    activeProfile = normalizeProfile(user, {});
    renderProfile();

    try {
      activeProfile = await ensureUserProfile(user);
      await ensureDefaultNotifications(user);
      renderProfile();

      unsubscribers = [
        listenUserProfile(
          user.uid,
          (profile) => {
            if (profile) activeProfile = profile;
            renderProfile();
          },
          (error) => console.warn("Could not listen to profile:", error)
        ),
        listenNotifications(
          user.uid,
          (items) => {
            activeNotifications = items;
            renderProfile();
          },
          (error) => console.warn("Could not listen to notifications:", error)
        ),
        listenActivities(
          user.uid,
          (items) => {
            activeActivities = items;
            activeActivityError = "";
            renderProfile();
          },
          (error) => {
            console.warn("Could not listen to learning history:", error);
            activeActivityError = "Could not load learning history. Check Firestore rules for this user.";
            activeActivities = [];
            renderProfile();
          }
        ),
      ];
    } catch (error) {
      console.warn("Could not sync Firestore; showing Google profile data instead:", error);
    }
  });
}

signOutBtn.addEventListener("click", async () => {
  const previousUser = activeUser;
  sessionStorage.setItem("toeic-just-signed-out", "1");
  cleanupListeners();
  activeUser = null;
  activeProfile = normalizeProfile(null, {});
  activeNotifications = [];
  activeActivities = [];
  activeActivityError = "";
  setAuthState("signed-out");
  resetProfile();
  renderProfile();

  try {
    await signOutUser();
    window.location.href = "../index.html";
  } catch (error) {
    console.warn("Sign out failed:", error);
    sessionStorage.removeItem("toeic-just-signed-out");
    if (previousUser) {
      activeUser = previousUser;
      setAuthState("signed-in");
    }
  }
});

notificationList?.addEventListener("click", async (event) => {
  if (!activeUser) return;
  const item = event.target.closest("[data-notification-id]");
  if (!item) return;

  try {
    if (event.target.closest("[data-delete-notification]")) {
      await deleteNotification(activeUser.uid, item.dataset.notificationId);
    } else {
      await markNotificationRead(activeUser.uid, item.dataset.notificationId);
    }
  } catch (error) {
    console.warn("Could not update notification:", error);
  }
});

notificationList?.addEventListener("keydown", async (event) => {
  if ((event.key !== "Enter" && event.key !== " ") || !activeUser) return;
  const item = event.target.closest("[data-notification-id]");
  if (!item) return;

  event.preventDefault();
  try {
    await markNotificationRead(activeUser.uid, item.dataset.notificationId);
  } catch (error) {
    console.warn("Could not mark notification as read:", error);
  }
});

markAllReadBtn?.addEventListener("click", async () => {
  if (!activeUser || !activeNotifications.some((item) => item.unread)) return;
  try {
    await markAllNotificationsRead(activeUser.uid, activeNotifications);
  } catch (error) {
    console.warn("Could not mark all notifications as read:", error);
  }
});

clearNotificationsBtn?.addEventListener("click", async () => {
  if (!activeUser || !activeNotifications.length) return;
  try {
    await clearNotifications(activeUser.uid, activeNotifications);
  } catch (error) {
    console.warn("Could not clear notifications:", error);
  }
});

function renderProfile() {
  const unreadCount = activeNotifications.filter((item) => item.unread).length;

  document.querySelector("#userAvatar").src = activeProfile.photoURL || "https://www.gravatar.com/avatar/?d=mp";
  document.querySelector("#userName").textContent = activeProfile.displayName || "TOEIC Learner";
  document.querySelector("#userEmail").textContent = activeProfile.email || "";
  document.querySelector("#streakMetric").textContent = activeProfile.stats?.streak || 0;
  document.querySelector("#lessonsMetric").textContent = activeProfile.stats?.lessons || 0;
  document.querySelector("#profileBell")?.classList.toggle("has-unread", unreadCount > 0);

  notificationList.classList.toggle("is-empty", activeNotifications.length === 0);
  notificationList.innerHTML = activeNotifications.length
    ? activeNotifications
        .map(
          (item) => `
            <article class="notification-item ${item.unread ? "is-unread" : ""}" data-notification-id="${item.id}" tabindex="0">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <p>${escapeHtml(item.body)}</p>
              </div>
              <button class="notification-delete" type="button" data-delete-notification aria-label="Delete notification">&times;</button>
            </article>
          `
        )
        .join("")
    : `<div class="notification-empty">No notifications yet.</div>`;

  markAllReadBtn.disabled = unreadCount === 0;
  clearNotificationsBtn.disabled = activeNotifications.length === 0;

  activityList.classList.toggle("is-empty", activeActivities.length === 0);
  activityList.innerHTML = activeActivityError
    ? `<div class="activity-empty activity-empty--error">${escapeHtml(activeActivityError)}</div>`
    : activeActivities.length
      ? activeActivities.map((item) => renderActivityItem(item)).join("")
      : `<div class="activity-empty">No learning activity yet.</div>`;
}

function renderActivityItem(item) {
  const title = item.title || item.body || "Learning activity";
  const body = item.body && item.title ? `<p>${escapeHtml(item.body)}</p>` : "";
  const meta = formatActivityMeta(item);
  return `
    <div class="activity-item">
      <strong>${escapeHtml(title)}</strong>
      ${body}
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    </div>
  `;
}

function formatActivityMeta(item) {
  const pieces = [];
  if (item.courseTitle) pieces.push(item.courseTitle);

  const date = item.createdAt?.toDate?.() || getActivityDate(item);
  if (date) {
    pieces.push(
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    );
  } else if (item.createdDateKey) {
    pieces.push(item.createdDateKey);
  }

  return pieces.join(" - ");
}

function getActivityDate(item) {
  const timestamp = Number(item.createdAtMs || 0);
  if (timestamp > 0) return new Date(timestamp);

  const parsed = Date.parse(item.createdAtIso || "");
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function setAuthState(state) {
  document.body.classList.toggle("is-signed-in", state === "signed-in");
  document.body.classList.toggle("is-signed-out", state === "signed-out");
  document.body.classList.remove("auth-loading");
}

function cleanupListeners() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
}

function resetProfile() {
  document.querySelector("#userAvatar").src = "";
  document.querySelector("#userName").textContent = "TOEIC Learner";
  document.querySelector("#userEmail").textContent = "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
