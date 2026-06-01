(() => {
  if (globalThis.cookieMathCommanderContentInstalled) {
    return;
  }

  globalThis.cookieMathCommanderContentInstalled = true;

  let running = false;
  let activeLoopId = 0;
  let failureDelayMs = 1000;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'COOKIE_MATH_START_LOOP') {
      running = true;
      activeLoopId = message.loopId;
      runLoop(activeLoopId);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === 'COOKIE_MATH_STOP_LOOP') {
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
          type: 'MATH_COMMANDER_TICK',
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
