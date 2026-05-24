import { auth, db } from "./firebase-app.js";
import { collection, doc, getDoc, getDocs, setDoc, writeBatch, deleteDoc } from "firebase/firestore";
import { getIdToken } from "firebase/auth";
import { requireAdminAccess, renderCourseUnavailable } from "./access-control.js";

const formCourse = document.getElementById("form-course");
const formLesson = document.getElementById("form-lesson");
const selectCourse = document.getElementById("select-course");
const selectLesson = document.getElementById("select-lesson");
const partList = document.getElementById("part-list");
const inputPartTitle = document.getElementById("input-part-title");
const inputPartOrder = document.getElementById("input-part-order");
const inputNotifyNewLesson = document.getElementById("input-notify-new-lesson");
const mailStatus = document.getElementById("mail-status");
const workspace = document.getElementById("admin-workspace");
const toast = document.getElementById("toast");

let loadedCourses = [];
let loadedLessons = [];
let loadedParts = [];

(async function init() {
  const access = await requireAdminAccess();

  if (!access.allowed) {
    renderCourseUnavailable();
    return;
  }

  // Allow access
  workspace.style.display = "";

  await fetchCoursesForSelect();

  selectCourse.addEventListener("change", handleCourseSelectionChanged);
  selectLesson.addEventListener("change", handleLessonSelectionChanged);
  inputPartTitle.addEventListener("change", syncOrderFieldsFromPart);
  inputPartTitle.addEventListener("blur", syncOrderFieldsFromPart);
  formCourse.addEventListener("submit", handleCreateCourse);
  formLesson.addEventListener("submit", handleCreateLesson);

  const btnDeleteLesson = document.getElementById("btn-delete-lesson");
  if (btnDeleteLesson) {
    btnDeleteLesson.addEventListener("click", handleDeleteLesson);
  }
})();

function showToast(message, isError = false) {
  toast.textContent = message;
  if (isError) {
    toast.classList.add("error");
  } else {
    toast.classList.remove("error");
  }

  toast.classList.add("show");
  setTimeout(() => {
    toast.classList.remove("show");
  }, 3000);
}

async function fetchCoursesForSelect() {
  if (!db) return;
  try {
    const snap = await getDocs(collection(db, "courses"));
    loadedCourses = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Sort by order
    loadedCourses.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

    selectCourse.innerHTML = `<option value="">-- Chọn Khóa học --</option>` + loadedCourses.map(c => `<option value="${c.id}">${c.title}</option>`).join("");
  } catch (error) {
    console.error("Error fetching courses for admin:", error);
    showToast("Lỗi khi tải danh sách khóa học", true);
  }
}

async function handleCourseSelectionChanged() {
  const courseId = selectCourse.value;
  partList.innerHTML = "";
  inputPartTitle.value = "";
  selectLesson.innerHTML = `<option value="">-- Tạo Bài học Mới --</option>`;
  loadedLessons = [];
  loadedParts = [];
  resetLessonFields(courseId);

  if (!courseId) return;

  try {
    const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));

    loadedLessons = lessonsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    loadedLessons.sort(sortLessonsForAdmin);

    loadedParts = buildPartCatalog(getSelectedCourse(), loadedLessons);

    partList.innerHTML = loadedParts
      .map(part => `<option value="${escapeAttribute(part.title)}" label="${escapeAttribute(part.id)}">`)
      .join("");

    selectLesson.innerHTML = `<option value="">-- Tạo Bài học Mới --</option>` +
      loadedLessons.map(l => `<option value="${l.id}">${l.title}</option>`).join("");

  } catch (error) {
    console.error("Error fetching parts for course:", error);
  }
}

function handleLessonSelectionChanged() {
  const lessonId = selectLesson.value;
  const btnDelete = document.getElementById("btn-delete-lesson");
  const submitBtn = formLesson.querySelector("button[type='submit']");

  if (!lessonId) {
    // Reset form for new lesson
    resetLessonFields(selectCourse.value);
    if (btnDelete) btnDelete.style.display = "none";
    if (submitBtn) submitBtn.textContent = "Thêm Bài học";
    return;
  }

  const lesson = loadedLessons.find(l => l.id === lessonId);
  if (!lesson) return;

  formLesson.elements["lessonId"].value = lesson.id;
  formLesson.elements["title"].value = lesson.title || "";
  formLesson.elements["video"].value = lesson.video || "";
  formLesson.elements["file"].value = lesson.file || "";
  formLesson.elements["order"].value = lesson.order || 1;
  formLesson.elements["isExercise"].checked = lesson.isExercise || false;
  formLesson.elements["partTitle"].value = lesson.partTitle || findPartById(lesson.partId)?.title || "";
  inputPartOrder.value = lesson.partOrder || findPartById(lesson.partId)?.order || "";
  inputNotifyNewLesson.checked = Boolean(lesson.notifyNewLesson);
  updateMailStatus(lesson);

  if (btnDelete) btnDelete.style.display = "block";
  if (submitBtn) submitBtn.textContent = "Cập nhật Bài học";
}

async function handleCreateCourse(e) {
  e.preventDefault();
  const submitBtn = formCourse.querySelector("button[type='submit']");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.textContent;
    submitBtn.textContent = "Đang xử lý...";
  }

  const data = new FormData(formCourse);
  const id = data.get("id").trim();

  if (!id) {
    showToast("ID Khóa học không được để trống", true);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "Lưu Khóa học";
    }
    return;
  }

  const courseData = {
    title: data.get("title"),
    subtitle: data.get("subtitle") || "",
    color: data.get("color") || "#070711",
    order: Number(data.get("order")) || 0,
    published: true,
    hasParts: false // default false, will be inferred by course-service if parts exist
  };

  try {
    const courseRef = doc(db, "courses", id);
    await setDoc(courseRef, courseData, { merge: true }); // merge true so we can update existing

    showToast(`Đã lưu khóa học: ${courseData.title}`);
    formCourse.reset();

    // Refresh the dropdown
    await fetchCoursesForSelect();
    selectCourse.value = id; // select the newly created course
  } catch (error) {
    console.error("Error saving course:", error);
    showToast("Lỗi khi lưu khóa học", true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "Lưu Khóa học";
    }
  }
}

function slugify(text) {
  return text.toString().toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getSelectedCourse() {
  return loadedCourses.find(course => course.id === selectCourse.value) || null;
}

function sortLessonsForAdmin(a, b) {
  return (
    Number(a.partOrder || 0) - Number(b.partOrder || 0) ||
    Number(a.order || 0) - Number(b.order || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""))
  );
}

function resetLessonFields(courseId) {
  formLesson.elements["courseId"].value = courseId || "";
  formLesson.elements["lessonId"].value = "";
  formLesson.elements["title"].value = "";
  formLesson.elements["video"].value = "";
  formLesson.elements["file"].value = "";
  formLesson.elements["order"].value = 1;
  formLesson.elements["isExercise"].checked = false;
  formLesson.elements["partTitle"].value = "";
  inputPartOrder.value = "";
  inputNotifyNewLesson.checked = true;
  updateMailStatus(null);

  const btnDelete = document.getElementById("btn-delete-lesson");
  if (btnDelete) btnDelete.style.display = "none";

  const submitBtn = formLesson.querySelector("button[type='submit']");
  if (submitBtn) submitBtn.textContent = "Thêm Bài học";
}

function buildPartCatalog(course, lessons) {
  const partsById = new Map();
  const partsByTitle = new Map();

  function addPart(part = {}) {
    const title = String(part.title || part.partTitle || "").trim();
    const id = String(part.id || part.partId || "").trim();
    if (!title && !id) return;

    const normalized = {
      id: id || slugify(title),
      title: title || id,
      order: Number(part.order ?? part.partOrder ?? 0),
    };
    const existingByTitle = partsByTitle.get(normalizeKey(normalized.title));
    const existingById = partsById.get(normalized.id);
    const existing = existingById || existingByTitle;

    if (existing) {
      if (!existing.id && normalized.id) existing.id = normalized.id;
      if (!existing.title && normalized.title) existing.title = normalized.title;
      if (!existing.order && normalized.order) existing.order = normalized.order;
      partsById.set(existing.id, existing);
      partsByTitle.set(normalizeKey(existing.title), existing);
      return;
    }

    partsById.set(normalized.id, normalized);
    partsByTitle.set(normalizeKey(normalized.title), normalized);
  }

  (Array.isArray(course?.parts) ? course.parts : []).forEach(addPart);
  lessons.forEach((lesson) => {
    if (lesson.partId || lesson.partTitle) {
      addPart({
        id: lesson.partId,
        title: lesson.partTitle,
        order: lesson.partOrder,
      });
    }
  });

  return [...partsById.values()].sort((a, b) =>
    Number(a.order || 0) - Number(b.order || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""))
  );
}

function findPartById(partId) {
  const key = String(partId || "").trim();
  if (!key) return null;
  return loadedParts.find(part => part.id === key) || null;
}

function findPartByTitle(partTitle) {
  const inputKey = normalizeKey(partTitle);
  if (!inputKey) return null;

  const exact = loadedParts.find(part => normalizeKey(part.title) === inputKey || normalizeKey(part.id) === inputKey);
  if (exact) return exact;

  const range = inputKey.match(/questions? (\d+) (\d+)/);
  if (range) {
    const [, start, end] = range;
    const byQuestionRange = loadedParts.find((part) => {
      const titleKey = normalizeKey(part.title);
      return new RegExp(`questions? ${start} ${end}`).test(titleKey);
    });
    if (byQuestionRange) return byQuestionRange;
  }

  if (inputKey.length >= 6) {
    return loadedParts.find(part => normalizeKey(part.title).includes(inputKey)) || null;
  }

  return null;
}

function getNextPartOrder() {
  return loadedParts.reduce((maxOrder, part) => Math.max(maxOrder, Number(part.order || 0)), 0) + 1;
}

function getUniquePartId(partTitle) {
  const baseId = slugify(partTitle) || `part-${getNextPartOrder()}`;
  let candidate = baseId;
  let suffix = 2;

  while (loadedParts.some(part => part.id === candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function getNextLessonOrder(partId) {
  const normalizedPartId = String(partId || "").trim();
  return loadedLessons
    .filter(lesson => lesson.published !== false)
    .filter(lesson => String(lesson.partId || "").trim() === normalizedPartId)
    .reduce((maxOrder, lesson) => Math.max(maxOrder, Number(lesson.order || 0)), 0) + 1;
}

function syncOrderFieldsFromPart() {
  const partSelection = resolvePartSelection(getSelectedCourse(), inputPartTitle.value);
  if (partSelection.error) return;

  inputPartOrder.value = partSelection.partOrder || "";
  if (!selectLesson.value && !formLesson.elements["lessonId"].value) {
    formLesson.elements["order"].value = getNextLessonOrder(partSelection.partId);
  }
}

function clampOrder(value, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(number, max));
}

function samePart(lesson, partId) {
  return String(lesson?.partId || "").trim() === String(partId || "").trim();
}

function reorderParts(partSelection, requestedPartOrder) {
  if (!partSelection.partId) return [];

  const selectedPart = {
    id: partSelection.partId,
    title: partSelection.partTitle,
    order: Number(partSelection.partOrder || getNextPartOrder()),
  };
  const parts = loadedParts
    .filter(part => part.id !== selectedPart.id)
    .map(part => ({
      id: part.id,
      title: part.title,
      order: Number(part.order || 0),
    }))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.title || "").localeCompare(String(b.title || "")));

  const insertIndex = clampOrder(requestedPartOrder, 1, parts.length + 1) - 1;
  parts.splice(insertIndex, 0, selectedPart);
  return parts.map((part, index) => ({ ...part, order: index + 1 }));
}

function getReorderedLessonUpdates(targetLesson, requestedLessonOrder, partOrderById) {
  const targetPartId = String(targetLesson.partId || "").trim();
  const oldLesson = loadedLessons.find(lesson => lesson.id === targetLesson.id);
  const oldPartId = String(oldLesson?.partId || targetPartId).trim();
  const affectedPartIds = new Set([oldPartId, targetPartId]);
  const updates = new Map();

  affectedPartIds.forEach((partId) => {
    const rows = loadedLessons
      .filter(lesson => lesson.id !== targetLesson.id && samePart(lesson, partId))
      .filter(lesson => lesson.published !== false)
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0) || String(a.title || "").localeCompare(String(b.title || "")));

    if (partId === targetPartId) {
      const insertIndex = clampOrder(requestedLessonOrder, 1, rows.length + 1) - 1;
      rows.splice(insertIndex, 0, targetLesson);
    }

    rows.forEach((lesson, index) => {
      const order = index + 1;
      const partOrder = partOrderById.get(partId) ?? Number(lesson.partOrder || targetLesson.partOrder || 0);
      updates.set(lesson.id, {
        order,
        partOrder,
        globalOrder: getNextGlobalOrder(partOrder, order),
      });
    });
  });

  loadedLessons.forEach((lesson) => {
    if (updates.has(lesson.id)) return;
    const partId = String(lesson.partId || "").trim();
    if (!partOrderById.has(partId)) return;

    const partOrder = partOrderById.get(partId);
    if (Number(lesson.partOrder || 0) === partOrder) return;

    const order = Number(lesson.order || 0);
    updates.set(lesson.id, {
      partOrder,
      globalOrder: getNextGlobalOrder(partOrder, order),
    });
  });

  return updates;
}

function buildCoursePartsPayload(orderedParts, targetLesson) {
  const countByPart = new Map(orderedParts.map(part => [part.id, { lectures: 0, exams: 0 }]));
  const lessons = loadedLessons
    .filter(lesson => lesson.id !== targetLesson.id)
    .concat(targetLesson);

  lessons.forEach((lesson) => {
    if (lesson.published === false || !lesson.partId || !countByPart.has(lesson.partId)) return;
    const count = countByPart.get(lesson.partId);
    if (lesson.isExercise) {
      count.exams += 1;
    } else {
      count.lectures += 1;
    }
  });

  return orderedParts.map((part) => {
    const count = countByPart.get(part.id) || { lectures: 0, exams: 0 };
    return {
      id: part.id,
      title: part.title,
      order: part.order,
      lectures: count.lectures,
      exams: count.exams,
    };
  });
}

function updateMailStatus(lesson) {
  if (!mailStatus) return;

  if (!lesson) {
    mailStatus.textContent = "";
    return;
  }

  if (lesson.announcementStatus === "sent" || lesson.announcementStatus === "sent-with-errors") {
    const sentCount = Number(lesson.announcementSentCount || 0);
    const failedCount = Number(lesson.announcementFailedCount || 0);
    mailStatus.textContent = `Mail thông báo: đã gửi ${sentCount} email${failedCount ? `, lỗi ${failedCount}` : ""}.`;
    return;
  }

  if (lesson.announcementStatus === "queued") {
    mailStatus.textContent = "Mail thông báo: đã queue, worker sẽ gửi.";
    return;
  }

  if (lesson.notifyNewLesson) {
    mailStatus.textContent = "Mail thông báo: đang chờ gửi.";
    return;
  }

  mailStatus.textContent = "";
}

async function triggerLessonAnnouncement() {
  if (!inputNotifyNewLesson.checked) return null;

  try {
    if (!auth?.currentUser) throw new Error("Admin user is not signed in.");
    mailStatus.textContent = "Mail thông báo: đang gọi worker gửi...";
    const token = await getIdToken(auth.currentUser, true);
    const response = await fetch("/api/lesson-announcement", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    const sent = (result.announcements?.results || []).reduce((total, item) => total + Number(item.sent || 0), 0);
    const failed = (result.announcements?.results || []).reduce((total, item) => total + Number(item.failed || 0), 0);
    mailStatus.textContent = `Mail thông báo: đã xử lý, gửi ${sent} email${failed ? `, lỗi ${failed}` : ""}.`;
    return result;
  } catch (error) {
    console.warn("Could not trigger lesson announcement worker:", error);
    mailStatus.textContent = "Mail thông báo: đã đánh dấu gửi; cron sẽ xử lý nếu worker local không chạy.";
    return null;
  }
}

function resolvePartSelection(course, rawPartTitle) {
  const partTitle = String(rawPartTitle || "").trim();
  const courseHasParts = Boolean(course?.hasParts || course?.parts?.length || loadedParts.length);

  if (!partTitle) {
    if (courseHasParts) {
      return { error: "Vui long chon part truoc khi luu bai hoc." };
    }
    return { partId: "", partTitle: "", partOrder: 0 };
  }

  const existingPart = findPartByTitle(partTitle);
  if (existingPart) {
    return {
      partId: existingPart.id,
      partTitle: existingPart.title,
      partOrder: Number(existingPart.order || 0),
      isNewPart: false,
    };
  }

  const nextPartOrder = getNextPartOrder();

  return {
    partId: getUniquePartId(partTitle),
    partTitle,
    partOrder: nextPartOrder,
    isNewPart: true,
  };
}

function getNextGlobalOrder(partOrder, order) {
  if (!partOrder) return Number(order || 0);
  return (Number(partOrder) - 1) * 10000 + Number(order || 0);
}

async function refreshCoursePartMetadata(courseId, selectedPart = null) {
  const courseRef = doc(db, "courses", courseId);
  const courseSnap = await getDoc(courseRef);
  const courseData = courseSnap.exists() ? courseSnap.data() : {};
  const partsById = new Map();
  const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
  const courseTotals = { lectures: 0, exams: 0 };

  function addPartMeta(part = {}) {
    const id = String(part.id || part.partId || "").trim();
    const title = String(part.title || part.partTitle || "").trim();
    if (!id && !title) return;

    const partId = id || slugify(title);
    const existing = partsById.get(partId) || {};
    partsById.set(partId, {
      id: partId,
      title: existing.title || title || partId,
      order: Number(existing.order || part.order || part.partOrder || 0),
      lectures: Number(existing.lectures || part.lectures || 0),
      exams: Number(existing.exams || part.exams || 0),
    });
  }

  (Array.isArray(courseData.parts) ? courseData.parts : []).forEach(addPartMeta);
  loadedParts.forEach(addPartMeta);
  if (selectedPart?.partId) {
    addPartMeta({
      id: selectedPart.partId,
      title: selectedPart.partTitle,
      order: selectedPart.partOrder,
    });
  }

  const publishedLessons = lessonsSnap.docs
    .map((lessonDoc) => lessonDoc.data())
    .filter((lesson) => lesson.published !== false);

  publishedLessons.forEach((lesson) => {
    if (lesson.isExercise) {
      courseTotals.exams += 1;
    } else {
      courseTotals.lectures += 1;
    }

    if (lesson.partId || lesson.partTitle) {
      addPartMeta({
        id: lesson.partId,
        title: lesson.partTitle,
        order: lesson.partOrder,
      });
    }
  });

  if (!partsById.size) {
    await setDoc(
      courseRef,
      {
        hasParts: false,
        parts: [],
        lectures: courseTotals.lectures,
        exams: courseTotals.exams,
      },
      { merge: true }
    );
    return;
  }

  const counts = new Map([...partsById.keys()].map(partId => [partId, { lectures: 0, exams: 0 }]));

  publishedLessons.forEach((lesson) => {
    if (!lesson.partId) return;
    if (!counts.has(lesson.partId)) {
      counts.set(lesson.partId, { lectures: 0, exams: 0 });
    }
    const item = counts.get(lesson.partId);
    if (lesson.isExercise) {
      item.exams += 1;
    } else {
      item.lectures += 1;
    }
  });

  const updatedParts = [...partsById.values()].sort((a, b) =>
    Number(a.order || 0) - Number(b.order || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""))
  ).map((part, index) => {
    const count = counts.get(part.id) || { lectures: 0, exams: 0 };
    return {
      ...part,
      order: Number(part.order ?? index + 1),
      lectures: count.lectures,
      exams: count.exams,
    };
  });

  await setDoc(
    courseRef,
    {
      hasParts: true,
      parts: updatedParts,
      lectures: courseTotals.lectures,
      exams: courseTotals.exams,
    },
    { merge: true }
  );
}

async function saveLessonWithOrdering(courseId, lessonId, lessonData, partSelection) {
  const courseRef = doc(db, "courses", courseId);
  const lessonsCol = collection(db, "courses", courseId, "lessons");
  const lessonRef = lessonId ? doc(lessonsCol, lessonId) : doc(lessonsCol);
  const savedLessonId = lessonRef.id;
  const requestedPartOrder = Number(inputPartOrder.value) || partSelection.partOrder || getNextPartOrder();
  const orderedParts = partSelection.partId ? reorderParts(partSelection, requestedPartOrder) : [];
  const partOrderById = new Map(orderedParts.map(part => [part.id, Number(part.order || 0)]));
  const finalPartOrder = partOrderById.get(partSelection.partId) ?? Number(partSelection.partOrder || 0);
  const requestedLessonOrder = Number(formLesson.elements["order"].value) || getNextLessonOrder(partSelection.partId);
  const targetLesson = {
    ...(loadedLessons.find(lesson => lesson.id === savedLessonId) || {}),
    id: savedLessonId,
    ...lessonData,
    partId: partSelection.partId,
    partTitle: partSelection.partTitle,
    partOrder: finalPartOrder,
  };
  const lessonUpdates = getReorderedLessonUpdates(targetLesson, requestedLessonOrder, partOrderById);
  const targetUpdate = lessonUpdates.get(savedLessonId) || {
    order: requestedLessonOrder,
    partOrder: finalPartOrder,
    globalOrder: getNextGlobalOrder(finalPartOrder, requestedLessonOrder),
  };
  const batch = writeBatch(db);

  if (orderedParts.length) {
    batch.set(
      courseRef,
      {
        hasParts: true,
        parts: buildCoursePartsPayload(orderedParts, targetLesson),
      },
      { merge: true }
    );
  }

  lessonUpdates.forEach((update, id) => {
    const targetRef = id === savedLessonId ? lessonRef : doc(lessonsCol, id);
    const payload = id === savedLessonId
      ? {
          ...lessonData,
          id: savedLessonId,
          partOrder: update.partOrder,
          order: update.order,
          globalOrder: update.globalOrder,
        }
      : update;

    batch.set(targetRef, payload, { merge: true });
  });

  if (!lessonUpdates.has(savedLessonId)) {
    batch.set(
      lessonRef,
      {
        ...lessonData,
        id: savedLessonId,
        ...targetUpdate,
      },
      { merge: true }
    );
  }

  await batch.commit();

  await refreshCoursePartMetadata(courseId, partSelection.partId ? {
    ...partSelection,
    partOrder: finalPartOrder,
  } : null);

  return {
    lessonId: savedLessonId,
    partOrder: finalPartOrder,
    order: targetUpdate.order,
  };
}

async function handleCreateLesson(e) {
  e.preventDefault();
  const submitBtn = formLesson.querySelector("button[type='submit']");
  const btnDelete = document.getElementById("btn-delete-lesson");
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.textContent;
    submitBtn.textContent = "Đang xử lý...";
  }
  if (btnDelete) {
    btnDelete.disabled = true;
  }

  const data = new FormData(formLesson);

  const courseId = data.get("courseId");
  if (!courseId) {
    showToast("Vui lòng chọn khóa học", true);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "Thêm Bài học";
    }
    if (btnDelete) btnDelete.disabled = false;
    return;
  }

  const course = getSelectedCourse();
  const partSelection = resolvePartSelection(course, data.get("partTitle"));
  if (partSelection.error) {
    showToast(partSelection.error, true);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "Thêm Bài học";
    }
    if (btnDelete) btnDelete.disabled = false;
    return;
  }

  let lessonId = (data.get("lessonId") || "").toString().trim();
  const wasNewLesson = !lessonId;
  const shouldNotifyNewLesson = inputNotifyNewLesson.checked;

  const lessonData = {
    title: data.get("title"),
    video: data.get("video") || "",
    file: data.get("file") || "",
    isExercise: data.get("isExercise") === "on",
    partTitle: partSelection.partTitle,
    partId: partSelection.partId,
    partOrder: partSelection.partOrder,
    notifyNewLesson: shouldNotifyNewLesson,
    published: true,
  };

  try {
    const saveResult = await saveLessonWithOrdering(courseId, lessonId, lessonData, partSelection);
    lessonId = saveResult.lessonId;

    if (partSelection.partTitle) {
      const safeSelector = `option[value="${partSelection.partTitle.replace(/"/g, '\\"')}"]`;
      if (!partList.querySelector(safeSelector)) {
        const option = document.createElement("option");
        option.value = partSelection.partTitle;
        partList.appendChild(option);
      }
    }

    let notificationMessage = "";
    if (shouldNotifyNewLesson) {
      await triggerLessonAnnouncement();
      notificationMessage = mailStatus?.textContent || "";
    }

    showToast(`Đã lưu bài học: ${lessonData.title}`);

    // Refresh the lessons dropdown to show the newly added/edited lesson
    await handleCourseSelectionChanged();
    if (notificationMessage && mailStatus) {
      mailStatus.textContent = notificationMessage;
    }

    // Reset specific fields only to make entering multiple lessons faster (only if it was a new addition)
    if (wasNewLesson) {
      formLesson.elements["title"].value = "";
      formLesson.elements["video"].value = "";
      formLesson.elements["lessonId"].value = "";
      formLesson.elements["partTitle"].value = partSelection.partTitle;
      inputPartOrder.value = saveResult.partOrder || "";
      formLesson.elements["order"].value = getNextLessonOrder(partSelection.partId); // Auto increment order

      formLesson.elements["title"].focus();
    } else {
      selectLesson.value = lessonId; // keep it selected if we just updated it
      handleLessonSelectionChanged();
    }
  } catch (error) {
    console.error("Error saving lesson:", error);
    showToast("Lỗi: " + (error.message || "Không xác định"), true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || "Thêm Bài học";
    }
    if (btnDelete) {
      btnDelete.disabled = false;
    }
  }
}

async function handleDeleteLesson() {
  const courseId = selectCourse.value;
  const lessonId = selectLesson.value;

  if (!courseId || !lessonId) {
    showToast("Vui lòng chọn khóa học và bài học cần xóa", true);
    return;
  }

  const lesson = loadedLessons.find(l => l.id === lessonId);
  if (!lesson) return;

  const confirmDelete = confirm(`Bạn có chắc chắn muốn xóa bài học "${lesson.title}" không?`);
  if (!confirmDelete) return;

  const btnDelete = document.getElementById("btn-delete-lesson");
  const submitBtn = formLesson.querySelector("button[type='submit']");

  if (btnDelete) btnDelete.disabled = true;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const lessonRef = doc(db, "courses", courseId, "lessons", lessonId);
    await deleteDoc(lessonRef);

    showToast(`Đã xóa bài học: ${lesson.title}`);

    // Refresh course metadata
    await refreshCoursePartMetadata(courseId, {
      partId: lesson.partId,
      partTitle: lesson.partTitle,
      partOrder: lesson.partOrder
    });

    // Refresh the lessons list
    await handleCourseSelectionChanged();

    // Reset fields
    resetLessonFields(courseId);
  } catch (error) {
    console.error("Error deleting lesson:", error);
    showToast("Lỗi khi xóa bài học: " + (error.message || "Không xác định"), true);
  } finally {
    if (btnDelete) btnDelete.disabled = false;
    if (submitBtn) submitBtn.disabled = false;
  }
}
