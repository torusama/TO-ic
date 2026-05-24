import { ensureDefaultNotifications, deleteNotification, listenNotifications, markNotificationRead } from "./notification-service.js";
import { claimStreakAnimation, ensureUserProfile, listenUserProfile, listenPairStreaks, onUserChanged, getMutualFollowers, getPairStreaks, sendStreakInvite, acceptPairStreak, rejectPairStreak, getPublicProfile, sendPairStreakNudgeReminder } from "./user-service.js";
import { hasAdminAccess } from "./access-control.js";
import { rollStreakNumber, setStreakNumber } from "./streak-animation.js";

const currentPage = document.body.dataset.page;
const links = [
  { id: "hoc-phan", label: "Courses", href: "./hoc-phan.html" },
  { id: "tu-vung", label: "Flash Card", href: "./tu-vung.html" },
  { id: "luyen-de", label: "Practice", href: "./luyen-de.html" },
  { id: "ca-nhan", label: "Profile", href: "./ca-nhan.html" },
];

const header = document.querySelector("#site-header");
let activeUser = null;
let notifications = [];
let allowNotificationItemAnimation = false;
let activePairTab = "friends";
let activeLoadPairFriends = null;
let cachedMutuals = null;
let cachedPairStreaks = null;
let unsubscribeNotifications = () => {};
let unsubscribeHeaderProfile = () => {};
let unsubscribePairStreaks = () => {};
let closeTimer;
let cachedProfile = null;
const checkedHeaderAnimations = new Set();
const playedStreakPopupKeys = new Set();
const shownPairNudgeKeys = new Set();
const renderedNotificationIds = new Set();
const animatedNotificationIds = new Set();
let shouldCheckPairNudgeAfterStreak = false;
let activePairNudgeCandidate = null;
let pairNudgeCloseTimer = null;

if (header) {
  header.innerHTML = `
    <header class="topbar">
      <div class="topbar__inner">
        <a class="brand" href="./hoc-phan.html" aria-label="TOEIC Learning">
          <img src="https://d35aaqx5ub95lt.cloudfront.net/images/splash/f92d5f2f7d56636846861c458c0d0b6c.svg" alt="" width="140" height="33" />
          <span class="brand__divider"></span>
          <span>TOEIC GUIDE</span>
          <div class="header-streak" id="headerStreak">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 18px; height: 18px; flex-shrink:0;">
              <path fill="#ff9600" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
              <path fill="#ffc800" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z" />
            </svg>
            <strong class="streak-val" data-header-streak-val>0</strong>
          </div>
          <div class="header-streak header-streak--pair" id="headerPairStreak" style="display: none; margin-left: 8px;">
            <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 18px; height: 18px; flex-shrink:0;">
              <path class="flame-path-1" fill="#c084fc" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
              <path class="flame-path-2" fill="#e879f9" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z" />
            </svg>
            <strong class="streak-val" data-header-pair-streak-val>0</strong>
          </div>
        </a>
        <div class="topbar__right">
          <nav class="nav-links" aria-label="Main navigation">
            ${links.map((link) => `<a class="${link.id === currentPage ? "is-active" : ""}" href="${link.href}">${link.label}</a>`).join("")}
            <a href="./admin.html" id="adminNav" style="display: none; color: var(--green); font-weight: 800;">Admin</a>
          </nav>
          <div class="notification-menu">
            <button class="notification-bell" type="button" aria-label="Notifications" aria-expanded="false" aria-controls="notificationPopover">
              <svg class="notification-bell__icon bell-art" viewBox="0 0 24 24" aria-hidden="true">
                <path class="bell-art__body" d="M7 10.15C7 6.92 9.14 4.5 12 4.5s5 2.42 5 5.65v1.46c0 .8.21 1.58.6 2.28l.77 1.4c.43.78-.13 1.71-1.02 1.71H6.65c-.89 0-1.45-.93-1.02-1.71l.77-1.4c.39-.7.6-1.48.6-2.28v-1.46Z" />
                <path class="bell-art__clapper" d="M9.8 18h4.4a2.2 2.2 0 0 1-4.4 0Z" />
                <path class="bell-art__shine" d="M10 7.35c.48-.5 1.17-.78 2-.78.34 0 .62.28.62.62s-.28.62-.62.62c-.49 0-.85.14-1.1.42-.25.27-.4.68-.44 1.23a.62.62 0 1 1-1.24-.08c.05-.84.31-1.52.78-2.03Z" />
              </svg>
              <strong data-notification-count hidden></strong>
            </button>
            <section id="notificationPopover" class="notification-popover" hidden>
              <div class="notification-popover__head">
                <span>Notifications</span>
                <small data-notification-summary>0 new</small>
              </div>
              <div class="notification-popover__list" data-notification-list></div>
              <a class="notification-popover__detail" href="./ca-nhan.html#thong-bao">View details</a>
            </section>
          </div>
        </div>
      </div>
    </header>
    <nav class="mobile-bottom-nav" aria-label="Mobile navigation">
      ${links.map((link) => {
        let iconSvg = '';
        if (link.id === 'hoc-phan') iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/><path d="M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>';
        if (link.id === 'tu-vung') iconSvg = '<svg viewBox="0 0 24 24"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>';
        if (link.id === 'luyen-de') iconSvg = '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
        if (link.id === 'ca-nhan') iconSvg = '<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';

        return `
          <a class="mobile-bottom-nav__link ${link.id === currentPage ? "is-active" : ""}" href="${link.href}">
            <div class="mobile-bottom-nav__icon">${iconSvg}</div>
            <span class="mobile-bottom-nav__label">${link.label}</span>
          </a>
        `;
      }).join("")}
    </nav>
    <section id="streakModal" class="profile-modal" hidden>
      <div class="profile-modal__backdrop" data-close-streak-modal></div>
      <article class="profile-modal__panel streak-modal-panel" role="dialog" aria-modal="true" aria-labelledby="streakModalTitle">
        <div class="profile-modal__head" style="align-items: center; justify-content: space-between; display: flex; width: 100%;">
          <div id="streakModalDefaultHead" style="display:block;">
            <p class="eyebrow">Your Journey</p>
            <h2 id="streakModalTitle">Streak Status</h2>
          </div>
          <div id="streakModalPairHead" style="display:none; align-items:center; gap: 12px;">
            <button id="streakModalBackBtn" type="button" style="background:none; border:none; padding:0; cursor:pointer; color:var(--gray-light); display:grid; place-items:center;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <h2 style="margin:0; font-size:24px; color:var(--dark-blue);">Pair Streak</h2>
          </div>
          <button class="profile-modal__close" type="button" data-close-streak-modal aria-label="Close">&times;</button>
        </div>

        <div class="streak-modal-content">
          <div id="streakViewMain">
            <div class="streak-week-view">
              <h3><strong id="streakModalCount" style="color:var(--orange)">0</strong> day streak</h3>
              <div class="streak-week-grid" id="streakWeekGrid"></div>
              <p class="streak-week-msg" id="streakWeekMsg">Complete a lesson today to extend your streak!</p>
            </div>

            <div class="pair-streak-section">
              <div class="pair-streak-init">
                <button class="btn btn--secondary" id="loadPairStreakBtn" style="text-transform:uppercase; letter-spacing:0.5px;">Start a Pair Streak</button>
              </div>
            </div>
          </div>

          <div id="streakViewPair" style="display:none;">
            <div class="pair-streak-tabs" style="display:flex; margin-bottom:20px; border-bottom: 2px solid var(--border-color); padding-bottom: 4px; gap: 0; position: relative;">
              <button type="button" id="tabStreakFriends" class="pair-streak-tab active" style="background:none; border:none; padding:8px 0; font-size:13px; font-weight:900; color:var(--dark-blue); cursor:pointer; flex: 1; text-align: center; text-transform: uppercase; letter-spacing:0.5px; transition: color 0.2s ease;">
                Find Friends
              </button>
              <button type="button" id="tabStreakInvites" class="pair-streak-tab" style="background:none; border:none; padding:8px 0; font-size:13px; font-weight:900; color:var(--gray-light); cursor:pointer; flex: 1; text-align: center; text-transform: uppercase; letter-spacing:0.5px; transition: color 0.2s ease; position: relative;">
                Invitations
                <span id="streakInvitesBadge" style="display:none; position:absolute; top:-2px; right:4px; background:#ef4444; color:white; font-size:10px; font-weight:800; border-radius:10px; padding:2px 6px; line-height:1;">0</span>
              </button>
              <div id="tabSlider" style="position: absolute; bottom: -2px; left: 0; width: 50%; height: 3px; background: var(--dark-blue); border-radius: 3px; transition: transform 0.3s cubic-bezier(0.25, 1, 0.5, 1); z-index: 1;"></div>
            </div>
            <div id="pairStreakList" class="pair-streak-list"></div>
          </div>
        </div>
      </article>
    </section>
    <section id="pairNudgeModal" class="profile-modal" hidden>
      <div class="profile-modal__backdrop" data-close-pair-nudge></div>
      <article class="profile-modal__panel pair-nudge-panel" role="dialog" aria-modal="true" aria-labelledby="pairNudgeTitle">
        <button class="profile-modal__close" type="button" data-close-pair-nudge aria-label="Close">&times;</button>
        <div class="pair-nudge-avatar-wrap">
          <img class="pair-nudge-avatar" id="pairNudgeAvatar" src="https://www.gravatar.com/avatar/?d=mp" alt="" />
          <span class="pair-nudge-check" aria-hidden="true">✓</span>
        </div>
        <h2 id="pairNudgeTitle">Keep the team streak alive</h2>
        <p id="pairNudgeBody">Your partner has not studied today yet.</p>
        <div class="pair-nudge-actions">
          <button class="btn btn--primary" type="button" id="sendPairNudgeBtn">Remind Partner</button>
        </div>
        <p class="pair-nudge-status" id="pairNudgeStatus" aria-live="polite"></p>
      </article>
    </section>
  `;

  const menu = header.querySelector(".notification-menu");
  const bell = header.querySelector(".notification-bell");
  const popover = header.querySelector("#notificationPopover");
  const badge = header.querySelector("[data-notification-count]");
  const summary = header.querySelector("[data-notification-summary]");
  const list = header.querySelector("[data-notification-list]");

  renderNotifications();

  onUserChanged(async (user) => {
    activeUser = user;
    cachedMutuals = null;
    cachedPairStreaks = null;
    cachedProfile = null;
    activePairNudgeCandidate = null;
    shouldCheckPairNudgeAfterStreak = false;
    allowNotificationItemAnimation = false;
    renderedNotificationIds.clear();
    animatedNotificationIds.clear();
    unsubscribeNotifications();
    unsubscribeHeaderProfile();
    unsubscribePairStreaks();
    notifications = [];
    renderNotifications();
    renderHeaderStreak(null);
    renderHeaderPairStreak([]);

    const adminNav = document.getElementById("adminNav");
    if (adminNav) {
      adminNav.style.display = hasAdminAccess(user) ? "" : "none";
    }

    if (!user) return;

    try {
      unsubscribeNotifications = listenNotifications(
        user.uid,
        (items) => {
          notifications = items;
          renderNotifications();
          allowNotificationItemAnimation = true;
        },
        (error) => {
          console.warn("Could not listen to notifications:", error);
          notifications = [];
          renderNotifications();
        }
      );

      unsubscribePairStreaks = listenPairStreaks(
        user.uid,
        (items) => {
          cachedPairStreaks = items;
          renderHeaderPairStreak(items);
        },
        (error) => {
          console.warn("Could not listen to pair streaks:", error);
          cachedPairStreaks = [];
          renderHeaderPairStreak([]);
        }
      );

      unsubscribeHeaderProfile = listenUserProfile(
        user.uid,
        (nextProfile) => {
          cachedProfile = nextProfile;
          renderHeaderStreak(nextProfile);
        },
        (error) => console.warn("Could not listen to header profile:", error)
      );

      // Run profile initialization and seeding in background
      ensureUserProfile(user).then((profile) => {
        if (profile) {
          if (!cachedProfile) {
            cachedProfile = profile;
            renderHeaderStreak(profile);
          }
          ensureDefaultNotifications(user, profile).catch((err) => {
            console.warn("Could not ensure default notifications:", err);
          });
        }
      }).catch((error) => {
        console.warn("Could not initialize profile database:", error);
      });
    } catch (error) {
      console.warn("Could not initialize notification data:", error);
    }
  });

  bell?.addEventListener("click", () => {
    if (popover.hidden) {
      openPopover();
    } else {
      closePopover();
    }
  });

  list?.addEventListener("click", async (event) => {

    const item = event.target.closest("[data-notification-id]");
    if (!item || !activeUser) return;

    const notifId = item.dataset.notificationId;
    const notifData = notifications.find((n) => n.id === notifId);

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

  list?.addEventListener("keydown", async (event) => {
    if ((event.key !== "Enter" && event.key !== " ") || !activeUser) return;
    const item = event.target.closest("[data-notification-id]");
    if (!item) return;
    event.preventDefault();
    const notifData = notifications.find((n) => n.id === item.dataset.notificationId);
    try {
      await markNotificationRead(activeUser.uid, item.dataset.notificationId);
      openNotificationTarget(notifData);
    } catch (error) {
      console.warn("Could not mark notification as read:", error);
    }
  });

  document.addEventListener("click", (event) => {
    if (popover?.hidden || event.composedPath().includes(menu)) return;
    closePopover();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || popover?.hidden) return;
    closePopover({ focusBell: true });
  });

  function renderNotifications() {
    const unreadCount = notifications.filter((item) => item.unread).length;
    bell.classList.toggle("has-unread", unreadCount > 0);
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 0 ? unreadCount : "";
    summary.textContent = activeUser ? `${unreadCount} new` : "Signed out";
    list.classList.toggle("is-empty", notifications.length === 0);

    if (!activeUser) {
      list.innerHTML = `<div class="notification-popover__empty">Sign in to view notifications.</div>`;
      return;
    }

    list.innerHTML = notifications.length
      ? notifications
          .map((item) => {
            const id = String(item.id || "");
            const isNewUnread = Boolean(
              id &&
                item.unread &&
                allowNotificationItemAnimation &&
                !renderedNotificationIds.has(id) &&
                !animatedNotificationIds.has(id)
            );
            if (isNewUnread) animatedNotificationIds.add(id);
            return `
                <article class="notification-popover__item ${item.unread ? "is-unread" : ""} ${isNewUnread ? "is-new" : ""}" data-notification-id="${escapeHtml(id)}" tabindex="0">
                  <div style="flex-grow:1; display:flex; flex-direction:column; align-items:flex-start;">
                    <strong>${escapeHtml(item.title)}</strong>
                    <span style="margin-bottom:2px;">${escapeHtml(item.body)}</span>
                  </div>
                  <button class="notification-popover__delete" type="button" data-delete-notification aria-label="Delete notification">&times;</button>
                </article>
              `;
          })
          .join("")
      : `<div class="notification-popover__empty">No notifications yet.</div>`;

    syncRenderedNotificationIds(notifications);
  }

  function syncRenderedNotificationIds(items) {
    const nextIds = new Set(items.map((item) => String(item.id || "")).filter(Boolean));
    renderedNotificationIds.forEach((id) => {
      if (!nextIds.has(id)) renderedNotificationIds.delete(id);
    });
    nextIds.forEach((id) => renderedNotificationIds.add(id));
  }

  function openNotificationTarget(notifData) {
    if (!notifData) return;
    if (notifData.type === "streak_invite" || notifData.type === "streak_accept" || notifData.type === "pair_streak_broken") {
      closePopover();
      openStreakModal(false, true, notifData.type === "streak_invite" ? "invites" : "friends");
    }
  }

  function openPopover() {
    clearTimeout(closeTimer);
    popover.hidden = false;
    requestAnimationFrame(() => popover.classList.add("is-open"));
    bell.setAttribute("aria-expanded", "true");
  }

  function closePopover({ focusBell = false } = {}) {
    popover.classList.remove("is-open");
    bell.setAttribute("aria-expanded", "false");
    closeTimer = setTimeout(() => {
      popover.hidden = true;
      if (focusBell) bell.focus();
    }, 180);
  }

  async function renderHeaderStreak(profile) {
    const headerStreak = header.querySelector("#headerStreak");
    const streakVal = header.querySelector("[data-header-streak-val]");

    if (!headerStreak || !streakVal) return;

    headerStreak.style.display = activeUser ? "flex" : "none";
    const streak = Number(profile?.stats?.streak || 0);

    const lastStreakDate = profile?.stats?.lastStreakDate || "";
    const checkKey = `${activeUser?.uid || "guest"}__${lastStreakDate}__${streak}`;
    if (activeUser && lastStreakDate && streak > 0 && !checkedHeaderAnimations.has(checkKey)) {
      checkedHeaderAnimations.add(checkKey);
      const claim = await claimStreakAnimation(activeUser.uid, "header");
      if (claim.shouldAnimate) {
        rollStreakNumber(streakVal, claim.from, claim.to);
        openStreakModal(true);
      } else {
        setStreakNumber(streakVal, streak);
      }
    } else {
      setStreakNumber(streakVal, streak);
    }
  }

  function renderHeaderPairStreak(pairStreaks = cachedPairStreaks) {
    const headerPairStreak = header.querySelector("#headerPairStreak");
    const pairStreakVal = header.querySelector("[data-header-pair-streak-val]");

    if (!headerPairStreak || !pairStreakVal) return;

    if (!activeUser || !Array.isArray(pairStreaks) || !pairStreaks.length) {
      headerPairStreak.style.display = "none";
      return;
    }

    const activePairs = pairStreaks.filter((pair) => pair.status === "active" && !pair.isBroken);
    const brokenPairs = pairStreaks.filter((pair) => pair.status === "broken" || pair.isBroken);
    if (!activePairs.length && !brokenPairs.length) {
      headerPairStreak.style.display = "none";
      return;
    }

    const highestPair = activePairs.length
      ? activePairs.reduce((prev, current) => (prev.streak > current.streak ? prev : current))
      : { streak: 0, isBroken: true, status: "broken" };
    headerPairStreak.style.display = "flex";
    pairStreakVal.textContent = highestPair.isBroken || highestPair.status === "broken" ? "0" : highestPair.streak;
    headerPairStreak.classList.toggle("is-broken", highestPair.isBroken || highestPair.status === "broken" || highestPair.streak === 0);
  }

  const streakModal = document.querySelector("#streakModal");
  const closeStreakModalBtns = document.querySelectorAll("[data-close-streak-modal]");
  const headerStreakBtn = header.querySelector("#headerStreak");
  const pairNudgeModal = document.querySelector("#pairNudgeModal");
  const closePairNudgeBtns = document.querySelectorAll("[data-close-pair-nudge]");
  const sendPairNudgeBtn = document.querySelector("#sendPairNudgeBtn");
  const pairNudgeBody = document.querySelector("#pairNudgeBody");
  const pairNudgeAvatar = document.querySelector("#pairNudgeAvatar");
  const pairNudgeStatus = document.querySelector("#pairNudgeStatus");

  const viewMain = streakModal?.querySelector("#streakViewMain");
  const viewPair = streakModal?.querySelector("#streakViewPair");
  const headMain = streakModal?.querySelector("#streakModalDefaultHead");
  const headPair = streakModal?.querySelector("#streakModalPairHead");
  const backBtn = streakModal?.querySelector("#streakModalBackBtn");

  if (headerStreakBtn) {
    headerStreakBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStreakModal(false);
    });
  }

  const headerPairStreakBtn = header.querySelector("#headerPairStreak");
  if (headerPairStreakBtn) {
    headerPairStreakBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStreakModal(false, true); // Opens directly in pair view
    });
  }

  closeStreakModalBtns.forEach((btn) => btn.addEventListener("click", () => {
    settleStreakDayAnimations(streakModal);
    closeStreakModal();
  }));

  closePairNudgeBtns.forEach((btn) => btn.addEventListener("click", () => {
    closePairNudgeModal();
  }));

  sendPairNudgeBtn?.addEventListener("click", () => {
    if (!activeUser || !activePairNudgeCandidate || sendPairNudgeBtn.disabled) return;

    const user = activeUser;
    const candidate = { ...activePairNudgeCandidate };
    showPairNudgeQueued(candidate);

    sendPairStreakNudgeReminder(user, candidate.partnerUid, {
      keepalive: true,
    }).catch((error) => {
      console.warn("Could not send pair streak nudge after UI confirmation:", error);
    });
  });

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      viewMain.style.display = "block";
      viewPair.style.display = "none";
      headMain.style.display = "block";
      headPair.style.display = "none";
    });
  }

  const tabFriends = streakModal?.querySelector("#tabStreakFriends");
  const tabInvites = streakModal?.querySelector("#tabStreakInvites");
  const tabSlider = streakModal?.querySelector("#tabSlider");

  if (tabFriends && tabInvites) {
    tabFriends.addEventListener("click", () => {
      activePairTab = "friends";
      tabFriends.style.color = "var(--dark-blue)";
      tabInvites.style.color = "var(--gray-light)";
      if (tabSlider) tabSlider.style.transform = "translateX(0)";
      if (typeof activeLoadPairFriends === "function") activeLoadPairFriends();
    });

    tabInvites.addEventListener("click", () => {
      activePairTab = "invites";
      tabInvites.style.color = "var(--dark-blue)";
      tabFriends.style.color = "var(--gray-light)";
      if (tabSlider) tabSlider.style.transform = "translateX(100%)";
      if (typeof activeLoadPairFriends === "function") activeLoadPairFriends();
    });
  }

  window.openStreakModal = openStreakModal;

  function closeStreakModal() {
    if (streakModal) streakModal.hidden = true;
    if (shouldCheckPairNudgeAfterStreak) {
      shouldCheckPairNudgeAfterStreak = false;
      maybeOpenPairNudgeModal();
    }
  }

  function closePairNudgeModal() {
    if (pairNudgeCloseTimer) {
      clearTimeout(pairNudgeCloseTimer);
      pairNudgeCloseTimer = null;
    }
    if (pairNudgeModal) pairNudgeModal.hidden = true;
    activePairNudgeCandidate = null;
    resetPairNudgeFeedback();
  }

  async function openStreakModal(isAnimate = false, startOnPairView = false, initialTab = "friends") {
    if (!activeUser || !streakModal || !cachedProfile) return;
    streakModal.hidden = false;

    viewMain.style.display = startOnPairView ? "none" : "block";
    viewPair.style.display = startOnPairView ? "block" : "none";
    headMain.style.display = startOnPairView ? "none" : "block";
    headPair.style.display = startOnPairView ? "flex" : "none";

    if (startOnPairView) {
      activePairTab = initialTab;
      if (tabFriends && tabInvites) {
        if (activePairTab === "invites") {
          tabInvites.style.color = "var(--dark-blue)";
          tabFriends.style.color = "var(--gray-light)";
          if (tabSlider) tabSlider.style.transform = "translateX(100%)";
        } else {
          tabFriends.style.color = "var(--dark-blue)";
          tabInvites.style.color = "var(--gray-light)";
          if (tabSlider) tabSlider.style.transform = "translateX(0)";
        }
      }
    }

    const countEl = streakModal.querySelector("#streakModalCount");
    const gridEl = streakModal.querySelector("#streakWeekGrid");
    const msgEl = streakModal.querySelector("#streakWeekMsg");
    const pairListEl = streakModal.querySelector("#pairStreakList");

    countEl.parentElement.style.cursor = "";
    countEl.parentElement.onclick = null;

    const streak = Number(cachedProfile.stats?.streak || 0);
    const lastStreakDate = cachedProfile.stats?.lastStreakDate || "";
    const dayNames = ["M", "T", "W", "T", "F", "S", "S"];

    const today = new Date();
    const todayStr = getDateKey(today);
    const isTodayCompleted = lastStreakDate === todayStr;
    const streakPopupKey = `${activeUser.uid}__${todayStr}__${streak}`;
    const shouldAnimateToday = Boolean(
      isAnimate && isTodayCompleted && !playedStreakPopupKeys.has(streakPopupKey)
    );

    if (shouldAnimateToday) {
      playedStreakPopupKeys.add(streakPopupKey);
      shouldCheckPairNudgeAfterStreak = !startOnPairView;
    }

    countEl.textContent = String(streak);

    const weekStart = getWeekStartDate(today);
    gridEl.className = "streak-week-grid";
    gridEl.innerHTML = renderStreakWeekDays(weekStart, dayNames, (date) => {
      const dateKey = getDateKey(date);
      const isToday = dateKey === todayStr;
      return {
        isToday,
        isCompleted: isToday ? isTodayCompleted : date < today && streak > 0,
        isAnimating: isToday && shouldAnimateToday,
      };
    });

    if (shouldAnimateToday) {
      settleStreakDayAnimationAfterPop(gridEl.querySelector(".streak-day__flame.is-animating"));
    }

    if (isTodayCompleted) {
      msgEl.textContent = "You're on a roll! Come back tomorrow.";
    } else {
      msgEl.textContent = "Complete a lesson today to extend your streak!";
    }

    // Load Pair Streak Mutuals
    pairListEl.innerHTML = `
      <div class="pair-streak-init">
        <button class="btn btn--secondary" id="loadPairStreakBtn">Start a Pair Streak</button>
      </div>
    `;

    const loadBtn = document.getElementById("loadPairStreakBtn");

    async function loadPairFriends() {
      activeLoadPairFriends = loadPairFriends;
      let mutuals = cachedMutuals;
      let pairStreaks = cachedPairStreaks;

      settleStreakDayAnimations(streakModal);

      viewMain.style.display = "none";
      viewPair.style.display = "block";
      headMain.style.display = "none";
      headPair.style.display = "flex";

      if (!mutuals || !pairStreaks) {
        if (loadBtn) {
          loadBtn.textContent = "LOADING FRIENDS...";
          loadBtn.disabled = true;
        }
        pairListEl.innerHTML = `
          <div class="pair-streak-empty" style="width: 100%;">
            <p>Loading pair streaks...</p>
          </div>
        `;

        const [fetchedMutuals, fetchedPairStreaks] = await Promise.all([
          getMutualFollowers(activeUser.uid),
          getPairStreaks(activeUser.uid)
        ]);

        cachedMutuals = fetchedMutuals;
        cachedPairStreaks = fetchedPairStreaks;
        mutuals = fetchedMutuals;
        pairStreaks = fetchedPairStreaks;
      }

      if (loadBtn) {
        loadBtn.textContent = "START A PAIR STREAK";
        loadBtn.disabled = false;
      }

      const pendingInvites = pairStreaks.filter(ps => ps.status === "pending" && ps.invitedBy !== activeUser.uid);

      const tabBadge = streakModal.querySelector("#streakInvitesBadge");
      if (tabBadge) {
        if (pendingInvites.length > 0) {
          tabBadge.style.display = "inline-block";
          tabBadge.textContent = String(pendingInvites.length);
        } else {
          tabBadge.style.display = "none";
        }
      }

      if (activePairTab === "invites") {
        if (pendingInvites.length === 0) {
          pairListEl.innerHTML = `
            <div class="pair-streak-empty" style="width: 100%;">
              <p>No pending invitations at the moment.</p>
            </div>
          `;
        } else {
          pairListEl.innerHTML = `
            <div style="width: 100%;">
              <div style="display: flex; flex-direction: column; gap: 12px;">
                ${pendingInvites.map(item => {
                  const partner = mutuals.find(m => m.uid === item.partnerUid) || {};
                  const inviterName = partner.displayName || "A friend";
                  const inviterPhotoURL = partner.photoURL || "";
                  const notif = notifications.find(n => n.type === "streak_invite" && n.inviterUid === item.partnerUid);
                  const notifId = notif ? notif.id : `streak_invite_${item.partnerUid}`;

                  return `
                    <div class="pair-streak-item" style="border-color: rgba(168, 85, 247, 0.3); background: rgba(168, 85, 247, 0.02);">
                      <img src="${inviterPhotoURL || 'https://www.gravatar.com/avatar/?d=mp'}" alt="" />
                      <span style="flex: 1; text-align: left;">${escapeHtml(inviterName)}</span>
                      <div style="display: flex; gap: 6px;">
                        <button class="btn btn--primary" style="font-size: 11px; padding: 6px 12px; height: auto;" data-popup-accept-uid="${item.partnerUid}" data-notification-id="${notifId}">Accept</button>
                        <button class="btn btn--secondary" style="font-size: 11px; padding: 6px 12px; height: auto; background: #fee2e2; color: #ef4444; border-color: #fca5a5;" data-popup-reject-uid="${item.partnerUid}" data-notification-id="${notifId}">Reject</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }
      } else {
        if (mutuals.length === 0) {
          pairListEl.innerHTML = `
            <div class="pair-streak-empty" style="width: 100%;">
              <p>You have no mutual followers.</p>
              <a class="btn btn--secondary" href="./ca-nhan.html#friendModal" style="margin-top:16px;text-decoration:none;display:inline-block;padding:8px 16px;font-size:12px;text-transform:uppercase;">Find friends</a>
            </div>
          `;
        } else {
          pairListEl.innerHTML = `
            <div style="width: 100%;">
              <div style="display: flex; flex-direction: column; gap: 12px;">
                ${mutuals.map((m) => {
                  const activePair = pairStreaks.find(ps => ps.partnerUid === m.uid);
                  let actionButtonHtml = "";

                  if (activePair) {
                    if (activePair.status === "pending") {
                      if (activePair.invitedBy === activeUser.uid) {
                        actionButtonHtml = `<button class="btn btn--secondary pair-streak-invite-btn" type="button" disabled>Sent!</button>`;
                      } else {
                        actionButtonHtml = `<span style="font-size: 12px; font-weight: 800; color: #a855f7; font-style: italic;">Invited you</span>`;
                      }
                    } else if (activePair.status === "broken" || activePair.isBroken) {
                      actionButtonHtml = `
                        <div class="pair-streak-badge pair-streak-badge--broken" aria-label="Pair streak ended">
                          <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; flex-shrink:0;">
                            <path fill="#94a3b8" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
                            <path fill="#cbd5e1" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z" />
                          </svg>
                          <span>0 days</span>
                        </div>
                      `;
                    } else {
                      actionButtonHtml = `
                        <div class="pair-streak-badge">
                          <svg viewBox="0 0 24 24" aria-hidden="true" style="width: 16px; height: 16px; flex-shrink:0;">
                            <path fill="#c084fc" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
                            <path fill="#e879f9" d="M9.5 16.3c0-1.1.6-2.1 1.5-2.8.65.95 1.55 1.55 2.3 2.25.72.68 1.1 1.45 1.1 2.3a2.45 2.45 0 0 1-4.9 0v-1.75Z" />
                          </svg>
                          <span>${activePair.streak} days</span>
                        </div>
                      `;
                    }
                  } else {
                    actionButtonHtml = `<button class="btn btn--primary pair-streak-invite-btn" type="button" data-invite-uid="${m.uid}">Invite</button>`;
                  }

                  return `
                    <div class="pair-streak-item">
                      <img src="${m.photoURL || 'https://www.gravatar.com/avatar/?d=mp'}" alt="" />
                      <span>${escapeHtml(m.displayName)}</span>
                      ${actionButtonHtml}
                    </div>
                  `;
                }).join("")}
              </div>
            </div>
          `;
        }
      }

      const inviteBtns = pairListEl.querySelectorAll("[data-invite-uid]");
      inviteBtns.forEach(ibtn => ibtn.addEventListener("click", async (ev) => {
        const targetUid = ev.target.dataset.inviteUid;
        ev.target.disabled = true;
        ev.target.textContent = "Sent!";
        ev.target.classList.replace("btn--primary", "btn--secondary");
        await sendStreakInvite(activeUser, targetUid);
        cachedPairStreaks = null;
        await loadPairFriends();
      }));

      // Accept buttons click inside popup
      const acceptBtns = pairListEl.querySelectorAll("[data-popup-accept-uid]");
      acceptBtns.forEach(abtn => abtn.addEventListener("click", async (ev) => {
        const targetBtn = ev.target.closest("[data-popup-accept-uid]");
        const notifId = targetBtn.dataset.notificationId;
        const inviterUid = targetBtn.dataset.popupAcceptUid;

        const itemEl = targetBtn.closest(".pair-streak-item");
        const allBtns = itemEl.querySelectorAll("button");
        allBtns.forEach(b => b.disabled = true);
        targetBtn.textContent = "Accepted!";

        try {
          await acceptPairStreak(activeUser, inviterUid);
          await markNotificationRead(activeUser.uid, notifId);
          cachedPairStreaks = null;
          await loadPairFriends();
          if (cachedProfile) renderHeaderStreak(cachedProfile);
        } catch (err) {
          console.warn("Could not accept invite inside popup:", err);
          allBtns.forEach(b => b.disabled = false);
          targetBtn.textContent = "Accept";
        }
      }));

      // Reject buttons click inside popup
      const rejectBtns = pairListEl.querySelectorAll("[data-popup-reject-uid]");
      rejectBtns.forEach(rbtn => rbtn.addEventListener("click", async (ev) => {
        const targetBtn = ev.target.closest("[data-popup-reject-uid]");
        const notifId = targetBtn.dataset.notificationId;
        const inviterUid = targetBtn.dataset.popupRejectUid;

        const itemEl = targetBtn.closest(".pair-streak-item");
        const allBtns = itemEl.querySelectorAll("button");
        allBtns.forEach(b => b.disabled = true);
        targetBtn.textContent = "Rejected";

        try {
          await rejectPairStreak(activeUser, inviterUid);
          await deleteNotification(activeUser.uid, notifId);
          cachedPairStreaks = null;
          await loadPairFriends();
        } catch (err) {
          console.warn("Could not reject invite inside popup:", err);
          allBtns.forEach(b => b.disabled = false);
          targetBtn.textContent = "Reject";
        }
      }));
    }

    if (loadBtn) {
      loadBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await loadPairFriends();
      });
    }

    if (startOnPairView) {
      loadPairFriends();
    }
  }

  async function maybeOpenPairNudgeModal() {
    if (!activeUser || !cachedProfile || !pairNudgeModal) return;

    const todayStr = getDateKey(new Date());
    if (cachedProfile.stats?.lastStreakDate !== todayStr) return false;

    try {
      const pairStreaks = Array.isArray(cachedPairStreaks) ? cachedPairStreaks : await getPairStreaks(activeUser.uid);
      const activePairs = pairStreaks.filter((pair) => pair.status === "active");
      const partnerProfiles = await Promise.all(
        activePairs.map((pair) => getPublicProfile(pair.partnerUid))
      );
      const candidates = [];

      activePairs.forEach((pair, index) => {
        const partner = partnerProfiles[index];
        if (!partner) return;

        const key = `${activeUser.uid}__${pair.partnerUid}__${todayStr}`;
        const blockReason = getPairNudgeBlockReason({
          userStats: cachedProfile.stats || {},
          pair,
          partner,
          todayStr,
        });
        const isEligible = !blockReason;

        if (!isEligible) return;
        if (shownPairNudgeKeys.has(key)) return;

        candidates.push({
          key,
          partnerUid: pair.partnerUid,
          displayName: partner.displayName || "your partner",
          photoURL: partner.photoURL || "",
          streak: Number(pair.streak || 0),
          blockReason,
          isEligible,
        });
      });

      if (!candidates.length) return false;

      candidates.sort((a, b) => b.streak - a.streak);
      openPairNudgeModal(candidates[0]);
      return true;
    } catch (error) {
      console.warn("Could not check pair streak nudge:", error);
      return false;
    }
  }

  function openPairNudgeModal(candidate) {
    resetPairNudgeFeedback();
    activePairNudgeCandidate = candidate;
    shownPairNudgeKeys.add(candidate.key);

    if (pairNudgeAvatar) pairNudgeAvatar.src = candidate.photoURL || "https://www.gravatar.com/avatar/?d=mp";
    if (pairNudgeBody) {
      pairNudgeBody.textContent = candidate.blockReason
        ? `${candidate.displayName} is your pair streak partner. A reminder can only be sent when you have studied today and they have not.`
        : `${candidate.displayName} has not studied today yet. Remind them to finish one lesson so your team streak can increase.`;
    }
    if (pairNudgeStatus) {
      pairNudgeStatus.textContent = candidate.blockReason ? candidate.blockReason : "";
    }
    if (sendPairNudgeBtn) {
      sendPairNudgeBtn.disabled = Boolean(candidate.blockReason);
      sendPairNudgeBtn.textContent = candidate.blockReason ? "Not available" : "Remind Partner";
    }
    pairNudgeModal.hidden = false;
  }

  function showPairNudgeQueued(candidate) {
    const panel = pairNudgeModal?.querySelector(".pair-nudge-panel");
    panel?.classList.add("is-reminded");

    if (sendPairNudgeBtn) {
      sendPairNudgeBtn.disabled = true;
      sendPairNudgeBtn.textContent = "Reminded";
    }
    if (pairNudgeBody) {
      pairNudgeBody.textContent = `AzoTa has queued a reminder for ${candidate.displayName}.`;
    }
    if (pairNudgeStatus) {
      pairNudgeStatus.textContent = "You are all set. AzoTa will handle the rest.";
    }

    pairNudgeCloseTimer = setTimeout(() => {
      closePairNudgeModal();
    }, 1500);
  }

  function resetPairNudgeFeedback() {
    const panel = pairNudgeModal?.querySelector(".pair-nudge-panel");
    panel?.classList.remove("is-reminded");
  }

  function getPairNudgeBlockReason({ userStats = {}, pair = {}, partner = {}, todayStr }) {
    const partnerName = partner.displayName || "Your partner";
    if (userStats.lastStreakDate !== todayStr) {
      return "Finish one lesson today before sending a team streak reminder.";
    }
    if (pair.lastUpdateDate === todayStr) {
      return "Your team streak is already safe today, so no reminder is needed.";
    }
    if (partner.stats?.lastStreakDate === todayStr) {
      return `${partnerName} already studied today, so no reminder is needed.`;
    }
    return "";
  }

}

function renderStreakWeekDays(weekStart, dayNames, getDayState) {
  let html = "";
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i);
    const state = getDayState(date, i);
    let flameClass = "";

    if (state.isCompleted) {
      flameClass = "is-completed";
    }
    if (state.isAnimating) {
      flameClass = "is-animating";
    }

    html += `
      <div class="streak-day ${state.isToday ? "is-today" : ""}">
        <span class="streak-day__label">${dayNames[i]}</span>
        <div class="streak-day__flame ${flameClass}">
           <svg viewBox="0 0 24 24" aria-hidden="true">
             <path fill="currentColor" d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z" />
           </svg>
           <div class="streak-day__check">✓</div>
        </div>
      </div>
    `;
  }
  return html;
}

function getWeekStartDate(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function finishStreakDayAnimation(flameEl) {
  if (!flameEl) return;
  flameEl.classList.remove("is-animating");
  flameEl.classList.add("is-completed");
}

function settleStreakDayAnimations(root) {
  root?.querySelectorAll(".streak-day__flame.is-animating").forEach(finishStreakDayAnimation);
}

function settleStreakDayAnimationAfterPop(flameEl) {
  if (!flameEl) return;
  const finish = () => finishStreakDayAnimation(flameEl);
  flameEl.querySelector(".streak-day__check")?.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 1100);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
