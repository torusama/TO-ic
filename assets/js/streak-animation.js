export function setStreakNumber(element, value) {
  if (!element) return;
  element.textContent = String(Number(value || 0));
}

export function rollStreakNumber(element, fromValue, toValue) {
  if (!element) return;

  const from = Number(fromValue || 0);
  const to = Number(toValue || 0);
  if (from === to) {
    setStreakNumber(element, to);
    return;
  }

  element.classList.remove("is-streak-rolling");
  element.innerHTML = `
    <span class="streak-roll" aria-hidden="true">
      <span>${from}</span>
      <span>${to}</span>
    </span>
  `;
  element.setAttribute("aria-label", String(to));

  window.requestAnimationFrame(() => {
    element.classList.add("is-streak-rolling");
  });

  window.setTimeout(() => {
    element.classList.remove("is-streak-rolling");
    setStreakNumber(element, to);
  }, 720);
}
