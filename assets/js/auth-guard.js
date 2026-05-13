import { hasFirebaseConfig } from "./firebase-app.js";
import { onUserChanged } from "./user-service.js";

if (!hasFirebaseConfig) {
  redirectHome();
} else {
  onUserChanged((user) => {
    if (!user) redirectHome();
  });
}

function redirectHome() {
  if (sessionStorage.getItem("toeic-just-signed-out") === "1") {
    sessionStorage.removeItem("toeic-just-signed-out");
    window.location.replace("../index.html");
    return;
  }

  const next = `${window.location.pathname.split("/").pop()}${window.location.search}${window.location.hash}`;
  window.location.replace(`../index.html?next=${encodeURIComponent(next)}`);
}
