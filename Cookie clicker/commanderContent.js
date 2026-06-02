/**
 * commanderContent.js
 * A tab-side heartbeat for Commander Mode.
 *
 * The content script stays attached to the Cookie Clicker tab and asks the
 * extension background service worker to perform one validated AI step at a
 * time. This keeps Commander Mode independent from the popup window.
 */

(() => {
  if (globalThis.cookieAiCommanderContentInstalled) {
    return;
  }

  globalThis.cookieAiCommanderContentInstalled = true;

  let running = false;
  let activeLoopId = 0;
  let failureDelayMs = 1000;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COOKIE_AI_START_LOOP') {
      running = true;
      activeLoopId = message.loopId;
      runLoop(activeLoopId);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'COOKIE_AI_STOP_LOOP') {
      running = false;
      activeLoopId = message.loopId;
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  async function runLoop(loopId) {
    while (running && activeLoopId === loopId) {
      let delayMs = 1000;

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'COMMANDER_TICK',
          loopId
        });

        if (!response?.running) {
          running = false;
          break;
        }

        delayMs = response.delayMs || delayMs;
        failureDelayMs = 1000;
      } catch (_err) {
        failureDelayMs = Math.min(failureDelayMs * 2, 30000);
        delayMs = failureDelayMs;
      }

      await delay(delayMs);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
