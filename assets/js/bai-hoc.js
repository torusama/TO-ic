import { completeLesson, listenCompletedLessons, onUserChanged, getCompletedLessonKey, getTimerProgress, saveTimerProgress, clearTimerProgress, recordLessonActivity } from "./user-service.js";

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
  let youtubeApiPromise = null;
  let lessonOpenRecorded = false;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function youtubeEmbed(url) {
    if (!url) return { src: "", isYouTube: false };
    try {
      const parsed = new URL(url, window.location.href);
      let videoId = "";
      if (parsed.hostname.includes("youtu.be")) {
        videoId = parsed.pathname.replace("/", "");
      }
      if (parsed.hostname.includes("youtube.com")) {
        videoId = parsed.searchParams.get("v") || parsed.pathname.replace("/embed/", "");
      }

      if (videoId) {
        const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
        embedUrl.searchParams.set("enablejsapi", "1");
        embedUrl.searchParams.set("origin", window.location.origin);
        embedUrl.searchParams.set("playsinline", "1");
        return { src: embedUrl.href, isYouTube: true };
      }
    } catch (error) {
      return { src: url, isYouTube: false };
    }
    return { src: url, isYouTube: false };
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
              video.src
                ? `<iframe id="lessonVideoPlayer" src="${escapeHtml(video.src)}" title="${escapeHtml(title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
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

      if (!lessonOpenRecorded) {
        lessonOpenRecorded = true;
        recordLessonActivity(user, {
          type: "lesson-opened",
          title: "Lesson opened",
          body: title,
          courseId: course.id,
          courseTitle: course.title,
          lessonId: lesson?.id,
          lessonTitle: title,
        }).catch((error) => {
          console.warn("Could not record lesson activity:", error);
        });
      }

      let savedProgress = { elapsed: 0, videoTime: 0 };
      let savedProgressReady = false;
      let completedSnapshotReady = false;
      let timerStarted = false;

      function startWhenReady() {
        if (runId !== timerRunId || timerStarted || !savedProgressReady || !completedSnapshotReady || hasCompletedLesson) return;
        timerStarted = true;
        startTimer(savedProgress, runId);
      }

      getTimerProgress(user.uid, completionKey)
        .then((progress) => {
          if (runId !== timerRunId) return;
          savedProgress = normalizeProgress(progress);
          savedProgressReady = true;
          startWhenReady();
        })
        .catch(() => {
          if (runId !== timerRunId) return;
          savedProgressReady = true;
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

  function startTimer(savedProgress, runId) {
    if (!lesson?.id) return;

    const timerText = document.querySelector("#lessonTimerText");
    if (!timerText) return;

    const totalSeconds = COMPLETION_MINUTES * 60;
    let elapsed = Math.min(savedProgress.elapsed || 0, totalSeconds);
    let videoTime = Math.max(savedProgress.videoTime || 0, 0);
    let lastSaved = elapsed;
    let lastSavedVideoTime = videoTime;
    let isPlaying = false;
    let player = null;

    if (!video.src) {
      setTimerState("loading", "Video is not ready yet.");
      return;
    }

    showRemaining("paused", elapsed);

    if (!video.isYouTube) {
      setTimerState("loading", "Play tracking is only available for YouTube videos.");
      return;
    }

    setupYouTubePlayer(runId)
      .then((readyPlayer) => {
        if (runId !== timerRunId) return;
        player = readyPlayer;
        const currentTime = getPlayerTime(player);
        if (videoTime > 2 && currentTime < 2) {
          player.seekTo(videoTime, true);
        } else if (currentTime > videoTime) {
          videoTime = currentTime;
        }

        const state = player.getPlayerState?.();
        isPlaying = state === window.YT?.PlayerState?.PLAYING;
        if (isPlaying) {
          scheduleTick();
        } else {
          showRemaining("paused", elapsed);
        }
      })
      .catch((error) => {
        console.warn("Could not initialize YouTube tracking:", error);
        setTimerState("loading", "Could not connect video tracking.");
      });

    function tick() {
      if (runId !== timerRunId) return;
      if (!isPlaying) return;

      if (hasCompletedLesson) {
        saveNow();
        if (activeUser) clearTimerProgress(activeUser.uid, completionKey);
        updateCompletionStatus();
        return;
      }

      elapsed++;
      videoTime = getPlayerTime(player);

      if (elapsed >= totalSeconds) {
        setTimerState("loading", "Completing lesson...");
        saveNow();
        markLessonComplete();
        return;
      }

      showRemaining("running", elapsed);

      // Save often enough that refreshing or leaving the page does not reset progress.
      if (activeUser && (elapsed - lastSaved >= 5 || Math.abs(videoTime - lastSavedVideoTime) >= 5)) {
        lastSaved = elapsed;
        lastSavedVideoTime = videoTime;
        saveNow();
      }

      scheduleTick();
    }

    function scheduleTick() {
      clearTimeout(timerTimeoutId);
      timerTimeoutId = setTimeout(tick, 1000);
    }

    function handlePlayerState(state) {
      if (runId !== timerRunId) return;
      const ytState = window.YT?.PlayerState || {};
      const nextIsPlaying = state === ytState.PLAYING;

      if (!nextIsPlaying) {
        isPlaying = false;
        clearTimeout(timerTimeoutId);
        videoTime = getPlayerTime(player);
        saveNow();
        if (!hasCompletedLesson) showRemaining("paused", elapsed);
        return;
      }

      isPlaying = true;
      videoTime = getPlayerTime(player);
      showRemaining("running", elapsed);
      scheduleTick();
    }

    function setupYouTubePlayer(runId) {
      const iframe = document.querySelector("#lessonVideoPlayer");
      if (!iframe) return Promise.reject(new Error("Lesson video iframe is missing."));

      return loadYouTubeApi().then(
        (YT) =>
          new Promise((resolve) => {
            if (runId !== timerRunId) return;
            const instance = new YT.Player(iframe, {
              events: {
                onReady: (event) => resolve(event.target),
                onStateChange: (event) => handlePlayerState(event.data),
              },
            });
            player = instance;
          })
      );
    }


    function showRemaining(state, watchedSeconds) {
      const secondsLeft = Math.max(totalSeconds - watchedSeconds, 0);
      const mins = Math.floor(secondsLeft / 60);
      const secs = secondsLeft % 60;
      const label = state === "running" ? "Auto-complete in" : "Paused - resume video to complete in";
      setTimerState(state, `${label} ${mins}:${String(secs).padStart(2, "0")}`);
    }

    function saveNow() {
      if (!activeUser || hasCompletedLesson) return;
      saveTimerProgress(activeUser.uid, completionKey, {
        elapsed,
        videoTime: getPlayerTime(player) || videoTime,
      });
    }

    // Also save on pause, refresh, tab close, and mobile browser backgrounding.
    window.addEventListener("beforeunload", () => {
      saveNow();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) saveNow();
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
        await clearTimerProgress(activeUser.uid, completionKey);
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

  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (youtubeApiPromise) return youtubeApiPromise;

    youtubeApiPromise = new Promise((resolve, reject) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve(window.YT);
      };

      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.async = true;
        script.onerror = () => reject(new Error("YouTube iframe API failed to load."));
        document.head.appendChild(script);
      }
    });

    return youtubeApiPromise;
  }

  function getPlayerTime(player) {
    try {
      return Number(player?.getCurrentTime?.() || 0);
    } catch (_) {
      return 0;
    }
  }

  function normalizeProgress(progress) {
    if (typeof progress === "number") return { elapsed: progress, videoTime: 0 };
    return {
      elapsed: Number(progress?.elapsed || 0),
      videoTime: Number(progress?.videoTime || 0),
    };
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
    timerEl.classList.toggle("is-paused", state === "paused");
    timerEl.classList.toggle("is-completed", state === "completed");
    timerText.textContent = text;
  }
})();
