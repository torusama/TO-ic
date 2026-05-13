import { getCompletedLessonKey, listenCompletedLessons, onUserChanged } from "./user-service.js";

import "./data.js";
import "./nghe-doc-data.js";

(function () {
  const params = new URLSearchParams(window.location.search);
  const courseId = params.get("course");
  const { courses } = window.TOIC_DATA;
  const course = courses.find((item) => item.id === courseId) || courses[0];
  const breadcrumb = document.querySelector("#course-breadcrumb");
  const detail = document.querySelector("#course-detail");
  let completedLessons = new Set();
  let unsubscribeCompletedLessons = () => {};

  const parts = course.parts?.length
    ? course.parts
    : [
        {
          id: "default",
          title: course.title,
          lectures: course.lessons?.length || 0,
          exams: course.exams || 0,
          items: course.lessons || [],
        },
      ];

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function metaFor(item) {
    if (item.isExercise) {
      return `${item.docs || 0} docs`;
    }
    const docs = item.docs || 0;
    return `${item.lectures || 1} lessons${docs ? ` / ${docs} docs` : ""}`;
  }

  function lessonUrl(item) {
    return `./bai-hoc.html?course=${encodeURIComponent(course.id)}&lesson=${encodeURIComponent(item.id)}`;
  }

  function renderTitle(item) {
    const title = escapeHtml(item.title);
    if (item.isExercise) {
      if (!item.link) return `<span class="row-title-link is-disabled">${title}</span>`;
      return `<a class="row-title-link" href="${escapeHtml(item.link)}" target="_blank" rel="noreferrer">${title}</a>`;
    }
    return `<a class="row-title-link" href="${lessonUrl(item)}">${title}</a>`;
  }

  function renderAction(item) {
    if (item.isExercise) {
      if (!item.file) {
        return `<button class="download-mini" type="button" disabled>Download</button>`;
      }
      return `<a class="download-mini" href="${escapeHtml(item.file)}" target="_blank" rel="noreferrer">Download</a>`;
    }
    if (completedLessons.has(getCompletedLessonKey(course.id, item.id))) return `<span class="row-done">Done</span>`;
    return "";
  }

  function renderRow(item, index) {
    return `
      <div class="timeline-row ${item.isExercise ? "is-exercise" : ""}">
        <span class="timeline-index">${String(index + 1).padStart(2, "0")}</span>
        <span class="row-main">
          <strong>${renderTitle(item)}</strong>
          <small>${metaFor(item)}</small>
        </span>
        <span class="row-action">${renderAction(item)}</span>
      </div>
    `;
  }

  function renderPart(part, index) {
    return `
      <article class="content-card course-list-card" data-part-card>
      <button class="list-header list-header--button" type="button" data-toggle-lessons aria-expanded="true">
          <span>
            <span class="eyebrow">PART ${index + 1}</span>
            <strong class="part-title">${escapeHtml(part.title)}</strong>
            <span>${part.lectures || 0} lessons / ${part.exams || 0} online tests</span>
          </span>
      </button>
      <div class="lesson-list-wrap" data-lesson-list>
        <div class="timeline-list">
          ${part.items.map((item, itemIndex) => renderRow(item, itemIndex)).join("")}
        </div>
      </div>
      </article>
    `;
  }

  function renderPage() {
    breadcrumb.innerHTML = `
      <a href="./hoc-phan.html">Home</a>
      <span>/</span>
      <a href="./hoc-phan.html">Course catalog</a>
      <span>/</span>
      <strong>${escapeHtml(course.title)}</strong>
    `;

    detail.innerHTML = `<div class="part-panels">${parts.map(renderPart).join("")}</div>`;

    detail.querySelectorAll("[data-toggle-lessons]").forEach((toggle) => {
      const card = toggle.closest("[data-part-card]");
      toggle.addEventListener("click", () => {
        const next = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(next));
        card.classList.toggle("is-collapsed", !next);
      });
    });
  }

  renderPage();

  onUserChanged((user) => {
    unsubscribeCompletedLessons();
    completedLessons = new Set();
    renderPage();

    if (!user) return;
    unsubscribeCompletedLessons = listenCompletedLessons(
      user.uid,
      (lessonIds) => {
        completedLessons = lessonIds;
        renderPage();
      },
      (error) => console.warn("Could not listen to completed lessons:", error)
    );
  });
})();
