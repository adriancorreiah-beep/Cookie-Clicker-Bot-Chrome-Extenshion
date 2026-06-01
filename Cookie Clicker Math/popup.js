const COOKIE_CLICKER_URL = 'orteil.dashnet.org/cookieclicker';
const POLL_MS = 1000;

const runButton = document.getElementById('run');
const output = document.getElementById('output');
const mathOutput = document.getElementById('mathOutput');
const controlsTab = document.getElementById('controlsTab');
const mathTab = document.getElementById('mathTab');
const controlsPanel = document.getElementById('controlsPanel');
const mathPanel = document.getElementById('mathPanel');
const optionsToggle = document.getElementById('optionsToggle');
const optionalActions = document.getElementById('optionalActions');
const timeGoalInput = document.getElementById('timeGoal');
const targetGoalInput = document.getElementById('targetGoal');
const strategySelect = document.getElementById('strategy');
const allowAchievementActionsInput = document.getElementById('allowAchievementActions');
const allowWrinklersInput = document.getElementById('allowWrinklers');
const allowSugarLumpCollectInput = document.getElementById('allowSugarLumpCollect');
const allowSugarLumpSpendInput = document.getElementById('allowSugarLumpSpend');
const allowAscensionInput = document.getElementById('allowAscension');
const allowAscensionUpgradesInput = document.getElementById('allowAscensionUpgrades');

let commanderRunning = false;

function setActiveTab(tabName) {
  const showMath = tabName === 'math';
  controlsTab.classList.toggle('active', !showMath);
  mathTab.classList.toggle('active', showMath);
  controlsPanel.classList.toggle('active', !showMath);
  mathPanel.classList.toggle('active', showMath);
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'advice';
}

function setOutput(message) {
  output.innerText = message;
}

function setMathOutput(message) {
  const hasDetails = Boolean(message && message !== 'Run Advice Mode or Commander Mode to see planner math.');
  mathOutput.innerText = message || 'Run Advice Mode or Commander Mode to see planner math.';
  mathOutput.classList.toggle('status', !hasDetails);
}

function setButtonState({ running, busy = false }) {
  commanderRunning = running;
  runButton.disabled = busy;
  runButton.innerText = running ? 'STOP COMMANDER' : 'Run Math Strategy';
  runButton.style.background = running ? '#e05252' : '#e2b24a';
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
    timeGoal: timeGoalInput.value.trim(),
    targetGoal: targetGoalInput.value.trim(),
    strategy: strategySelect.value,
    allowAchievementActions: allowAchievementActionsInput.checked,
    allowWrinklers: allowWrinklersInput.checked,
    allowSugarLumpCollect: allowSugarLumpCollectInput.checked,
    allowSugarLumpSpend: allowSugarLumpSpendInput.checked,
    allowAscension: allowAscensionInput.checked,
    allowAscensionUpgrades: allowAscensionUpgradesInput.checked
  };
}

function validateGoal(options) {
  if (options.timeGoal && options.targetGoal) {
    return 'Use either a time goal or a cookie target, not both.';
  }

  return '';
}

function renderStatus(status) {
  if (!status) return;

  setButtonState({ running: Boolean(status.running) });

  if (status.message) {
    setOutput(status.message);
  }

  setMathOutput(status.mathDetails);
}

async function refreshStatus() {
  try {
    const status = await sendRuntimeMessage('GET_STATUS');
    renderStatus(status);
  } catch (err) {
    console.error('Unable to read Math Commander status:', err);
  }
}

runButton.addEventListener('click', async () => {
  if (commanderRunning) {
    setButtonState({ running: true, busy: true });
    setOutput('Stopping Math Commander...');

    try {
      const status = await sendRuntimeMessage('STOP_COMMANDER');
      renderStatus(status);
    } catch (err) {
      console.error('Failed to stop Math Commander:', err);
      setOutput('Error: Could not stop Math Commander.');
      setButtonState({ running: true });
    }

    return;
  }

  const options = requestOptions();
  const goalError = validateGoal(options);
  if (goalError) {
    setOutput(goalError);
    return;
  }

  const tab = await getActiveCookieTab();
  if (!tab) {
    setOutput('Error: Please open the Cookie Clicker tab.');
    return;
  }

  const mode = selectedMode();
  setButtonState({ running: false, busy: true });
  setOutput(mode === 'commander'
    ? 'Starting Math Commander...'
    : 'Reading Cookie Clicker state...');

  try {
    const status = await sendRuntimeMessage(
      mode === 'commander' ? 'START_COMMANDER' : 'ANALYZE_ONCE',
      { tabId: tab.id, options }
    );

    renderStatus(status);
  } catch (err) {
    console.error('Math strategy failed:', err);
    setOutput(`Error: ${err.message || 'Math strategy failed.'}`);
    setButtonState({ running: false });
  }
});

controlsTab.addEventListener('click', () => {
  setActiveTab('controls');
});

mathTab.addEventListener('click', () => {
  setActiveTab('math');
});

optionsToggle.addEventListener('click', () => {
  const isOpening = optionalActions.hidden;
  optionalActions.hidden = !isOpening;
  optionsToggle.setAttribute('aria-expanded', String(isOpening));
});

refreshStatus();
setInterval(refreshStatus, POLL_MS);
