import { loadCourseSummaries } from "./course-service.js";
import { renderCourseUnavailable, requireCourseAccess } from "./access-control.js";

(async function () {
  const access = await requireCourseAccess();
  if (!access.allowed) {
    renderCourseUnavailable();
    return;
  }

  const courses = await loadCourseSummaries();
  const panels = document.querySelector("#course-panels");

  if (!courses.length) {
    renderCourseUnavailable();
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
