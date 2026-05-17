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
  listenActivities,
  listenCompletedLessons,
  listenUserProfile,
  normalizeProfile,
  onUserChanged,
  signOutUser,
  updateEmailPreferences,
} from "./user-service.js";
import { loadCourseWithLessons } from "./course-service.js";

const firebaseNotice = document.querySelector("#firebaseNotice");
const signOutBtn = document.querySelector("#signOutBtn");
const notificationList = document.querySelector("#notificationList");
const learningMap = document.querySelector("#learningMap");
const skillComboChart = document.querySelector("#skillComboChart");
const skillPieChart = document.querySelector("#skillPieChart");
const markAllReadBtn = document.querySelector("#markAllReadBtn");
const clearNotificationsBtn = document.querySelector("#clearNotificationsBtn");
const emailStudyReminders = document.querySelector("#emailStudyReminders");
const emailNewLessonAlerts = document.querySelector("#emailNewLessonAlerts");
const emailSettingsStatus = document.querySelector("#emailSettingsStatus");

let activeUser = null;
let activeProfile = normalizeProfile(null, {});
let activeNotifications = [];
let activeActivities = [];
let activeCompletedLessons = new Set();
let activeCoursesById = new Map();
let unsubscribers = [];
let courseDataVersion = 0;

setAuthState("signed-out");

if (!hasFirebaseConfig) {
  firebaseNotice.hidden = false;
} else {
  onUserChanged(async (user) => {
    cleanupListeners();
    const loadVersion = ++courseDataVersion;
    activeUser = user;
    activeNotifications = [];
    activeActivities = [];
    activeCompletedLessons = new Set();
    activeCoursesById = new Map();

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
      loadProfileCourseData().then(() => {
        if (loadVersion === courseDataVersion) renderProfile();
      });

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
            renderProfile();
          },
          (error) => {
            console.warn("Could not listen to learning activity:", error);
            activeActivities = [];
            renderProfile();
          }
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
  activeActivities = [];
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

[emailStudyReminders, emailNewLessonAlerts].forEach((toggle) => {
  toggle?.addEventListener("change", saveEmailSettings);
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
  renderSkillChartPanels();
  renderEmailSettings();
}

async function loadProfileCourseData() {
  const courses = await Promise.all([
    loadCourseWithLessons("nghe-doc"),
    loadCourseWithLessons("noi-viet"),
  ]);

  activeCoursesById = new Map(courses.filter(Boolean).map((course) => [course.id, course]));
}

async function saveEmailSettings() {
  if (!activeUser) return;

  setEmailSettingsSaving(true, "Saving email settings...");
  try {
    await updateEmailPreferences(activeUser.uid, {
      studyReminders: emailStudyReminders?.checked,
      newLessonAlerts: emailNewLessonAlerts?.checked,
    });
    setEmailSettingsSaving(false, "Saved. Mail will be sent from azotatoeic@gmail.com.");
  } catch (error) {
    console.warn("Could not save email settings:", error);
    setEmailSettingsSaving(false, "Could not save email settings. Try again.");
    renderEmailSettings();
  }
}

function renderEmailSettings() {
  const preferences = activeProfile.emailPreferences || {};

  if (emailStudyReminders) {
    emailStudyReminders.checked = preferences.studyReminders !== false;
    emailStudyReminders.disabled = !activeUser;
  }

  if (emailNewLessonAlerts) {
    emailNewLessonAlerts.checked = preferences.newLessonAlerts !== false;
    emailNewLessonAlerts.disabled = !activeUser;
  }

  if (emailSettingsStatus && !emailSettingsStatus.dataset.isSaving) {
    emailSettingsStatus.textContent = activeUser
      ? "Mail will be sent from azotatoeic@gmail.com."
      : "Sign in to manage email reminders.";
  }
}

function setEmailSettingsSaving(isSaving, message) {
  [emailStudyReminders, emailNewLessonAlerts].forEach((toggle) => {
    if (toggle) toggle.disabled = isSaving || !activeUser;
  });

  if (!emailSettingsStatus) return;
  emailSettingsStatus.dataset.isSaving = isSaving ? "true" : "";
  emailSettingsStatus.textContent = message;

  if (!isSaving) {
    window.setTimeout(() => {
      if (emailSettingsStatus.dataset.isSaving) return;
      renderEmailSettings();
    }, 1800);
  }
}

function renderLearningMap() {
  if (!learningMap) return;

  const items = getLearningMapItems().map(normalizeMapItem);
  learningMap.innerHTML = renderSpiderMap(items);
}

function renderSkillChartPanels() {
  if (!skillComboChart || !skillPieChart) return;

  const items = getCoreSkillItems(getLearningMapItems().map(normalizeMapItem));
  skillComboChart.innerHTML = renderComboChart(items);
  skillPieChart.innerHTML = renderPieChart(items);
}

function renderSpiderMap(items) {
  const size = 420;
  const center = 210;
  const radius = 145;
  const levels = [0.2, 0.4, 0.6, 0.8, 1];
  const grid = levels
    .map((level) => `<polygon class="spider-grid-line" points="${getSpiderPoints(items.length, level, center, radius)}"></polygon>`)
    .join("");
  const axes = items
    .map((item, index) => {
      const end = getSpiderPoint(index, items.length, 1, center, radius);
      const label = getSpiderPoint(index, items.length, 1.24, center, radius);
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
      if (item.percent <= 0) return "";
      const point = getSpiderPoint(index, items.length, item.percent / 100, center, radius);
      return `<circle class="spider-marker" cx="${point.x}" cy="${point.y}" r="5" style="--skill-color: ${escapeHtml(item.color)}"><title>${escapeHtml(item.title)} ${escapeHtml(item.status)}</title></circle>`;
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
        </svg>
      </div>
    </div>
  `;
}

function getCoreSkillItems(items) {
  const skillOrder = ["Listening", "Reading", "Speaking", "Writing", "Practice"];
  return skillOrder.map((title) => items.find((item) => item.title === title)).filter(Boolean);
}

function renderComboChart(items) {
  const width = 430;
  const height = 240;
  const top = 24;
  const right = 18;
  const bottom = 44;
  const left = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const baseY = top + chartHeight;
  const step = chartWidth / Math.max(items.length, 1);
  const barWidth = Math.min(42, step * 0.44);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((level) => {
      const y = Number((baseY - chartHeight * level).toFixed(2));
      return `<line class="combo-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>`;
    })
    .join("");
  const points = items
    .map((item, index) => {
      const x = left + index * step + step / 2;
      const y = baseY - chartHeight * (item.percent / 100);
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(" ");
  const groups = items.map((item, index) => renderComboSkillGroup(item, index, { left, top, baseY, chartHeight, step, barWidth, width })).join("");
  const markers = items
    .map((item, index) => {
      const x = left + index * step + step / 2;
      const y = baseY - chartHeight * (item.percent / 100);
      return `<circle class="combo-line-dot" cx="${Number(x.toFixed(2))}" cy="${Number(y.toFixed(2))}" r="4"></circle>`;
    })
    .join("");

  return `
    <div class="skill-chart-block skill-chart-block--combo" aria-label="Skill progress chart">
      <svg class="skill-chart-svg combo-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Completed lessons by skill">
        <g>${grid}</g>
        <g>${groups}</g>
        <polyline class="combo-line" points="${points}"></polyline>
        <g>${markers}</g>
      </svg>
    </div>
  `;
}

function renderComboSkillGroup(item, index, chart) {
  const percent = clamp(item.percent, 0, 100);
  const xCenter = chart.left + index * chart.step + chart.step / 2;
  const barX = xCenter - chart.barWidth / 2;
  const barHeight = chart.chartHeight * (percent / 100);
  const visibleBarHeight = percent > 0 ? barHeight : 3;
  const barY = chart.baseY - visibleBarHeight;
  const hitX = chart.left + index * chart.step;
  const tooltipWidth = 142;
  const tooltipHeight = 58;
  const tooltipX = clamp(xCenter - tooltipWidth / 2, 6, chart.width - tooltipWidth - 6);
  const tooltipY = Math.max(6, barY - tooltipHeight - 8);

  return `
    <g class="combo-skill-group" tabindex="0">
      <rect class="combo-hit-zone" x="${Number(hitX.toFixed(2))}" y="${chart.top}" width="${Number(chart.step.toFixed(2))}" height="${chart.chartHeight + 30}"></rect>
      <rect class="combo-track" x="${Number(barX.toFixed(2))}" y="${chart.top}" width="${Number(chart.barWidth.toFixed(2))}" height="${chart.chartHeight}" rx="10"></rect>
      <rect class="combo-bar-fill ${percent === 0 ? "is-empty" : ""}" x="${Number(barX.toFixed(2))}" y="${Number(barY.toFixed(2))}" width="${Number(chart.barWidth.toFixed(2))}" height="${Number(visibleBarHeight.toFixed(2))}" rx="10" style="--skill-color: ${escapeHtml(item.color)}"></rect>
      <text class="combo-x-label" x="${Number(xCenter.toFixed(2))}" y="${chart.baseY + 28}" text-anchor="middle">${escapeHtml(getShortSkillLabel(item.title))}</text>
      ${renderChartTooltip(item, tooltipX, tooltipY, tooltipWidth, tooltipHeight)}
    </g>
  `;
}

function renderPieChart(items) {
  const width = 260;
  const height = 260;
  const center = 130;
  const radius = 100;
  const totalCompleted = items.reduce((sum, item) => sum + item.completed, 0);
  let currentAngle = 0;
  const slices = totalCompleted
    ? items
        .map((item) => {
          if (!item.completed) return "";
          const sliceSize = (item.completed / totalCompleted) * 360;
          const startAngle = currentAngle;
          const endAngle = currentAngle + sliceSize;
          currentAngle = endAngle;
          const share = Math.round((item.completed / totalCompleted) * 100);
          const tooltipItem = {
            ...item,
            tooltipDetail: `${share}% of completed work`,
            tooltipMeta: `${item.completed} completed lessons`,
          };
          return `
            <g class="pie-slice-group" tabindex="0">
              <path class="pie-slice" d="${getPieSlicePath(center, center, radius, startAngle, endAngle)}" style="--skill-color: ${escapeHtml(item.color)}">
                <title>${escapeHtml(item.title)} ${share}% of completed work</title>
              </path>
              ${renderChartTooltip(tooltipItem, 58, 184, 150, 58)}
            </g>
          `;
        })
        .join("")
    : "";
  const centerContent = totalCompleted
    ? `
        <circle class="pie-center" cx="${center}" cy="${center}" r="38"></circle>
        <text class="pie-center-title" x="${center}" y="${center - 2}" text-anchor="middle">TOEIC</text>
        <text class="pie-center-subtitle" x="${center}" y="${center + 16}" text-anchor="middle">skills</text>
      `
    : `<circle class="pie-empty-ring" cx="${center}" cy="${center}" r="${radius}"></circle>`;

  return `
    <div class="skill-chart-block skill-chart-block--pie" aria-label="Skill category chart">
      <svg class="skill-chart-svg pie-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Skill categories">
        <g class="pie-slices">${slices}</g>
        ${centerContent}
      </svg>
    </div>
  `;
}

function renderChartTooltip(item, x, y, width, height) {
  const totalLine = item.tooltipDetail || (item.total ? `${item.completed}/${item.total} completed` : "No lessons yet");
  const detailLine = item.tooltipMeta || (item.total ? `${item.total} tracked lessons` : "Waiting for data");
  return `
    <g class="chart-tooltip" transform="translate(${Number(x.toFixed(2))} ${Number(y.toFixed(2))})">
      <rect width="${width}" height="${height}" rx="10"></rect>
      <text class="chart-tooltip-title" x="10" y="18">${escapeHtml(item.title)}</text>
      <text class="chart-tooltip-line" x="10" y="36">${escapeHtml(totalLine)}</text>
      <text class="chart-tooltip-line" x="10" y="50">${escapeHtml(detailLine)}</text>
    </g>
  `;
}

function getPieSlicePath(cx, cy, radius, startAngle, endAngle) {
  if (Math.abs(endAngle - startAngle) >= 360) {
    return `
      M ${cx} ${cy - radius}
      A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius}
      A ${radius} ${radius} 0 1 1 ${cx} ${cy - radius}
      Z
    `;
  }
  const start = getPolarPoint(cx, cy, radius, startAngle);
  const end = getPolarPoint(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
}

function getPolarPoint(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: Number((cx + radius * Math.cos(radians)).toFixed(2)),
    y: Number((cy + radius * Math.sin(radians)).toFixed(2)),
  };
}

function getShortSkillLabel(title) {
  const labels = {
    Listening: "Listen",
    Reading: "Read",
    Speaking: "Speak",
    Writing: "Write",
    Practice: "Practice",
  };
  return labels[title] || title;
}

function normalizeMapItem(item) {
  const percent = item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0;
  return {
    ...item,
    percent,
    status: `${item.completed}/${item.total}`,
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
  const listeningLessons = getCourseLessons("nghe-doc", isListeningPart);
  const readingLessons = getCourseLessons("nghe-doc", isReadingPart);
  const speakingLessons = getCourseLessons("noi-viet", isSpeakingPart);
  const writingLessons = getCourseLessons("noi-viet", isWritingPart);
  const practiceItems = getTrackedPracticeItems();

  return [
    {
      title: "Listening",
      axisLabel: "Listening",
      description: `${listeningLessons.length || 0} lessons from TOEIC Listening Parts 1-4`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#ff9600",
      softColor: "rgba(255, 150, 0, 0.13)",
      completed: countCompleted("nghe-doc", listeningLessons),
      total: listeningLessons.length,
    },
    {
      title: "Reading",
      axisLabel: "Reading",
      description: `${readingLessons.length || 0} lessons from TOEIC Reading Parts 5-7`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#1cb0f6",
      softColor: "rgba(28, 176, 246, 0.13)",
      completed: countCompleted("nghe-doc", readingLessons),
      total: readingLessons.length,
    },
    {
      title: "Speaking",
      axisLabel: "Speaking",
      description: `${speakingLessons.length || 0} lessons from current Speaking data`,
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#58cc02",
      softColor: "rgba(88, 204, 2, 0.14)",
      completed: countCompleted("noi-viet", speakingLessons),
      total: speakingLessons.length,
    },
    {
      title: "Writing",
      axisLabel: "Writing",
      description: `${writingLessons.length || 0} lessons from current Writing data`,
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#ff4b4b",
      softColor: "rgba(255, 75, 75, 0.12)",
      completed: countCompleted("noi-viet", writingLessons),
      total: writingLessons.length,
    },
    {
      title: "Practice",
      axisLabel: "Practice",
      description: `${practiceItems.length || 0} tracked practice exercises`,
      href: "./luyen-de.html",
      color: "#ffc800",
      softColor: "rgba(255, 200, 0, 0.16)",
      completed: countPracticeCompleted(practiceItems),
      total: practiceItems.length,
    },
  ];
}

function isListeningPart(part) {
  const partNumber = getPartNumber(part.id);
  return partNumber >= 1 && partNumber <= 4;
}

function isReadingPart(part) {
  const partNumber = getPartNumber(part.id);
  return partNumber >= 5;
}

function isSpeakingPart(part) {
  return /speaking|read-text-aloud|speak/i.test(`${part.id || ""} ${part.title || ""}`);
}

function isWritingPart(part) {
  return /writing|write|email|essay|respond/i.test(`${part.id || ""} ${part.title || ""}`);
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

function getTrackedPracticeItems() {
  const explicitPracticeItems = getExplicitPracticeItems();
  if (explicitPracticeItems.length) return explicitPracticeItems;

  return getCourseExercises("nghe-doc").map((item) => ({
    ...item,
    courseId: "nghe-doc",
  }));
}

function getExplicitPracticeItems() {
  return [];
}

function getCourse(courseId) {
  return activeCoursesById.get(courseId) || null;
}

function getPartNumber(partId) {
  const match = String(partId || "").match(/part-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function countCompleted(courseId, items) {
  return items.filter((item) => activeCompletedLessons.has(getCompletedLessonKey(item.courseId || courseId, item.id))).length;
}

function countPracticeCompleted(items) {
  const itemKeys = new Set(items.map((item) => getCompletedLessonKey(item.courseId || "practice", item.id)));
  const completedKeys = new Set();

  items.forEach((item) => {
    const key = getCompletedLessonKey(item.courseId || "practice", item.id);
    if (activeCompletedLessons.has(key)) completedKeys.add(key);
  });

  activeActivities.forEach((activity) => {
    if (!["practice-opened", "practice-completed"].includes(activity.type)) return;
    const key = getCompletedLessonKey(activity.courseId || "practice", activity.lessonId || activity.itemId);
    if (itemKeys.has(key)) completedKeys.add(key);
  });

  return completedKeys.size;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
