import { FIREBASE_CONFIG } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const requiredFirebaseKeys = ["apiKey", "authDomain", "projectId", "appId"];

export const hasFirebaseConfig = requiredFirebaseKeys.every((key) => Boolean(FIREBASE_CONFIG[key]));
export const app = hasFirebaseConfig ? initializeApp(FIREBASE_CONFIG) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
