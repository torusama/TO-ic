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
  getCompletedLessonKey,
  listenCompletedLessons,
  listenUserProfile,
  normalizeProfile,
  onUserChanged,
  signOutUser,
} from "./user-service.js";

import "./data.js";
import "./nghe-doc-data.js";

const firebaseNotice = document.querySelector("#firebaseNotice");
const signOutBtn = document.querySelector("#signOutBtn");
const notificationList = document.querySelector("#notificationList");
const learningMap = document.querySelector("#learningMap");
const markAllReadBtn = document.querySelector("#markAllReadBtn");
const clearNotificationsBtn = document.querySelector("#clearNotificationsBtn");

let activeUser = null;
let activeProfile = normalizeProfile(null, {});
let activeNotifications = [];
let activeCompletedLessons = new Set();
let unsubscribers = [];

setAuthState("signed-out");

if (!hasFirebaseConfig) {
  firebaseNotice.hidden = false;
} else {
  onUserChanged(async (user) => {
    cleanupListeners();
    activeUser = user;
    activeNotifications = [];
    activeCompletedLessons = new Set();

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
        listenCompletedLessons(
          user.uid,
          (lessonIds) => {
            activeCompletedLessons = lessonIds;
            renderProfile();
          },
          (error) => {
            console.warn("Could not listen to completed lessons:", error);
            activeCompletedLessons = new Set();
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
  activeCompletedLessons = new Set();
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

  renderLearningMap();
}

function renderLearningMap() {
  if (!learningMap) return;

  const items = getLearningMapItems();
  learningMap.innerHTML = items.map((item) => renderLearningMapCard(item)).join("");
}

function renderLearningMapCard(item) {
  const percent = item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0;
  const status = item.total > 0 ? `${item.completed}/${item.total}` : item.emptyLabel || "Soon";
  const completeClass = item.total > 0 && item.completed >= item.total ? " is-complete" : "";

  return `
    <a class="learning-map-card${completeClass}" href="${escapeHtml(item.href)}" style="--skill-color: ${escapeHtml(item.color)}; --skill-soft: ${escapeHtml(item.softColor)}; --skill-progress: ${percent}%">
      <span class="learning-map-icon" aria-hidden="true">${escapeHtml(item.icon)}</span>
      <span class="learning-map-card__body">
        <span class="learning-map-card__top">
          <strong>${escapeHtml(item.title)}</strong>
          <em>${escapeHtml(status)}</em>
        </span>
        <span>${escapeHtml(item.description)}</span>
        <span class="learning-map-progress" aria-hidden="true"><i></i></span>
        <small>${percent}% complete</small>
      </span>
    </a>
  `;
}

function getLearningMapItems() {
  const listeningLessons = getCourseLessons("nghe-doc", (part) => getPartNumber(part.id) <= 4);
  const readingLessons = getCourseLessons("nghe-doc", (part) => getPartNumber(part.id) >= 5);
  const speakingLessons = getCourseLessons("noi-viet", (part) => /speaking|read-text-aloud/i.test(part.id));
  const writingLessons = getCourseLessons("noi-viet", (part) => /writing/i.test(part.id));
  const flashcardLessons = window.TOIC_DATA?.vocabCourses?.flatMap((course) => course.lessons || []) || [];
  const practiceTests = getCourseExercises("nghe-doc");

  return [
    {
      title: "Listening",
      icon: "L",
      description: `${listeningLessons.length || 0} video lessons from TOEIC Parts 1-4`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#ff9600",
      softColor: "rgba(255, 150, 0, 0.13)",
      completed: countCompleted("nghe-doc", listeningLessons),
      total: listeningLessons.length,
    },
    {
      title: "Reading",
      icon: "R",
      description: `${readingLessons.length || 0} video lessons from TOEIC Parts 5-7`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#1cb0f6",
      softColor: "rgba(28, 176, 246, 0.13)",
      completed: countCompleted("nghe-doc", readingLessons),
      total: readingLessons.length,
    },
    {
      title: "Speaking",
      icon: "S",
      description: `${speakingLessons.length || 0} lessons for TOEIC speaking prompts`,
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#58cc02",
      softColor: "rgba(88, 204, 2, 0.14)",
      completed: countCompleted("noi-viet", speakingLessons),
      total: speakingLessons.length,
    },
    {
      title: "Writing",
      icon: "W",
      description: writingLessons.length ? `${writingLessons.length} writing lessons ready` : "Writing lessons will appear here when added",
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#ff4b4b",
      softColor: "rgba(255, 75, 75, 0.12)",
      completed: countCompleted("noi-viet", writingLessons),
      total: writingLessons.length,
      emptyLabel: "Next",
    },
    {
      title: "Flashcards",
      icon: "F",
      description: `${flashcardLessons.length || 0} vocabulary days for quick review`,
      href: "./tu-vung.html",
      color: "#ffc800",
      softColor: "rgba(255, 200, 0, 0.16)",
      completed: 0,
      total: flashcardLessons.length,
    },
    {
      title: "Practice tests",
      icon: "P",
      description: `${practiceTests.length || 0} TOEIC drills and mock tests`,
      href: "./luyen-de.html",
      color: "#8b5cf6",
      softColor: "rgba(139, 92, 246, 0.12)",
      completed: 0,
      total: practiceTests.length,
    },
  ];
}

function getCourseLessons(courseId, partFilter = () => true) {
  const course = getCourse(courseId);
  if (!course) return [];
  if (!course.parts?.length) return (course.lessons || []).filter((item) => !item.isExercise);

  return course.parts
    .filter(partFilter)
    .flatMap((part) => part.items || [])
    .filter((item) => !item.isExercise);
}

function getCourseExercises(courseId) {
  const course = getCourse(courseId);
  if (!course) return [];
  if (!course.parts?.length) return (course.lessons || []).filter((item) => item.isExercise);

  return course.parts.flatMap((part) => part.items || []).filter((item) => item.isExercise);
}

function getCourse(courseId) {
  return window.TOIC_DATA?.courses?.find((course) => course.id === courseId) || null;
}

function getPartNumber(partId) {
  const match = String(partId || "").match(/part-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function countCompleted(courseId, items) {
  return items.filter((item) => activeCompletedLessons.has(getCompletedLessonKey(courseId, item.id))).length;
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
