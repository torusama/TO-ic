import { loadCourseSummaries } from "./course-service.js";

(async function () {
  const courses = await loadCourseSummaries();
  const panels = document.querySelector("#course-panels");

  if (!courses.length) {
    panels.innerHTML = `
      <article class="empty-page">
        <strong>Course data is not available yet.</strong>
        <p>Please sign in again or try refreshing the page.</p>
      </article>
    `;
    return;
  }

  panels.innerHTML = courses
    .map(
      (course) => `
        <a class="course-card" href="./hoc-phan-chi-tiet.html?course=${course.id}">
          <span class="course-thumb" style="--course-color: ${course.color}">
            <span class="course-title-art">TOEIC<br /><strong>Prep</strong></span>
            <span class="course-tag">${course.tag}</span>
          </span>
          <strong>${course.title}</strong>
          <span>${course.lectures} lessons / ${course.exams} online tests</span>
        </a>
      `
    )
    .join("");
})();
