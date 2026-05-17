const vocabParts = [
  {
    title: "TUYỂN CHỌN KỸ LƯỠNG 1500 TỪ VỰNG TOEIC THƯỜNG XUYÊN THI",
    description: "Chắt lọc 1500 Từ vựng thường xuyên gặp và thi TOEIC trong 2 năm gần nhất theo 3 cấp độ Ưu tiên [ Ưu tiên 1 là CAO nhất ]",
    items: createPriorityVocabularyLessons(30),
  },
  {
    title: "1600 TỪ VỰNG TRỌNG ĐIỂM - THEO XU HƯỚNG RA ĐỀ NĂM 2026",
    description: "Chắt lọc Từ các đề thi thử và đề thi thực tế năm 2026",
  },
  {
    title: "1000 TỪ VỰNG TRỌNG ĐIỂM - THEO XU HƯỚNG RA ĐỀ THI MỚI NHẤT",
    description: "Từ vựng được trích từ các đề thi thực tế, các đề thi thử sát đề thi thật - theo xu hướng ra đề 2025",
  },
  {
    title: "1000 TỪ VỰNG NÂNG CAO MỤC TIÊU 850-990 ĐIỂM",
    description: "Chắt lọc 1000 từ vựng nâng cao với 2 giọng đọc Nam - Nữ dành cho các em có mục tiêu trên 850 điểm",
  },
  {
    title: "Từ vựng Toeic - Nghe Hiểu",
    description: "10 chuyên đề",
  },
  {
    title: "Từ vựng Toeic - Đọc Hiểu",
    description: "16 chuyên đề",
  },
  {
    title: "Từ vựng TOEIC part 7",
    description: "7 chuyên đề",
  },
  {
    title: "Từ vựng theo chủ đề",
    description: "11 chủ đề",
  },
];

(function () {
  const target = document.querySelector("#vocabParts");
  if (!target) return;

  target.innerHTML = `<div class="part-panels">${vocabParts.map(renderVocabPart).join("")}</div>`;

  target.querySelectorAll("[data-toggle-vocab]").forEach((toggle) => {
    const card = toggle.closest("[data-part-card]");
    toggle.addEventListener("click", () => {
      const next = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(next));
      card.classList.toggle("is-collapsed", !next);
    });
  });
})();

function renderVocabPart(part, index) {
  const items = part.items || [];

  return `
    <article class="content-card course-list-card" data-part-card>
      <button class="list-header list-header--button" type="button" data-toggle-vocab aria-expanded="true">
        <span>
          <span class="eyebrow">PART ${index + 1}</span>
          <strong class="part-title">${escapeHtml(part.title)}</strong>
          <span>${escapeHtml(part.description)}</span>
        </span>
      </button>
      <div class="lesson-list-wrap" data-lesson-list>
        <div class="timeline-list timeline-list--compact">
          ${items.map(renderVocabRow).join("")}
        </div>
      </div>
    </article>
  `;
}

function createPriorityVocabularyLessons(count) {
  return Array.from({ length: count }, (_, index) => ({
    title: `[ƯU TIÊN 1] 700 TỪ VỰNG QUAN TRỌNG NHẤT - DAY ${index + 1}`,
    questions: 50,
  }));
}

function renderVocabRow(item, index) {
  return `
    <div class="timeline-row">
      <span class="timeline-index">${String(index + 1).padStart(2, "0")}</span>
      <span class="row-main">
        <strong><span class="row-title-link is-disabled">${escapeHtml(item.title)}</span></strong>
        <small>${Number(item.questions || 0)} câu hỏi</small>
      </span>
      <span class="row-action"></span>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
