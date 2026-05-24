import { FIREBASE_CONFIG } from "./firebase-config.js";
import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const requiredFirebaseKeys = ["apiKey", "authDomain", "projectId", "appId"];

export const hasFirebaseConfig = requiredFirebaseKeys.every((key) => Boolean(FIREBASE_CONFIG[key]));
export const app = hasFirebaseConfig ? initializeApp(FIREBASE_CONFIG) : null;
export const auth = app ? getAuth(app) : null;
export const authPersistenceReady = auth
  ? setPersistence(auth, browserLocalPersistence).catch((error) => {
      console.warn("Could not enable persistent Firebase auth:", error);
    })
  : Promise.resolve();
export const db = app ? getFirestore(app) : null;
