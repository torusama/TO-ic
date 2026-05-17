import { db } from "./firebase-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import "./data.js";
import "./nghe-doc-data.js";

export async function loadCourseSummaries() {
  const fallbackCourses = getStaticCourses();
  if (!db) return fallbackCourses;

  try {
    const snapshot = await getDocs(collection(db, "courses"));
    const courses = snapshot.docs
      .map((docSnap) => normalizeCourseSummary(docSnap.id, docSnap.data()))
      .filter((course) => course.published !== false)
      .sort(sortByOrderThenTitle);

    return courses.length ? courses : fallbackCourses;
  } catch (error) {
    console.warn("Could not load Firestore course summaries; using bundled data:", error);
    return fallbackCourses;
  }
}

export async function loadCourseWithLessons(courseId) {
  const fallbackCourses = getStaticCourses();
  const fallbackCourse = fallbackCourses.find((course) => course.id === courseId) || fallbackCourses[0] || null;
  if (!db) return fallbackCourse;

  try {
    const selectedId = courseId || fallbackCourse?.id;
    if (!selectedId) return fallbackCourse;

    const courseSnap = await getDoc(doc(db, "courses", selectedId));
    if (!courseSnap.exists()) return fallbackCourse;

    const lessonsSnap = await getDocs(collection(db, "courses", selectedId, "lessons"));
    const lessonItems = lessonsSnap.docs
      .map((docSnap) => normalizeLesson(docSnap.id, docSnap.data()))
      .filter((lesson) => lesson.published !== false)
      .sort(sortByGlobalThenPartThenOrder);

    return buildCourseWithLessons(normalizeCourseSummary(courseSnap.id, courseSnap.data()), lessonItems);
  } catch (error) {
    console.warn("Could not load Firestore course detail; using bundled data:", error);
    return fallbackCourse;
  }
}

export function getStaticCourses() {
  return window.TOIC_DATA?.courses || [];
}

function buildCourseWithLessons(course, lessonItems) {
  const hasParts = Boolean(course.hasParts || course.parts?.length);
  const lessons = lessonItems.filter((item) => !item.isExercise);

  if (!hasParts) {
    return {
      ...course,
      parts: [],
      lessons,
    };
  }

  const partsById = new Map();
  (course.parts || []).forEach((part, index) => {
    partsById.set(part.id, {
      id: part.id,
      title: part.title || "Lessons",
      lectures: Number(part.lectures || 0),
      exams: Number(part.exams || 0),
      order: Number(part.order ?? index),
      items: [],
    });
  });

  lessonItems.forEach((item) => {
    const partId = item.partId || "default";
    if (!partsById.has(partId)) {
      partsById.set(partId, {
        id: partId,
        title: item.partTitle || "Lessons",
        lectures: 0,
        exams: 0,
        order: Number(item.partOrder || 0),
        items: [],
      });
    }
    partsById.get(partId).items.push(item);
  });

  const parts = [...partsById.values()]
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((part) => ({
      ...part,
      items: part.items.sort(sortByOrderThenTitle),
      lectures: part.lectures || part.items.filter((item) => !item.isExercise).length,
      exams: part.exams || part.items.filter((item) => item.isExercise).length,
    }));

  return {
    ...course,
    parts,
    lessons,
  };
}

function normalizeCourseSummary(id, data = {}) {
  return {
    id,
    title: data.title || "TOEIC Course",
    subtitle: data.subtitle || "",
    badge: data.badge || "",
    tag: data.tag || "",
    color: data.color || "#ef1d52",
    image: data.image || "",
    lectures: Number(data.lectures || 0),
    exams: Number(data.exams || 0),
    order: Number(data.order || 0),
    published: data.published !== false,
    hasParts: Boolean(data.hasParts),
    parts: normalizeParts(data.parts),
  };
}

function normalizeParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((part) => part?.id)
    .map((part, index) => ({
      id: part.id,
      title: part.title || "",
      lectures: Number(part.lectures || 0),
      exams: Number(part.exams || 0),
      order: Number(part.order ?? index),
    }));
}

function normalizeLesson(id, data = {}) {
  return {
    id,
    ...data,
    isExercise: Boolean(data.isExercise),
    lectures: Number(data.lectures || 0),
    docs: Number(data.docs || 0),
    questions: Number(data.questions || 0),
    score: Number(data.score || 0),
    order: Number(data.order || 0),
    partOrder: Number(data.partOrder || 0),
    globalOrder: Number(data.globalOrder || data.order || 0),
  };
}

function sortByOrderThenTitle(a, b) {
  return Number(a.order || 0) - Number(b.order || 0) || String(a.title || "").localeCompare(String(b.title || ""));
}

function sortByGlobalThenPartThenOrder(a, b) {
  return (
    Number(a.globalOrder || 0) - Number(b.globalOrder || 0) ||
    Number(a.partOrder || 0) - Number(b.partOrder || 0) ||
    Number(a.order || 0) - Number(b.order || 0) ||
    String(a.title || "").localeCompare(String(b.title || ""))
  );
}
