import { completeLesson, listenCompletedLessons, onUserChanged, getCompletedLessonKey, getTimerProgress, saveTimerProgress, clearTimerProgress } from "./user-service.js";

import "./data.js";
import "./nghe-doc-data.js";

(function () {
  const COMPLETION_MINUTES = 30;
  const params = new URLSearchParams(window.location.search);
  const courseId = params.get("course");
  const lessonId = params.get("lesson");
  const { courses } = window.TOIC_DATA;
  const course = courses.find((item) => item.id === courseId) || courses[0];
  const items = course.parts?.length ? course.parts.flatMap((part) => part.items) : course.lessons || [];
  const lesson = items.find((item) => item.id === lessonId && !item.isExercise) || items.find((item) => !item.isExercise) || items[0];
  const lessonNumber = items.filter((item) => !item.isExercise).findIndex((item) => item.id === lesson?.id) + 1;
  const breadcrumb = document.querySelector("#lesson-breadcrumb");
  const learning = document.querySelector("#lesson-learning");
  const completionKey = getCompletedLessonKey(course.id, lesson?.id);

  let activeUser = null;
  let hasCompletedLesson = false;
  let pendingCompletion = false;
  let timerTimeoutId = 0;
  let timerRunId = 0;
  let unsubscribeCompletedLessons = () => {};

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function youtubeEmbed(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.href);
      if (parsed.hostname.includes("youtu.be")) {
        return `https://www.youtube.com/embed/${parsed.pathname.replace("/", "")}`;
      }
      if (parsed.hostname.includes("youtube.com")) {
        const id = parsed.searchParams.get("v");
        if (id) return `https://www.youtube.com/embed/${id}`;
        if (parsed.pathname.startsWith("/embed/")) return parsed.href;
      }
    } catch (error) {
      return url;
    }
    return url;
  }

  const order = String(Math.max(lessonNumber, 1)).padStart(2, "0");
  const title = lesson?.title || "Lesson";
  const video = youtubeEmbed(lesson?.link || lesson?.video);
  const documentButton = lesson?.file
    ? `<a class="btn btn--primary" href="${escapeHtml(lesson.file)}" target="_blank" rel="noreferrer">Download</a>`
    : `<button class="btn btn--primary" type="button" disabled>Download</button>`;

  breadcrumb.innerHTML = `
    <a href="./hoc-phan.html">Home</a>
    <span>/</span>
    <a href="./hoc-phan.html">Course catalog</a>
    <span>/</span>
    <a href="./hoc-phan-chi-tiet.html?course=${encodeURIComponent(course.id)}">${escapeHtml(course.title)}</a>
    <span>/</span>
    <strong>${order}. ${escapeHtml(title)}</strong>
  `;

  learning.innerHTML = `
    <div class="lesson-detail-stack">
      <section class="lesson-hero-card">
        <div class="lesson-heading-row lesson-heading-row--simple">
          <h1>${escapeHtml(title)}</h1>
          <span id="lessonCompletionStatus" class="lesson-completion-status" hidden>Done</span>
        </div>

        <div class="lesson-video-shell">
          <div class="lesson-video-frame lesson-video-frame--centered">
            ${
              video
                ? `<iframe id="lessonVideoPlayer" src="${escapeHtml(video)}" title="${escapeHtml(title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
                : `<div class="video-empty">No video link for this lesson yet.</div>`
            }
          </div>

          <div id="lessonTimer" class="lesson-timer is-loading" aria-live="polite">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span id="lessonTimerText">Checking lesson progress...</span>
          </div>
        </div>
      </section>

      <section class="lesson-doc-card">
        <div>
          <p class="lesson-kicker">Documents</p>
          <h2>Lesson documents</h2>
        </div>
        ${documentButton}
      </section>
    </div>
  `;

  updateCompletionStatus();
  setupAuthSync();

  function setupAuthSync() {
    onUserChanged((user) => {
      const runId = resetTimerRun();
      activeUser = user;
      unsubscribeCompletedLessons();
      hasCompletedLesson = false;
      updateCompletionStatus();

      if (!user) {
        setTimerState("loading", "Waiting for sign-in...");
        return;
      }

      let savedElapsed = 0;
      let savedElapsedReady = false;
      let completedSnapshotReady = false;
      let timerStarted = false;

      function startWhenReady() {
        if (runId !== timerRunId || timerStarted || !savedElapsedReady || !completedSnapshotReady || hasCompletedLesson) return;
        timerStarted = true;
        startTimer(savedElapsed, runId);
      }

      getTimerProgress(user.uid, completionKey)
        .then((elapsed) => {
          if (runId !== timerRunId) return;
          savedElapsed = elapsed;
          savedElapsedReady = true;
          startWhenReady();
        })
        .catch(() => {
          if (runId !== timerRunId) return;
          savedElapsedReady = true;
          startWhenReady();
        });

      unsubscribeCompletedLessons = listenCompletedLessons(
        user.uid,
        (lessonIds) => {
          if (runId !== timerRunId) return;
          hasCompletedLesson = lessonIds.has(completionKey);
          completedSnapshotReady = true;
          updateCompletionStatus();
          startWhenReady();
          if (pendingCompletion) markLessonComplete();
        },
        (error) => {
          console.warn("Could not listen to completed lessons:", error);
          completedSnapshotReady = true;
          startWhenReady();
        }
      );
    });
  }

  function startTimer(savedElapsed, runId) {
    if (!lesson?.id) return;

    const timerText = document.querySelector("#lessonTimerText");
    if (!timerText) return;

    const totalSeconds = COMPLETION_MINUTES * 60;
    let elapsed = Math.min(savedElapsed || 0, totalSeconds);
    let lastSaved = elapsed;

    function tick() {
      if (runId !== timerRunId) return;

      if (hasCompletedLesson) {
        if (activeUser) clearTimerProgress(activeUser.uid, completionKey);
        updateCompletionStatus();
        return;
      }

      const secondsLeft = totalSeconds - elapsed;

      if (secondsLeft <= 0) {
        setTimerState("loading", "Completing lesson...");
        if (activeUser) clearTimerProgress(activeUser.uid, completionKey);
        markLessonComplete();
        return;
      }

      const mins = Math.floor(secondsLeft / 60);
      const secs = secondsLeft % 60;
      setTimerState("running", `Auto-complete in ${mins}:${String(secs).padStart(2, "0")}`);

      elapsed++;

      // Save to Firebase every 30 seconds to avoid excessive writes
      if (activeUser && elapsed - lastSaved >= 30) {
        lastSaved = elapsed;
        saveTimerProgress(activeUser.uid, completionKey, elapsed);
      }

      timerTimeoutId = setTimeout(tick, 1000);
    }

    tick();

    // Also save on page unload
    window.addEventListener("beforeunload", () => {
      if (activeUser && !hasCompletedLesson) {
        saveTimerProgress(activeUser.uid, completionKey, elapsed);
      }
    });
  }

  async function markLessonComplete() {
    if (hasCompletedLesson || !lesson?.id) return;
    if (!activeUser) {
      pendingCompletion = true;
      return;
    }

    pendingCompletion = false;

    try {
      const changed = await completeLesson(activeUser, {
        courseId: course.id,
        courseTitle: course.title,
        lessonId: lesson.id,
        lessonTitle: title,
      });
      if (changed) {
        hasCompletedLesson = true;
        updateCompletionStatus();
      }
    } catch (error) {
      console.warn("Could not complete lesson:", error);
    }
  }

  function updateCompletionStatus() {
    const status = document.querySelector("#lessonCompletionStatus");
    if (status) status.hidden = !hasCompletedLesson;
    if (hasCompletedLesson) {
      setTimerState("completed", "Lesson completed");
    }
  }

  function resetTimerRun() {
    timerRunId += 1;
    clearTimeout(timerTimeoutId);
    timerTimeoutId = 0;
    setTimerState("loading", "Checking lesson progress...");
    return timerRunId;
  }

  function setTimerState(state, text) {
    const timerEl = document.querySelector("#lessonTimer");
    const timerText = document.querySelector("#lessonTimerText");
    if (!timerEl || !timerText) return;

    timerEl.hidden = false;
    timerEl.classList.toggle("is-loading", state === "loading");
    timerEl.classList.toggle("is-running", state === "running");
    timerEl.classList.toggle("is-completed", state === "completed");
    timerText.textContent = text;
  }
})();
