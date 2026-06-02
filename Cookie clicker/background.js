  /**
 * background.js
 * Durable controller for Cookie AI Master Advisor.
 *
 * This file owns database loading, AI requests, command validation, and
 * Commander Mode. Keeping those jobs out of the popup lets Commander Mode
 * continue after the popup closes.
 */

const DB_FILES = [
  'Angel_Demon_upgrades',
  'Bingo_Center_Research_Facility',
  'buildings',
  'Cookie_upgrades',
  'Discount_Luck_upgrades',
  'Golden_Cookie_upgrades',
  'Income_multiplier_Upgrades',
  'Kitten_Upgrades',
  'Persistent_upgrades',
  'Ascension_upgrades',
  'Production_upgrades',
  'All_upgrades',
  'Achievements',
  'Golden_Cookie_info',
  'Reindeer_info',
  'Wrinkler_info',
  'Wrath_Cookie_info',
  'Krumblor_info',
  'Shiny_Wrinkler_info',
  'Santa_info'
];

const AI_ENDPOINT = 'http://127.0.0.1:1234/v1/chat/completions';
const AI_MODEL = 'meta-llama-3.1-8b-instruct';
const BIG_COOKIE_CLICKS_PER_SECOND = 44;
const COMMANDER_BASE_DELAY_MS = 1000;
const COMMANDER_MAX_BACKOFF_MS = 30000;
const COMMANDER_MAX_FAILURES = 5;
const VALID_ACTION_TYPES = new Set([
  'BUY_UPGRADE',
  'BUY_BUILDING',
  'CLICK_COOKIE',
  'CLICK_BIG_COOKIE',
  'CLICK_GOLDEN_COOKIE',
  'SAVE_UP',
  'WAIT'
]);

let gameDatabase = {};
let databaseReadyPromise = loadDatabases();

let commanderState = {
  running: false,
  tabId: null,
  options: null,
  loopId: 0,
  failureCount: 0,
  message: 'Click above to analyze your game state...',
  lastCommand: null,
  failedDatabaseFiles: []
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('Cookie AI message failed:', err);
      sendResponse({
        ok: false,
        running: commanderState.running,
        message: `Error: ${err.message || 'Request failed.'}`,
        error: err.message || String(err)
      });
    });

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_STATUS':
      return getPublicStatus();

    case 'STOP_COMMANDER':
      await stopCommander('Commander Mode deactivated.');
      return getPublicStatus();

    case 'START_COMMANDER':
      return startCommander(message.tabId, message.options);

    case 'ANALYZE_ONCE':
      return analyzeOnce(message.tabId, message.options);

    case 'COMMANDER_TICK':
      return commanderTick(message.loopId);

    default:
      throw new Error(`Unknown request type: ${message?.type || 'missing'}`);
  }
}

async function loadDatabases() {
  const loadedDatabase = {};
  const failedFiles = [];

  await Promise.all(DB_FILES.map(async (dbName) => {
    try {
      const response = await fetch(chrome.runtime.getURL(`${dbName}.json`));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      loadedDatabase[dbName] = await response.json();
    } catch (err) {
      console.error(`Failed to load database file: ${dbName}.json`, err);
      failedFiles.push(`${dbName}.json`);
    }
  }));

  gameDatabase = loadedDatabase;
  commanderState.failedDatabaseFiles = failedFiles;

  if (Object.keys(gameDatabase).length === 0) {
    throw new Error('No local Cookie Clicker databases could be loaded.');
  }

  return {
    loaded: Object.keys(gameDatabase),
    failed: failedFiles
  };
}

async function ensureDatabasesLoaded() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = loadDatabases();
  }

  try {
    return await databaseReadyPromise;
  } catch (err) {
    databaseReadyPromise = null;
    throw err;
  }
}

function getPublicStatus() {
  return {
    ok: true,
    running: commanderState.running,
    tabId: commanderState.tabId,
    message: commanderState.message,
    failureCount: commanderState.failureCount,
    lastCommand: commanderState.lastCommand,
    failedDatabaseFiles: commanderState.failedDatabaseFiles
  };
}

async function analyzeOnce(tabId, options) {
  commanderState.message = 'Loading local strategy databases...';
  await ensureDatabasesLoaded();

  const state = enrichGameState(await extractGameState(tabId));
  const advice = await getAiAdvice(state, normalizeOptions(options));

  commanderState.failureCount = 0;
  commanderState.lastCommand = null;
  commanderState.message = `ADVICE:\n${advice}`;

  return getPublicStatus();
}

async function startCommander(tabId, options) {
  if (!Number.isInteger(tabId)) {
    throw new Error('Missing Cookie Clicker tab.');
  }

  commanderState = {
    ...commanderState,
    running: true,
    tabId,
    options: normalizeOptions(options),
    loopId: commanderState.loopId + 1,
    failureCount: 0,
    message: 'Commander Mode started. Loading local strategy databases...',
    lastCommand: null
  };

  try {
    await ensureCommanderContentScript(tabId);
    await setBigCookieAutoClicker(tabId, true);
    await chrome.tabs.sendMessage(tabId, {
      type: 'COOKIE_AI_START_LOOP',
      loopId: commanderState.loopId
    });
  } catch (err) {
    try {
      await setBigCookieAutoClicker(tabId, false);
    } catch (_stopErr) {
      // Startup already failed; just make sure the public Commander state reflects that.
    }

    commanderState.running = false;
    commanderState.message = `Could not start Commander Mode: ${err.message || err}`;
    throw err;
  }

  return getPublicStatus();
}

async function stopCommander(message) {
  const tabId = commanderState.tabId;

  commanderState.running = false;
  commanderState.loopId += 1;
  commanderState.failureCount = 0;
  commanderState.message = message;

  if (Number.isInteger(tabId)) {
    try {
      await setBigCookieAutoClicker(tabId, false);
    } catch (_err) {
      // The tab may have closed or reloaded; the background state is already stopped.
    }

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'COOKIE_AI_STOP_LOOP',
        loopId: commanderState.loopId
      });
    } catch (_err) {
      // The tab may have closed or reloaded; the background state is already stopped.
    }
  }
}

async function ensureCommanderContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['commanderContent.js']
  });
}

async function commanderTick(loopId) {
  if (!commanderState.running || commanderState.loopId !== loopId) {
    return {
      ...getPublicStatus(),
      running: false,
      delayMs: 0
    };
  }

  try {
    await ensureDatabasesLoaded();
    const clickerStatus = await setBigCookieAutoClicker(commanderState.tabId, true);
    const preClicks = await clickGameTargets(commanderState.tabId);

    const result = await getAiCommand(
      commanderState.tabId,
      commanderState.options
    );

    const execution = await applyCommand(
      commanderState.tabId,
      result.command
    );
    const postClicks = await clickGameTargets(commanderState.tabId);

    commanderState.failureCount = 0;
    commanderState.lastCommand = result.command;
    commanderState.message = formatExecutionMessage(
      result.command,
      execution,
      mergeClickStats(preClicks, postClicks, clickerStatus)
    );

    return {
      ...getPublicStatus(),
      delayMs: COMMANDER_BASE_DELAY_MS
    };
  } catch (err) {
    commanderState.failureCount += 1;

    if (commanderState.failureCount >= COMMANDER_MAX_FAILURES) {
      await stopCommander(
        `Commander Mode stopped after ${COMMANDER_MAX_FAILURES} failed attempts: ${err.message || err}`
      );

      return {
        ...getPublicStatus(),
        running: false,
        delayMs: 0
      };
    }

    const backoffMs = Math.min(
      COMMANDER_BASE_DELAY_MS * (2 ** commanderState.failureCount),
      COMMANDER_MAX_BACKOFF_MS
    );

    commanderState.message =
      `Commander retry ${commanderState.failureCount}/${COMMANDER_MAX_FAILURES}: ` +
      `${err.message || err}. Retrying in ${Math.ceil(backoffMs / 1000)}s.`;

    return {
      ...getPublicStatus(),
      delayMs: backoffMs
    };
  }
}

async function getAiCommand(tabId, options) {
  const normalizedOptions = normalizeOptions(options);
  const state = enrichGameState(await extractGameState(tabId));
  const prompt = buildPrompt(state, normalizedOptions);
  let command = coerceAiCommand(await requestAiCommand(prompt), state);
  const repairReason = getSaveUpRepairReason(command, state);

  if (repairReason) {
    const repairPrompt = buildRepairPrompt(state, normalizedOptions, command, repairReason);
    command = coerceAiCommand(await requestAiCommand(repairPrompt), state);

    const remainingRepairReason = getSaveUpRepairReason(command, state);
    if (remainingRepairReason) {
      command = buildFallbackCommand(command, state, remainingRepairReason);
    }
  }

  return { state, command };
}

async function extractGameState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const numberOrNull = (value) => (
        Number.isFinite(Number(value)) ? Number(value) : null
      );

      const safeCall = (fn, fallback = null) => {
        try {
          return fn();
        } catch (_err) {
          return fallback;
        }
      };
      const cleanText = (value) => String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (typeof Game === 'undefined') {
        return { ready: false, reason: 'Cookie Clicker Game object was not found.' };
      }

      if (Game.ready === 0) {
        return { ready: false, reason: 'Cookie Clicker is still loading.' };
      }

      const cookies = numberOrNull(Game.cookies);

      const upgradesInShop = Object.values(Game.Upgrades)
        .filter((upgrade) => upgrade.unlocked && !upgrade.bought)
        .filter((upgrade) => upgrade.pool !== 'debug' && upgrade.pool !== 'toggle')
        .map((upgrade) => {
          const price = safeCall(
            () => upgrade.getPrice(),
            upgrade.basePrice ?? upgrade.price ?? null
          );

          return {
            name: upgrade.name,
            price: numberOrNull(price),
            basePrice: numberOrNull(upgrade.basePrice ?? upgrade.price),
            affordable: Number.isFinite(Number(price)) && cookies >= Number(price),
            description: cleanText(upgrade.desc),
            pool: upgrade.pool || '',
            order: numberOrNull(upgrade.order)
          };
        })
        .sort((a, b) => {
          if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
          return (a.price ?? Number.MAX_VALUE) - (b.price ?? Number.MAX_VALUE);
        });

      const buildings = Object.values(Game.Objects).map((building) => {
        const currentPrice = numberOrNull(
          building.price ?? safeCall(() => building.getPrice(), null)
        );
        const cpsPerUnit = numberOrNull(
          building.storedCps ?? building.baseCps ?? safeCall(() => building.cps(), null)
        );

        return {
          name: building.name,
          amount: numberOrNull(building.amount),
          currentPrice,
          cpsPerUnit,
          totalCps: numberOrNull(building.storedTotalCps),
          affordable: currentPrice !== null && cookies >= currentPrice,
          unlocked: building.locked ? false : true
          };
        });
      const boughtUpgrades = Object.values(Game.Upgrades)
        .filter((upgrade) => upgrade.bought)
        .map((upgrade) => ({
          name: upgrade.name,
          pool: upgrade.pool || '',
          order: numberOrNull(upgrade.order)
        }))
        .sort((a, b) => (a.order ?? Number.MAX_VALUE) - (b.order ?? Number.MAX_VALUE));
      const unlockedAchievements = Object.values(Game.Achievements || {})
        .filter((achievement) => achievement.won)
        .map((achievement) => achievement.name);
      const activeBuffs = Object.values(Game.buffs || {}).map((buff) => ({
        name: buff.name,
        time: numberOrNull(buff.time),
        maxTime: numberOrNull(buff.maxTime),
        multiplier: numberOrNull(buff.multCpS)
      }));
      const wrinklers = Array.isArray(Game.wrinklers) ? Game.wrinklers.map((wrinkler) => ({
        phase: numberOrNull(wrinkler.phase),
        sucked: numberOrNull(wrinkler.sucked),
        type: numberOrNull(wrinkler.type)
      })) : [];
      const shimmers = Array.isArray(Game.shimmers) ? Game.shimmers.map((shimmer) => ({
        type: shimmer.type || '',
        life: numberOrNull(shimmer.life),
        duration: numberOrNull(shimmer.dur)
      })) : [];

      return {
        ready: true,
        cookies,
        cps: numberOrNull(Game.cookiesPs),
        cookiesEarned: numberOrNull(Game.cookiesEarned),
        cookiesReset: numberOrNull(Game.cookiesReset),
        cookiesAllTime: numberOrNull(Game.cookiesEarned) + numberOrNull(Game.cookiesReset),
        heavenlyChips: numberOrNull(Game.heavenlyChips),
        prestige: numberOrNull(Game.prestige),
        ascensions: numberOrNull(Game.resets),
        achievementsWon: unlockedAchievements.length,
        milkProgress: numberOrNull(Game.milkProgress),
        milkName: Game.milkName || '',
        lumps: numberOrNull(Game.lumps),
        lumpsTotal: numberOrNull(Game.lumpsTotal),
        season: Game.season || '',
        elderWrath: numberOrNull(Game.elderWrath),
        pledgeT: numberOrNull(Game.pledgeT),
        santaLevel: numberOrNull(Game.santaLevel),
        dragonLevel: numberOrNull(Game.dragonLevel),
        dragonAura: numberOrNull(Game.dragonAura),
        dragonAura2: numberOrNull(Game.dragonAura2),
        goldenClicks: numberOrNull(Game.goldenClicks),
        handmadeCookies: numberOrNull(Game.handmadeCookies),
        cookieClicks: numberOrNull(Game.cookieClicks),
        boughtUpgrades,
        activeBuffs,
        wrinklers,
        shimmers,
        upgradesInShop,
        buildings,
        timestamp: Date.now()
      };
    }
  });

  const state = results[0]?.result;

  if (!state) {
    throw new Error('Could not read Cookie Clicker state.');
  }

  if (!state.ready) {
    throw new Error(state.reason || 'Cookie Clicker is not ready.');
  }

  return state;
}

function enrichGameState(state) {
  return {
    ...state,
    upgradesInShop: state.upgradesInShop.map((upgrade) => {
      const meta = lookupUpgradeDetails(upgrade.name);
      const price = firstFiniteNumber(
        upgrade.price,
        meta?.['base price'],
        meta?.['Base price'],
        meta?.cost,
        meta?.Cost
      );

      return {
        ...upgrade,
        price,
        affordable: price !== null && state.cookies >= price,
        effect: trimText(
          upgrade.description || meta?.description || meta?.Description || 'No local description.',
          180
        ),
        databaseSource: meta?.databaseSource || null
      };
    }),
    buildings: state.buildings.map((building) => {
      const meta = gameDatabase.buildings?.[building.name] || {};
      const baseCps = firstFiniteNumber(building.cpsPerUnit, meta['Base CpS']);
      const currentPrice = firstFiniteNumber(building.currentPrice, meta['Base Cost']);
      const paybackSeconds =
        baseCps && currentPrice ? Math.round((currentPrice / baseCps) * 100) / 100 : null;

      return {
        ...building,
        currentPrice,
        cpsPerUnit: baseCps,
        affordable: currentPrice !== null && state.cookies >= currentPrice,
        paybackSeconds
      };
    })
  };
}

function lookupUpgradeDetails(name) {
  for (const dbName of DB_FILES) {
    if (dbName === 'buildings') continue;

    const entry = gameDatabase[dbName]?.[name];
    if (entry) {
      return {
        ...entry,
        databaseSource: dbName
      };
    }
  }

  return null;
}

function summarizeSaveData(state) {
  return {
    cookies: Math.floor(state.cookies ?? 0),
    cps: state.cps,
    cookiesEarned: state.cookiesEarned,
    cookiesReset: state.cookiesReset,
    cookiesAllTime: state.cookiesAllTime,
    heavenlyChips: state.heavenlyChips,
    prestige: state.prestige,
    ascensions: state.ascensions,
    achievementsWon: state.achievementsWon,
    milkProgress: state.milkProgress,
    milkName: state.milkName,
    lumps: state.lumps,
    lumpsTotal: state.lumpsTotal,
    season: state.season,
    elderWrath: state.elderWrath,
    pledgeT: state.pledgeT,
    santaLevel: state.santaLevel,
    dragonLevel: state.dragonLevel,
    dragonAura: state.dragonAura,
    dragonAura2: state.dragonAura2,
    goldenClicks: state.goldenClicks,
    handmadeCookies: state.handmadeCookies,
    cookieClicks: state.cookieClicks,
    boughtUpgradeCount: state.boughtUpgrades?.length || 0,
    recentBoughtUpgrades: (state.boughtUpgrades || []).slice(-30).map((upgrade) => upgrade.name),
    activeBuffs: state.activeBuffs || [],
    visibleShimmers: state.shimmers || [],
    wrinklerCount: (state.wrinklers || []).filter((wrinkler) => wrinkler.phase > 0).length
  };
}

function buildReferenceSummaries(state, options = {}) {
  const goalText = `${options.goal || ''} ${options.strategy || ''}`.toLowerCase();
  const wants = (term) => goalText.includes(term);
  const boughtUpgradeNames = new Set(
    (state.boughtUpgrades || []).map((upgrade) => String(upgrade.name || '').toLowerCase())
  );
  const shopUpgradeNames = new Set(
    (state.upgradesInShop || []).map((upgrade) => String(upgrade.name || '').toLowerCase())
  );
  const hasBoughtUpgrade = (name) => boughtUpgradeNames.has(name.toLowerCase());
  const hasUpgradeInShop = (name) => shopUpgradeNames.has(name.toLowerCase());
  const wrinklerCount = (state.wrinklers || []).filter((wrinkler) => wrinkler.phase > 0).length;
  const hasWrathContext = Number(state.elderWrath || 0) > 0 || wants('wrath') || wants('grandmapocalypse');
  const hasChristmasContext =
    state.season === 'christmas' ||
    wants('christmas') ||
    hasBoughtUpgrade('A festive hat') ||
    hasUpgradeInShop('A festive hat');
  const hasReindeerContext = hasChristmasContext || wants('reindeer');
  const hasWrinklerContext = wrinklerCount > 0 || hasWrathContext || wants('wrinkler');
  const hasDragonContext =
    Number(state.dragonLevel || 0) > 0 ||
    wants('dragon') ||
    wants('krumblor') ||
    wants('aura') ||
    hasBoughtUpgrade('A crumbly egg') ||
    hasUpgradeInShop('A crumbly egg');

  const summaries = [];
  const add = (dbName, mapper) => {
    const summary = gameDatabase[dbName]?.__summary;
    if (summary) summaries.push(mapper(summary));
  };
  const compactOutcomes = (summary) => (summary.outcomes || []).map((outcome) => ({
    name: outcome.name,
    probability: outcome.probability,
    duration: outcome.duration,
    requirement: outcome.requirement
  }));

  add('Achievements', (summary) => ({
    topic: summary.topic,
    counts: summary.counts,
    keyFacts: summary.keyFacts
  }));
  add('Golden_Cookie_info', (summary) => ({
    topic: summary.topic,
    keyFacts: summary.keyFacts,
    outcomes: compactOutcomes(summary),
    relatedUpgrades: summary.relatedUpgradeNames,
    relatedAchievements: summary.relatedAchievementNames
  }));

  if (hasReindeerContext) {
    add('Reindeer_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      relatedUpgrades: summary.relatedUpgradeNames,
      relatedAchievements: summary.relatedAchievementNames
    }));
  }

  if (hasWrinklerContext) {
    add('Wrinkler_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      cpsMultiplierByCount: summary.cpsMultiplierByCount,
      relatedUpgrades: summary.relatedUpgradeNames,
      relatedAchievements: summary.relatedAchievementNames
    }));
  }

  if (hasWrinklerContext || wants('shiny')) {
    add('Shiny_Wrinkler_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      obtaining: trimText(summary.obtaining, 450)
    }));
  }

  if (hasWrathContext) {
    add('Wrath_Cookie_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      chances: trimText(summary.chances, 450),
      outcomes: compactOutcomes(summary)
    }));
  }

  if (hasDragonContext) {
    add('Krumblor_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      auras: summary.auraNames,
      upgrades: summary.upgradeNames,
      trainingSteps: summary.trainingSteps,
      strategy: trimText(summary.strategy, 650)
    }));
  }

  if (hasChristmasContext || wants('santa')) {
    add('Santa_info', (summary) => ({
      topic: summary.topic,
      keyFacts: summary.keyFacts,
      stages: summary.stageNames,
      upgrades: summary.upgradeNames,
      allBonuses: summary.allBonuses
    }));
  }

  return summaries;
}

function buildPrompt(state, options) {
  const affordableUpgrades = state.upgradesInShop
    .filter((upgrade) => upgrade.affordable)
    .map((upgrade) => upgrade.name);
  const affordableBuildings = state.buildings
    .filter((building) => building.affordable)
    .map((building) => building.name);
  const allowedSaveUpTargets = buildAllowedSaveUpTargets(state);

  const promptState = {
    saveData: summarizeSaveData(state),
    goal: options.goal,
    strategy: options.strategy,
    referenceSummaries: buildReferenceSummaries(state, options),
    allowedBuyUpgradeTargets: affordableUpgrades,
    allowedBuyBuildingTargets: affordableBuildings,
    allowedSaveUpTargets,
    buildings: state.buildings.map((building) => ({
      name: building.name,
      owned: building.amount,
      price: building.currentPrice,
      cpsPerUnit: building.cpsPerUnit,
      paybackSeconds: building.paybackSeconds,
      affordable: building.affordable
    })),
    upgradesInShop: state.upgradesInShop.map((upgrade) => ({
      name: upgrade.name,
      price: upgrade.price,
      affordable: upgrade.affordable,
      effect: upgrade.effect,
      source: upgrade.databaseSource
    }))
  };

  return `
Analyze this Cookie Clicker state and choose exactly one next action.

Rules:
- Output raw JSON only. No markdown, no prose outside JSON.
- The JSON shape must be: {"explanation":"...","actionType":"...","targetName":"..."}.
- Valid actionType values: BUY_UPGRADE, BUY_BUILDING, CLICK_COOKIE, CLICK_BIG_COOKIE, CLICK_GOLDEN_COOKIE, SAVE_UP.
- For BUY_UPGRADE, targetName must exactly match one name from allowedBuyUpgradeTargets.
- For BUY_BUILDING, targetName must exactly match one name from allowedBuyBuildingTargets.
- SAVE_UP is allowed even when cheaper items are affordable, but it must be concrete.
- For SAVE_UP, targetName must exactly match one name from allowedSaveUpTargets.
- Do not put the save target only in explanation; targetName must contain the exact target.
- If your intended target is already affordable, return BUY_UPGRADE or BUY_BUILDING for it instead of SAVE_UP.
- Never use SAVE_UP as a generic wait/no-op. If there is no concrete save target, choose a buy action or CLICK_BIG_COOKIE.
- Use CLICK_BIG_COOKIE, CLICK_GOLDEN_COOKIE, CLICK_COOKIE, or SAVE_UP instead of buying something unaffordable.
- Prefer the user's goal and strategy, but never invent target names.

State:
${JSON.stringify(promptState)}
`;
}

function buildRepairPrompt(state, options, previousCommand, repairReason) {
  return `
${buildPrompt(state, options)}

Your previous Commander command was rejected:
${repairReason}

Previous command:
${JSON.stringify(previousCommand)}

Return one corrected raw JSON command only. If you still choose SAVE_UP, targetName must exactly match one name from allowedSaveUpTargets.
`;
}

function buildAllowedSaveUpTargets(state, limit = 20) {
  const cookies = Number(state.cookies) || 0;
  const cps = Number(state.cps) || 0;
  const withWait = (target) => {
    const shortfall = Math.max(0, target.price - cookies);
    return {
      ...target,
      shortfall,
      secondsToAfford: cps > 0 ? Math.ceil(shortfall / cps) : null
    };
  };

  return [
    ...state.upgradesInShop
      .filter((upgrade) => !upgrade.affordable && upgrade.price !== null)
      .map((upgrade) => withWait({
        type: 'upgrade',
        name: upgrade.name,
        price: upgrade.price,
        effect: upgrade.effect
      })),
    ...state.buildings
      .filter((building) => !building.affordable && building.currentPrice !== null)
      .map((building) => withWait({
        type: 'building',
        name: building.name,
        price: building.currentPrice,
        owned: building.amount,
        cpsPerUnit: building.cpsPerUnit,
        paybackSeconds: building.paybackSeconds
      }))
  ]
    .sort((a, b) => {
      if (a.shortfall !== b.shortfall) return a.shortfall - b.shortfall;
      return a.price - b.price;
    })
    .slice(0, limit);
}

function buildAdvicePrompt(state, options) {
  const affordableUpgrades = state.upgradesInShop
    .filter((upgrade) => upgrade.affordable)
    .slice(0, 12)
    .map((upgrade) => ({
      name: upgrade.name,
      price: upgrade.price,
      effect: upgrade.effect
    }));
  const affordableBuildings = state.buildings
    .filter((building) => building.affordable)
    .sort((a, b) => {
      const aPayback = a.paybackSeconds ?? Number.MAX_VALUE;
      const bPayback = b.paybackSeconds ?? Number.MAX_VALUE;
      if (aPayback !== bPayback) return aPayback - bPayback;
      return (a.currentPrice ?? Number.MAX_VALUE) - (b.currentPrice ?? Number.MAX_VALUE);
    })
    .slice(0, 12)
    .map((building) => ({
      name: building.name,
      owned: building.amount,
      price: building.currentPrice,
      cpsPerUnit: building.cpsPerUnit,
      paybackSeconds: building.paybackSeconds
    }));
  const nextUnaffordableTargets = [
    ...state.upgradesInShop
      .filter((upgrade) => !upgrade.affordable && upgrade.price !== null)
      .map((upgrade) => ({
        type: 'upgrade',
        name: upgrade.name,
        price: upgrade.price,
        shortfall: Math.max(0, upgrade.price - state.cookies),
        effect: upgrade.effect
      })),
    ...state.buildings
      .filter((building) => !building.affordable && building.currentPrice !== null)
      .map((building) => ({
        type: 'building',
        name: building.name,
        price: building.currentPrice,
        shortfall: Math.max(0, building.currentPrice - state.cookies),
        cpsPerUnit: building.cpsPerUnit
      }))
  ]
    .sort((a, b) => a.shortfall - b.shortfall)
    .slice(0, 8);

  const adviceState = {
    saveData: summarizeSaveData(state),
    goal: options.goal,
    strategy: options.strategy,
    referenceSummaries: buildReferenceSummaries(state, options),
    affordableUpgrades,
    affordableBuildings,
    nextUnaffordableTargets,
    buildingSummary: state.buildings.map((building) => ({
      name: building.name,
      owned: building.amount,
      price: building.currentPrice
    }))
  };

  return `
Give human-readable Cookie Clicker strategy advice for this exact game state.

Advice Mode rules:
- Do not output JSON.
- Do not give an automation command.
- Give a short structured answer with these labels: Best move, Why, Next target, Avoid.
- If saving is recommended, name the exact target, current price, current cookies, and shortfall.
- If anything is affordable and worth buying now, say that directly instead of vaguely saying to save up.
- Keep it concise but useful.

State:
${JSON.stringify(adviceState)}
`;
}

async function getAiAdvice(state, options) {
  const response = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a Cookie Clicker strategy coach. Give clear structured advice, not automation JSON.'
        },
        { role: 'user', content: buildAdvicePrompt(state, options) }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`AI server returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI server returned empty advice.');
  }

  return trimText(content, 2200);
}

async function requestAiCommand(prompt) {
  const response = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You are a Cookie Clicker automation engine. Return one valid raw JSON command only.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`AI server returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    return buildEmptyAiCommand('AI server returned an empty command.');
  }

  return parseAiCommand(content);
}

function parseAiCommand(content) {
  let jsonText = content.trim();
  const fencedJson = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedJson) {
    jsonText = fencedJson[1].trim();
  } else {
    const objectStart = jsonText.indexOf('{');
    const objectEnd = jsonText.lastIndexOf('}');

    if (objectStart !== -1 && objectEnd > objectStart) {
      jsonText = jsonText.slice(objectStart, objectEnd + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`AI returned invalid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI returned JSON, but not a command object.');
  }

  const rawActionType = String(parsed.actionType || parsed.action || '').trim();
  if (!rawActionType) {
    const hasAnyCommandDetail = Boolean(
      String(parsed.explanation || parsed.reason || '').trim() ||
      String(parsed.targetName || parsed.target || '').trim()
    );

    if (!hasAnyCommandDetail) {
      return buildEmptyAiCommand('AI returned JSON without a command.');
    }

    throw new Error('AI returned no actionType. If it wants to save up, it must return actionType "SAVE_UP".');
  }

  let actionType = rawActionType
    .replace(/[\s-]+/g, '_')
    .toUpperCase();

  if (actionType === 'WAIT') {
    actionType = 'SAVE_UP';
  }

  const rawExplanation = String(parsed.explanation || parsed.reason || '').trim();

  return {
    explanation: trimText(rawExplanation, 500) || defaultExplanationForAction(actionType),
    actionType,
    targetName: parsed.targetName === null || parsed.targetName === undefined
      ? ''
      : String(parsed.targetName).trim()
  };
}

function defaultExplanationForAction(actionType) {
  if (actionType === 'SAVE_UP') {
    return 'AI explicitly chose to save up for a future purchase.';
  }

  if (actionType === 'CLICK_GOLDEN_COOKIE') {
    return 'AI chose to click a visible golden cookie.';
  }

  if (actionType === 'CLICK_BIG_COOKIE' || actionType === 'CLICK_COOKIE') {
    return 'AI chose to click the big cookie.';
  }

  return 'AI returned a command without an explanation.';
}

function coerceAiCommand(command, state) {
  if (!VALID_ACTION_TYPES.has(command.actionType)) {
    throw new Error(
      `AI chose invalid actionType "${command.actionType}". If it wants to save up, it must use "SAVE_UP".`
    );
  }

  if (
    isPurchaseAction(command.actionType) &&
    !command.targetName
  ) {
    throw new Error(`AI chose ${command.actionType} without a targetName.`);
  }

  if (command.actionType === 'SAVE_UP') {
    return normalizeSaveUpCommand(command, state);
  }

  const saveTarget = getUnaffordableSaveTarget(command, state);
  if (saveTarget) {
    return saveTarget;
  }

  const validationError = getCommandValidationError(command, state);

  if (!validationError) {
    if (isTargetlessAction(command.actionType)) {
      return {
        ...command,
        targetName: ''
      };
    }

    return command;
  }

  return buildFallbackCommand(command, state, validationError);
}

function normalizeSaveUpCommand(command, state) {
  if (!command.targetName) {
    return command;
  }

  const target = resolvePurchaseTarget(command.targetName, state);
  if (!target) {
    return command;
  }

  if (target.affordable) {
    const actionType = target.type === 'upgrade' ? 'BUY_UPGRADE' : 'BUY_BUILDING';
    return {
      actionType,
      targetName: target.name,
      explanation:
        `AI wanted to save for "${target.name}", but it is affordable now, so Commander is buying it instead.`,
      fallbackFrom: command
    };
  }

  const shortfall = target.price === null ? null : Math.max(0, target.price - (Number(state.cookies) || 0));
  const details = target.price === null
    ? ''
    : ` Target costs ${formatNumber(target.price)}; current cookies ${formatNumber(state.cookies)}; shortfall ${formatNumber(shortfall)}.`;

  return {
    ...command,
    targetName: target.name,
    saveTargetType: target.type,
    explanation: trimText(`${command.explanation}${details}`, 650)
  };
}

function getSaveUpRepairReason(command, state) {
  if (command.actionType !== 'SAVE_UP') {
    return '';
  }

  if (!command.targetName) {
    return 'SAVE_UP did not include an exact targetName, so Commander cannot tell whether the AI is intentionally saving or just idling.';
  }

  const target = resolvePurchaseTarget(command.targetName, state);
  if (!target) {
    return `SAVE_UP target "${command.targetName}" is not a visible upgrade or building target.`;
  }

  if (target.price === null) {
    return `SAVE_UP target "${target.name}" has no readable price.`;
  }

  const allowedSaveTarget = buildAllowedSaveUpTargets(state)
    .some((item) => item.name === target.name);
  if (!allowedSaveTarget) {
    return `SAVE_UP target "${target.name}" is visible, but it is not one of the allowedSaveUpTargets sent to Commander.`;
  }

  return '';
}

function getCommandValidationError(command, state) {
  if (isTargetlessAction(command.actionType)) {
    return null;
  }

  if (command.actionType === 'BUY_UPGRADE') {
    const upgrade = state.upgradesInShop.find((item) => item.name === command.targetName);

    if (!upgrade) {
      return `AI chose unavailable upgrade "${command.targetName}".`;
    }

    if (upgrade.price !== null && !upgrade.affordable) {
      return `AI chose unaffordable upgrade "${command.targetName}".`;
    }
  }

  if (command.actionType === 'BUY_BUILDING') {
    const building = state.buildings.find((item) => item.name === command.targetName);

    if (!building) {
      return `AI chose unavailable building "${command.targetName}".`;
    }

    if (building.currentPrice !== null && !building.affordable) {
      return `AI chose unaffordable building "${command.targetName}".`;
    }
  }

  return null;
}

function isTargetlessAction(actionType) {
  return actionType === 'CLICK_COOKIE' ||
    actionType === 'CLICK_BIG_COOKIE' ||
    actionType === 'CLICK_GOLDEN_COOKIE' ||
    actionType === 'SAVE_UP' ||
    actionType === 'WAIT';
}

function isPurchaseAction(actionType) {
  return actionType === 'BUY_UPGRADE' || actionType === 'BUY_BUILDING';
}

function buildEmptyAiCommand(reason) {
  return {
    actionType: 'CLICK_BIG_COOKIE',
    targetName: '',
    explanation: `${reason} Commander treated that as no command and kept the big cookie auto-clicker running instead.`
  };
}

function getUnaffordableSaveTarget(command, state) {
  if (command.actionType === 'BUY_UPGRADE') {
    const upgrade = state.upgradesInShop.find((item) => item.name === command.targetName);

    if (upgrade && upgrade.price !== null && !upgrade.affordable) {
      return buildSaveUpCommand(
        command,
        upgrade.name,
        'upgrade',
        upgrade.price,
        state.cookies,
        `AI wants "${upgrade.name}", but it costs ${formatNumber(upgrade.price)} and you have ${formatNumber(state.cookies)}.`
      );
    }
  }

  if (command.actionType === 'BUY_BUILDING') {
    const building = state.buildings.find((item) => item.name === command.targetName);

    if (building && building.currentPrice !== null && !building.affordable) {
      return buildSaveUpCommand(
        command,
        building.name,
        'building',
        building.currentPrice,
        state.cookies,
        `AI wants "${building.name}", but it costs ${formatNumber(building.currentPrice)} and you have ${formatNumber(state.cookies)}.`
      );
    }
  }

  return null;
}

function resolvePurchaseTarget(targetName, state) {
  const wanted = String(targetName || '').trim();
  if (!wanted) return null;

  const exactUpgrade = state.upgradesInShop.find((item) => item.name === wanted);
  if (exactUpgrade) {
    return {
      type: 'upgrade',
      name: exactUpgrade.name,
      price: exactUpgrade.price ?? null,
      affordable: Boolean(exactUpgrade.affordable)
    };
  }

  const exactBuilding = state.buildings.find((item) => item.name === wanted);
  if (exactBuilding) {
    return {
      type: 'building',
      name: exactBuilding.name,
      price: exactBuilding.currentPrice ?? null,
      affordable: Boolean(exactBuilding.affordable)
    };
  }

  const normalized = wanted.toLowerCase();
  const upgrade = state.upgradesInShop.find((item) => item.name.toLowerCase() === normalized);
  if (upgrade) {
    return {
      type: 'upgrade',
      name: upgrade.name,
      price: upgrade.price ?? null,
      affordable: Boolean(upgrade.affordable)
    };
  }

  const building = state.buildings.find((item) => item.name.toLowerCase() === normalized);
  if (building) {
    return {
      type: 'building',
      name: building.name,
      price: building.currentPrice ?? null,
      affordable: Boolean(building.affordable)
    };
  }

  return null;
}

function buildSaveUpCommand(command, targetName, targetType, price, cookies, reason) {
  const shortfall = Math.max(0, price - (Number(cookies) || 0));
  return {
    actionType: 'SAVE_UP',
    targetName,
    saveTargetType: targetType,
    explanation: `${reason} Shortfall: ${formatNumber(shortfall)}. Saving up instead of buying cheaper available items.`,
    fallbackFrom: command
  };
}

function buildFallbackCommand(command, state, reason) {
  const affordableUpgrade = state.upgradesInShop
    .filter((upgrade) => upgrade.affordable)
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))[0];

  if (affordableUpgrade) {
    return {
      actionType: 'BUY_UPGRADE',
      targetName: affordableUpgrade.name,
      explanation:
        `${reason} AI did not provide an actionable save target, so Commander is buying the strongest affordable visible upgrade it can identify: "${affordableUpgrade.name}".`,
      fallbackFrom: command
    };
  }

  const affordableBuilding = state.buildings
    .filter((building) => building.affordable && building.unlocked !== false)
    .sort((a, b) => {
      const aPayback = a.paybackSeconds ?? Number.MAX_VALUE;
      const bPayback = b.paybackSeconds ?? Number.MAX_VALUE;
      if (aPayback !== bPayback) return aPayback - bPayback;
      return (a.currentPrice ?? Number.MAX_VALUE) - (b.currentPrice ?? Number.MAX_VALUE);
    })[0];

  if (affordableBuilding) {
    return {
      actionType: 'BUY_BUILDING',
      targetName: affordableBuilding.name,
      explanation:
        `${reason} AI did not provide an actionable save target, so Commander is buying the affordable building with the best payback: "${affordableBuilding.name}".`,
      fallbackFrom: command
    };
  }

  const nearestTarget = buildAllowedSaveUpTargets(state, 1)[0];
  if (nearestTarget) {
    return {
      actionType: 'SAVE_UP',
      targetName: nearestTarget.name,
      saveTargetType: nearestTarget.type,
      explanation:
        `${reason} No valid purchases are affordable yet, so Commander is saving for nearest visible ${nearestTarget.type} "${nearestTarget.name}" with a shortfall of ${formatNumber(nearestTarget.shortfall)}.`,
      fallbackFrom: command
    };
  }

  return {
    actionType: 'CLICK_BIG_COOKIE',
    targetName: '',
    explanation:
      `${reason} No valid buy or save target is visible, so Commander will keep clicking while waiting for the game state to update.`,
    fallbackFrom: command
  };
}

async function setBigCookieAutoClicker(tabId, enabled) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [enabled, BIG_COOKIE_CLICKS_PER_SECOND],
    func: (shouldRun, clicksPerSecond) => {
      const state = globalThis.cookieAiBigCookieAutoClicker || {
        running: false,
        timerId: null,
        clicksPerSecond,
        intervalMs: 1000 / clicksPerSecond,
        nextClickAt: 0,
        totalClicks: 0,
        startedAt: 0,
        lastError: ''
      };

      globalThis.cookieAiBigCookieAutoClicker = state;

      const stop = () => {
        state.running = false;
        if (state.timerId !== null) {
          clearTimeout(state.timerId);
          state.timerId = null;
        }
      };

      if (!shouldRun) {
        stop();
        return {
          ok: true,
          autoClickerRunning: false,
          autoClickerCps: clicksPerSecond,
          autoClickerClicks: state.totalClicks,
          message: 'Big cookie auto-clicker stopped.'
        };
      }

      if (typeof Game === 'undefined') {
        stop();
        return {
          ok: false,
          autoClickerRunning: false,
          autoClickerCps: clicksPerSecond,
          autoClickerClicks: state.totalClicks,
          message: 'Cookie Clicker Game object was not found.'
        };
      }

      const clickBigCookie = () => {
        const before = Number(Game.cookieClicks) || 0;
        const bigCookie = document.getElementById('bigCookie');

        if (bigCookie) {
          const rect = bigCookie.getBoundingClientRect();
          const clientX = rect.left + (rect.width / 2);
          const clientY = rect.top + (rect.height / 2);
          Game.mouseX = clientX;
          Game.mouseY = clientY;
          bigCookie.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX,
            clientY
          }));
        }

        if ((Number(Game.cookieClicks) || 0) <= before && typeof Game.ClickCookie === 'function') {
          Game.ClickCookie();
        }

        return (Number(Game.cookieClicks) || 0) > before;
      };

      const scheduleNext = () => {
        if (!state.running) return;
        const delayMs = Math.max(0, state.nextClickAt - performance.now());
        state.timerId = setTimeout(runClickLoop, delayMs);
      };

      const runClickLoop = () => {
        if (!state.running) return;

        try {
          if (typeof Game !== 'undefined' && !Game.OnAscend && clickBigCookie()) {
            state.totalClicks += 1;
          }
          state.lastError = '';
        } catch (err) {
          state.lastError = err?.message || String(err);
        }

        state.nextClickAt += state.intervalMs;
        const now = performance.now();
        if (state.nextClickAt < now - state.intervalMs) {
          state.nextClickAt = now + state.intervalMs;
        }
        scheduleNext();
      };

      state.clicksPerSecond = clicksPerSecond;
      state.intervalMs = 1000 / clicksPerSecond;

      if (!state.running) {
        state.running = true;
        state.startedAt = Date.now();
        state.nextClickAt = performance.now();
        runClickLoop();
      }

      return {
        ok: true,
        autoClickerRunning: state.running,
        autoClickerCps: state.clicksPerSecond,
        autoClickerClicks: state.totalClicks,
        message: `Big cookie auto-clicker running at about ${state.clicksPerSecond} clicks/sec.`
      };
    }
  });

  return results[0]?.result || {
    ok: false,
    autoClickerRunning: false,
    autoClickerCps: BIG_COOKIE_CLICKS_PER_SECOND,
    autoClickerClicks: 0,
    message: 'No auto-clicker result returned.'
  };
}

async function clickGameTargets(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const result = {
        ok: true,
        goldenCookiesClicked: 0,
        message: ''
      };

      if (typeof Game === 'undefined') {
        return {
          ...result,
          ok: false,
          message: 'Cookie Clicker Game object was not found.'
        };
      }

      const shimmers = Array.isArray(Game.shimmers) ? [...Game.shimmers] : [];
      const clickGoldenCookie = (shimmer) => {
        if (typeof shimmer?.pop === 'function') {
          shimmer.pop();
          return true;
        }

        if (typeof shimmer?.l?.click === 'function') {
          shimmer.l.click();
          return true;
        }

        return false;
      };

      for (const shimmer of shimmers) {
        if (shimmer?.type === 'golden') {
          try {
            if (clickGoldenCookie(shimmer)) {
              result.goldenCookiesClicked++;
            }
          } catch (_err) {
            // Golden cookies are temporary; ignore one that disappeared mid-click.
          }
        }
      }

      const messages = [];
      if (result.goldenCookiesClicked) {
        messages.push(`clicked ${result.goldenCookiesClicked} golden cookie(s)`);
      }
      result.message = messages.join(', ');

      return result;
    }
  });

  return results[0]?.result || {
    ok: false,
    goldenCookiesClicked: 0,
    message: 'No click result returned.'
  };
}

function mergeClickStats(...statsList) {
  return statsList.reduce((merged, stats) => ({
    goldenCookiesClicked: merged.goldenCookiesClicked + (stats?.goldenCookiesClicked || 0),
    autoClickerRunning: merged.autoClickerRunning || Boolean(stats?.autoClickerRunning),
    autoClickerCps: stats?.autoClickerCps || merged.autoClickerCps
  }), {
    goldenCookiesClicked: 0,
    autoClickerRunning: false,
    autoClickerCps: 0
  });
}

async function applyCommand(tabId, command) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [command],
    func: (cmd) => {
      if (typeof Game === 'undefined') {
        return { ok: false, message: 'Cookie Clicker Game object was not found.' };
      }

      if (cmd.actionType === 'SAVE_UP' || cmd.actionType === 'WAIT') {
        return {
          ok: true,
          message: cmd.targetName
            ? `Saving up for "${cmd.targetName}".`
            : 'Saving up for a future purchase.'
        };
      }

      if (cmd.actionType === 'CLICK_GOLDEN_COOKIE') {
        const shimmers = Array.isArray(Game.shimmers) ? [...Game.shimmers] : [];
        let goldenCookiesClicked = 0;
        const clickGoldenCookie = (shimmer) => {
          if (typeof shimmer?.pop === 'function') {
            shimmer.pop();
            return true;
          }

          if (typeof shimmer?.l?.click === 'function') {
            shimmer.l.click();
            return true;
          }

          return false;
        };

        for (const shimmer of shimmers) {
          if (shimmer?.type === 'golden' && clickGoldenCookie(shimmer)) {
            goldenCookiesClicked++;
          }
        }

        return {
          ok: true,
          message: goldenCookiesClicked
            ? `Clicked ${goldenCookiesClicked} golden cookie(s).`
            : 'No golden cookies were visible.'
        };
      }

      if (cmd.actionType === 'CLICK_COOKIE' || cmd.actionType === 'CLICK_BIG_COOKIE') {
        const clicker = globalThis.cookieAiBigCookieAutoClicker;
        return {
          ok: true,
          message: clicker?.running
            ? `Big cookie auto-clicker is already running at about ${clicker.clicksPerSecond} clicks/sec.`
            : 'Big cookie click command accepted; Commander auto-clicker will resume on the next tick.'
        };
      }

      if (cmd.actionType === 'BUY_UPGRADE') {
        const upgrade = Game.Upgrades[cmd.targetName];
        if (!upgrade) {
          return { ok: false, message: `Upgrade not found: ${cmd.targetName}` };
        }

        const wasBought = Boolean(upgrade.bought);
        upgrade.buy();

        return {
          ok: Boolean(upgrade.bought) && !wasBought,
          message: upgrade.bought ? `Bought upgrade: ${cmd.targetName}` : `Could not buy upgrade: ${cmd.targetName}`
        };
      }

      if (cmd.actionType === 'BUY_BUILDING') {
        const building = Game.Objects[cmd.targetName];
        if (!building) {
          return { ok: false, message: `Building not found: ${cmd.targetName}` };
        }

        const previousAmount = building.amount;
        building.buy();

        return {
          ok: building.amount > previousAmount,
          message: building.amount > previousAmount
            ? `Bought building: ${cmd.targetName}`
            : `Could not buy building: ${cmd.targetName}`
        };
      }

      return { ok: false, message: `Unsupported action: ${cmd.actionType}` };
    }
  });

  return results[0]?.result || { ok: false, message: 'No execution result returned.' };
}

function formatExecutionMessage(command, execution, clickStats = {}) {
  const prefix = execution?.ok ? 'EXECUTING' : 'SKIPPED';
  const action = formatActionLabel(command);
  const clickSummary = formatClickSummary(clickStats);

  return [
    `${prefix}: ${action}`,
    command.explanation,
    execution?.message || '',
    clickSummary
  ].filter(Boolean).join('\n').trim();
}

function formatActionLabel(command) {
  if (command.actionType === 'SAVE_UP') {
    return command.targetName ? `SAVING UP for ${command.targetName}` : 'SAVING UP';
  }

  return command.targetName
    ? `${command.actionType} ${command.targetName}`
    : command.actionType;
}

function formatClickSummary(clickStats) {
  const parts = [];

  if (clickStats.goldenCookiesClicked) {
    parts.push(`golden cookies: ${clickStats.goldenCookiesClicked}`);
  }

  if (clickStats.autoClickerRunning) {
    parts.push(`big cookie auto-clicker: ~${clickStats.autoClickerCps || BIG_COOKIE_CLICKS_PER_SECOND} cps`);
  }

  return parts.length ? `Auto actions: ${parts.join(', ')}.` : '';
}

function normalizeOptions(options = {}) {
  return {
    goal: String(options.goal || 'Maximum Efficiency').trim() || 'Maximum Efficiency',
    strategy: String(options.strategy || 'aggressive').trim() || 'aggressive'
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }

  return null;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  return Math.floor(number).toLocaleString('en-US');
}

function trimText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}
