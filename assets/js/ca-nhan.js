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
  learningMap.innerHTML = renderSpiderMap(items.map(normalizeMapItem));
}

function renderSpiderMap(items) {
  const size = 340;
  const center = 170;
  const radius = 108;
  const levels = [0.2, 0.4, 0.6, 0.8, 1];
  const average = Math.round(items.reduce((sum, item) => sum + item.percent, 0) / Math.max(items.length, 1));
  const grid = levels
    .map((level) => `<polygon class="spider-grid-line" points="${getSpiderPoints(items.length, level, center, radius)}"></polygon>`)
    .join("");
  const axes = items
    .map((item, index) => {
      const end = getSpiderPoint(index, items.length, 1, center, radius);
      const label = getSpiderPoint(index, items.length, 1.27, center, radius);
      return `
        <line class="spider-axis" x1="${center}" y1="${center}" x2="${end.x}" y2="${end.y}"></line>
        <text class="spider-axis-label" x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(item.axisLabel)}</text>
      `;
    })
    .join("");
  const valuePoints = items
    .map((item, index) => {
      const point = getSpiderPoint(index, items.length, item.percent / 100, center, radius);
      return `${point.x},${point.y}`;
    })
    .join(" ");
  const markers = items
    .map((item, index) => {
      const point = getSpiderPoint(index, items.length, item.percent / 100, center, radius);
      return `<circle class="spider-marker" cx="${point.x}" cy="${point.y}" r="5" style="--skill-color: ${escapeHtml(item.color)}"><title>${escapeHtml(item.title)} ${item.percent}%</title></circle>`;
    })
    .join("");

  return `
    <div class="spider-map-shell">
      <div class="spider-chart-wrap">
        <svg class="spider-chart" viewBox="0 0 ${size} ${size}" role="img" aria-label="Skill progress radar chart">
          <g class="spider-grid">${grid}</g>
          <g>${axes}</g>
          <polygon class="spider-value-area" points="${valuePoints}"></polygon>
          <g>${markers}</g>
          <circle class="spider-core" cx="${center}" cy="${center}" r="31"></circle>
          <text class="spider-core-value" x="${center}" y="${center - 3}" text-anchor="middle">${average}%</text>
          <text class="spider-core-label" x="${center}" y="${center + 15}" text-anchor="middle">overall</text>
        </svg>
      </div>
      <div class="spider-legend">
        ${items.map(renderSpiderLegendItem).join("")}
      </div>
    </div>
  `;
}

function renderSpiderLegendItem(item) {
  return `
    <a class="spider-legend-item" href="${escapeHtml(item.href)}" style="--skill-color: ${escapeHtml(item.color)}; --skill-soft: ${escapeHtml(item.softColor)}">
      <span class="spider-legend-dot" aria-hidden="true"></span>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.description)}</small>
      </span>
      <em>${escapeHtml(item.status)}</em>
    </a>
  `;
}

function normalizeMapItem(item) {
  const percent = item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0;
  return {
    ...item,
    percent,
    status: item.total > 0 ? `${item.completed}/${item.total}` : item.emptyLabel || "Soon",
  };
}

function getSpiderPoints(count, scale, center, radius) {
  return Array.from({ length: count }, (_, index) => {
    const point = getSpiderPoint(index, count, scale, center, radius);
    return `${point.x},${point.y}`;
  }).join(" ");
}

function getSpiderPoint(index, count, scale, center, radius) {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  return {
    x: Number((center + Math.cos(angle) * radius * scale).toFixed(2)),
    y: Number((center + Math.sin(angle) * radius * scale).toFixed(2)),
  };
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
      axisLabel: "Listen",
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
      axisLabel: "Read",
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
      axisLabel: "Speak",
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
      axisLabel: "Write",
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
      axisLabel: "Cards",
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
      axisLabel: "Tests",
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
