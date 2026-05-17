import { hasFirebaseConfig } from "./firebase-app.js";
import { onUserChanged, signInWithGoogle } from "./user-service.js";

const signInButton = document.querySelector("#homeGoogleSignInBtn");
const statusText = document.querySelector("#homeAuthStatus");
const nextUrl = getNextUrl();

if (!hasFirebaseConfig) {
  signInButton.disabled = true;
  statusText.textContent = "Firebase is not configured yet, so sign-in is unavailable.";
} else {
  onUserChanged(async (user) => {
    if (user) {
      window.location.replace(nextUrl);
      return;
    }

    signInButton.disabled = false;
    signInButton.innerHTML = "<span>G</span> Start now";
    statusText.textContent = "Start with Google sign-in to sync your learning data.";
  });

  document.querySelectorAll(".home-login-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await signInWithGoogle();
        window.location.href = nextUrl;
      } catch (error) {
        console.warn("Google sign-in failed:", error);
        if (statusText) statusText.textContent = getSignInErrorMessage(error);
        btn.disabled = false;
      }
    });
  });
}

function getNextUrl() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  if (!next) return "./pages/hoc-phan.html";
  if (/^https?:\/\//i.test(next)) return "./pages/hoc-phan.html";
  if (next.startsWith("pages/")) return `./${next}`;
  if (next.startsWith("./pages/")) return next;
  return `./pages/${next.replace(/^\.?\//, "")}`;
}

function getSignInErrorMessage(error) {
  const code = error?.code || "";
  if (code === "auth/unauthorized-domain") {
    return `This domain is not allowed in Firebase Auth: ${window.location.hostname}. Open localhost or add this domain in Authorized domains.`;
  }
  if (code === "auth/operation-not-allowed") {
    return "Google sign-in is not enabled in Firebase Authentication.";
  }
  if (code === "auth/popup-blocked") {
    return "The Google sign-in popup was blocked by the browser.";
  }
  if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
    return "Google sign-in was closed before it finished.";
  }
  if (code === "auth/network-request-failed") {
    return "Network error while connecting to Google sign-in.";
  }
  return code ? `Google sign-in failed: ${code}` : "Sign-in did not finish. Check the popup or Firebase settings.";
}

// Scroll Reveal Animation
const revealElements = document.querySelectorAll(".reveal-on-scroll");
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-revealed");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.15,
    rootMargin: "0px 0px -50px 0px",
  }
);

revealElements.forEach((el) => revealObserver.observe(el));
