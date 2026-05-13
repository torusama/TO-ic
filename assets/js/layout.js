import { ensureDefaultNotifications, deleteNotification, listenNotifications, markNotificationRead } from "./notification-service.js";
import { ensureUserProfile, onUserChanged } from "./user-service.js";

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
let unsubscribeNotifications = () => {};
let closeTimer;

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
        </a>
        <div class="topbar__right">
          <nav class="nav-links" aria-label="Main navigation">
            ${links.map((link) => `<a class="${link.id === currentPage ? "is-active" : ""}" href="${link.href}">${link.label}</a>`).join("")}
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
    unsubscribeNotifications();
    notifications = [];
    renderNotifications();

    if (!user) return;

    try {
      const profile = await ensureUserProfile(user);
      await ensureDefaultNotifications(user);
      unsubscribeNotifications = listenNotifications(
        user.uid,
        (items) => {
          notifications = items;
          renderNotifications();
        },
        (error) => {
          console.warn("Could not listen to notifications:", error);
          notifications = [];
          renderNotifications();
        }
      );

      const headerStreak = header.querySelector("#headerStreak");
      const streakVal = header.querySelector("[data-header-streak-val]");
      if (headerStreak && streakVal) {
        headerStreak.style.display = user ? "flex" : "none";
        if (user && profile) {
          streakVal.textContent = profile.stats?.streak || 0;
        }
      }
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

    try {
      if (event.target.closest("[data-delete-notification]")) {
        await deleteNotification(activeUser.uid, item.dataset.notificationId);
      } else {
        await markNotificationRead(activeUser.uid, item.dataset.notificationId);
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
    try {
      await markNotificationRead(activeUser.uid, item.dataset.notificationId);
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
          .map(
            (item) => `
              <article class="notification-popover__item ${item.unread ? "is-unread" : ""}" data-notification-id="${item.id}" tabindex="0">
                <div>
                  <strong>${escapeHtml(item.title)}</strong>
                  <span>${escapeHtml(item.body)}</span>
                </div>
                <button class="notification-popover__delete" type="button" data-delete-notification aria-label="Delete notification">&times;</button>
              </article>
            `
          )
          .join("")
      : `<div class="notification-popover__empty">No notifications yet.</div>`;
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
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
