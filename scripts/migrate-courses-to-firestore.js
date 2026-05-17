const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const admin = require("firebase-admin");

const serviceAccountPath =
  process.argv[2] ||
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (!serviceAccountPath) {
  console.error("Usage: node scripts/migrate-courses-to-firestore.js <firebase-service-account.json>");
  process.exit(1);
}

const resolvedServiceAccountPath = path.resolve(serviceAccountPath);
if (!fs.existsSync(resolvedServiceAccountPath)) {
  console.error(`Service account file was not found: ${resolvedServiceAccountPath}`);
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..");
const serviceAccount = JSON.parse(fs.readFileSync(resolvedServiceAccountPath, "utf8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const data = loadBundledData();
  const courses = data.courses || [];
  if (!courses.length) {
    throw new Error("No courses found in bundled data.");
  }

  const writes = [];
  courses.forEach((course, courseIndex) => {
    const courseId = toDocId(course.id || `course-${courseIndex + 1}`);
    const normalizedCourse = normalizeCourse(course, courseIndex);
    writes.push({
      ref: db.collection("courses").doc(courseId),
      data: normalizedCourse,
    });

    getCourseLessonDocs(course, courseIndex).forEach((lessonDoc) => {
      writes.push({
        ref: db.collection("courses").doc(courseId).collection("lessons").doc(lessonDoc.id),
        data: lessonDoc.data,
      });
    });
  });

  await commitInBatches(writes);
  console.log(`Migrated ${courses.length} courses with ${writes.length - courses.length} lesson documents.`);
}

function loadBundledData() {
  const sandbox = {
    window: {},
    console,
  };
  vm.createContext(sandbox);

  runBrowserDataFile(sandbox, "assets/js/data.js");
  runBrowserDataFile(sandbox, "assets/js/nghe-doc-data.js");

  return sandbox.window.TOIC_DATA || {};
}

function runBrowserDataFile(sandbox, relativePath) {
  const filename = path.join(rootDir, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  vm.runInContext(source, sandbox, { filename });
}

function normalizeCourse(course, courseIndex) {
  const hasParts = Array.isArray(course.parts) && course.parts.length > 0;
  return cleanObject({
    title: course.title || "",
    subtitle: course.subtitle || "",
    badge: course.badge || "",
    tag: course.tag || "",
    color: course.color || "#ef1d52",
    image: course.image || "",
    lectures: Number(course.lectures || 0),
    exams: Number(course.exams || 0),
    order: Number(course.order ?? courseIndex + 1),
    published: course.published !== false,
    hasParts,
    parts: hasParts ? course.parts.map(normalizePartMeta) : [],
    migratedAt: FieldValue.serverTimestamp(),
  });
}

function normalizePartMeta(part, partIndex) {
  return cleanObject({
    id: toDocId(part.id || `part-${partIndex + 1}`),
    title: part.title || "",
    lectures: Number(part.lectures || 0),
    exams: Number(part.exams || 0),
    order: Number(part.order ?? partIndex + 1),
  });
}

function getCourseLessonDocs(course, courseIndex) {
  if (Array.isArray(course.parts) && course.parts.length) {
    return course.parts.flatMap((part, partIndex) => {
      const partMeta = normalizePartMeta(part, partIndex);
      return (part.items || []).map((item, itemIndex) =>
        normalizeLessonDoc(item, {
          course,
          courseIndex,
          part: partMeta,
          partIndex,
          itemIndex,
          globalIndex: partIndex * 10000 + itemIndex,
        })
      );
    });
  }

  return (course.lessons || []).map((item, itemIndex) =>
    normalizeLessonDoc(item, {
      course,
      courseIndex,
      part: null,
      partIndex: 0,
      itemIndex,
      globalIndex: itemIndex,
    })
  );
}

function normalizeLessonDoc(item, context) {
  const docId = toDocId(item.id || `${context.course.id || "course"}-lesson-${context.globalIndex + 1}`);
  const part = context.part;
  return {
    id: docId,
    data: cleanObject({
      title: item.title || "",
      type: item.type || "",
      status: item.status || "",
      isExercise: Boolean(item.isExercise),
      lectures: Number(item.lectures || 0),
      docs: Number(item.docs || 0),
      questions: Number(item.questions || 0),
      score: Number(item.score || 0),
      video: item.video || "",
      link: item.link || "",
      linkType: item.linkType || "",
      file: item.file || "",
      fileLabel: item.fileLabel || "",
      description: item.description || "",
      sourceRow: item.sourceRow || null,
      partId: part?.id || "",
      partTitle: part?.title || "",
      partOrder: Number(part?.order || context.partIndex + 1),
      order: Number(item.order ?? context.itemIndex + 1),
      globalOrder: Number(item.globalOrder ?? context.globalIndex + 1),
      published: item.published !== false,
      migratedAt: FieldValue.serverTimestamp(),
    }),
  };
}

async function commitInBatches(writes) {
  const batchSize = 450;
  for (let index = 0; index < writes.length; index += batchSize) {
    const batch = db.batch();
    writes.slice(index, index + batchSize).forEach((write) => {
      batch.set(write.ref, write.data, { merge: true });
    });
    await batch.commit();
    console.log(`Committed ${Math.min(index + batchSize, writes.length)} / ${writes.length} writes...`);
  }
}

function cleanObject(value) {
  if (Array.isArray(value)) {
    return value.map(cleanObject).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object" || value.constructor?.name?.includes("Transform")) {
    return value;
  }

  return Object.entries(value).reduce((acc, [key, item]) => {
    if (item === undefined) return acc;
    acc[key] = cleanObject(item);
    return acc;
  }, {});
}

function toDocId(value) {
  return String(value || "item")
    .trim()
    .replace(/[/.#[\]]/g, "-")
    .replace(/\s+/g, "-")
    .toLowerCase();
}
