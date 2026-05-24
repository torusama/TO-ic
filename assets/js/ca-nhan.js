import { hasFirebaseConfig } from "./firebase-app.js";
import {
  clearNotifications,
  deleteNotification,
  ensureDefaultNotifications,
  listenNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notification-service.js";
import {
  claimStreakAnimation,
  ensureUserProfile,
  followUser,
  getCompletedLessonKey,
  getPublicProfile,
  listSuggestedProfiles,
  listenActivities,
  listenCompletedLessons,
  listenFollowerProfiles,
  listenFollowingProfiles,
  listenUserProfile,
  normalizeProfile,
  onUserChanged,
  recordProfileView,
  searchPublicProfiles,
  signOutUser,
  unfollowUser,
  updateEmailPreferences,
  updateUserProfile,
} from "./user-service.js";
import { loadCourseWithLessons } from "./course-service.js";
import { rollStreakNumber, setStreakNumber } from "./streak-animation.js";

const firebaseNotice = document.querySelector("#firebaseNotice");
const signOutBtn = document.querySelector("#signOutBtn");
const notificationList = document.querySelector("#notificationList");
const learningMap = document.querySelector("#learningMap");
const skillComboChart = document.querySelector("#skillComboChart");
const skillPieChart = document.querySelector("#skillPieChart");
const markAllReadBtn = document.querySelector("#markAllReadBtn");
const clearNotificationsBtn = document.querySelector("#clearNotificationsBtn");
const emailStudyReminders = document.querySelector("#emailStudyReminders");
const emailNewLessonAlerts = document.querySelector("#emailNewLessonAlerts");
const emailReminderIntensity = document.querySelector("#emailReminderIntensity");
const emailReminderIntensityButton = document.querySelector("#emailReminderIntensityButton");
const emailReminderIntensityLabel = document.querySelector("#emailReminderIntensityLabel");
const emailReminderIntensityMenu = emailReminderIntensity?.querySelector(".email-select__menu");
const emailReminderIntensityOptions = Array.from(document.querySelectorAll("[data-email-reminder-intensity-option]"));
const emailReminderIntensityCard = emailReminderIntensity?.closest(".email-select");
const emailSettingsCard = emailReminderIntensity?.closest(".email-settings-card");
const emailSettingsGrid = emailReminderIntensity?.closest(".profile-email-grid");
const emailSettingsStatus = document.querySelector("#emailSettingsStatus");
const editProfileBtn = document.querySelector("#editProfileBtn");
const editProfileModal = document.querySelector("#editProfileModal");
const editProfileForm = document.querySelector("#editProfileForm");
const displayNameInput = document.querySelector("#displayNameInput");
const avatarUploadInput = document.querySelector("#avatarUploadInput");
const editAvatarPreview = document.querySelector("#editAvatarPreview");
const avatarCropPanel = document.querySelector("#avatarCropPanel");
const avatarCropStage = document.querySelector("#avatarCropStage");
const avatarCropImage = document.querySelector("#avatarCropImage");
const avatarZoomInput = document.querySelector("#avatarZoomInput");
const avatarApplyCropBtn = document.querySelector("#avatarApplyCropBtn");
const editProfileStatus = document.querySelector("#editProfileStatus");
const findFriendsBtn = document.querySelector("#findFriendsBtn");
const friendModal = document.querySelector("#friendModal");
const friendSearchInput = document.querySelector("#friendSearchInput");
const friendResults = document.querySelector("#friendResults");
const friendSearchStatus = document.querySelector("#friendSearchStatus");
const profileSocialStats = document.querySelector("#profileSocialStats");
const followersMetric = document.querySelector("#followersMetric");
const followingMetric = document.querySelector("#followingMetric");
const connectionsModal = document.querySelector("#connectionsModal");
const connectionModalTitle = document.querySelector("#connectionModalTitle");
const connectionList = document.querySelector("#connectionList");
const connectionTabs = document.querySelector("#connectionTabs");
const maxAvatarUploadBytes = 5 * 1024 * 1024;
const avatarOutputSize = 240;
const maxAvatarDataUrlLength = 650000;
const acceptedAvatarTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

let activeUser = null;
let activeProfile = normalizeProfile(null, {});
let activeNotifications = [];
let activeActivities = [];
let activeCompletedLessons = new Set();
let activeCoursesById = new Map();
let activeFollowing = new Set();
let activeFollowers = [];
let activeFollowingProfiles = [];
let friendProfiles = [];
let pendingAvatarDataUrl = "";
let avatarCropState = null;
let unsubscribers = [];
let courseDataVersion = 0;
let friendSearchTimer = 0;
let activeConnectionTab = "followers";
let isGuestMode = false;
let guestUid = null;
const checkedProfileAnimations = new Set();
let renderProfilePending = false;
let chartRevealObserver = null;

function scheduleRenderProfile() {
  if (renderProfilePending) return;
  renderProfilePending = true;
  requestAnimationFrame(() => {
    renderProfilePending = false;
    renderProfile();
  });
}

setAuthState("signed-out");

if (!hasFirebaseConfig) {
  firebaseNotice.hidden = false;
} else {
  onUserChanged(async (user) => {
    cleanupListeners();
    const loadVersion = ++courseDataVersion;
    activeUser = user;
    activeNotifications = [];
    activeActivities = [];
    activeCompletedLessons = new Set();
    activeCoursesById = new Map();
    activeFollowing = new Set();
    activeFollowers = [];
    activeFollowingProfiles = [];
    friendProfiles = [];
    pendingAvatarDataUrl = "";

    guestUid = new URLSearchParams(window.location.search).get("uid");
    isGuestMode = guestUid && (!user || guestUid !== user.uid);

    if (isGuestMode) {
      setAuthState("signed-in");
      try {
        const guestProfile = await getPublicProfile(guestUid);
        if (guestProfile) {
          activeProfile = guestProfile;

          loadProfileCourseData().then(() => {
             if (loadVersion === courseDataVersion) renderProfile();
          });

          if (user) {
            const loggedIn = await ensureUserProfile(user);
            recordProfileView(user, guestUid, loggedIn);
            unsubscribers = [
              listenFollowingProfiles(user.uid, (followingProfiles) => {
                activeFollowingProfiles = followingProfiles;
                activeFollowing = new Set(followingProfiles.map((p) => p.uid));
                renderProfile();
              }),
              listenActivities(guestUid, (items) => {
                activeActivities = items;
                renderProfile();
              }),
              listenCompletedLessons(guestUid, (lessonIds) => {
                activeCompletedLessons = lessonIds;
                renderProfile();
              })
            ];
          }
        } else {
          activeProfile = normalizeProfile(null, { displayName: "User not found" });
        }
      } catch (error) {
        activeProfile = normalizeProfile(null, { displayName: "Error loading profile" });
      }
      renderProfile();
      return;
    }

    if (!user) {
      activeProfile = normalizeProfile(null, {});
      setAuthState("signed-out");
      resetProfile();
      renderProfile();
      return;
    }

    setAuthState("signed-in");
    activeProfile = normalizeProfile(user, {});
    renderProfile();

    try {
      unsubscribers = [
        listenUserProfile(
          user.uid,
          (profile) => {
            if (profile) activeProfile = profile;
            scheduleRenderProfile();
          },
          (error) => console.warn("Could not listen to profile:", error)
        ),
        listenNotifications(
          user.uid,
          (items) => {
            activeNotifications = items;
            scheduleRenderProfile();
          },
          (error) => console.warn("Could not listen to notifications:", error)
        ),
        listenActivities(
          user.uid,
          (items) => {
            activeActivities = items;
            scheduleRenderProfile();
          },
          (error) => {
            console.warn("Could not listen to learning activity:", error);
            activeActivities = [];
            scheduleRenderProfile();
          }
        ),
        listenCompletedLessons(
          user.uid,
          (lessonIds) => {
            activeCompletedLessons = lessonIds;
            scheduleRenderProfile();
          },
          (error) => {
            console.warn("Could not listen to completed lessons:", error);
            activeCompletedLessons = new Set();
            scheduleRenderProfile();
          }
        ),
        listenFollowingProfiles(
          user.uid,
          (followingProfiles) => {
            activeFollowingProfiles = followingProfiles;
            activeFollowing = new Set(followingProfiles.map((profile) => profile.uid));
            scheduleRenderProfile();
            renderFriendLists();
            renderConnectionsModal();
          },
          (error) => console.warn("Could not listen to following:", error)
        ),
        listenFollowerProfiles(
          user.uid,
          (followers) => {
            activeFollowers = followers;
            scheduleRenderProfile();
            renderConnectionsModal();
          },
          (error) => console.warn("Could not listen to followers:", error)
        ),
      ];

      loadProfileCourseData(user).then(() => {
        if (loadVersion === courseDataVersion) scheduleRenderProfile();
      });

      ensureUserProfile(user).then((profile) => {
        if (profile) {
          activeProfile = profile;
          scheduleRenderProfile();
          ensureDefaultNotifications(user, profile).catch((err) => {
            console.warn("Could not ensure default notifications:", err);
          });
        }
      }).catch((error) => {
        console.warn("Could not initialize profile database:", error);
      });
    } catch (error) {
      console.warn("Could not sync Firestore; showing Google profile data instead:", error);
    }
  });
}

signOutBtn.addEventListener("click", async () => {
  const previousUser = activeUser;
  sessionStorage.setItem("toeic-just-signed-out", "1");
  cleanupListeners();
  activeUser = null;
  activeProfile = normalizeProfile(null, {});
  activeNotifications = [];
  activeActivities = [];
  activeCompletedLessons = new Set();
  activeFollowers = [];
  activeFollowingProfiles = [];
  activeFollowing = new Set();
  setAuthState("signed-out");
  resetProfile();
  renderProfile();

  try {
    await signOutUser();
    window.location.href = "../index.html";
  } catch (error) {
    console.warn("Sign out failed:", error);
    sessionStorage.removeItem("toeic-just-signed-out");
    if (previousUser) {
      activeUser = previousUser;
      setAuthState("signed-in");
    }
  }
});

notificationList?.addEventListener("click", async (event) => {
  if (!activeUser) return;
  const item = event.target.closest("[data-notification-id]");
  if (!item) return;

  const notifId = item.dataset.notificationId;
  const notifData = activeNotifications.find((n) => n.id === notifId);

  try {
    if (event.target.closest("[data-delete-notification]")) {
      await deleteNotification(activeUser.uid, notifId);
    } else {
      await markNotificationRead(activeUser.uid, notifId);
      openNotificationTarget(notifData);
    }
  } catch (error) {
    console.warn("Could not update notification:", error);
  }
});

notificationList?.addEventListener("keydown", async (event) => {
  if ((event.key !== "Enter" && event.key !== " ") || !activeUser) return;
  const item = event.target.closest("[data-notification-id]");
  if (!item) return;

  event.preventDefault();
  const notifData = activeNotifications.find((n) => n.id === item.dataset.notificationId);
  try {
    await markNotificationRead(activeUser.uid, item.dataset.notificationId);
    openNotificationTarget(notifData);
  } catch (error) {
    console.warn("Could not mark notification as read:", error);
  }
});

function openNotificationTarget(notifData) {
  if (!notifData || typeof window.openStreakModal !== "function") return;
  if (notifData.type === "streak_invite" || notifData.type === "streak_accept" || notifData.type === "pair_streak_broken") {
    window.openStreakModal(false, true, notifData.type === "streak_invite" ? "invites" : "friends");
  }
}

markAllReadBtn?.addEventListener("click", async () => {
  if (!activeUser || !activeNotifications.some((item) => item.unread)) return;
  try {
    await markAllNotificationsRead(activeUser.uid, activeNotifications);
  } catch (error) {
    console.warn("Could not mark all notifications as read:", error);
  }
});

clearNotificationsBtn?.addEventListener("click", async () => {
  if (!activeUser || !activeNotifications.length) return;
  try {
    await clearNotifications(activeUser.uid, activeNotifications);
  } catch (error) {
    console.warn("Could not clear notifications:", error);
  }
});

const EMAIL_REMINDER_INTENSITY_LABELS = {
  gentle: "Gentle",
  normal: "Normal",
  dramatic: "AzoTa dramatic",
};

[emailStudyReminders, emailNewLessonAlerts].forEach((toggle) => {
  toggle?.addEventListener("change", saveEmailSettings);
});

emailReminderIntensityButton?.addEventListener("click", () => {
  setEmailReminderIntensityOpen(!emailReminderIntensity?.classList.contains("is-open"));
});

emailReminderIntensityOptions.forEach((option) => {
  option.addEventListener("click", () => {
    const value = option.dataset.emailReminderIntensityOption || "dramatic";
    if (!activeUser || option.disabled || getEmailReminderIntensityValue() === value) {
      setEmailReminderIntensityOpen(false);
      return;
    }
    setEmailReminderIntensityValue(value);
    setEmailReminderIntensityOpen(false);
    saveEmailSettings();
  });
});

document.addEventListener("click", (event) => {
  if (!emailReminderIntensity || emailReminderIntensity.contains(event.target)) return;
  setEmailReminderIntensityOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setEmailReminderIntensityOpen(false);
});

editProfileBtn?.addEventListener("click", openEditProfileModal);
findFriendsBtn?.addEventListener("click", openFriendModal);

profileSocialStats?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-connection-list]") : null;
  if (!button) return;
  openConnectionsModal(button.dataset.connectionList || "followers");
});

connectionTabs?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-connection-tab]") : null;
  if (!button) return;
  activeConnectionTab = button.dataset.connectionTab || "followers";
  renderConnectionsModal();
});

document.querySelectorAll("[data-close-edit-modal]").forEach((button) => {
  button.addEventListener("click", closeEditProfileModal);
});

document.querySelectorAll("[data-close-friend-modal]").forEach((button) => {
  button.addEventListener("click", closeFriendModal);
});

document.querySelectorAll("[data-close-connections-modal]").forEach((button) => {
  button.addEventListener("click", closeConnectionsModal);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeEditProfileModal();
  closeFriendModal();
  closeConnectionsModal();
});

avatarUploadInput?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (!acceptedAvatarTypes.has(file.type)) {
    setEditProfileStatus("Choose a JPG, PNG, or WebP image.");
    event.target.value = "";
    return;
  }

  if (file.size > maxAvatarUploadBytes) {
    setEditProfileStatus("Avatar image must be 5 MB or smaller.");
    event.target.value = "";
    return;
  }

  setEditProfileStatus("Position your avatar, then apply the crop.");
  try {
    await openAvatarCropper(file);
  } catch (error) {
    console.warn("Could not prepare avatar:", error);
    pendingAvatarDataUrl = activeProfile.photoURL || "";
    if (editAvatarPreview) editAvatarPreview.src = getAvatarUrl(activeProfile);
    closeAvatarCropper();
    setEditProfileStatus("Could not use that image. Try another one under 5 MB.");
  } finally {
    event.target.value = "";
  }
});

avatarZoomInput?.addEventListener("input", () => {
  if (!avatarCropState) return;
  avatarCropState.scale = Number(avatarZoomInput.value || avatarCropState.scale);
  clampAvatarCrop();
  renderAvatarCrop();
});

avatarApplyCropBtn?.addEventListener("click", () => {
  if (!avatarCropState) return;
  try {
    pendingAvatarDataUrl = createCroppedAvatar();
    if (editAvatarPreview) editAvatarPreview.src = pendingAvatarDataUrl;
    closeAvatarCropper();
    setEditProfileStatus("Avatar ready. Save to keep it.");
  } catch (error) {
    console.warn("Could not crop avatar:", error);
    setEditProfileStatus("Could not crop that image. Try another one.");
  }
});

avatarCropStage?.addEventListener("pointerdown", (event) => {
  if (!avatarCropState) return;
  event.preventDefault();
  avatarCropStage.setPointerCapture?.(event.pointerId);
  avatarCropState.dragging = true;
  avatarCropState.dragStartX = event.clientX;
  avatarCropState.dragStartY = event.clientY;
  avatarCropState.startX = avatarCropState.x;
  avatarCropState.startY = avatarCropState.y;
});

avatarCropStage?.addEventListener("pointermove", (event) => {
  if (!avatarCropState?.dragging) return;
  avatarCropState.x = avatarCropState.startX + event.clientX - avatarCropState.dragStartX;
  avatarCropState.y = avatarCropState.startY + event.clientY - avatarCropState.dragStartY;
  clampAvatarCrop();
  renderAvatarCrop();
});

["pointerup", "pointercancel", "lostpointercapture"].forEach((eventName) => {
  avatarCropStage?.addEventListener(eventName, () => {
    if (avatarCropState) avatarCropState.dragging = false;
  });
});

editProfileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeUser) return;

  const displayName = String(displayNameInput?.value || "").replace(/\s+/g, " ").trim();
  if (!displayName) {
    setEditProfileStatus("Display name cannot be empty.");
    displayNameInput?.focus();
    return;
  }

  if (avatarCropState) {
    setEditProfileStatus("Apply the avatar crop before saving.");
    avatarApplyCropBtn?.focus();
    return;
  }

  setEditProfileSaving(true, "Saving profile...");
  try {
    await updateUserProfile(activeUser, {
      displayName,
      photoURL: pendingAvatarDataUrl || activeProfile.photoURL || "",
    });
    activeProfile = normalizeProfile(activeUser, {
      ...activeProfile,
      displayName,
      photoURL: pendingAvatarDataUrl || activeProfile.photoURL || "",
    });
    renderProfile();
    setEditProfileSaving(false, "Saved.");
    window.setTimeout(closeEditProfileModal, 450);
  } catch (error) {
    console.warn("Could not save profile:", error);
    setEditProfileSaving(false, "Could not save profile. Try again.");
  }
});

friendSearchInput?.addEventListener("input", () => {
  window.clearTimeout(friendSearchTimer);
  friendSearchTimer = window.setTimeout(() => {
    loadFriendProfiles(friendSearchInput.value);
  }, 240);
});

friendResults?.addEventListener("click", handleFriendAction);
connectionList?.addEventListener("click", handleFriendAction);

function openEditProfileModal() {
  if (!editProfileModal || !activeUser) return;

  closeAvatarCropper();
  pendingAvatarDataUrl = activeProfile.photoURL || "";
  if (displayNameInput) displayNameInput.value = activeProfile.displayName || "";
  if (editAvatarPreview) editAvatarPreview.src = getAvatarUrl(activeProfile);
  setEditProfileStatus("");
  setEditProfileSaving(false);
  setModalOpen(editProfileModal, true);
  window.setTimeout(() => displayNameInput?.focus(), 0);
}

function closeEditProfileModal() {
  if (!editProfileModal || editProfileModal.hidden) return;
  setModalOpen(editProfileModal, false);
  closeAvatarCropper();
  pendingAvatarDataUrl = "";
  setEditProfileStatus("");
}

function openFriendModal() {
  if (!friendModal || !activeUser) return;

  setModalOpen(friendModal, true);
  window.setTimeout(() => friendSearchInput?.focus(), 0);
  if (!friendProfiles.length) {
    loadFriendProfiles(friendSearchInput?.value || "");
  } else {
    renderFriendLists();
  }
}

function closeFriendModal() {
  if (!friendModal || friendModal.hidden) return;
  setModalOpen(friendModal, false);
}

function openConnectionsModal(type = "followers") {
  if (!connectionsModal || !activeUser) return;
  activeConnectionTab = type === "following" ? "following" : "followers";
  renderConnectionsModal();
  setModalOpen(connectionsModal, true);
}

function closeConnectionsModal() {
  if (!connectionsModal || connectionsModal.hidden) return;
  setModalOpen(connectionsModal, false);
}

async function loadFriendProfiles(term = "") {
  if (!activeUser) return;

  const cleanTerm = String(term || "").trim();
  setFriendStatus(cleanTerm ? "Searching..." : "Loading suggestions...");
  if (friendResults) {
    friendResults.innerHTML = `<div class="friend-empty">Loading learners...</div>`;
  }

  try {
    friendProfiles = cleanTerm
      ? await searchPublicProfiles(cleanTerm, activeUser.uid)
      : await listSuggestedProfiles(activeUser.uid);
    setFriendStatus(cleanTerm ? `${friendProfiles.length} result${friendProfiles.length === 1 ? "" : "s"}` : "Suggested learners");
    renderFriendLists();
  } catch (error) {
    console.warn("Could not load friend profiles:", error);
    friendProfiles = [];
    setFriendStatus("Could not load friends");
    if (friendResults) {
      friendResults.innerHTML = `<div class="friend-empty">Friend list is shy right now. Try again.</div>`;
    }
  }
}

async function handleFriendAction(event) {
  if (!activeUser) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const followBtn = target.closest("[data-follow-uid]");
  const unfollowBtn = target.closest("[data-unfollow-uid]");
  const uid = followBtn?.dataset.followUid || unfollowBtn?.dataset.unfollowUid || "";
  if (!uid) return;

  const profile = getFriendProfile(uid);
  if (!profile) return;

  const button = followBtn || unfollowBtn;
  button.disabled = true;

  try {
    if (followBtn) {
      await followUser(activeUser, profile, activeProfile);
      activeFollowing.add(profile.uid);
      if (!activeFollowingProfiles.some((item) => item.uid === profile.uid)) {
        activeFollowingProfiles = [profile, ...activeFollowingProfiles];
      }
    } else {
      await unfollowUser(activeUser.uid, profile.uid);
      activeFollowing.delete(profile.uid);
      activeFollowingProfiles = activeFollowingProfiles.filter((item) => item.uid !== profile.uid);
    }
    renderFriendLists();
    renderConnectionsModal();
  } catch (error) {
    console.warn("Could not update friend follow state:", error);
    setFriendStatus("Could not update follow. Try again.");
    button.disabled = false;
  }
}

function renderFriendLists() {
  if (!friendResults) return;

  if (!friendProfiles.length) {
    friendResults.innerHTML = `<div class="friend-empty">No learners found yet.</div>`;
    return;
  }

  friendResults.innerHTML = friendProfiles.map(renderFriendCard).join("");
}

function renderConnectionsModal() {
  if (!connectionsModal || !connectionList) return;

  const isFollowers = activeConnectionTab !== "following";
  const items = isFollowers ? activeFollowers : activeFollowingProfiles;
  if (connectionModalTitle) connectionModalTitle.textContent = isFollowers ? "Followers" : "Following";

  connectionTabs?.querySelectorAll("[data-connection-tab]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.connectionTab === activeConnectionTab);
  });

  connectionList.innerHTML = items.length
    ? items.map((profile) => renderConnectionItem(profile, isFollowers ? "followers" : "following")).join("")
    : `<div class="connection-empty">${isFollowers ? "No followers yet." : "Not following anyone yet."}</div>`;
}

function renderConnectionItem(profile, type) {
  const isFollowing = activeFollowing.has(profile.uid);
  const label = type === "followers" ? (isFollowing ? "Follows you - following back" : "Follows you") : "Following";

  return `
    <article class="connection-item">
      <a href="ca-nhan.html?uid=${escapeHtml(profile.uid)}"><img class="connection-item__avatar" src="${escapeHtml(getAvatarUrl(profile))}" alt="" /></a>
      <div class="connection-item__body">
        <a href="ca-nhan.html?uid=${escapeHtml(profile.uid)}" style="text-decoration:none;"><strong>${escapeHtml(profile.displayName)}</strong></a>
        <span>${label}</span>
      </div>
      ${renderFollowButton(profile, isFollowing)}
    </article>
  `;
}

function renderFriendCard(profile) {
  const isFollowing = activeFollowing.has(profile.uid);
  const lessons = Number(profile.stats?.lessons || 0);
  const streak = Number(profile.stats?.streak || 0);

  return `
    <article class="friend-card">
      <div class="friend-card__body">
        <a href="ca-nhan.html?uid=${escapeHtml(profile.uid)}"><img class="friend-card__avatar" src="${escapeHtml(getAvatarUrl(profile))}" alt="" /></a>
        <a href="ca-nhan.html?uid=${escapeHtml(profile.uid)}" style="text-decoration:none;"><strong class="friend-card__name">${escapeHtml(profile.displayName)}</strong></a>
        <div class="friend-card__stats">
          <span>${renderFriendStreakIcon()} <strong>${streak}</strong></span>
          <span>${renderFriendLessonsIcon()} <strong>${lessons}</strong></span>
        </div>
      </div>
      <div class="friend-card__action">
        ${renderFollowButton(profile, isFollowing)}
      </div>
    </article>
  `;
}

function renderFollowButton(profile, isFollowing) {
  return isFollowing
    ? `<button class="friend-chip-btn is-following" type="button" data-unfollow-uid="${escapeHtml(profile.uid)}">Following</button>`
    : `<button class="friend-chip-btn" type="button" data-follow-uid="${escapeHtml(profile.uid)}">Follow</button>`;
}

function renderFriendStreakIcon() {
  return `
    <svg class="friend-stat-icon friend-stat-icon--streak" viewBox="0 0 24 24" aria-hidden="true">
      <path
        class="friend-stat-icon__flame-main"
        d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z"
      />
      <path class="friend-stat-icon__flame-core" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z" />
    </svg>
  `;
}

function renderFriendLessonsIcon() {
  return `
    <svg class="friend-stat-icon friend-stat-icon--lessons" viewBox="0 0 24 24" aria-hidden="true">
      <path class="friend-stat-icon__book-shadow" d="M7 5.2h8.2c1.45 0 2.8 1.18 2.8 2.63v10.92H8.2A3.2 3.2 0 0 1 5 15.55V7.2c0-1.1.9-2 2-2Z" />
      <path class="friend-stat-icon__book-main" d="M5.8 4h7.9c1.55 0 2.8 1.25 2.8 2.8v10.45H7.6a3.1 3.1 0 0 1-3.1-3.1V5.3c0-.72.58-1.3 1.3-1.3Z" />
      <path class="friend-stat-icon__book-page" d="M7.35 15.1h9.15v2.15H7.55c-.68 0-1.22-.48-1.22-1.08s.46-1.07 1.02-1.07Z" />
      <path class="friend-stat-icon__book-mark" d="M13.1 4h2.25v6.25l-1.12-.82-1.13.82V4Z" />
    </svg>
  `;
}

function getFriendProfile(uid) {
  return (
    friendProfiles.find((profile) => profile.uid === uid) ||
    activeFollowers.find((profile) => profile.uid === uid) ||
    activeFollowingProfiles.find((profile) => profile.uid === uid) ||
    null
  );
}

function setEditProfileSaving(isSaving, message = "") {
  if (editProfileForm) {
    editProfileForm.querySelectorAll("button, input").forEach((control) => {
      control.disabled = isSaving;
    });
  }
  setEditProfileStatus(message);
}

function setEditProfileStatus(message) {
  if (editProfileStatus) editProfileStatus.textContent = message || "";
}

function setFriendStatus(message) {
  if (friendSearchStatus) friendSearchStatus.textContent = message || "";
}

function setModalOpen(modal, isOpen) {
  modal.hidden = !isOpen;
  const hasOpenModal = Boolean(
    (friendModal && !friendModal.hidden) ||
      (editProfileModal && !editProfileModal.hidden) ||
      (connectionsModal && !connectionsModal.hidden)
  );
  document.body.classList.toggle("modal-open", hasOpenModal);
}

function getAvatarUrl(profile) {
  return profile?.photoURL || "https://www.gravatar.com/avatar/?d=mp";
}

function openAvatarCropper(file) {
  return new Promise((resolve, reject) => {
    closeAvatarCropper();
    const imageUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (!avatarCropPanel || !avatarCropStage || !avatarCropImage || !avatarZoomInput) {
        URL.revokeObjectURL(imageUrl);
        reject(new Error("Avatar cropper is unavailable"));
        return;
      }

      avatarCropPanel.hidden = false;
      avatarCropImage.src = imageUrl;
      window.requestAnimationFrame(() => {
        const stageSize = avatarCropStage.getBoundingClientRect().width || 260;
        const cropSize = stageSize * 0.84;
        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;
        const baseScale = Math.max(cropSize / naturalWidth, cropSize / naturalHeight);

        avatarCropState = {
          image,
          objectUrl: imageUrl,
          naturalWidth,
          naturalHeight,
          stageSize,
          cropSize,
          baseScale,
          scale: 1,
          x: 0,
          y: 0,
          dragging: false,
        };

        avatarZoomInput.value = "1";
        clampAvatarCrop();
        renderAvatarCrop();
        resolve();
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("Could not read image"));
    };
    image.src = imageUrl;
  });
}

function closeAvatarCropper() {
  if (avatarCropState?.objectUrl) URL.revokeObjectURL(avatarCropState.objectUrl);
  avatarCropState = null;
  if (avatarCropPanel) avatarCropPanel.hidden = true;
  if (avatarCropImage) avatarCropImage.src = "";
  if (avatarZoomInput) avatarZoomInput.value = "1";
}

function renderAvatarCrop() {
  if (!avatarCropState || !avatarCropImage) return;
  const width = avatarCropState.naturalWidth * avatarCropState.baseScale * avatarCropState.scale;
  const height = avatarCropState.naturalHeight * avatarCropState.baseScale * avatarCropState.scale;
  avatarCropImage.style.width = `${width}px`;
  avatarCropImage.style.height = `${height}px`;
  avatarCropImage.style.transform = `translate(-50%, -50%) translate(${avatarCropState.x}px, ${avatarCropState.y}px)`;
}

function clampAvatarCrop() {
  if (!avatarCropState) return;
  const width = avatarCropState.naturalWidth * avatarCropState.baseScale * avatarCropState.scale;
  const height = avatarCropState.naturalHeight * avatarCropState.baseScale * avatarCropState.scale;
  const maxX = Math.max(0, (width - avatarCropState.cropSize) / 2);
  const maxY = Math.max(0, (height - avatarCropState.cropSize) / 2);
  avatarCropState.x = clamp(avatarCropState.x, -maxX, maxX);
  avatarCropState.y = clamp(avatarCropState.y, -maxY, maxY);
}

function createCroppedAvatar() {
  if (!avatarCropState) throw new Error("No avatar crop selected");
  const canvas = document.createElement("canvas");
  canvas.width = avatarOutputSize;
  canvas.height = avatarOutputSize;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create avatar canvas");

  const displayedWidth = avatarCropState.naturalWidth * avatarCropState.baseScale * avatarCropState.scale;
  const displayedHeight = avatarCropState.naturalHeight * avatarCropState.baseScale * avatarCropState.scale;
  const imageLeft = avatarCropState.stageSize / 2 - displayedWidth / 2 + avatarCropState.x;
  const imageTop = avatarCropState.stageSize / 2 - displayedHeight / 2 + avatarCropState.y;
  const cropLeft = (avatarCropState.stageSize - avatarCropState.cropSize) / 2;
  const cropTop = (avatarCropState.stageSize - avatarCropState.cropSize) / 2;
  const sourceX = ((cropLeft - imageLeft) / displayedWidth) * avatarCropState.naturalWidth;
  const sourceY = ((cropTop - imageTop) / displayedHeight) * avatarCropState.naturalHeight;
  const sourceSize = (avatarCropState.cropSize / displayedWidth) * avatarCropState.naturalWidth;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, avatarOutputSize, avatarOutputSize);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    avatarCropState.image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    0,
    0,
    avatarOutputSize,
    avatarOutputSize
  );

  let quality = 0.82;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > maxAvatarDataUrlLength && quality > 0.42) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  if (dataUrl.length > maxAvatarDataUrlLength) throw new Error("Avatar data URL is too large");
  return dataUrl;
}

function renderProfile() {
  const isGuest = isGuestMode;
  const editBtn = document.querySelector("#editProfileBtn");
  const signOutBtn = document.querySelector("#signOutBtn");
  const profileActions = document.querySelector(".profile-actions");
  const findFriendsBtn = document.querySelector("#findFriendsBtn");
  const lessonsCard = document.querySelector(".lessons-card");
  const streakCard = document.querySelector(".streak-card");
  const statStack = document.querySelector(".profile-stat-stack");
  const profileHeading = document.querySelector(".profile-heading");

  if (isGuest) {
    if (editBtn) editBtn.hidden = true;
    if (signOutBtn) signOutBtn.hidden = true;
    if (findFriendsBtn) findFriendsBtn.style.display = "none";
    if (statStack) {
      statStack.style.gap = "0";
      statStack.style.gridTemplateRows = "1fr";
    }
    if (lessonsCard) {
      lessonsCard.style.height = "100%";
      lessonsCard.style.minHeight = "100%";
    }

    if (profileHeading) {
      if (!profileHeading.querySelector(".heading-content")) {
        const p = profileHeading.querySelector("p");
        const h1 = profileHeading.querySelector("h1");
        if (p && h1) {
          const wrapper = document.createElement("div");
          wrapper.className = "heading-content";
          profileHeading.insertBefore(wrapper, p);
          wrapper.appendChild(p);
          wrapper.appendChild(h1);
          profileHeading.style.display = "flex";
          profileHeading.style.justifyContent = "space-between";
          profileHeading.style.alignItems = "center";
        }
      }

      let backBtn = document.querySelector("#guestBackBtn");
      if (!backBtn) {
        backBtn = document.createElement("button");
        backBtn.id = "guestBackBtn";
        backBtn.className = "btn btn--secondary";
        backBtn.style.padding = "0 24px";
        backBtn.style.height = "48px";
        backBtn.innerHTML = "BACK";
        backBtn.onclick = () => window.history.back();
        profileHeading.appendChild(backBtn);
      } else {
        backBtn.hidden = false;
      }
    }

    let followGuestBtn = document.querySelector("#followGuestBtn");
    if (!followGuestBtn) {
       followGuestBtn = document.createElement("div");
       followGuestBtn.id = "followGuestBtn";
       profileActions?.appendChild(followGuestBtn);
    }
    if (followGuestBtn) followGuestBtn.hidden = false;

    const isFollowing = activeFollowing.has(guestUid);
    if (activeUser && activeProfile.uid) {
      if (followGuestBtn) {
        followGuestBtn.innerHTML = isFollowing
          ? `<button class="btn btn--primary is-following" type="button" data-unfollow-uid="${escapeHtml(guestUid)}" style="width:100%;margin-top:10px;background:var(--page-bg);color:var(--dark-blue);border:2px solid var(--border-color);box-shadow:none;">Following</button>`
          : `<button class="btn btn--primary" type="button" data-follow-uid="${escapeHtml(guestUid)}" style="width:100%;margin-top:10px;">Follow</button>`;
      }
    } else {
      if (followGuestBtn) followGuestBtn.innerHTML = '';
    }
  } else {
    if (editBtn) editBtn.hidden = false;
    if (signOutBtn) signOutBtn.hidden = false;
    if (findFriendsBtn) findFriendsBtn.style.display = "";
    if (statStack) {
      statStack.style.gap = "";
      statStack.style.gridTemplateRows = "";
    }
    if (lessonsCard) {
      lessonsCard.style.height = "";
      lessonsCard.style.minHeight = "";
    }
    const followGuestBtn = document.querySelector("#followGuestBtn");
    if (followGuestBtn) followGuestBtn.hidden = true;
    const backBtn = document.querySelector("#guestBackBtn");
    if (backBtn) backBtn.hidden = true;
  }

  const emailGrid = document.querySelector(".profile-email-grid");
  const thongBao = document.querySelector("#thong-bao");
  const socialStats = document.querySelector("#profileSocialStats");
  const compactGrid = document.querySelector(".profile-compact-grid");
  const chartGrid = document.querySelector(".profile-chart-grid");
  const pieChartCard = document.querySelector(".profile-card--pie-chart");
  const comboChartCard = document.querySelector(".profile-card--combo-chart");
  const radarChartCard = document.querySelector(".profile-card--learning-map");

  if (isGuest) {
    if (emailGrid) emailGrid.hidden = true;
    if (thongBao) thongBao.hidden = true;
    if (socialStats) socialStats.hidden = true;
    if (chartGrid) chartGrid.hidden = false;

    if (comboChartCard && compactGrid) {
      compactGrid.appendChild(comboChartCard);
      if (radarChartCard) radarChartCard.style.gridColumn = "";
      comboChartCard.style.gridColumn = "";

      if (radarChartCard) {
        comboChartCard.style.height = radarChartCard.offsetHeight ? radarChartCard.offsetHeight + "px" : "420px";
      }

      const comboCanvas = document.querySelector("#skillComboChart");
      if (comboCanvas) {
        comboCanvas.style.display = "";
        comboCanvas.style.justifyContent = "";
        comboCanvas.style.margin = "";
        comboCanvas.style.width = "";
      }
    }

    if (pieChartCard) {
      pieChartCard.hidden = false;
      pieChartCard.style.gridColumn = "1 / -1";

      const pieCanvas = document.querySelector("#skillPieChart");
      if (pieCanvas) {
        pieCanvas.style.display = "flex";
        pieCanvas.style.justifyContent = "center";
        pieCanvas.style.margin = "0 auto";
        pieCanvas.style.width = "100%";
      }
    }
  } else {
    if (emailGrid) emailGrid.hidden = false;
    if (thongBao) thongBao.hidden = false;
    if (socialStats) socialStats.hidden = false;
    if (pieChartCard) {
      pieChartCard.hidden = false;
      pieChartCard.style.gridColumn = "";
      const pieCanvas = document.querySelector("#skillPieChart");
      if (pieCanvas) {
        pieCanvas.style.display = "";
        pieCanvas.style.justifyContent = "";
        pieCanvas.style.margin = "";
        pieCanvas.style.width = "";
      }
    }
    if (chartGrid) chartGrid.hidden = false;

    if (comboChartCard && chartGrid) {
      chartGrid.appendChild(comboChartCard);
      comboChartCard.style.gridColumn = "";
      comboChartCard.style.height = "";
      if (radarChartCard) radarChartCard.style.gridColumn = "";
    }
  }

  const unreadCount = activeNotifications.filter((item) => item.unread).length;

  document.querySelector("#userAvatar").src = activeProfile.photoURL || "https://www.gravatar.com/avatar/?d=mp";
  document.querySelector("#userName").textContent = activeProfile.displayName || "TOEIC Learner";
  document.querySelector("#userEmail").textContent = activeProfile.email || "";
  if (followersMetric) followersMetric.textContent = String(activeProfile.stats?.followersCount ?? activeFollowers.length);
  if (followingMetric) followingMetric.textContent = String(activeProfile.stats?.followingCount ?? activeFollowingProfiles.length);
  renderProfileStreak();
  document.querySelector("#lessonsMetric").textContent = activeProfile.stats?.lessons || 0;
  document.querySelector("#profileBell")?.classList.toggle("has-unread", unreadCount > 0);

  notificationList.classList.toggle("is-empty", activeNotifications.length === 0);
  notificationList.innerHTML = activeNotifications.length
    ? activeNotifications
        .map(
          (item) => `
            <article class="notification-item ${item.unread ? "is-unread" : ""}" data-notification-id="${item.id}" tabindex="0">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <p>${escapeHtml(item.body)}</p>
              </div>
              <button class="notification-delete" type="button" data-delete-notification aria-label="Delete notification">&times;</button>
            </article>
          `
        )
        .join("")
    : `<div class="notification-empty">No notifications yet.</div>`;

  markAllReadBtn.disabled = unreadCount === 0;
  clearNotificationsBtn.disabled = activeNotifications.length === 0;

  renderLearningMap();
  renderSkillChartPanels();
  setupChartRevealAnimations();
  renderEmailSettings();

  document.documentElement.classList.remove("is-guest-view-init");
}

async function renderProfileStreak() {
  const target = document.querySelector("#streakMetric");
  const streakCard = target?.closest(".streak-card");
  const streak = Number(activeProfile.stats?.streak || 0);

  if (streakCard) {
    streakCard.style.cursor = "pointer";
    streakCard.onclick = () => {
      if (typeof window.openStreakModal === "function") {
        window.openStreakModal(false);
      }
    };
  }

  const lastStreakDate = activeProfile.stats?.lastStreakDate || "";
  const checkKey = `${activeUser?.uid || "guest"}__${lastStreakDate}__${streak}`;
  if (!activeUser || !lastStreakDate || streak <= 0 || checkedProfileAnimations.has(checkKey)) {
    setStreakNumber(target, streak);
    return;
  }

  checkedProfileAnimations.add(checkKey);
  const claim = await claimStreakAnimation(activeUser.uid, "profile");
  if (claim.shouldAnimate) {
    rollStreakNumber(target, claim.from, claim.to);
  } else {
    setStreakNumber(target, streak);
  }
}

async function loadProfileCourseData(user = activeUser) {
  const courses = await Promise.all([
    loadCourseWithLessons("nghe-doc", user),
    loadCourseWithLessons("noi-viet", user),
  ]);

  activeCoursesById = new Map(courses.filter(Boolean).map((course) => [course.id, course]));
}

async function saveEmailSettings() {
  if (!activeUser) return;

  setEmailSettingsSaving(true, "Saving email settings...");
  try {
    await updateEmailPreferences(activeUser.uid, {
      studyReminders: emailStudyReminders?.checked,
      newLessonAlerts: emailNewLessonAlerts?.checked,
      reminderIntensity: getEmailReminderIntensityValue(),
    });
    setEmailSettingsSaving(false, "Saved. Mail will be sent from azotatoeic@gmail.com.");
  } catch (error) {
    console.warn("Could not save email settings:", error);
    setEmailSettingsSaving(false, "Could not save email settings. Try again.");
    renderEmailSettings();
  }
}

function getEmailReminderIntensityValue() {
  return emailReminderIntensity?.dataset.value || "dramatic";
}

function setEmailReminderIntensityValue(value) {
  const nextValue = ["gentle", "normal", "dramatic"].includes(value) ? value : "dramatic";
  if (emailReminderIntensity) {
    emailReminderIntensity.dataset.value = nextValue;
  }
  if (emailReminderIntensityLabel) {
    emailReminderIntensityLabel.textContent = EMAIL_REMINDER_INTENSITY_LABELS[nextValue] || EMAIL_REMINDER_INTENSITY_LABELS.dramatic;
  }
  emailReminderIntensityOptions.forEach((option) => {
    const isSelected = option.dataset.emailReminderIntensityOption === nextValue;
    option.classList.toggle("is-selected", isSelected);
    option.setAttribute("aria-selected", isSelected ? "true" : "false");
  });
}

function setEmailReminderIntensityDisabled(isDisabled) {
  emailReminderIntensityOptions.forEach((option) => {
    option.disabled = isDisabled;
  });
  if (emailReminderIntensityButton) {
    emailReminderIntensityButton.disabled = isDisabled;
  }

  if (!emailReminderIntensity) return;
  emailReminderIntensity.classList.toggle("is-disabled", isDisabled);
  emailReminderIntensity.setAttribute("aria-disabled", isDisabled ? "true" : "false");
  if (isDisabled) setEmailReminderIntensityOpen(false);
}

function setEmailReminderIntensityOpen(isOpen) {
  if (!emailReminderIntensity || !emailReminderIntensityButton || !emailReminderIntensityMenu) return;
  const nextOpen = Boolean(isOpen && !emailReminderIntensity.classList.contains("is-disabled"));
  emailReminderIntensity.classList.toggle("is-open", nextOpen);
  emailReminderIntensityCard?.classList.toggle("is-dropdown-open", nextOpen);
  emailSettingsCard?.classList.toggle("is-dropdown-open", nextOpen);
  emailSettingsGrid?.classList.toggle("is-dropdown-open", nextOpen);
  emailReminderIntensityButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
  emailReminderIntensityMenu.hidden = !nextOpen;
}

function renderEmailSettings() {
  const preferences = activeProfile.emailPreferences || {};

  if (emailStudyReminders) {
    emailStudyReminders.checked = preferences.studyReminders !== false;
    emailStudyReminders.disabled = !activeUser;
  }

  if (emailNewLessonAlerts) {
    emailNewLessonAlerts.checked = preferences.newLessonAlerts !== false;
    emailNewLessonAlerts.disabled = !activeUser;
  }

  setEmailReminderIntensityValue(
    ["gentle", "normal", "dramatic"].includes(preferences.reminderIntensity)
      ? preferences.reminderIntensity
      : "dramatic"
  );
  setEmailReminderIntensityDisabled(!activeUser || preferences.studyReminders === false);

  if (emailSettingsStatus && !emailSettingsStatus.dataset.isSaving) {
    emailSettingsStatus.textContent = activeUser
      ? "Mail will be sent from azotatoeic@gmail.com."
      : "Sign in to manage email reminders.";
  }
}

function setEmailSettingsSaving(isSaving, message) {
  [emailStudyReminders, emailNewLessonAlerts].forEach((toggle) => {
    if (toggle) toggle.disabled = isSaving || !activeUser;
  });
  setEmailReminderIntensityDisabled(isSaving || !activeUser || emailStudyReminders?.checked === false);

  if (!emailSettingsStatus) return;
  emailSettingsStatus.dataset.isSaving = isSaving ? "true" : "";
  emailSettingsStatus.textContent = message;

  if (!isSaving) {
    window.setTimeout(() => {
      if (emailSettingsStatus.dataset.isSaving) return;
      renderEmailSettings();
    }, 1800);
  }
}

function renderLearningMap() {
  if (!learningMap) return;

  const items = getVisibleLearningMapItems();
  learningMap.innerHTML = renderSpiderMap(items);
}

function renderSkillChartPanels() {
  if (!skillComboChart || !skillPieChart) return;

  const items = getSkillChartItems();
  skillComboChart.innerHTML = renderComboChart(items);
  skillPieChart.innerHTML = renderPieChart(items);
}

function getSkillChartItems() {
  const items = getCoreSkillItems(getVisibleLearningMapItems());
  return items;
}

function getVisibleLearningMapItems() {
  return getLearningMapItems().map(normalizeMapItem);
}

function renderSpiderMap(items) {
  const size = 420;
  const center = 210;
  const radius = 145;
  const levels = [0.2, 0.4, 0.6, 0.8, 1];
  const grid = levels
    .map((level) => `<polygon class="spider-grid-line" points="${getSpiderPoints(items.length, level, center, radius)}"></polygon>`)
    .join("");
  const axes = items
    .map((item, index) => {
      const end = getSpiderPoint(index, items.length, 1, center, radius);
      const label = getSpiderPoint(index, items.length, 1.24, center, radius);
      return `
        <line class="spider-axis" x1="${center}" y1="${center}" x2="${end.x}" y2="${end.y}"></line>
        <text class="spider-axis-label" x="${label.x}" y="${label.y}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(item.axisLabel)}</text>
      `;
    })
    .join("");
  const valuePoints = items
    .map((item, index) => {
      const point = getSpiderPoint(index, items.length, item.percent / 100, center, radius);
      return `${point.x},${point.y}`;
    })
    .join(" ");
  const markers = items
    .map((item, index) => {
      if (item.percent <= 0) return "";
      const point = getSpiderPoint(index, items.length, item.percent / 100, center, radius);
      return `<circle class="spider-marker" cx="${point.x}" cy="${point.y}" r="5" style="--skill-color: ${escapeHtml(item.color)}"><title>${escapeHtml(item.title)} ${escapeHtml(item.status)}</title></circle>`;
    })
    .join("");

  return `
    <div class="spider-map-shell chart-anim">
      <div class="spider-chart-wrap">
        <svg class="spider-chart" viewBox="0 0 ${size} ${size}" role="img" aria-label="Skill progress radar chart">
          <g class="spider-grid">${grid}</g>
          <g>${axes}</g>
          <polygon class="spider-value-area" points="${valuePoints}"></polygon>
          <g>${markers}</g>
        </svg>
      </div>
    </div>
  `;
}

function getCoreSkillItems(items) {
  const skillOrder = ["Listening", "Reading", "Speaking", "Writing", "Practice"];
  return skillOrder.map((title) => items.find((item) => item.title === title)).filter(Boolean);
}

function renderComboChart(items) {
  const width = 430;
  const height = 240;
  const top = 24;
  const right = 18;
  const bottom = 44;
  const left = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const baseY = top + chartHeight;
  const step = chartWidth / Math.max(items.length, 1);
  const barWidth = Math.min(42, step * 0.44);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((level) => {
      const y = Number((baseY - chartHeight * level).toFixed(2));
      return `<line class="combo-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>`;
    })
    .join("");
  const points = items
    .map((item, index) => {
      const x = left + index * step + step / 2;
      const y = baseY - chartHeight * (item.percent / 100);
      return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`;
    })
    .join(" ");
  const chart = { left, top, baseY, chartHeight, step, barWidth, width };
  const groups = items.map((item, index) => renderComboSkillGroup(item, index, chart)).join("");
  const markers = items
    .map((item, index) => {
      const x = left + index * step + step / 2;
      const y = baseY - chartHeight * (item.percent / 100);
      return `<circle class="combo-line-dot" cx="${Number(x.toFixed(2))}" cy="${Number(y.toFixed(2))}" r="4"></circle>`;
    })
    .join("");
  const tooltips = items.map((item, index) => renderComboTooltipGroup(item, index, chart)).join("");

  return `
    <div class="skill-chart-block skill-chart-block--combo chart-anim" aria-label="Skill progress chart">
      <svg class="skill-chart-svg combo-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Completed lessons by skill">
        <g>${grid}</g>
        <g>${groups}</g>
        <polyline class="combo-line" points="${points}"></polyline>
        <g>${markers}</g>
        <g class="combo-tooltip-layer">${tooltips}</g>
      </svg>
    </div>
  `;
}

function setupChartRevealAnimations() {
  const charts = Array.from(document.querySelectorAll(".chart-anim"));
  if (!charts.length) return;

  charts.forEach((chart) => {
    chart.classList.remove("is-visible");
    chart.removeAttribute("data-chart-revealed");
  });

  if (!("IntersectionObserver" in window)) {
    requestAnimationFrame(() => {
      charts.forEach((chart) => {
        chart.dataset.chartRevealed = "true";
        chart.classList.add("is-visible");
      });
    });
    return;
  }

  chartRevealObserver?.disconnect();
  chartRevealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || entry.target.dataset.chartRevealed) return;
        entry.target.dataset.chartRevealed = "true";
        entry.target.classList.add("is-visible");
        chartRevealObserver.unobserve(entry.target);
      });
    },
    {
      threshold: 0.32,
      rootMargin: "0px 0px -12% 0px",
    }
  );

  charts.forEach((chart) => chartRevealObserver.observe(chart));
}

function renderComboSkillGroup(item, index, chart) {
  const percent = clamp(item.percent, 0, 100);
  const xCenter = chart.left + index * chart.step + chart.step / 2;
  const barX = xCenter - chart.barWidth / 2;
  const barHeight = chart.chartHeight * (percent / 100);
  const visibleBarHeight = percent > 0 ? barHeight : 3;
  const barY = chart.baseY - visibleBarHeight;
  const hitX = chart.left + index * chart.step;

  return `
    <g class="combo-skill-group" tabindex="0">
      <rect class="combo-hit-zone" x="${Number(hitX.toFixed(2))}" y="${chart.top}" width="${Number(chart.step.toFixed(2))}" height="${chart.chartHeight + 30}"></rect>
      <rect class="combo-track" x="${Number(barX.toFixed(2))}" y="${chart.top}" width="${Number(chart.barWidth.toFixed(2))}" height="${chart.chartHeight}" rx="10"></rect>
      <rect class="combo-bar-fill ${percent === 0 ? "is-empty" : ""}" x="${Number(barX.toFixed(2))}" y="${Number(barY.toFixed(2))}" width="${Number(chart.barWidth.toFixed(2))}" height="${Number(visibleBarHeight.toFixed(2))}" rx="10" style="--skill-color: ${escapeHtml(item.color)}; --bar-delay: ${Number((index * 0.06).toFixed(2))}s;"></rect>
      <text class="combo-x-label" x="${Number(xCenter.toFixed(2))}" y="${chart.baseY + 28}" text-anchor="middle">${escapeHtml(getShortSkillLabel(item.title))}</text>
    </g>
  `;
}

function renderComboTooltipGroup(item, index, chart) {
  const percent = clamp(item.percent, 0, 100);
  const xCenter = chart.left + index * chart.step + chart.step / 2;
  const hitX = chart.left + index * chart.step;
  const pointY = chart.baseY - chart.chartHeight * (percent / 100);
  const tooltipWidth = 122;
  const tooltipHeight = 60;
  const tooltipX = clamp(xCenter - tooltipWidth / 2, 6, chart.width - tooltipWidth - 6);
  const tooltipY = pointY > chart.top + 54 ? pointY - tooltipHeight - 12 : pointY + 12;
  const tooltipArrowX = clamp(xCenter - tooltipX, 14, tooltipWidth - 14);
  const arrowSide = pointY > chart.top + 54 ? "bottom" : "top";

  return `
    <g class="combo-tooltip-group" tabindex="0" aria-label="${escapeHtml(item.title)} ${item.status}">
      <rect class="combo-tooltip-hit-zone" x="${Number(hitX.toFixed(2))}" y="${chart.top}" width="${Number(chart.step.toFixed(2))}" height="${chart.chartHeight + 30}"></rect>
      ${renderComboTooltip(item, tooltipX, tooltipY, tooltipWidth, tooltipHeight, tooltipArrowX, arrowSide)}
    </g>
  `;
}

function renderComboTooltip(item, x, y, width, height, arrowX, arrowSide = "bottom") {
  const totalLine = item.total ? `${item.completed}/${item.total} completed` : "No lessons yet";
  const detailLine = item.total ? `${item.total} tracked lessons` : "Waiting for data";
  const arrowHalf = 7;
  const arrowHeight = 9;
  const arrowPoints =
    arrowSide === "top"
      ? `${Number((arrowX - arrowHalf).toFixed(2))},0 ${Number(arrowX.toFixed(2))},-${arrowHeight} ${Number((arrowX + arrowHalf).toFixed(2))},0`
      : `${Number((arrowX - arrowHalf).toFixed(2))},${height} ${Number(arrowX.toFixed(2))},${height + arrowHeight} ${Number((arrowX + arrowHalf).toFixed(2))},${height}`;
  return `
    <g class="chart-tooltip chart-tooltip--combo" transform="translate(${Number(x.toFixed(2))} ${Number(y.toFixed(2))})">
      <polygon class="chart-tooltip-arrow" points="${arrowPoints}"></polygon>
      <rect width="${width}" height="${height}" rx="8"></rect>
      <text class="chart-tooltip-title" x="${width / 2}" y="19" text-anchor="middle">${escapeHtml(item.title)}</text>
      <text class="chart-tooltip-line" x="${width / 2}" y="39" text-anchor="middle">${escapeHtml(totalLine)}</text>
      <text class="chart-tooltip-line chart-tooltip-line--muted" x="${width / 2}" y="53" text-anchor="middle">${escapeHtml(detailLine)}</text>
    </g>
  `;
}

function renderPieChart(items) {
  const width = 260;
  const height = 260;
  const center = 130;
  const radius = 94;
  const totalCompleted = items.reduce((sum, item) => sum + item.completed, 0);
  const activeItems = items.filter((item) => item.completed > 0);
  let currentAngle = 0;
  const slices = totalCompleted
    ? activeItems
        .map((item, index) => {
          const sliceSize = (item.completed / totalCompleted) * 360;
          const startAngle = currentAngle;
          const endAngle = currentAngle + sliceSize;
          currentAngle = endAngle;
          const share = Math.round((item.completed / totalCompleted) * 100);
          const tooltipItem = {
            ...item,
            tooltipDetail: `${item.completed} (${share}%)`,
            tooltipMeta: "completed lessons",
          };
          const sliceMarkup =
            sliceSize >= 359.99
              ? `<circle class="pie-slice" cx="${center}" cy="${center}" r="${radius}" style="--skill-color: ${escapeHtml(item.color)}; --slice-delay: ${Number((index * 0.08).toFixed(2))}s;"></circle>`
              : `<path class="pie-slice" d="${getPieSlicePath(center, center, radius, startAngle, endAngle)}" style="--skill-color: ${escapeHtml(item.color)}; --slice-delay: ${Number((index * 0.08).toFixed(2))}s;"></path>`;
          const midAngle = startAngle + sliceSize / 2;
          const tooltip = getPieTooltipPosition(center, center, radius, midAngle, width, height);
          const hoverOffset = getPolarPoint(0, 0, 4, midAngle);
          return `
            <g class="pie-slice-group" tabindex="0" aria-label="${escapeHtml(item.title)} ${item.completed} (${share}%)" style="--slice-offset-x: ${hoverOffset.x}px; --slice-offset-y: ${hoverOffset.y}px;">
              ${sliceMarkup}
              ${renderPieTooltip(tooltipItem, tooltip.x, tooltip.y, tooltip.width, tooltip.height, tooltip.arrowPoints)}
            </g>
          `;
        })
        .join("")
    : "";
  const emptyState = totalCompleted
    ? ""
    : `
        <circle class="pie-empty-ring" cx="${center}" cy="${center}" r="${radius}"></circle>
        <text class="pie-empty-text" x="${center}" y="${center}" text-anchor="middle" dominant-baseline="middle">No data</text>
      `;

  return `
    <div class="skill-chart-block skill-chart-block--pie chart-anim" aria-label="Skill category chart">
      <svg class="skill-chart-svg pie-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Skill categories">
        <g class="pie-slices">${slices}</g>
        ${emptyState}
      </svg>
    </div>
  `;
}

function renderPieTooltip(item, x, y, width, height, arrowPoints) {
  const totalLine = item.tooltipDetail || (item.total ? `${item.completed}/${item.total}` : "No data");
  const detailLine = item.tooltipMeta || "completed lessons";
  return `
    <g class="chart-tooltip chart-tooltip--pie" transform="translate(${Number(x.toFixed(2))} ${Number(y.toFixed(2))})">
      <polygon class="chart-tooltip-arrow" points="${arrowPoints}"></polygon>
      <rect width="${width}" height="${height}" rx="8"></rect>
      <circle class="chart-tooltip-color" cx="15" cy="18" r="4" style="--skill-color: ${escapeHtml(item.color)}"></circle>
      <text class="chart-tooltip-title" x="28" y="21">${escapeHtml(item.title)}</text>
      <text class="chart-tooltip-line" x="28" y="42">${escapeHtml(totalLine)}</text>
      <text class="chart-tooltip-line chart-tooltip-line--muted" x="28" y="56">${escapeHtml(detailLine)}</text>
    </g>
  `;
}

function getPieSlicePath(cx, cy, radius, startAngle, endAngle) {
  const start = getPolarPoint(cx, cy, radius, startAngle);
  const end = getPolarPoint(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y} Z`;
}

function getPieTooltipPosition(cx, cy, radius, angle, width, height) {
  const tooltipWidth = 148;
  const tooltipHeight = 64;
  const gap = 16;
  const normalizedAngle = ((angle % 360) + 360) % 360;
  const point = getPolarPoint(cx, cy, radius, normalizedAngle);
  const arrowSize = 10;
  const arrowHalf = 7;

  if (normalizedAngle >= 45 && normalizedAngle < 135) {
    const x = cx + radius + gap;
    const y = clamp(point.y - tooltipHeight / 2, 4, height - tooltipHeight - 4);
    const arrowY = clamp(point.y - y, arrowHalf + 8, tooltipHeight - arrowHalf - 8);
    return {
      x,
      y,
      width: tooltipWidth,
      height: tooltipHeight,
      arrowPoints: `0,${Number((arrowY - arrowHalf).toFixed(2))} -${arrowSize},${Number(arrowY.toFixed(2))} 0,${Number((arrowY + arrowHalf).toFixed(2))}`,
    };
  }

  if (normalizedAngle >= 135 && normalizedAngle < 225) {
    const x = clamp(point.x - tooltipWidth / 2, 4, width - tooltipWidth - 4);
    const y = cy + radius + gap;
    const arrowX = clamp(point.x - x, arrowHalf + 10, tooltipWidth - arrowHalf - 10);
    return {
      x,
      y,
      width: tooltipWidth,
      height: tooltipHeight,
      arrowPoints: `${Number((arrowX - arrowHalf).toFixed(2))},0 ${Number(arrowX.toFixed(2))},-${arrowSize} ${Number((arrowX + arrowHalf).toFixed(2))},0`,
    };
  }

  if (normalizedAngle >= 225 && normalizedAngle < 315) {
    const x = cx - radius - gap - tooltipWidth;
    const y = clamp(point.y - tooltipHeight / 2, 4, height - tooltipHeight - 4);
    const arrowY = clamp(point.y - y, arrowHalf + 8, tooltipHeight - arrowHalf - 8);
    return {
      x,
      y,
      width: tooltipWidth,
      height: tooltipHeight,
      arrowPoints: `${tooltipWidth},${Number((arrowY - arrowHalf).toFixed(2))} ${tooltipWidth + arrowSize},${Number(arrowY.toFixed(2))} ${tooltipWidth},${Number((arrowY + arrowHalf).toFixed(2))}`,
    };
  }

  const x = clamp(point.x - tooltipWidth / 2, 4, width - tooltipWidth - 4);
  const y = cy - radius - gap - tooltipHeight;
  const arrowX = clamp(point.x - x, arrowHalf + 10, tooltipWidth - arrowHalf - 10);
  return {
    x,
    y,
    width: tooltipWidth,
    height: tooltipHeight,
    arrowPoints: `${Number((arrowX - arrowHalf).toFixed(2))},${tooltipHeight} ${Number(arrowX.toFixed(2))},${tooltipHeight + arrowSize} ${Number((arrowX + arrowHalf).toFixed(2))},${tooltipHeight}`,
  };
}

function getPolarPoint(cx, cy, radius, angle) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: Number((cx + radius * Math.cos(radians)).toFixed(2)),
    y: Number((cy + radius * Math.sin(radians)).toFixed(2)),
  };
}

function renderChartTooltip(item, x, y, width, height) {
  const totalLine = item.tooltipDetail || (item.total ? `${item.completed}/${item.total} completed` : "No lessons yet");
  const detailLine = item.tooltipMeta || (item.total ? `${item.total} tracked lessons` : "Waiting for data");
  return `
    <g class="chart-tooltip" transform="translate(${Number(x.toFixed(2))} ${Number(y.toFixed(2))})">
      <rect width="${width}" height="${height}" rx="10"></rect>
      <text class="chart-tooltip-title" x="10" y="18">${escapeHtml(item.title)}</text>
      <text class="chart-tooltip-line" x="10" y="36">${escapeHtml(totalLine)}</text>
      <text class="chart-tooltip-line" x="10" y="50">${escapeHtml(detailLine)}</text>
    </g>
  `;
}

function getShortSkillLabel(title) {
  const labels = {
    Listening: "Listen",
    Reading: "Read",
    Speaking: "Speak",
    Writing: "Write",
    Practice: "Practice",
  };
  return labels[title] || title;
}

function normalizeMapItem(item) {
  const percent = item.total > 0 ? Math.round((item.completed / item.total) * 100) : 0;
  return {
    ...item,
    percent,
    status: `${item.completed}/${item.total}`,
  };
}

function getSpiderPoints(count, scale, center, radius) {
  return Array.from({ length: count }, (_, index) => {
    const point = getSpiderPoint(index, count, scale, center, radius);
    return `${point.x},${point.y}`;
  }).join(" ");
}

function getSpiderPoint(index, count, scale, center, radius) {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / count;
  return {
    x: Number((center + Math.cos(angle) * radius * scale).toFixed(2)),
    y: Number((center + Math.sin(angle) * radius * scale).toFixed(2)),
  };
}

function getLearningMapItems() {
  const listeningLessons = getCourseLessons("nghe-doc", isListeningPart);
  const readingLessons = getCourseLessons("nghe-doc", isReadingPart);
  const speakingLessons = getCourseLessons("noi-viet", isSpeakingPart);
  const writingLessons = getCourseLessons("noi-viet", isWritingPart);
  const practiceItems = getTrackedPracticeItems();

  return [
    {
      title: "Listening",
      axisLabel: "Listening",
      description: `${listeningLessons.length || 0} lessons from TOEIC Listening Parts 1-4`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#ff9600",
      softColor: "rgba(255, 150, 0, 0.13)",
      completed: countCompleted("nghe-doc", listeningLessons),
      total: listeningLessons.length,
    },
    {
      title: "Reading",
      axisLabel: "Reading",
      description: `${readingLessons.length || 0} lessons from TOEIC Reading Parts 5-7`,
      href: "./hoc-phan-chi-tiet.html?course=nghe-doc",
      color: "#1cb0f6",
      softColor: "rgba(28, 176, 246, 0.13)",
      completed: countCompleted("nghe-doc", readingLessons),
      total: readingLessons.length,
    },
    {
      title: "Speaking",
      axisLabel: "Speaking",
      description: `${speakingLessons.length || 0} lessons from current Speaking data`,
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#58cc02",
      softColor: "rgba(88, 204, 2, 0.14)",
      completed: countCompleted("noi-viet", speakingLessons),
      total: speakingLessons.length,
    },
    {
      title: "Writing",
      axisLabel: "Writing",
      description: `${writingLessons.length || 0} lessons from current Writing data`,
      href: "./hoc-phan-chi-tiet.html?course=noi-viet",
      color: "#ff4b4b",
      softColor: "rgba(255, 75, 75, 0.12)",
      completed: countCompleted("noi-viet", writingLessons),
      total: writingLessons.length,
    },
    {
      title: "Practice",
      axisLabel: "Practice",
      description: `${practiceItems.length || 0} tracked practice exercises`,
      href: "./luyen-de.html",
      color: "#ffc800",
      softColor: "rgba(255, 200, 0, 0.16)",
      completed: countPracticeCompleted(practiceItems),
      total: practiceItems.length,
    },
  ];
}

function isListeningPart(part) {
  const partNumber = getPartNumber(part.id);
  return partNumber >= 1 && partNumber <= 4;
}

function isReadingPart(part) {
  const partNumber = getPartNumber(part.id);
  return partNumber >= 5;
}

function isSpeakingPart(part) {
  return /speaking|read-text-aloud|speak/i.test(`${part.id || ""} ${part.title || ""}`);
}

function isWritingPart(part) {
  return /writing|write|email|essay|respond/i.test(`${part.id || ""} ${part.title || ""}`);
}

function getCourseLessons(courseId, partFilter = () => true) {
  const course = getCourse(courseId);
  if (!course) return [];
  if (!course.parts?.length) return (course.lessons || []).filter((item) => !item.isExercise);

  return course.parts
    .filter(partFilter)
    .flatMap((part) => part.items || [])
    .filter((item) => !item.isExercise);
}

function getCourseExercises(courseId) {
  const course = getCourse(courseId);
  if (!course) return [];
  if (!course.parts?.length) return (course.lessons || []).filter((item) => item.isExercise);

  return course.parts.flatMap((part) => part.items || []).filter((item) => item.isExercise);
}

function getTrackedPracticeItems() {
  const explicitPracticeItems = getExplicitPracticeItems();
  if (explicitPracticeItems.length) return explicitPracticeItems;

  return getCourseExercises("nghe-doc").map((item) => ({
    ...item,
    courseId: "nghe-doc",
  }));
}

function getExplicitPracticeItems() {
  return [];
}

function getCourse(courseId) {
  return activeCoursesById.get(courseId) || null;
}

function getPartNumber(partId) {
  const match = String(partId || "").match(/part-(\d+)/);
  return match ? Number(match[1]) : 0;
}

function countCompleted(courseId, items) {
  return items.filter((item) => activeCompletedLessons.has(getCompletedLessonKey(item.courseId || courseId, item.id))).length;
}

function countPracticeCompleted(items) {
  const itemKeys = new Set(items.map((item) => getCompletedLessonKey(item.courseId || "practice", item.id)));
  const completedKeys = new Set();

  items.forEach((item) => {
    const key = getCompletedLessonKey(item.courseId || "practice", item.id);
    if (activeCompletedLessons.has(key)) completedKeys.add(key);
  });

  activeActivities.forEach((activity) => {
    if (!["practice-opened", "practice-completed"].includes(activity.type)) return;
    const key = getCompletedLessonKey(activity.courseId || "practice", activity.lessonId || activity.itemId);
    if (itemKeys.has(key)) completedKeys.add(key);
  });

  return completedKeys.size;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setAuthState(state) {
  document.body.classList.toggle("is-signed-in", state === "signed-in");
  document.body.classList.toggle("is-signed-out", state === "signed-out");
  document.body.classList.remove("auth-loading");
}

function cleanupListeners() {
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
}

function resetProfile() {
  document.querySelector("#userAvatar").src = "";
  document.querySelector("#userName").textContent = "TOEIC Learner";
  document.querySelector("#userEmail").textContent = "";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
