/**
 * popup.js
 * Popup UI controller for Cookie AI Master Advisor.
 *
 * The long-running automation lives in background.js so closing this popup
 * does not immediately kill Commander Mode.
 */

const COOKIE_CLICKER_URL = 'orteil.dashnet.org/cookieclicker';
const POLL_MS = 1000;

const analyzeButton = document.getElementById('analyze');
const adviceDisplay = document.getElementById('advice');
const goalInput = document.getElementById('goal');
const strategySelect = document.getElementById('strategy');

let commanderRunning = false;

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'suggest';
}

function setDisplay(message) {
  adviceDisplay.innerText = message;
}

function setButtonState({ running, busy = false }) {
  commanderRunning = running;
  analyzeButton.disabled = busy;
  analyzeButton.innerText = running ? 'STOP COMMANDER' : 'Execute AI Strategy';
  analyzeButton.style.backgroundColor = running ? '#ff4444' : '#dfb24c';
}

async function sendRuntimeMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

async function getActiveCookieTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes(COOKIE_CLICKER_URL)) {
    return null;
  }
  return tab;
}

function requestOptions() {
  return {
    goal: goalInput.value.trim() || 'Maximum Efficiency',
    strategy: strategySelect.value
  };
}

function renderStatus(status) {
  if (!status) return;

  setButtonState({ running: Boolean(status.running) });

  if (status.message) {
    setDisplay(status.message);
  }
}

async function refreshStatus() {
  try {
    const status = await sendRuntimeMessage('GET_STATUS');
    renderStatus(status);
  } catch (err) {
    console.error('Unable to read Commander status:', err);
  }
}

analyzeButton.addEventListener('click', async () => {
  if (commanderRunning) {
    setButtonState({ running: true, busy: true });
    setDisplay('Stopping Commander Mode...');

    try {
      const status = await sendRuntimeMessage('STOP_COMMANDER');
      renderStatus(status);
    } catch (err) {
      console.error('Failed to stop Commander Mode:', err);
      setDisplay('Error: Could not stop Commander Mode.');
      setButtonState({ running: true });
    }
    return;
  }

  const tab = await getActiveCookieTab();
  if (!tab) {
    setDisplay('Error: Please open the Cookie Clicker tab.');
    return;
  }

  const mode = selectedMode();
  const options = requestOptions();

  setButtonState({ running: false, busy: true });
  setDisplay(mode === 'auto'
    ? 'Starting Commander Mode...'
    : 'Extracting game state for advice...');

  try {
    const response = await sendRuntimeMessage(
      mode === 'auto' ? 'START_COMMANDER' : 'ANALYZE_ONCE',
      { tabId: tab.id, options }
    );

    renderStatus(response);
  } catch (err) {
    console.error('AI request failed:', err);
    setDisplay(`Error: ${err.message || 'AI request failed.'}`);
    setButtonState({ running: false });
  }
});

refreshStatus();
setInterval(refreshStatus, POLL_MS);
