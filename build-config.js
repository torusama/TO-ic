const fs = require("fs");
const path = require("path");

const configDir = path.join(__dirname, "assets", "js");
const configPath = path.join(configDir, "firebase-config.js");

if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

const firebaseConfig = {
  apiKey: readEnv("FIREBASE_API_KEY"),
  authDomain: readEnv("FIREBASE_AUTH_DOMAIN"),
  projectId: readEnv("FIREBASE_PROJECT_ID"),
  storageBucket: readEnv("FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: readEnv("FIREBASE_MESSAGING_SENDER_ID"),
  appId: readEnv("FIREBASE_APP_ID"),
  measurementId: readEnv("FIREBASE_MEASUREMENT_ID"),
};

const hasRequiredEnv = ["apiKey", "authDomain", "projectId", "appId"].every((key) => Boolean(firebaseConfig[key]));

if (!hasRequiredEnv && fs.existsSync(configPath)) {
  console.log("Using existing assets/js/firebase-config.js because Firebase env vars are not complete.");
  process.exit(0);
}

const configContent = `export const FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig, null, 2)};
`;

fs.writeFileSync(configPath, configContent);

if (hasRequiredEnv) {
  console.log("Firebase config generated from environment variables.");
} else {
  console.warn("Firebase env vars are incomplete. Generated an empty config so the app can still build.");
}

function readEnv(name) {
  return process.env[`VITE_${name}`] || process.env[name] || "";
}
