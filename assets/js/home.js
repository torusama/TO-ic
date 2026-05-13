import { hasFirebaseConfig } from "./firebase-app.js";
import { onUserChanged, signInWithGoogle, ensureUserProfile } from "./user-service.js?v=lesson-progress-3";

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
        if (statusText) statusText.textContent = "Sign-in did not finish. Check the popup or Firebase settings.";
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
