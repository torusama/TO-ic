import "./data.js";
import "./nghe-doc-data.js";

(function () {
  const { courses } = window.TOIC_DATA;
  const panels = document.querySelector("#course-panels");

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
