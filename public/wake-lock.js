/* Keeps the screen on while riding (Screen Wake Lock API). The browser drops the
   lock whenever the page is hidden, so it is re-acquired when the page is shown again. */

export function createWakeLock() {
  let wanted = false;
  let sentinel = null;
  let requesting = false;
  let denied = false; // a refused request is not retried until the page is shown again

  async function acquire() {
    if (!wanted || sentinel || requesting || denied) return;
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    requesting = true;
    try {
      sentinel = await navigator.wakeLock.request("screen");
      sentinel.addEventListener("release", () => { sentinel = null; });
      if (!wanted) release(); // turned off while the request was pending
    } catch (e) {
      denied = true;
      console.warn("wake lock unavailable", e);
    } finally {
      requesting = false;
    }
  }

  function release() {
    const s = sentinel;
    sentinel = null;
    s?.release().catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    denied = false;
    acquire();
  });

  return {
    // Holds the lock while `on` is true. Safe to call repeatedly with the same value.
    set(on) {
      if (on === wanted) return;
      wanted = on;
      if (on) acquire();
      else release();
    },
  };
}
