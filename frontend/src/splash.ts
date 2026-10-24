/** The splash stays on screen at least this long, so it reads as a splash and not a flicker. */
const minimumMs = 700;
/** Without a signal from the app, the splash leaves after this long anyway. */
const fallbackMs = 8000;

let shownAt: number | null = null;
let ready = false;
let leaving = false;

/** The window is on screen: the splash's minimum time starts now. */
export function markShown() {
  if (shownAt !== null) return;
  shownAt = performance.now();
  if (ready) leave();
}

/** Fades out the splash of index.html. Called once the app has its first data. */
export function hideSplash() {
  ready = true;
  if (shownAt !== null) leave();
}

function leave() {
  if (leaving || shownAt === null) return;
  leaving = true;
  const splash = document.getElementById("splash");
  if (!splash) return;
  const wait = Math.max(0, shownAt + minimumMs - performance.now());
  window.setTimeout(() => {
    splash.classList.add("done");
    window.setTimeout(() => splash.remove(), 220);
  }, wait);
}

window.setTimeout(() => {
  markShown();
  hideSplash();
}, fallbackMs);
