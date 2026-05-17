import { renderCourseUnavailable, requireCourseAccess } from "./access-control.js";

(async function () {
  const access = await requireCourseAccess();
  if (!access.allowed) {
    renderCourseUnavailable();
    return;
  }

  const target = document.querySelector("#empty-tests");
  if (!target) return;

  target.innerHTML = `
    <article class="empty-page">
      <strong>No practice test data yet</strong>
      <p>This area is ready for practice sets after the test format and Azota links are finalized.</p>
    </article>
  `;
})();
