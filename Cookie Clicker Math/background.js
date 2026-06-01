const COMMANDER_TICK_MS = 1000;
const COMMANDER_MAX_FAILURES = 5;
const BIG_COOKIE_CLICKS_PER_SECOND = 44;
const BUILDING_PRICE_GROWTH = 1.15;
const ENGINE_BEAM_WIDTH = 24;
const ENGINE_CANDIDATE_LIMIT = 42;
const ENGINE_MAX_DEPTH = 9;
const ENGINE_MAX_TARGET_SECONDS = 365 * 24 * 60 * 60;
const ASCENSION_BEAM_WIDTH = 32;
const ASCENSION_CANDIDATE_LIMIT = 58;
const ASCENSION_MAX_DEPTH = 34;
const ASCENSION_TRANSITION_MAX_MS = 45000;
const ASCENSION_RETRY_MIN_MS = 3000;
const ASCENSION_TRANSITION_POLL_MS = ASCENSION_RETRY_MIN_MS;

const VALID_ACTION_TYPES = new Set([
  'BUY_UPGRADE',
  'BUY_BUILDING',
  'CLICK_BIG_COOKIE',
  'CLICK_GOLDEN_COOKIE',
  'DO_ACHIEVEMENT_ACTION',
  'POP_WRINKLERS',
  'COLLECT_SUGAR_LUMP',
  'USE_SUGAR_LUMP',
  'ASCEND',
  'BUY_ASCENSION_UPGRADE',
  'REINCARNATE',
  'SAVE_UP',
  'WAIT'
]);

let commanderState = {
  running: false,
  tabId: null,
  options: {},
  loopId: 0,
  failureCount: 0,
  message: 'Math Commander is idle.',
  mathDetails: 'Run Advice Mode or Commander Mode to see planner math.',
  ascensionTransitionStartedAt: null,
  lastCommand: null
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => {
      console.error('Cookie Math Commander error:', err);
      sendResponse({
        ok: false,
        running: commanderState.running,
        message: `Error: ${err.message || err}`
      });
    });

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case 'GET_STATUS':
      return getPublicStatus();

    case 'ANALYZE_ONCE':
      return analyzeOnce(message.tabId, message.options);

    case 'START_COMMANDER':
      return startCommander(message.tabId, message.options);

    case 'STOP_COMMANDER':
      await stopCommander('Math Commander stopped.');
      return getPublicStatus();

    case 'MATH_COMMANDER_TICK':
      return commanderTick(message.loopId);

    default:
      throw new Error(`Unknown message type: ${message?.type || 'missing'}`);
  }
}

function getPublicStatus() {
  return {
    running: commanderState.running,
    message: commanderState.message,
    mathDetails: commanderState.mathDetails,
    lastCommand: commanderState.lastCommand
  };
}

async function analyzeOnce(tabId, options) {
  const analysis = await buildAnalysis(tabId, options);
  commanderState.failureCount = 0;
  commanderState.lastCommand = analysis.command;
  commanderState.message = formatAdvice(analysis);
  commanderState.mathDetails = formatMathDetails(analysis);
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
    message: 'Math Commander started. Reading live Cookie Clicker state...',
    mathDetails: 'Waiting for the first planner tick...',
    ascensionTransitionStartedAt: null,
    lastCommand: null
  };

  try {
    await ensureCommanderContentScript(tabId);
    await setBigCookieAutoClicker(tabId, false);
    await chrome.tabs.sendMessage(tabId, {
      type: 'COOKIE_MATH_START_LOOP',
      loopId: commanderState.loopId
    });
  } catch (err) {
    try {
      await setBigCookieAutoClicker(tabId, false);
    } catch (_stopErr) {
      // Startup failed, and the public state below is enough for the popup.
    }

    commanderState.running = false;
    commanderState.message = `Could not start Math Commander: ${err.message || err}`;
    throw err;
  }

  return getPublicStatus();
}

async function stopCommander(message) {
  const tabId = commanderState.tabId;

  commanderState.running = false;
  commanderState.loopId += 1;
  commanderState.failureCount = 0;
  commanderState.message = message || 'Math Commander stopped.';
  commanderState.ascensionTransitionStartedAt = null;

  if (Number.isInteger(tabId)) {
    try {
      await setBigCookieAutoClicker(tabId, false);
    } catch (_err) {
      // The tab may have closed or reloaded.
    }

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'COOKIE_MATH_STOP_LOOP',
        loopId: commanderState.loopId
      });
    } catch (_err) {
      // The tab may have closed or reloaded.
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
    return { ...getPublicStatus(), running: false, delayMs: 0 };
  }

  try {
    const transitionStatus = await getAscensionTransitionStatus(commanderState.tabId);
    if (transitionStatus.onAscend) {
      commanderState.ascensionTransitionStartedAt = null;
    }

    if (
      !transitionStatus.pending &&
      !transitionStatus.onAscend &&
      commanderState.ascensionTransitionStartedAt
    ) {
      const elapsedMs = Date.now() - commanderState.ascensionTransitionStartedAt;
      if (elapsedMs <= ASCENSION_TRANSITION_MAX_MS) {
        const minWaitLeftMs = Math.max(0, ASCENSION_RETRY_MIN_MS - elapsedMs);
        transitionStatus.pending = true;
        transitionStatus.elapsedMs = elapsedMs;
        transitionStatus.message =
          minWaitLeftMs > 0
            ? `Ascension command was sent once; waiting at least ${Math.ceil(minWaitLeftMs / 1000)}s before any retry.`
            : `Ascension command was sent once; waiting for the legacy screen animation (${Math.ceil(elapsedMs / 1000)}s).`;
      } else {
        commanderState.ascensionTransitionStartedAt = null;
      }
    }

    if (transitionStatus.pending) {
      const clickerStatus = await setBigCookieAutoClicker(commanderState.tabId, false);
      commanderState.failureCount = 0;
      commanderState.lastCommand = {
        actionType: 'ASCEND',
        targetName: 'legacy',
        explanation: transitionStatus.message
      };
      commanderState.message = [
        'WAITING: ASCENSION TRANSITION',
        transitionStatus.message,
        formatClickSummary(clickerStatus)
      ].filter(Boolean).join('\n');

      return {
        ...getPublicStatus(),
        delayMs: ASCENSION_TRANSITION_POLL_MS
      };
    }

    const analysis = await buildAnalysis(commanderState.tabId, commanderState.options);
    const preClicks = analysis.state.onAscend
      ? { ok: true, goldenCookiesClicked: 0, message: 'Skipped normal auto-actions on the ascension screen.' }
      : await clickGameTargets(commanderState.tabId);
    const clickerStatus = await setBigCookieAutoClicker(
      commanderState.tabId,
      !analysis.state.onAscend && !shouldSuppressBigCookieClicks(analysis.command)
    );
    const execution = await applyCommand(commanderState.tabId, analysis.command);
    const postClicks = analysis.state.onAscend || analysis.command.actionType === 'ASCEND'
      ? { ok: true, goldenCookiesClicked: 0, message: 'Skipped auto-clicks during ascension/legacy handling.' }
      : await clickGameTargets(commanderState.tabId);

    if (analysis.command.actionType === 'ASCEND') {
      if (execution?.pending) {
        commanderState.ascensionTransitionStartedAt = Date.now();
      } else if (execution?.ok) {
        commanderState.ascensionTransitionStartedAt = null;
      }
    }

    commanderState.failureCount = 0;
    commanderState.lastCommand = analysis.command;
    commanderState.message = formatExecutionMessage(
      analysis,
      execution,
      mergeClickStats(preClicks, postClicks, clickerStatus)
    );
    commanderState.mathDetails = formatMathDetails(analysis);

    return {
      ...getPublicStatus(),
      delayMs: analysis.command.actionType === 'ASCEND' && execution?.pending
        ? ASCENSION_TRANSITION_POLL_MS
        : COMMANDER_TICK_MS
    };
  } catch (err) {
    commanderState.failureCount += 1;

    if (commanderState.failureCount >= COMMANDER_MAX_FAILURES) {
      await stopCommander(
        `Math Commander stopped after ${COMMANDER_MAX_FAILURES} failed attempts: ${err.message || err}`
      );

      return { ...getPublicStatus(), running: false, delayMs: 0 };
    }

    const backoffMs = Math.min(30000, 1000 * (2 ** commanderState.failureCount));
    commanderState.message =
      `Math Commander retry ${commanderState.failureCount}/${COMMANDER_MAX_FAILURES}: ` +
      `${err.message || err}. Retrying in ${Math.ceil(backoffMs / 1000)}s.`;

    return {
      ...getPublicStatus(),
      delayMs: backoffMs
    };
  }
}

async function buildAnalysis(tabId, rawOptions) {
  const options = normalizeOptions(rawOptions);
  const state = await extractGameState(tabId);

  if (!state.isCookieClicker) {
    throw new Error('This tab does not look like Cookie Clicker. Open the main Cookie Clicker game tab first.');
  }

  const engine = runMathEngine(state, options);
  const candidates = engine.rootCandidates;
  const best = engine.bestCandidate;
  const command = commandFromPlan(engine, state, options);

  return {
    state,
    options,
    candidates,
    best,
    command,
    engine,
    baseline: engine.baseline,
    ascension: buildAscensionNote(state, options)
  };
}

function runMathEngine(state, options) {
  const model = createEngineModel(state, options);
  const baseline = buildEngineBaseline(model, options);
  const plan = beamSearchPlan(model, options);
  const ascensionPlan = buildDedicatedAscensionPlan(model, options);
  const rootCandidates = summarizeRootCandidates(plan.routes, options);
  const ascensionCandidates = ascensionPlan
    ? summarizeRootCandidates(ascensionPlan.routes, options)
    : [];
  const noPurchaseRoute = plan.routes.find((route) => !route.model.firstStep) ||
    scoreRoute(cloneEngineModel(model), options);
  const noPurchaseCandidate = buildNoPurchaseCandidate(noPurchaseRoute, model, options);
  const rankedChoices = [noPurchaseCandidate, ...rootCandidates, ...ascensionCandidates]
    .sort((a, b) => compareRouteScores(a.route, b.route));
  const bestCandidate = rankedChoices[0] || noPurchaseCandidate;

  return {
    model,
    baseline,
    plan,
    ascensionPlan,
    rootCandidates,
    ascensionCandidates,
    rankedChoices,
    noPurchaseCandidate,
    bestCandidate,
    warnings: buildEngineWarnings(state, rootCandidates)
  };
}

function createEngineModel(state, _options) {
  const passiveCps = Math.max(0, Number(state.cps) || 0);
  const liveClickCps = Math.max(0, Number(state.clickCps) || 0);
  const clickCpsRatio = passiveCps > 0 ? liveClickCps / passiveCps : 0;
  const clickFlatCps = state.onAscend ? 0 : passiveCps > 0 ? 0 : liveClickCps;
  const ownedUpgradeNames = (state.ownedUpgrades || [])
    .filter((upgrade) => upgrade.bought !== false)
    .map((upgrade) => String(upgrade.name || ''))
    .filter(Boolean);

  return {
    cookies: Math.max(0, Number(state.cookies) || 0),
    cookieClicks: Math.max(0, Number(state.cookieClicks) || 0),
    passiveCps,
    clickCpsRatio,
    clickFlatCps,
    randomCps: estimateRandomEventCps(state),
    elapsed: 0,
    lumps: Math.max(0, Number(state.lumps) || 0),
    sugarLump: { ...(state.sugarLump || {}) },
    wrinklersActive: Math.max(0, Number(state.wrinklersActive) || 0),
    wrinklersSucked: Math.max(0, Number(state.wrinklersSucked) || 0),
    prestige: Math.max(0, Number(state.prestige) || 0),
    heavenlyChips: Math.max(0, Number(state.heavenlyChips) || 0),
    prestigeGain: Math.max(0, Number(state.prestigeGain) || 0),
    onAscend: Boolean(state.onAscend),
    globalCpsMult: Math.max(0, Number(state.globalCpsMult) || 1),
    nextRunGlobalMultiplier: 1,
    milkProgress: Math.max(0, Number(state.milkProgress) || 0),
    milkPowerMultiplier: Math.max(0, Number(state.milkPowerMultiplier) || 1),
    ownedUpgradeNames,
    ownedKittenMilkFactors: ownedUpgradeNames
      .map((name) => kittenMilkFactor(name))
      .filter((factor) => factor > 0),
    goldenCookiesBlocked: Boolean(state.goldenCookiesBlocked),
    goldenCookieBlockers: [...(state.goldenCookieBlockers || [])],
    achievements: state.achievements || [],
    achievementStats: state.achievementStats || {},
    ascensionUpgrades: (state.ascensionUpgrades || []).map((upgrade) => ({ ...upgrade })),
    buildings: state.buildings
      .filter((building) => building.unlocked && building.currentPrice !== null)
      .map((building) => ({
        name: building.name,
        amount: Math.max(0, Number(building.amount) || 0),
        level: Math.max(0, Number(building.level) || 0),
        price: Math.max(0, Number(building.currentPrice) || 0),
        basePrice: Math.max(0, Number(building.basePrice) || Number(building.currentPrice) || 0),
        cpsPerUnit: Math.max(0, Number(building.cpsPerUnit) || 0),
        totalCps: Math.max(0, Number(building.totalCps) || 0),
        unlocked: building.unlocked !== false
      })),
    upgrades: state.upgradesInStore
      .filter((upgrade) => upgrade.price !== null)
      .map((upgrade) => ({
        name: upgrade.name,
        price: Math.max(0, Number(upgrade.price) || 0),
        description: String(upgrade.description || ''),
        pool: String(upgrade.pool || ''),
        order: Number(upgrade.order) || 0,
        effect: estimateUpgradeEffectRules(upgrade, state)
      })),
    history: [],
    firstStep: null
  };
}

function estimateRandomEventCps(state) {
  const passiveCps = Math.max(0, Number(state.cps) || 0);
  const wrinklers = Math.max(0, Number(state.wrinklersActive) || 0);
  const visibleGoldenCookies = state.goldenCookiesBlocked
    ? 0
    : Math.max(0, Number(state.goldenCookiesVisible) || 0);
  let estimate = 0;

  if (wrinklers > 0) {
    estimate += passiveCps * Math.min(1, wrinklers * 0.005);
  }

  if (visibleGoldenCookies > 0) {
    estimate += passiveCps * 0.02;
  }

  return estimate;
}

function cloneEngineModel(model) {
  return {
    cookies: model.cookies,
    cookieClicks: model.cookieClicks,
    passiveCps: model.passiveCps,
    clickCpsRatio: model.clickCpsRatio,
    clickFlatCps: model.clickFlatCps,
    randomCps: model.randomCps,
    elapsed: model.elapsed,
    lumps: model.lumps,
    sugarLump: { ...(model.sugarLump || {}) },
    wrinklersActive: model.wrinklersActive,
    wrinklersSucked: model.wrinklersSucked,
    prestige: model.prestige,
    heavenlyChips: model.heavenlyChips,
    prestigeGain: model.prestigeGain,
    onAscend: model.onAscend,
    globalCpsMult: model.globalCpsMult,
    nextRunGlobalMultiplier: model.nextRunGlobalMultiplier,
    milkProgress: model.milkProgress,
    milkPowerMultiplier: model.milkPowerMultiplier,
    ownedUpgradeNames: [...(model.ownedUpgradeNames || [])],
    ownedKittenMilkFactors: [...(model.ownedKittenMilkFactors || [])],
    goldenCookiesBlocked: model.goldenCookiesBlocked,
    goldenCookieBlockers: [...(model.goldenCookieBlockers || [])],
    achievements: model.achievements,
    achievementStats: model.achievementStats,
    ascensionUpgrades: model.ascensionUpgrades.map((upgrade) => ({ ...upgrade })),
    buildings: model.buildings.map((building) => ({ ...building })),
    upgrades: model.upgrades.map((upgrade) => ({
      ...upgrade,
      effect: cloneEffect(upgrade.effect)
    })),
    history: model.history.map((step) => ({ ...step })),
    firstStep: model.firstStep ? { ...model.firstStep } : null
  };
}

function cloneEffect(effect) {
  return {
    ...effect,
    effects: (effect.effects || []).map((item) => ({
      ...item,
      buildingNames: item.buildingNames ? [...item.buildingNames] : undefined,
      achievementNames: item.achievementNames ? [...item.achievementNames] : undefined
    })),
    reasons: [...(effect.reasons || [])]
  };
}

function engineIncomePerSecond(model) {
  return Math.max(
    0,
    model.passiveCps * (1 + model.clickCpsRatio) + model.clickFlatCps + model.randomCps
  );
}

function buildEngineBaseline(model, options) {
  const income = engineIncomePerSecond(model);

  if (options.objective.type === 'target') {
    const target = options.objective.targetCookies;
    return {
      incomePerSecond: income,
      label: income > 0
        ? `Baseline time to target, including auto-clicks: ${formatSeconds(Math.max(0, (target - model.cookies) / income))}`
        : 'Baseline time to target: unknown because modeled income is 0'
    };
  }

  return {
    incomePerSecond: income,
    label:
      `Baseline after ${formatSeconds(options.objective.horizonSeconds)}, including auto-clicks: ` +
      `${formatNumber(model.cookies + (income * options.objective.horizonSeconds))} cookies`
  };
}

function beamSearchPlan(startModel, options, overrideSettings = null) {
  const settings = overrideSettings || engineSettingsForOptions(options);
  const routes = [scoreRoute(cloneEngineModel(startModel), options)];
  let beams = [cloneEngineModel(startModel)];

  for (let depth = 0; depth < settings.maxDepth; depth++) {
    const expansions = [];

    for (const beam of beams) {
      const candidates = getEngineCandidates(beam, options).slice(0, settings.candidateLimit);

      for (const candidate of candidates) {
        const child = cloneEngineModel(beam);
        const step = advanceAndBuy(child, candidate, options);

        if (!step) continue;

        child.history.push(step);
        if (!child.firstStep) {
          child.firstStep = { ...step };
        }

        expansions.push(child);
      }
    }

    if (!expansions.length) {
      break;
    }

    const scoredExpansions = expansions
      .map((model) => scoreRoute(model, options))
      .sort(compareRouteScores);

    routes.push(...scoredExpansions);
    beams = scoredExpansions
      .slice(0, settings.beamWidth)
      .map((route) => route.model);
  }

  const sortedRoutes = routes.sort(compareRouteScores);
  return {
    routes: sortedRoutes,
    bestRoute: sortedRoutes[0] || routes[0],
    routeCount: sortedRoutes.length,
    maxDepth: settings.maxDepth,
    beamWidth: settings.beamWidth,
    candidateLimit: settings.candidateLimit
  };
}

function buildDedicatedAscensionPlan(startModel, options) {
  if (!options.allowAscension || startModel.onAscend || startModel.prestigeGain <= 0) {
    return null;
  }

  const ascendCandidate = annotateCandidate(buildAscendCandidate(startModel, options), startModel, options);
  const ascendedModel = cloneEngineModel(startModel);
  const ascendStep = advanceAndBuy(ascendedModel, ascendCandidate, options);

  if (!ascendStep) {
    return null;
  }

  ascendedModel.history.push(ascendStep);
  ascendedModel.firstStep = { ...ascendStep };

  return beamSearchPlan(
    ascendedModel,
    options,
    ascensionSettingsForOptions(options)
  );
}

function engineSettingsForOptions(options) {
  if (options.strategy === 'short') {
    return {
      maxDepth: Math.max(4, Math.min(ENGINE_MAX_DEPTH, 5)),
      beamWidth: Math.max(12, Math.floor(ENGINE_BEAM_WIDTH * 0.75)),
      candidateLimit: Math.max(24, Math.floor(ENGINE_CANDIDATE_LIMIT * 0.75))
    };
  }

  if (options.strategy === 'long') {
    return {
      maxDepth: ENGINE_MAX_DEPTH + 3,
      beamWidth: ENGINE_BEAM_WIDTH + 8,
      candidateLimit: ENGINE_CANDIDATE_LIMIT + 18
    };
  }

  return {
    maxDepth: ENGINE_MAX_DEPTH,
    beamWidth: ENGINE_BEAM_WIDTH,
    candidateLimit: ENGINE_CANDIDATE_LIMIT
  };
}

function ascensionSettingsForOptions(options) {
  if (options.strategy === 'long') {
    return {
      maxDepth: ASCENSION_MAX_DEPTH + 14,
      beamWidth: ASCENSION_BEAM_WIDTH + 16,
      candidateLimit: ASCENSION_CANDIDATE_LIMIT + 22
    };
  }

  if (options.strategy === 'short') {
    return {
      maxDepth: Math.max(18, ASCENSION_MAX_DEPTH - 10),
      beamWidth: Math.max(24, ASCENSION_BEAM_WIDTH - 8),
      candidateLimit: Math.max(42, ASCENSION_CANDIDATE_LIMIT - 12)
    };
  }

  return {
    maxDepth: ASCENSION_MAX_DEPTH,
    beamWidth: ASCENSION_BEAM_WIDTH,
    candidateLimit: ASCENSION_CANDIDATE_LIMIT
  };
}

function getEngineCandidates(model, options) {
  const buildingCandidates = model.onAscend ? [] : model.buildings
    .filter((building) => building.unlocked && building.price > 0 && building.cpsPerUnit > 0)
    .map((building) => annotateCandidate({
      key: `building:${building.name}`,
      kind: 'building',
      actionType: 'BUY_BUILDING',
      targetName: building.name,
      price: building.price,
      confidence: 'live',
      reason: `${building.name} adds ${formatNumber(building.cpsPerUnit)} passive CpS before click scaling.`
    }, model, options));

  const upgradeCandidates = model.onAscend ? [] : model.upgrades
    .filter((upgrade) => upgrade.price > 0)
    .map((upgrade) => annotateCandidate({
      key: `upgrade:${upgrade.name}`,
      kind: 'upgrade',
      actionType: 'BUY_UPGRADE',
      targetName: upgrade.name,
      price: upgrade.price,
      effect: upgrade.effect,
      confidence: upgrade.effect.confidence,
      reason: upgrade.effect.reasons.length
        ? `${upgrade.name}: ${upgrade.effect.reasons.join('; ')}.`
        : `${upgrade.name}: no direct production rule recognized.`
    }, model, options));

  const specialCandidates = buildSpecialActionCandidates(model, options)
    .map((candidate) => annotateCandidate(candidate, model, options));

  return [...specialCandidates, ...upgradeCandidates, ...buildingCandidates]
    .filter((candidate) => (
      candidate.incomeDelta > 0 ||
      candidate.progressionValue > 0 ||
      candidate.immediateCookieDelta > 0 ||
      candidate.lumpDelta > 0 ||
      candidate.specialScore > 0
    ))
    .sort((a, b) => b.frontierScore - a.frontierScore);
}

function buildSpecialActionCandidates(model, options) {
  const candidates = [];
  const income = engineIncomePerSecond(model);

  if (model.onAscend) {
    const ascensionUpgradeCandidates = options.allowAscensionUpgrades
      ? buildAscensionUpgradeCandidates(model)
      : [];

    if (ascensionUpgradeCandidates.length) {
      return ascensionUpgradeCandidates;
    }

    return [buildReincarnateCandidate(model, income)];
  }

  if (options.allowWrinklers && model.wrinklersActive > 0) {
    const achievements = achievementHints(model, ['wrinkler', 'wrinklers']);
    const cookieGain = Math.max(0, model.wrinklersSucked * 1.1);
    candidates.push({
      key: 'special:pop-wrinklers',
      kind: 'wrinkler',
      actionType: 'POP_WRINKLERS',
      targetName: 'all wrinklers',
      price: 0,
      confidence: 'live',
      effect: {
        effects: [
          { type: 'cookieDelta', amount: cookieGain },
          { type: 'wrinklersPopped' },
          ...milkEffectItemsForAchievements(achievements)
        ],
        progressionValue: achievementProgressionValue(model, achievements),
        reasons: [
          `pop ${model.wrinklersActive} active wrinkler(s) for about ${formatNumber(cookieGain)} stored cookies`,
          achievementReasonText(achievements)
        ].filter(Boolean)
      },
      specialScore: cookieGain + achievementProgressionValue(model, achievements),
      reason: `Pop ${model.wrinklersActive} wrinkler(s). ${achievementReasonText(achievements)}`.trim()
    });
  }

  if (options.allowSugarLumpCollect && model.sugarLump?.ripe) {
    const achievements = achievementHints(model, ['sugar lump', 'lumps']);
    candidates.push({
      key: 'special:collect-sugar-lump',
      kind: 'sugar lump',
      actionType: 'COLLECT_SUGAR_LUMP',
      targetName: 'ripe sugar lump',
      price: 0,
      confidence: 'live',
      effect: {
        effects: [
          { type: 'lumpDelta', amount: 1 },
          ...milkEffectItemsForAchievements(achievements)
        ],
        progressionValue: achievementProgressionValue(model, achievements),
        reasons: [
          'collect a ripe sugar lump',
          achievementReasonText(achievements)
        ].filter(Boolean)
      },
      specialScore: Math.max(1, income * 300) + achievementProgressionValue(model, achievements),
      reason: `Collect the ripe sugar lump. ${achievementReasonText(achievements)}`.trim()
    });
  }

  if (options.allowSugarLumpSpend && model.lumps > 0) {
    candidates.push(...buildSugarLumpSpendCandidates(model));
  }

  if (options.allowAscension && !model.onAscend && model.prestigeGain > 0) {
    const ascendCandidate = buildAscendCandidate(model, options);
    if (ascendCandidate.specialScore > 0) {
      candidates.push(ascendCandidate);
    }
  }

  if (options.allowAchievementActions) {
    candidates.push(...buildAchievementActionCandidates(model));
  }

  return candidates;
}

function buildReincarnateCandidate(model, income = 0) {
  return {
    key: 'special:reincarnate',
    kind: 'ascension',
    actionType: 'REINCARNATE',
    targetName: 'new run',
    price: 0,
    confidence: 'live',
    effect: {
      effects: [{ type: 'reincarnate' }],
      progressionValue: Math.max(1, income * 600 || BIG_COOKIE_CLICKS_PER_SECOND * 600),
      reasons: ['start the next run after ascension']
    },
    specialScore: Math.max(1, BIG_COOKIE_CLICKS_PER_SECOND * 600),
    reason: 'Start the next run after finishing ascension upgrades.'
  };
}

function buildSugarLumpSpendCandidates(model) {
  const achievements = achievementHints(model, ['level', 'sugar lump', 'minigame']);
  const achievementText = achievementReasonText(achievements);
  return model.buildings
    .filter((building) => building.amount > 0)
    .map((building) => {
      const lumpCost = Math.max(1, (Number(building.level) || 0) + 1);
      if (lumpCost > model.lumps) return null;

      const unlockValue = minigameUnlockValue(building);
      const cpsGain = (building.totalCps || 0) * 0.01;
      return {
        key: `special:use-lump:${building.name}`,
        kind: 'sugar lump',
        actionType: 'USE_SUGAR_LUMP',
        targetName: building.name,
        price: 0,
        lumpCost,
        confidence: 'heuristic',
        effect: {
          effects: [
            { type: 'lumpDelta', amount: -lumpCost },
            { type: 'buildingMultiplier', buildingNames: [building.name], factor: 1.01 },
            ...milkEffectItemsForAchievements(achievements)
          ],
          progressionValue: unlockValue,
          reasons: [
            `spend ${lumpCost} sugar lump(s) to level ${building.name}`,
            cpsGain > 0 ? `about +${formatNumber(cpsGain)} passive CpS from the level bonus` : '',
            unlockValue > 0 ? 'unlocks or improves a minigame path' : '',
            achievementText
          ].filter(Boolean)
        },
        specialScore: cpsGain + unlockValue,
        reason:
          `Spend ${lumpCost} sugar lump(s) on ${building.name}. ` +
          [unlockValue > 0 ? 'This helps unlock or improve a minigame.' : '', achievementText].filter(Boolean).join(' ')
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.specialScore - a.specialScore)
    .slice(0, 8);
}

function minigameUnlockValue(building) {
  const unlockBuildings = new Set(['Farm', 'Bank', 'Temple', 'Wizard tower']);
  if (unlockBuildings.has(building.name) && (Number(building.level) || 0) < 1) {
    return Math.max(1, engineIncomePerSecond({
      passiveCps: building.totalCps || 0,
      clickCpsRatio: 0,
      clickFlatCps: 0,
      randomCps: 0
    }) * 600);
  }

  return 0;
}

function buildAscendCandidate(model, options) {
  const achievements = achievementHints(model, ['ascend', 'prestige', 'heavenly']);
  const score = estimateAscensionScore(model, options) + achievementProgressionValue(model, achievements);

  return {
    key: 'special:ascend',
    kind: 'ascension',
    actionType: 'ASCEND',
    targetName: 'legacy',
    price: 0,
    confidence: 'heuristic',
    effect: {
      effects: [{ type: 'ascendReset' }],
      progressionValue: score,
      reasons: [
        `ascending would gain about ${formatNumber(model.prestigeGain)} prestige level(s)`,
        achievementReasonText(achievements)
      ].filter(Boolean)
    },
    specialScore: score,
    reason: `Ascend for about ${formatNumber(model.prestigeGain)} prestige level(s). ${achievementReasonText(achievements)}`.trim()
  };
}

function buildAscensionUpgradeCandidates(model) {
  return model.ascensionUpgrades
    .filter((upgrade) => (
      !upgrade.bought &&
      upgrade.canBePurchased !== false &&
      upgrade.showIfOk !== false &&
      upgrade.price !== null &&
      upgrade.price <= model.heavenlyChips
    ))
    .map((upgrade) => {
      const effect = estimateAscensionUpgradeEffect(upgrade, model);
      return {
        key: `special:ascension-upgrade:${upgrade.name}`,
        kind: 'ascension upgrade',
        actionType: 'BUY_ASCENSION_UPGRADE',
        targetName: upgrade.name,
        price: 0,
        heavenlyChipCost: upgrade.price,
        confidence: effect.confidence,
        effect,
        specialScore: effect.progressionValue,
        reason: `Buy heavenly upgrade "${upgrade.name}" for ${formatNumber(upgrade.price)} heavenly chip(s). ${effect.reasons.join('; ')}.`
      };
    })
    .sort((a, b) => b.specialScore - a.specialScore)
    .slice(0, 12);
}

function estimateAscensionUpgradeEffect(upgrade, model) {
  const desc = String(upgrade.description || '').toLowerCase();
  const effects = [{ type: 'heavenlyChipDelta', amount: -Math.max(0, Number(upgrade.price) || 0) }];
  const reasons = [];
  let progressionValue = Math.max(1, engineIncomePerSecond(model) * 120);
  let confidence = 'heuristic';

  const percent = firstPercentMatch(desc, [
    /cookie production[^.]*\+([\d.]+)%/,
    /cps[^.]*\+([\d.]+)%/,
    /production[^.]*\+([\d.]+)%/
  ]);

  if (percent > 0) {
    effects.push({ type: 'globalMultiplier', factor: 1 + (percent / 100) });
    effects.push({ type: 'nextRunGlobalMultiplier', factor: 1 + (percent / 100) });
    progressionValue += engineIncomePerSecond(model) * (percent / 100) * 3600;
    reasons.push(`modeled as +${percent}% production`);
    confidence = 'description';
  }

  if (desc.includes('season') || desc.includes('golden') || desc.includes('offline') || desc.includes('dragon')) {
    progressionValue += engineIncomePerSecond(model) * 600;
    reasons.push('long-term utility upgrade');
  }

  if (!reasons.length) {
    reasons.push('heavenly upgrade with progression value');
  }

  return { effects, reasons, progressionValue, confidence };
}

function buildAchievementActionCandidates(model) {
  const allClickAchievements = achievementHints(model, ['click', 'hand-made'], 20);
  const neverclickAchievements = (model.achievements || [])
    .filter((achievement) => !achievement.won)
    .map((achievement) => ({
      achievement,
      rule: neverclickRuleForAchievement(achievement)
    }))
    .filter((item) => item.rule)
    .sort((a, b) => a.rule.maxClicks - b.rule.maxClicks);
  const clickAchievements = allClickAchievements.filter((achievement) => (
    !neverclickRuleForAchievement(achievement) &&
    isBigCookieClickAchievement(achievement)
  ));
  const candidates = [];

  const trueNeverclickPossible = neverclickAchievements.some((item) => (
    item.rule.action === 'PRESERVE_TRUE_NEVERCLICK' && model.cookieClicks <= item.rule.maxClicks
  ));

  for (const { achievement, rule } of neverclickAchievements) {
    if (model.cookieClicks > rule.maxClicks) continue;
    if (rule.action === 'PRESERVE_NEVERCLICK' && trueNeverclickPossible) continue;

    const progressionValue = achievementProgressionValue(model, [achievement]);
    candidates.push({
      key: `special:achievement-${rule.key}`,
      kind: 'achievement',
      actionType: 'DO_ACHIEVEMENT_ACTION',
      targetName: achievement.name,
      achievementAction: rule.action,
      price: 0,
      confidence: 'achievement-hint',
      effect: {
        effects: [
          { type: 'disableBigCookieClicks' },
          ...milkEffectItemsForAchievements([achievement])
        ],
        progressionValue,
        reasons: [
          `May help achievement "${achievement.name}" because the current ascension has ${formatNumber(model.cookieClicks)} big-cookie click(s), within the ${rule.maxClicks} click limit.`
        ]
      },
      specialScore: progressionValue * (rule.action === 'PRESERVE_TRUE_NEVERCLICK' ? 3 : 2),
      reason: `Preserve the current ${formatNumber(model.cookieClicks)} big-cookie click(s) for "${achievement.name}"; do not click the big cookie.`
    });
  }

  if (!clickAchievements.length) return candidates;
  const clickAchievement = clickAchievements[0];

  candidates.push({
    key: 'special:achievement-click',
    kind: 'achievement',
    actionType: 'DO_ACHIEVEMENT_ACTION',
    targetName: clickAchievement.name,
    achievementAction: 'CLICK_BIG_COOKIE',
    price: 0,
    confidence: 'achievement-hint',
    effect: {
      effects: milkEffectItemsForAchievements([clickAchievement]),
      progressionValue: achievementProgressionValue(model, clickAchievements),
      reasons: [achievementReasonText(clickAchievements)]
    },
    specialScore: achievementProgressionValue(model, clickAchievements),
    reason: `Keep clicking toward milk achievement "${clickAchievement.name}".`
  });

  return candidates;
}

function neverclickRuleForAchievement(achievement) {
  return neverclickRuleForText(achievement?.name || '');
}

function isBigCookieClickAchievement(achievement) {
  const text = `${achievement?.name || ''} ${achievement?.description || ''}`.toLowerCase();

  if (
    text.includes('golden cookie') ||
    text.includes('wrath cookie') ||
    text.includes('reindeer') ||
    text.includes('wrinkler')
  ) {
    return false;
  }

  return text.includes('hand-made') ||
    text.includes('big cookie') ||
    text.includes('cookie clicks') ||
    text.includes('click the cookie') ||
    text.includes('from clicking') ||
    text.includes('clicking the cookie');
}

function isGoldenCookieAchievement(achievement) {
  const text = `${achievement?.name || ''} ${achievement?.description || ''}`.toLowerCase();
  return /\bgolden cookies?\b/.test(text) ||
    /\bwrath cookies?\b/.test(text) ||
    text.includes('four-leaf cookie') ||
    text.includes('seven horseshoes');
}

function neverclickRuleForText(text) {
  const normalized = String(text || '').trim().toLowerCase();

  if (normalized === 'true neverclick' || /\btrue\s+neverclick\b/.test(normalized)) {
    return {
      key: 'true-neverclick',
      action: 'PRESERVE_TRUE_NEVERCLICK',
      label: 'True Neverclick',
      maxClicks: 0
    };
  }

  if (normalized === 'neverclick' || /\bneverclick\b/.test(normalized)) {
    return {
      key: 'neverclick',
      action: 'PRESERVE_NEVERCLICK',
      label: 'Neverclick',
      maxClicks: 15
    };
  }

  return null;
}

function achievementHints(model, keywords, limit = 3) {
  const normalizedKeywords = keywords.map((keyword) => String(keyword).toLowerCase());
  return (model.achievements || [])
    .filter((achievement) => achievement.countsForMilk && !achievement.won)
    .filter((achievement) => !(model.goldenCookiesBlocked && isGoldenCookieAchievement(achievement)))
    .filter((achievement) => {
      const text = `${achievement.name} ${achievement.description}`.toLowerCase();
      return normalizedKeywords.some((keyword) => text.includes(keyword));
    })
    .slice(0, limit);
}

function milkEffectItemsForAchievements(achievements) {
  const milkAchievements = achievements.filter((achievement) => achievement.countsForMilk);
  if (!milkAchievements.length) return [];

  return [{
    type: 'milkAchievement',
    count: milkAchievements.length,
    achievementNames: milkAchievements.map((achievement) => achievement.name)
  }];
}

function achievementProgressionValue(model, achievements) {
  if (!achievements.length) return 0;
  return Math.max(1, engineIncomePerSecond(model) * 180 * achievements.length);
}

function achievementReasonText(achievements) {
  if (!achievements.length) return '';
  return `May help milk achievement(s): ${achievements.map((achievement) => `"${achievement.name}"`).join(', ')}.`;
}

function estimateAscensionScore(model, options) {
  const income = engineIncomePerSecond(model);
  if (model.prestigeGain <= 0) return 0;

  const prestigeBoostRatio = model.prestige > 0
    ? model.prestigeGain / Math.max(1, model.prestige)
    : model.prestigeGain;
  const targetPressure = options.objective.type === 'target'
    ? Math.max(1, options.objective.targetCookies / Math.max(1, model.cookies))
    : Math.max(1, options.objective.horizonSeconds / 3600);

  if (prestigeBoostRatio < 0.05 && targetPressure < 100) {
    return 0;
  }

  return Math.max(1, income * Math.min(86400, 1800 * Math.log10(10 + model.prestigeGain)));
}

function annotateCandidate(candidate, model, options) {
  const incomeBefore = engineIncomePerSecond(model);
  const scratch = cloneEngineModel(model);
  applyCandidateEffects(scratch, candidate);
  const incomeAfter = engineIncomePerSecond(scratch);
  const incomeDelta = Math.max(0, incomeAfter - incomeBefore);
  const immediateCookieDelta = Math.max(0, scratch.cookies - model.cookies);
  const lumpDelta = Math.max(0, scratch.lumps - model.lumps);
  const progressionValue = candidate.effect?.progressionValue || 0;
  const waitSeconds = candidate.price <= model.cookies
    ? 0
    : incomeBefore > 0
      ? (candidate.price - model.cookies) / incomeBefore
      : Number.POSITIVE_INFINITY;
  const paybackSeconds = incomeDelta > 0
    ? candidate.price / incomeDelta
    : Number.POSITIVE_INFINITY;
  const singleActionScore = scoreSingleAction(
    candidate,
    model,
    options,
    incomeBefore,
    incomeAfter,
    waitSeconds,
    immediateCookieDelta
  );
  const specialScore = candidate.specialScore || 0;
  const frontierScore = singleActionScore +
    (progressionValue * 0.25) +
    (immediateCookieDelta * 0.25) +
    (lumpDelta * Math.max(1, incomeBefore * 60)) +
    specialScore -
    (waitSeconds * 0.000001);

  return {
    ...candidate,
    affordable: model.cookies >= candidate.price,
    waitSeconds,
    paybackSeconds,
    incomeBefore,
    incomeAfter,
    incomeDelta,
    immediateCookieDelta,
    lumpDelta,
    cpsDelta: incomeDelta,
    progressionValue,
    specialScore,
    score: singleActionScore,
    frontierScore,
    effectLabel: incomeDelta > 0
      ? `modeled +${formatNumber(incomeDelta)} cookies/sec`
      : 'no direct income gain modeled',
    scoreLabel: describeCandidateScore(singleActionScore, options)
  };
}

function scoreSingleAction(candidate, model, options, incomeBefore, incomeAfter, waitSeconds, immediateCookieDelta = 0) {
  if (!Number.isFinite(waitSeconds)) {
    return 0;
  }

  if (options.objective.type === 'target') {
    const target = options.objective.targetCookies;
    const baseline = incomeBefore > 0
      ? Math.max(0, (target - model.cookies) / incomeBefore)
      : Number.POSITIVE_INFINITY;

    if (model.cookies >= target) return 0;
    if (baseline < waitSeconds) return 0;

    const cookiesAfterBuy = model.cookies + (incomeBefore * waitSeconds) - candidate.price + immediateCookieDelta;
    const remaining = Math.max(0, target - cookiesAfterBuy);
    const projected = waitSeconds + (incomeAfter > 0 ? remaining / incomeAfter : Number.POSITIVE_INFINITY);

    if (!Number.isFinite(baseline) && Number.isFinite(projected)) {
      return Number.MAX_SAFE_INTEGER / 2;
    }

    return baseline - projected;
  }

  const remaining = options.objective.horizonSeconds - model.elapsed - waitSeconds;
  if (remaining <= 0) return 0;

  const baselineCookies = model.cookies + (incomeBefore * (options.objective.horizonSeconds - model.elapsed));
  const cookiesAfterBuy = model.cookies + (incomeBefore * waitSeconds) - candidate.price + immediateCookieDelta;
  const projectedCookies = cookiesAfterBuy + (incomeAfter * remaining);

  return projectedCookies - baselineCookies;
}

function describeCandidateScore(score, options) {
  if (!Number.isFinite(score) || score <= 0) {
    return 'no positive projected value';
  }

  if (options.objective.type === 'target') {
    return score >= Number.MAX_SAFE_INTEGER / 4
      ? 'makes the target reachable'
      : `${formatSeconds(score)} faster to target`;
  }

  return `${formatNumber(score)} more cookies by the deadline`;
}

function advanceAndBuy(model, candidate, options) {
  const income = engineIncomePerSecond(model);
  const waitSeconds = candidate.price <= model.cookies
    ? 0
    : income > 0
      ? (candidate.price - model.cookies) / income
      : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(waitSeconds)) {
    return null;
  }

  if (candidate.lumpCost && candidate.lumpCost > model.lumps) {
    return null;
  }

  if (options.objective.type === 'maximize') {
    if (model.elapsed + waitSeconds >= options.objective.horizonSeconds) {
      return null;
    }
  } else {
    const targetWait = income > 0
      ? Math.max(0, (options.objective.targetCookies - model.cookies) / income)
      : Number.POSITIVE_INFINITY;

    if (targetWait <= waitSeconds || model.elapsed + waitSeconds > ENGINE_MAX_TARGET_SECONDS) {
      return null;
    }
  }

  const incomeBefore = income;
  model.cookies += incomeBefore * waitSeconds;
  model.elapsed += waitSeconds;
  model.cookies -= candidate.price;
  applyCandidateEffects(model, candidate);
  const incomeAfter = engineIncomePerSecond(model);

  return {
    key: candidate.key,
    actionType: candidate.actionType,
    kind: candidate.kind,
    targetName: candidate.targetName,
    achievementAction: candidate.achievementAction || '',
    price: candidate.price,
    lumpCost: candidate.lumpCost || 0,
    heavenlyChipCost: candidate.heavenlyChipCost || 0,
    waitSeconds,
    boughtAtSeconds: model.elapsed,
    incomeBefore,
    incomeAfter,
    incomeDelta: Math.max(0, incomeAfter - incomeBefore),
    paybackSeconds: candidate.paybackSeconds,
    confidence: candidate.confidence,
    progressionValue: candidate.progressionValue || 0,
    specialScore: candidate.specialScore || 0,
    reason: candidate.reason,
    effectLabel: candidate.effectLabel
  };
}

function applyCandidateEffects(model, candidate) {
  if (candidate.kind === 'building') {
    const building = model.buildings.find((item) => item.name === candidate.targetName);
    if (!building) return;

    model.passiveCps += building.cpsPerUnit;
    building.amount += 1;
    building.totalCps += building.cpsPerUnit;
    building.price *= BUILDING_PRICE_GROWTH;
    return;
  }

  const effect = candidate.effect || {};
  model.upgrades = model.upgrades.filter((upgrade) => upgrade.name !== candidate.targetName);

  if (candidate.actionType === 'DO_ACHIEVEMENT_ACTION') {
    const achievement = model.achievements.find((item) => item.name === candidate.targetName);
    if (achievement?.countsForMilk && !effect.effects?.some((item) => item.type === 'milkAchievement')) {
      applyMilkAchievementCount(model, 1);
    }
  }

  if (candidate.actionType === 'BUY_ASCENSION_UPGRADE') {
    const ascensionUpgrade = model.ascensionUpgrades.find((upgrade) => upgrade.name === candidate.targetName);
    if (ascensionUpgrade) {
      ascensionUpgrade.bought = true;
    }
  }

  if (candidate.actionType === 'USE_SUGAR_LUMP') {
    const building = model.buildings.find((item) => item.name === candidate.targetName);
    if (building) {
      building.level += 1;
    }
  }

  for (const item of effect.effects || []) {
    if (item.type === 'globalMultiplier') {
      applyGlobalMultiplier(model, item.factor);
    } else if (item.type === 'buildingMultiplier') {
      applyBuildingMultiplier(model, item.buildingNames || [], item.factor);
    } else if (item.type === 'passiveCpsDelta') {
      model.passiveCps += item.amount;
    } else if (item.type === 'clickRatioAdd') {
      model.clickCpsRatio += item.amount;
    } else if (item.type === 'clickMultiplier') {
      model.clickCpsRatio *= item.factor;
      model.clickFlatCps *= item.factor;
    } else if (item.type === 'kittenMultiplier') {
      const factor = Math.max(0, Number(item.milkFactor) || 0);
      if (factor > 0) {
        model.ownedKittenMilkFactors.push(factor);
        applyGlobalMultiplier(model, kittenMultiplierForMilk(model.milkProgress, [factor], model.milkPowerMultiplier));
      }
    } else if (item.type === 'milkAchievement') {
      const names = item.achievementNames || [];
      const availableNames = names.filter((name) => (
        model.achievements.some((achievement) => achievement.name === name && achievement.countsForMilk && !achievement.won)
      ));
      const count = names.length ? availableNames.length : Math.max(0, Number(item.count) || 1);
      applyMilkAchievementCount(model, count);
      if (availableNames.length) {
        const used = new Set(availableNames);
        model.achievements = model.achievements.filter((achievement) => !used.has(achievement.name));
      }
    } else if (item.type === 'disableBigCookieClicks') {
      model.clickCpsRatio = 0;
      model.clickFlatCps = 0;
    } else if (item.type === 'goldenCookieBlocker') {
      model.goldenCookiesBlocked = true;
      if (item.name && !model.goldenCookieBlockers.includes(item.name)) {
        model.goldenCookieBlockers.push(item.name);
      }
      model.randomCps = 0;
    } else if (item.type === 'buildingDiscount') {
      for (const building of model.buildings) {
        building.price *= item.factor;
      }
    } else if (item.type === 'upgradeDiscount') {
      for (const upgrade of model.upgrades) {
        upgrade.price *= item.factor;
      }
    } else if (item.type === 'randomCpsDelta') {
      model.randomCps += item.amount;
    } else if (item.type === 'nextRunGlobalMultiplier') {
      model.nextRunGlobalMultiplier *= item.factor;
    } else if (item.type === 'cookieDelta') {
      model.cookies += Math.max(0, item.amount || 0);
    } else if (item.type === 'lumpDelta') {
      model.lumps = Math.max(0, model.lumps + (item.amount || 0));
      if ((item.amount || 0) > 0 && model.sugarLump) {
        model.sugarLump.ripe = false;
        model.sugarLump.mature = false;
        model.sugarLump.ageMs = 0;
      }
    } else if (item.type === 'wrinklersPopped') {
      model.wrinklersActive = 0;
      model.wrinklersSucked = 0;
    } else if (item.type === 'heavenlyChipDelta') {
      model.heavenlyChips = Math.max(0, model.heavenlyChips + (item.amount || 0));
    } else if (item.type === 'ascendReset') {
      const oldPrestige = model.prestige;
      const gainedPrestige = model.prestigeGain;
      const newPrestige = oldPrestige + gainedPrestige;
      const prestigeRatio = prestigeGainCpsRatio(oldPrestige, newPrestige);
      model.onAscend = true;
      model.heavenlyChips += gainedPrestige;
      model.prestige = newPrestige;
      model.prestigeGain = 0;
      model.cookies = 0;
      model.cookieClicks = 0;
      model.passiveCps = 0;
      model.clickCpsRatio = 0;
      model.clickFlatCps = 0;
      model.randomCps = 0;
      model.wrinklersActive = 0;
      model.wrinklersSucked = 0;
      model.buildings = model.buildings.map((building) => ({
        ...building,
        amount: 0,
        totalCps: 0,
        price: building.basePrice || building.price
      }));
      if (prestigeRatio > 0 && Number.isFinite(prestigeRatio) && prestigeRatio !== 1) {
        model.globalCpsMult *= prestigeRatio;
        model.nextRunGlobalMultiplier *= prestigeRatio;
        applyGlobalMultiplier(model, prestigeRatio);
      }
    } else if (item.type === 'reincarnate') {
      model.onAscend = false;
      model.cookies = 0;
      model.cookieClicks = 0;
      model.passiveCps = 0;
      model.clickCpsRatio = 0;
      model.clickFlatCps = BIG_COOKIE_CLICKS_PER_SECOND * (model.nextRunGlobalMultiplier || 1);
      model.randomCps = 0;
      model.wrinklersActive = 0;
      model.wrinklersSucked = 0;
    }
  }

  if (candidate.actionType === 'DO_ACHIEVEMENT_ACTION') {
    model.achievements = model.achievements.filter((achievement) => achievement.name !== candidate.targetName);
  }
}

function applyGlobalMultiplier(model, factor) {
  if (!Number.isFinite(factor) || factor <= 0) return;

  model.passiveCps *= factor;
  model.randomCps *= factor;

  for (const building of model.buildings) {
    building.cpsPerUnit *= factor;
    building.totalCps *= factor;
  }
}

function applyMilkAchievementCount(model, count) {
  const amount = Math.max(0, Number(count) || 0);
  if (amount <= 0) return;

  const oldMilk = Math.max(0, Number(model.milkProgress) || 0);
  const newMilk = oldMilk + (amount * 0.04);
  const oldMultiplier = kittenMultiplierForMilk(oldMilk, model.ownedKittenMilkFactors, model.milkPowerMultiplier);
  const newMultiplier = kittenMultiplierForMilk(newMilk, model.ownedKittenMilkFactors, model.milkPowerMultiplier);
  const ratio = oldMultiplier > 0 ? newMultiplier / oldMultiplier : 1;

  model.milkProgress = newMilk;

  if (ratio > 0 && Number.isFinite(ratio) && ratio !== 1) {
    applyGlobalMultiplier(model, ratio);
  }
}

function kittenMultiplierForMilk(milkProgress, factors, milkPowerMultiplier = 1) {
  const milk = Math.max(0, Number(milkProgress) || 0);
  const power = Math.max(0, Number(milkPowerMultiplier) || 1);

  return (factors || []).reduce((multiplier, factor) => {
    const numericFactor = Math.max(0, Number(factor) || 0);
    return multiplier * (1 + (milk * power * numericFactor));
  }, 1);
}

function prestigeGainCpsRatio(oldPrestige, newPrestige) {
  const oldLevels = Math.max(0, Number(oldPrestige) || 0);
  const newLevels = Math.max(oldLevels, Number(newPrestige) || 0);
  return (1 + (newLevels / 100)) / Math.max(1, 1 + (oldLevels / 100));
}

function applyBuildingMultiplier(model, buildingNames, factor) {
  if (!Number.isFinite(factor) || factor <= 0) return;

  const names = new Set(buildingNames);
  for (const building of model.buildings) {
    if (!names.has(building.name)) continue;

    const before = building.totalCps;
    building.cpsPerUnit *= factor;
    building.totalCps *= factor;
    model.passiveCps += building.totalCps - before;
  }
}

function scoreRoute(model, options) {
  const income = engineIncomePerSecond(model);
  const utility = routeUtility(model);

  if (options.objective.type === 'target') {
    const target = options.objective.targetCookies;
    const reached = model.cookies >= target;
    const secondsToTarget = reached
      ? model.elapsed
      : income > 0
        ? model.elapsed + Math.max(0, (target - model.cookies) / income)
        : Number.POSITIVE_INFINITY;

    return {
      model,
      reached,
      secondsToTarget,
      utility,
      value: Number.isFinite(secondsToTarget) ? -secondsToTarget : -Number.MAX_VALUE
    };
  }

  const remaining = Math.max(0, options.objective.horizonSeconds - model.elapsed);
  const projectedCookies = model.cookies + (income * remaining);

  return {
    model,
    projectedCookies,
    utility,
    value: projectedCookies
  };
}

function routeUtility(model) {
  return model.history.reduce((sum, step) => (
    sum + (Number(step.specialScore) || 0) + (Number(step.progressionValue) || 0)
  ), 0);
}

function compareRouteScores(a, b) {
  if (Math.abs(b.value - a.value) > 0.000001) return b.value - a.value;
  if ((b.utility || 0) !== (a.utility || 0)) return (b.utility || 0) - (a.utility || 0);
  return (a.model.history.length || 0) - (b.model.history.length || 0);
}

function summarizeRootCandidates(routes, options) {
  const grouped = new Map();

  for (const route of routes) {
    const firstStep = route.model.firstStep;
    if (!firstStep) continue;

    const existing = grouped.get(firstStep.key);
    if (!existing || compareRouteScores(route, existing.route) < 0) {
      grouped.set(firstStep.key, {
        ...firstStep,
        route,
        routeSteps: route.model.history.map((step) => ({ ...step })),
        score: route.value
      });
    }
  }

  return [...grouped.values()]
    .map((candidate) => ({
      ...candidate,
      scoreLabel: describeRouteScore(candidate.route, options),
      affordable: candidate.waitSeconds <= 0,
      routePreview: candidate.routeSteps.slice(0, 4)
    }))
    .sort((a, b) => compareRouteScores(a.route, b.route));
}

function buildNoPurchaseCandidate(route, model, options) {
  const income = engineIncomePerSecond(model);
  const waitSeconds = options.objective.type === 'target'
    ? income > 0
      ? Math.max(0, (options.objective.targetCookies - model.cookies) / income)
      : Number.POSITIVE_INFINITY
    : Math.max(0, options.objective.horizonSeconds);

  return {
    key: 'wait:none',
    kind: 'wait',
    actionType: 'WAIT',
    targetName: '',
    price: 0,
    affordable: true,
    noPurchase: true,
    waitSeconds,
    paybackSeconds: Number.POSITIVE_INFINITY,
    incomeBefore: income,
    incomeAfter: income,
    incomeDelta: 0,
    confidence: 'exact-current-route',
    reason: options.objective.type === 'target'
      ? 'Buying nothing reaches the target fastest in the current simulation.'
      : 'Buying nothing keeps more cookies by the deadline than any tested purchase route.',
    route,
    routeSteps: [],
    routePreview: [],
    score: route.value,
    scoreLabel: describeRouteScore(route, options)
  };
}

function describeRouteScore(route, options) {
  if (options.objective.type === 'target') {
    return Number.isFinite(route.secondsToTarget)
      ? `route reaches target in ${formatSeconds(route.secondsToTarget)}`
      : 'route does not reach target';
  }

  return `route ends with ${formatNumber(route.projectedCookies)} cookies`;
}

function commandFromPlan(engine, state, options) {
  const best = engine.bestCandidate;

  if (!best || !best.route) {
    return {
      actionType: 'CLICK_BIG_COOKIE',
      targetName: '',
      explanation:
        `The math engine found no positive purchase route for ${formatObjective(options.objective)}. ` +
        'Keep the auto-clicker running and recalculate on the next tick.'
    };
  }

  if (best.noPurchase) {
    if (state.onAscend) {
      return {
        actionType: 'REINCARNATE',
        targetName: 'new run',
        explanation:
          'Cookie Clicker is on the ascension screen and no purchasable heavenly upgrade beat reincarnating. ' +
          'Start the next run so the commander can continue normal play.'
      };
    }

    return {
      actionType: 'WAIT',
      targetName: '',
      explanation:
        `${best.reason} The planner tested ${engine.plan.routeCount} routes and chose not to spend cookies. ` +
        `${best.scoreLabel}.`
    };
  }

  if (best.waitSeconds > 0) {
    return {
      actionType: 'SAVE_UP',
      targetName: best.targetName,
      saveTargetType: best.kind,
      explanation:
        `Save for ${best.kind} "${best.targetName}". ` +
        `${best.reason} The planner tested ${engine.plan.routeCount} routes; best route says wait ` +
        `${formatSeconds(best.waitSeconds)} for a ${formatNumber(Math.max(0, best.price - state.cookies))} shortfall. ` +
        `${best.scoreLabel}.`
    };
  }

  if (best.actionType !== 'BUY_UPGRADE' && best.actionType !== 'BUY_BUILDING') {
    return {
      actionType: best.actionType,
      targetName: best.targetName || '',
      achievementAction: best.achievementAction || '',
      lumpCost: best.lumpCost || 0,
      heavenlyChipCost: best.heavenlyChipCost || 0,
      explanation:
        `Do ${formatActionLabel(best)}. ` +
        `${best.reason} The planner tested ${engine.plan.routeCount} routes. ${best.scoreLabel}.`
    };
  }

  return {
    actionType: best.actionType,
    targetName: best.targetName,
    explanation:
      `Buy ${best.kind} "${best.targetName}". ` +
      `${best.reason} The planner tested ${engine.plan.routeCount} routes with beam width ${engine.plan.beamWidth}. ` +
      `${best.scoreLabel}.`
  };
}

function buildEngineWarnings(state, rootCandidates) {
  const warnings = [];

  if (state.goldenCookiesBlocked) {
    const blockers = (state.goldenCookieBlockers || []).join(', ') || 'a live switch';
    warnings.push(`Golden cookies are currently blocked by ${blockers}; golden-cookie achievements and golden-cookie frequency upgrades are ignored.`);
  }

  if (state.goldenCookiesVisible) {
    warnings.push('A golden cookie is visible; Commander will click it before/after the math step.');
  }

  if (state.wrinklersActive) {
    warnings.push('Wrinklers are modeled only as a light expected-value bonus, not full pop-timing optimization yet.');
  }

  if (!rootCandidates.length) {
    warnings.push('No visible purchase produced a positive modeled route; this can happen before a useful unlock appears.');
  }

  return warnings;
}

function estimateUpgradeEffectRules(upgrade, state) {
  const name = String(upgrade.name || '');
  const desc = String(upgrade.description || '').toLowerCase();
  const goldenCookiesBlocked = Boolean(state.goldenCookiesBlocked);
  const goldenCookieUpgrade = isGoldenCookieUpgrade(name, desc);
  const goldenCookieBlocker = isGoldenCookieBlockerUpgrade(name, desc);
  const effects = [];
  const reasons = [];
  let confidence = 'low';
  let progressionValue = 0;

  const globalPercent = firstPercentMatch(desc, [
    /cookie production multiplier\s*\+([\d.]+)%/,
    /cookie production[^.]*\+([\d.]+)%/,
    /cookies per second[^.]*\+([\d.]+)%/,
    /\bcps[^.]*\+([\d.]+)%/,
    /production[^.]*\+([\d.]+)%/
  ]);

  if (globalPercent > 0 && !hasSpecificBuildingName(desc, state)) {
    effects.push({ type: 'globalMultiplier', factor: 1 + (globalPercent / 100) });
    reasons.push(`global production +${globalPercent}%`);
    confidence = 'description';
  }

  addTwiceAsEfficientEffects(effects, reasons, desc, state);
  addPerBuildingEffects(effects, reasons, desc, state);
  addBuildingPercentEffects(effects, reasons, desc, state);

  if (desc.includes('clicking gains') && desc.includes('of your cps')) {
    const percent = firstPercentMatch(desc, [/clicking gains\s*\+([\d.]+)%\s*of your cps/]) || 1;
    const add = BIG_COOKIE_CLICKS_PER_SECOND * (percent / 100);
    effects.push({ type: 'clickRatioAdd', amount: add });
    reasons.push(`clicking gains +${percent}% of CpS per click, worth about +${formatNumber(add * 100)}% of passive CpS at ${BIG_COOKIE_CLICKS_PER_SECOND} cps`);
    confidence = 'description';
  }

  const clickPowerPercent = firstPercentMatch(desc, [
    /clicks are\s*\+([\d.]+)%/,
    /clicking is\s*([\d.]+)% more effective/,
    /mouse.*\+([\d.]+)%/
  ]);

  if (clickPowerPercent > 0) {
    effects.push({ type: 'clickMultiplier', factor: 1 + (clickPowerPercent / 100) });
    reasons.push(`clicking power +${clickPowerPercent}%`);
    confidence = 'description';
  }

  const kittenFactor = kittenMilkFactor(name);
  if (kittenFactor > 0) {
    const factor = 1 + ((Number(state.milkProgress) || 0) * (Number(state.milkPowerMultiplier) || 1) * kittenFactor);
    effects.push({ type: 'kittenMultiplier', milkFactor: kittenFactor });
    reasons.push(`kitten milk factor ${kittenFactor} at current milk (${formatNumber((Number(state.milkProgress) || 0) * 100)}% milk), multiplier ${formatNumber(factor)}x`);
    confidence = 'known-rule';
  }

  const upgradeDiscount = discountFactor(desc, /all upgrades are\s*([\d.]+)% cheaper/);
  if (upgradeDiscount < 1) {
    effects.push({ type: 'upgradeDiscount', factor: upgradeDiscount });
    reasons.push(`future upgrades ${formatNumber((1 - upgradeDiscount) * 100)}% cheaper`);
    confidence = 'description';
  }

  const buildingDiscount = discountFactor(desc, /all buildings are\s*([\d.]+)% cheaper/);
  if (buildingDiscount < 1) {
    effects.push({ type: 'buildingDiscount', factor: buildingDiscount });
    reasons.push(`future buildings ${formatNumber((1 - buildingDiscount) * 100)}% cheaper`);
    confidence = 'description';
  }

  if (goldenCookieBlocker) {
    if (!effects.some((effect) => effect.type === 'globalMultiplier' && Math.abs(effect.factor - 1.5) < 0.000001)) {
      effects.push({ type: 'globalMultiplier', factor: 1.5 });
      reasons.push('golden switch passive +50% CpS');
    }
    effects.push({ type: 'goldenCookieBlocker', name });
    reasons.push('turns on a CpS boost that prevents golden cookies from spawning');
    confidence = confidence === 'low' ? 'known-rule' : confidence;
  }

  if ((desc.includes('golden cookies') || desc.includes('wrath cookies')) && !goldenCookieBlocker) {
    if (goldenCookiesBlocked) {
      reasons.push('golden-cookie value ignored because current switches prevent golden cookies from spawning');
    } else {
      const amount = Math.max(0.01, (Number(state.cps) || 0) * 0.01);
      effects.push({ type: 'randomCpsDelta', amount });
      reasons.push('golden/wrath cookie improvement modeled as small expected value');
      confidence = confidence === 'low' ? 'expected-value' : confidence;
    }
  }

  if (looksLikeProgressionUpgrade(upgrade, desc) && !(goldenCookiesBlocked && goldenCookieUpgrade && !goldenCookieBlocker)) {
    progressionValue = Math.max(0.1, engineProgressionValue(state));
    reasons.push('progression/unlock value');
    confidence = confidence === 'low' ? 'progression' : confidence;
  }

  return {
    effects,
    reasons,
    confidence,
    progressionValue
  };
}

function addTwiceAsEfficientEffects(effects, reasons, desc, state) {
  const twiceMatches = [
    ...desc.matchAll(/([a-z][a-z\s']+?)\s+are twice as efficient/g),
    ...desc.matchAll(/([a-z][a-z\s']+?)\s+is twice as efficient/g)
  ];

  for (const match of twiceMatches) {
    const subject = match[1].trim();
    const buildingNames = resolveBuildingNamesFromText(subject, state);

    if (buildingNames.length) {
      effects.push({ type: 'buildingMultiplier', buildingNames, factor: 2 });
      reasons.push(`${buildingNames.join(', ')} twice as efficient`);
    }

    if (subject.includes('mouse') || subject.includes('click')) {
      effects.push({ type: 'clickMultiplier', factor: 2 });
      reasons.push('clicking twice as efficient');
    }
  }
}

function addPerBuildingEffects(effects, reasons, desc, state) {
  const matches = desc.matchAll(/([a-z][a-z\s']+?)\s+gain\s*\+([\d.]+)%\s*cps\s*per\s*([\d.]+)\s+([a-z][a-z\s']+)/g);

  for (const match of matches) {
    const targetNames = resolveBuildingNamesFromText(match[1], state);
    const percent = Number(match[2]);
    const perAmount = Number(match[3]);
    const sourceNames = resolveBuildingNamesFromText(match[4], state);
    const sourceAmount = sourceNames.reduce((sum, name) => {
      const building = state.buildings.find((item) => item.name === name);
      return sum + (Number(building?.amount) || 0);
    }, 0);

    if (!targetNames.length || !Number.isFinite(percent) || !Number.isFinite(perAmount) || perAmount <= 0 || sourceAmount <= 0) {
      continue;
    }

    const factor = 1 + ((percent / 100) * (sourceAmount / perAmount));
    effects.push({ type: 'buildingMultiplier', buildingNames: targetNames, factor });
    reasons.push(`${targetNames.join(', ')} gain +${percent}% CpS per ${perAmount} ${sourceNames.join('/')} (${formatNumber((factor - 1) * 100)}% now)`);
  }
}

function addBuildingPercentEffects(effects, reasons, desc, state) {
  const matches = desc.matchAll(/([a-z][a-z\s']+?)\s+gain\s*\+([\d.]+)%\s*cps/g);

  for (const match of matches) {
    if (match[0].includes(' per ')) continue;

    const buildingNames = resolveBuildingNamesFromText(match[1], state);
    const percent = Number(match[2]);

    if (!buildingNames.length || !Number.isFinite(percent)) continue;

    effects.push({ type: 'buildingMultiplier', buildingNames, factor: 1 + (percent / 100) });
    reasons.push(`${buildingNames.join(', ')} gain +${percent}% CpS`);
  }
}

function hasSpecificBuildingName(desc, state) {
  return state.buildings.some((building) => (
    buildingAliases(building.name).some((alias) => desc.includes(alias))
  ));
}

function resolveBuildingNamesFromText(text, state) {
  const normalized = String(text || '').toLowerCase();
  const names = [];

  for (const building of state.buildings) {
    if (buildingAliases(building.name).some((alias) => normalized.includes(alias))) {
      names.push(building.name);
    }
  }

  return [...new Set(names)];
}

function discountFactor(desc, pattern) {
  const match = desc.match(pattern);
  if (!match) return 1;

  const percent = Number(match[1]);
  if (!Number.isFinite(percent) || percent <= 0) return 1;

  return Math.max(0, 1 - (percent / 100));
}

function kittenMilkFactor(name) {
  const factors = {
    'Kitten helpers': 0.1,
    'Kitten workers': 0.125,
    'Kitten engineers': 0.15,
    'Kitten overseers': 0.175,
    'Kitten managers': 0.2,
    'Kitten accountants': 0.2,
    'Kitten specialists': 0.2,
    'Kitten experts': 0.2,
    'Kitten consultants': 0.2,
    'Kitten assistants to the regional manager': 0.175,
    'Kitten marketeers': 0.15,
    'Kitten analysts': 0.125,
    'Kitten executives': 0.115,
    'Kitten admins': 0.11,
    'Kitten strategists': 0.105,
    'Fortune #103': 0.05,
    'Kitten angels': 0.1
  };

  return factors[name] || 0;
}

function engineProgressionValue(state) {
  const cps = Math.max(0, Number(state.cps) || 0);
  const clickCps = Math.max(0, Number(state.clickCps) || 0);
  return Math.max(0.1, (cps + clickCps) * 0.02);
}

async function extractGameState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const safeCall = (fn, fallback = null) => {
        try {
          return fn();
        } catch (_err) {
          return fallback;
        }
      };

      const numberOrNull = (value) => (
        Number.isFinite(Number(value)) ? Number(value) : null
      );

      const cleanText = (value) => String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[^;]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const isCookieClicker = Boolean(
        globalThis.Game &&
        Game.Objects &&
        Game.ObjectsById &&
        Game.Upgrades &&
        typeof Game.cookies !== 'undefined'
      );

      if (!isCookieClicker) {
        return {
          isCookieClicker: false,
          url: location.href,
          title: document.title
        };
      }

      const globalCpsMult = numberOrNull(Game.globalCpsMult) || 1;
      const cookies = numberOrNull(Game.cookies) || 0;
      const cps = Math.max(0, numberOrNull(Game.cookiesPs) || 0);
      const cookiesPerClick = Math.max(
        0,
        numberOrNull(Game.computedMouseCps) ||
          numberOrNull(safeCall(() => Game.mouseCps(), null)) ||
          1
      );

      const buildings = (Array.isArray(Game.ObjectsById) ? Game.ObjectsById : [])
        .map((building) => {
          const currentPrice = numberOrNull(safeCall(() => building.getPrice(), building.price));
          const storedCps = Math.max(
            0,
            numberOrNull(building.storedCps) ||
              numberOrNull(safeCall(() => building.cps(building), null)) ||
              0
          );
          const amount = numberOrNull(building.amount) || 0;
          const cpsPerUnit = storedCps * globalCpsMult;
          const totalCps = Math.max(
            0,
            numberOrNull(building.storedTotalCps) * globalCpsMult ||
              cpsPerUnit * amount
          );

          return {
            id: numberOrNull(building.id),
            name: String(building.name || ''),
            amount,
            level: Math.max(0, numberOrNull(building.level) || 0),
            unlocked: building.unlocked !== 0,
            currentPrice,
            basePrice: numberOrNull(building.basePrice) || numberOrNull(building.price),
            cpsPerUnit,
            totalCps,
            affordable: currentPrice !== null && cookies >= currentPrice
          };
        })
        .filter((building) => building.name);

      const upgradesInStore = (Array.isArray(Game.UpgradesInStore) ? Game.UpgradesInStore : [])
        .map((upgrade) => {
          const price = numberOrNull(safeCall(() => upgrade.getPrice(), upgrade.basePrice || upgrade.price));
          const description = cleanText(
            safeCall(() => typeof upgrade.desc === 'function' ? upgrade.desc() : upgrade.desc, '')
          );

          return {
            id: numberOrNull(upgrade.id),
            name: String(upgrade.name || ''),
            price,
            basePrice: numberOrNull(upgrade.basePrice) || numberOrNull(upgrade.price),
            pool: String(upgrade.pool || ''),
            order: numberOrNull(upgrade.order),
            description,
            affordable: price !== null && cookies >= price
          };
        })
        .filter((upgrade) => upgrade.name);

      const achievements = (Array.isArray(Game.AchievementsById) ? Game.AchievementsById : Object.values(Game.Achievements || {}))
        .map((achievement) => {
          const description = cleanText(
            safeCall(() => typeof achievement.desc === 'function' ? achievement.desc() : achievement.desc, '')
          );
          const pool = String(achievement.pool || '');
          return {
            id: numberOrNull(achievement.id),
            name: String(achievement.name || ''),
            description,
            pool,
            won: Boolean(achievement.won),
            countsForMilk: pool !== 'shadow' && pool !== 'dungeon'
          };
        })
        .filter((achievement) => achievement.name);

      const achievementStats = achievements.reduce((stats, achievement) => {
        if (achievement.countsForMilk) {
          stats.normalTotal++;
          if (achievement.won) stats.normalWon++;
        } else if (achievement.pool === 'shadow') {
          stats.shadowTotal++;
          if (achievement.won) stats.shadowWon++;
        }
        return stats;
      }, {
        normalWon: 0,
        normalTotal: 0,
        shadowWon: 0,
        shadowTotal: 0
      });

      if (Game.OnAscend && typeof Game.BuildAscendTree === 'function') {
        safeCall(() => Game.BuildAscendTree(), null);
      }

      const allUpgrades = (Array.isArray(Game.UpgradesById) ? Game.UpgradesById : Object.values(Game.Upgrades || {}))
        .map((upgrade) => {
          const price = numberOrNull(safeCall(() => upgrade.getPrice(), upgrade.basePrice || upgrade.price));
          const description = cleanText(
            safeCall(() => typeof upgrade.desc === 'function' ? upgrade.desc() : upgrade.desc, '')
          );
          const parentNames = Array.isArray(upgrade.parents)
            ? upgrade.parents
              .map((parent) => parent?.name || parent)
              .filter(Boolean)
              .map(String)
            : [];
          const showIfOk = safeCall(
            () => typeof upgrade.showIf === 'function' ? Boolean(upgrade.showIf()) : true,
            true
          );
          const treeElement = typeof document !== 'undefined' && upgrade.id !== undefined
            ? document.getElementById(`heavenlyUpgrade${upgrade.id}`)
            : null;

          return {
            id: numberOrNull(upgrade.id),
            name: String(upgrade.name || ''),
            price,
            basePrice: numberOrNull(upgrade.basePrice) || numberOrNull(upgrade.price),
            description,
            bought: Boolean(upgrade.bought),
            pool: String(upgrade.pool || ''),
            unlocked: upgrade.unlocked !== 0,
            canBePurchased: typeof upgrade.canBePurchased === 'undefined'
              ? null
              : Boolean(upgrade.canBePurchased),
            showIfOk,
            parents: parentNames,
            visibleInAscensionTree: Boolean(treeElement),
            affordable: price !== null && (numberOrNull(Game.heavenlyChips) || 0) >= price
          };
        })
        .filter((upgrade) => upgrade.name);
      const ownedUpgrades = allUpgrades.filter((upgrade) => upgrade.bought);
      const hasUpgrade = (name) => Boolean(
        safeCall(() => typeof Game.Has === 'function' ? Game.Has(name) : false, false) ||
        ownedUpgrades.some((upgrade) => upgrade.name === name)
      );
      const storeHasGoldenSwitchOn = upgradesInStore.some((upgrade) => upgrade.name === 'Golden switch [on]');
      const storeHasGoldenSwitchOff = upgradesInStore.some((upgrade) => upgrade.name === 'Golden switch [off]');
      const goldenSwitchOn = Boolean(
        storeHasGoldenSwitchOn ||
        (!storeHasGoldenSwitchOff && hasUpgrade('Golden switch [on]'))
      );
      const goldenCookieBlockers = [];
      if (goldenSwitchOn) {
        goldenCookieBlockers.push('Golden switch');
      }

      const milkPowerMultiplier = Math.max(
        0,
        numberOrNull(safeCall(() => typeof Game.eff === 'function' ? Game.eff('milk') : null, null)) || 1
      );

      const ascensionUpgrades = allUpgrades
        .filter((upgrade) => String(upgrade?.pool || '') === 'prestige');

      const shimmers = Array.isArray(Game.shimmers) ? Game.shimmers : [];
      const wrinklers = Array.isArray(Game.wrinklers) ? Game.wrinklers : [];
      const now = Date.now();
      const lumpT = numberOrNull(Game.lumpT) || 0;
      const lumpAge = lumpT > 0 ? now - lumpT : 0;
      const lumpMatureAge = numberOrNull(Game.lumpMatureAge) || 20 * 60 * 60 * 1000;
      const lumpRipeAge = numberOrNull(Game.lumpRipeAge) || 23 * 60 * 60 * 1000;
      const prestigeGain = numberOrNull(Game.ascendMeterLevel) ||
        numberOrNull(safeCall(() => Game.HowMuchPrestige(Game.cookiesReset + Game.cookiesEarned) - Game.prestige, null)) ||
        0;

      return {
        isCookieClicker: true,
        url: location.href,
        title: document.title,
        version: String(Game.version || ''),
        cookies,
        cps,
        cookiesPerClick,
        clickCps: cookiesPerClick * 44,
        cookiesEarned: numberOrNull(Game.cookiesEarned) || 0,
        cookiesReset: numberOrNull(Game.cookiesReset) || 0,
        cookieClicks: numberOrNull(Game.cookieClicks) || 0,
        globalCpsMult,
        milkProgress: Math.max(0, numberOrNull(Game.milkProgress) || 0),
        milkPowerMultiplier,
        goldenCookiesBlocked: goldenCookieBlockers.length > 0,
        goldenCookieBlockers,
        lumps: Math.max(0, numberOrNull(Game.lumps) || 0),
        sugarLump: {
          currentType: numberOrNull(Game.lumpCurrentType) || 0,
          ageMs: lumpAge,
          matureAgeMs: lumpMatureAge,
          ripeAgeMs: lumpRipeAge,
          mature: lumpAge >= lumpMatureAge,
          ripe: lumpAge >= lumpRipeAge
        },
        prestige: numberOrNull(Game.prestige) || 0,
        heavenlyChips: numberOrNull(Game.heavenlyChips) || 0,
        prestigeGain,
        onAscend: Boolean(Game.OnAscend),
        frenzy: numberOrNull(Game.frenzy) || 0,
        frenzyPower: numberOrNull(Game.frenzyPower) || 1,
        goldenCookiesVisible: shimmers.filter((shimmer) => shimmer?.type === 'golden').length,
        wrinklersActive: wrinklers.filter((wrinkler) => wrinkler?.phase > 0).length,
        wrinklersSucked: wrinklers.reduce((sum, wrinkler) => sum + (numberOrNull(wrinkler?.sucked) || 0), 0),
        achievements,
        achievementStats,
        ascensionUpgrades,
        ownedUpgrades,
        buildings,
        upgradesInStore
      };
    }
  });

  return results[0]?.result || { isCookieClicker: false };
}

function buildCandidates(state, options) {
  const buildings = state.buildings
    .filter((building) => building.unlocked && building.currentPrice !== null && building.cpsPerUnit > 0)
    .map((building) => ({
      kind: 'building',
      actionType: 'BUY_BUILDING',
      targetName: building.name,
      price: building.currentPrice,
      affordable: building.affordable,
      cpsDelta: building.cpsPerUnit,
      effectLabel: `+${formatNumber(building.cpsPerUnit)} CpS`,
      confidence: 'live',
      reason: `${building.name} adds about ${formatNumber(building.cpsPerUnit)} CpS right now.`
    }));

  const upgrades = state.upgradesInStore
    .filter((upgrade) => upgrade.price !== null)
    .map((upgrade) => {
      const estimate = estimateUpgradeDeltaCps(upgrade, state);
      return {
        kind: 'upgrade',
        actionType: 'BUY_UPGRADE',
        targetName: upgrade.name,
        price: upgrade.price,
        affordable: upgrade.affordable,
        cpsDelta: estimate.cpsDelta,
        effectLabel: estimate.effectLabel,
        confidence: estimate.confidence,
        reason: estimate.reason
      };
    })
    .filter((upgrade) => upgrade.cpsDelta > 0 || (upgrade.affordable && options.strategy === 'long'));

  return [...upgrades, ...buildings];
}

function estimateUpgradeDeltaCps(upgrade, state) {
  const desc = String(upgrade.description || '').toLowerCase();
  const cps = Math.max(0, state.cps || 0);
  let cpsDelta = 0;
  let confidence = 'estimated';
  const reasons = [];

  const percent = firstPercentMatch(desc, [
    /cookie production multiplier\s*\+([\d.]+)%/,
    /cookies per second[^.]*\+([\d.]+)%/,
    /\bcps[^.]*\+([\d.]+)%/,
    /production[^.]*\+([\d.]+)%/
  ]);

  if (percent > 0) {
    const delta = cps * (percent / 100);
    cpsDelta = Math.max(cpsDelta, delta);
    confidence = 'description';
    reasons.push(`description says about +${percent}% production`);
  }

  if (/\btwice as efficient\b/.test(desc) || /\btwice as much\b/.test(desc)) {
    const affected = affectedBuildingCps(desc, state);
    if (affected > 0) {
      cpsDelta = Math.max(cpsDelta, affected);
      confidence = 'description';
      reasons.push('description doubles an affected building group');
    } else if (/all buildings|everything|production/.test(desc)) {
      cpsDelta = Math.max(cpsDelta, cps);
      confidence = 'description';
      reasons.push('description appears to double broad production');
    }
  }

  const buildingPercent = affectedBuildingPercent(desc, state);
  if (buildingPercent.cpsDelta > 0) {
    cpsDelta = Math.max(cpsDelta, buildingPercent.cpsDelta);
    confidence = 'description';
    reasons.push(buildingPercent.reason);
  }

  if (desc.includes('kitten') && desc.includes('milk')) {
    const kittenDelta = cps * Math.max(0.03, state.milkProgress * 0.06);
    cpsDelta = Math.max(cpsDelta, kittenDelta);
    reasons.push('kitten upgrade estimated from current milk');
  }

  if (desc.includes('click') || desc.includes('mouse')) {
    const clickDelta = Math.max(0, state.clickCps || 0) * 0.1;
    if (clickDelta > 0) {
      cpsDelta = Math.max(cpsDelta, clickDelta);
      reasons.push('clicking upgrade estimated from auto-click rate');
    }
  }

  if (cpsDelta <= 0 && looksLikeProgressionUpgrade(upgrade, desc)) {
    cpsDelta = Math.max(cps * 0.03, 0.1);
    confidence = 'progression';
    reasons.push('progression or unlock upgrade with delayed value');
  }

  if (cpsDelta <= 0 && upgrade.affordable && upgrade.price <= Math.max(10, state.cookies * 0.02)) {
    cpsDelta = Math.max(cps * 0.005, 0.01);
    confidence = 'low';
    reasons.push('cheap unknown upgrade with small placeholder value');
  }

  return {
    cpsDelta,
    confidence,
    effectLabel: cpsDelta > 0
      ? `estimated +${formatNumber(cpsDelta)} CpS`
      : 'unknown direct CpS gain',
    reason: reasons.length
      ? `${upgrade.name}: ${reasons.join('; ')}.`
      : `${upgrade.name}: direct production effect was not recognized yet.`
  };
}

function firstPercentMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }

  return 0;
}

function affectedBuildingCps(desc, state) {
  return state.buildings.reduce((sum, building) => {
    const aliases = buildingAliases(building.name);
    const affected = aliases.some((alias) => desc.includes(alias));
    return affected ? sum + (building.totalCps || 0) : sum;
  }, 0);
}

function affectedBuildingPercent(desc, state) {
  for (const building of state.buildings) {
    const aliases = buildingAliases(building.name);
    if (!aliases.some((alias) => desc.includes(alias))) continue;

    const percent = firstPercentMatch(desc, [
      /gain\s*\+([\d.]+)%/,
      /\+([\d.]+)%\s*cps/,
      /\+([\d.]+)%\s*production/
    ]);

    if (percent > 0) {
      return {
        cpsDelta: (building.totalCps || 0) * (percent / 100),
        reason: `${building.name} group appears to gain +${percent}% CpS`
      };
    }
  }

  return { cpsDelta: 0, reason: '' };
}

function buildingAliases(name) {
  const lower = String(name || '').toLowerCase();
  const irregular = {
    cursor: ['cursor', 'cursors'],
    grandma: ['grandma', 'grandmas'],
    factory: ['factory', 'factories'],
    chancemaker: ['chancemaker', 'chancemakers'],
    idleverse: ['idleverse', 'idleverses'],
    you: ['you']
  };

  if (irregular[lower]) {
    return irregular[lower];
  }

  return [lower, `${lower}s`];
}

function isGoldenCookieUpgrade(name, desc) {
  const text = `${name || ''} ${desc || ''}`.toLowerCase();
  return /\bgolden cookies?\b/.test(text) ||
    /\bwrath cookies?\b/.test(text);
}

function isGoldenCookieBlockerUpgrade(name, desc) {
  const text = `${name || ''} ${desc || ''}`.toLowerCase();
  return text.includes('golden switch') &&
    (
      text.includes('prevents golden cookies') ||
      text.includes('disables golden cookies') ||
      text.includes('golden cookies from spawning')
    );
}

function looksLikeProgressionUpgrade(upgrade, desc) {
  return upgrade.pool === 'tech' ||
    desc.includes('research') ||
    desc.includes('unlock') ||
    desc.includes('upgrade tree') ||
    desc.includes('appears') ||
    desc.includes('golden cookies appear');
}

function scoreCandidate(candidate, state, options) {
  const cps = Math.max(0, state.cps || 0);
  const cookies = Math.max(0, state.cookies || 0);
  const price = Math.max(0, candidate.price || 0);
  const waitSeconds = cookies >= price
    ? 0
    : cps > 0
      ? (price - cookies) / cps
      : Number.POSITIVE_INFINITY;

  const paybackSeconds = candidate.cpsDelta > 0
    ? price / candidate.cpsDelta
    : Number.POSITIVE_INFINITY;

  if (options.objective.type === 'target') {
    const target = options.objective.targetCookies;
    const baselineSeconds = cps > 0
      ? Math.max(0, (target - cookies) / cps)
      : Number.POSITIVE_INFINITY;

    if (cookies >= target || baselineSeconds < waitSeconds) {
      return { ...candidate, waitSeconds, paybackSeconds, score: 0 };
    }

    const cookiesAfterBuy = cookies + (cps * waitSeconds) - price;
    const cpsAfterBuy = cps + candidate.cpsDelta;
    const remaining = Math.max(0, target - cookiesAfterBuy);
    const totalSeconds = waitSeconds + (cpsAfterBuy > 0 ? remaining / cpsAfterBuy : Number.POSITIVE_INFINITY);
    const timeSaved = !Number.isFinite(baselineSeconds) && Number.isFinite(totalSeconds)
      ? Number.MAX_SAFE_INTEGER
      : baselineSeconds - totalSeconds;

    return {
      ...candidate,
      waitSeconds,
      paybackSeconds,
      score: timeSaved,
      projectedSeconds: totalSeconds,
      baselineSeconds,
      scoreLabel: timeSaved === Number.MAX_SAFE_INTEGER
        ? 'makes the target reachable from zero current CpS'
        : `${formatSeconds(timeSaved)} faster to target`
    };
  }

  const horizonSeconds = options.objective.horizonSeconds;
  const baselineCookies = cookies + (cps * horizonSeconds);

  if (waitSeconds >= horizonSeconds) {
    return { ...candidate, waitSeconds, paybackSeconds, score: 0 };
  }

  const cookiesAfterBuy = cookies + (cps * waitSeconds) - price;
  const remainingSeconds = horizonSeconds - waitSeconds;
  const projectedCookies = cookiesAfterBuy + ((cps + candidate.cpsDelta) * remainingSeconds);
  const netGain = projectedCookies - baselineCookies;

  return {
    ...candidate,
    waitSeconds,
    paybackSeconds,
    score: netGain,
    projectedCookies,
    baselineCookies,
    scoreLabel: `${formatNumber(netGain)} more cookies by the deadline`
  };
}

function commandFromCandidate(candidate, state, options) {
  if (!candidate || candidate.score <= 0) {
    return {
      actionType: 'CLICK_BIG_COOKIE',
      targetName: '',
      explanation: `No purchase beats simply waiting/clicking for ${formatObjective(options.objective)} right now.`
    };
  }

  if (!candidate.affordable) {
    return {
      actionType: 'SAVE_UP',
      targetName: candidate.targetName,
      saveTargetType: candidate.kind,
      explanation:
        `Save for ${candidate.kind} "${candidate.targetName}". ` +
        `${candidate.reason} It scores best for ${formatObjective(options.objective)}; ` +
        `shortfall is ${formatNumber(Math.max(0, candidate.price - state.cookies))}.`
    };
  }

  return {
    actionType: candidate.actionType,
    targetName: candidate.targetName,
    explanation:
      `Buy ${candidate.kind} "${candidate.targetName}". ` +
      `${candidate.reason} Score: ${candidate.scoreLabel || formatNumber(candidate.score)}.`
  };
}

function buildBaseline(state, options) {
  if (options.objective.type === 'target') {
    const target = options.objective.targetCookies;
    return {
      label: state.cps > 0
        ? `Baseline time to target: ${formatSeconds((target - state.cookies) / state.cps)}`
        : 'Baseline time to target: unknown because current CpS is 0'
    };
  }

  return {
    label:
      `Baseline after ${formatSeconds(options.objective.horizonSeconds)}: ` +
      `${formatNumber(state.cookies + (state.cps * options.objective.horizonSeconds))} cookies`
  };
}

function buildAscensionNote(state, options) {
  if (!state.prestigeGain || state.prestigeGain <= 0) {
    return 'Ascension: no prestige gain is visible from the live state yet.';
  }

  if (!options.allowAscension) {
    return (
      `Ascension: about ${formatNumber(state.prestigeGain)} prestige is visible, ` +
      'but the Ascend option is off.'
    );
  }

  return (
    `Ascension: live state shows about ${formatNumber(state.prestigeGain)} prestige available. ` +
    'The planner may ascend when its heuristic route beats continuing in the current run.'
  );
}

async function setBigCookieAutoClicker(tabId, enabled) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [enabled, BIG_COOKIE_CLICKS_PER_SECOND],
    func: (shouldRun, clicksPerSecond) => {
      const state = globalThis.cookieMathBigCookieAutoClicker || {
        running: false,
        timerId: null,
        clicksPerSecond,
        intervalMs: 1000 / clicksPerSecond,
        nextClickAt: 0,
        totalClicks: 0,
        lastError: ''
      };

      globalThis.cookieMathBigCookieAutoClicker = state;

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
      for (const shimmer of shimmers) {
        if (shimmer?.type !== 'golden') continue;

        try {
          if (typeof shimmer.pop === 'function') {
            shimmer.pop();
            result.goldenCookiesClicked++;
          } else if (typeof shimmer.l?.click === 'function') {
            shimmer.l.click();
            result.goldenCookiesClicked++;
          }
        } catch (_err) {
          // Golden cookies can disappear between reading and clicking.
        }
      }

      if (result.goldenCookiesClicked) {
        result.message = `clicked ${result.goldenCookiesClicked} golden cookie(s)`;
      }

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

async function getAscensionTransitionStatus(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [ASCENSION_TRANSITION_MAX_MS, ASCENSION_RETRY_MIN_MS],
    func: (maxTransitionMs, retryMinMs) => {
      if (typeof Game === 'undefined') {
        return {
          pending: false,
          onAscend: false,
          message: 'Cookie Clicker Game object was not found.'
        };
      }

      const transition = globalThis.cookieMathAscensionTransition || null;

      if (Game.OnAscend) {
        if (transition) {
          globalThis.cookieMathAscensionTransition = null;
        }

        return {
          pending: false,
          onAscend: true,
          message: 'Legacy screen is ready.'
        };
      }

      if (!transition?.startedAt) {
        return {
          pending: false,
          onAscend: false,
          message: ''
        };
      }

      const elapsedMs = Date.now() - transition.startedAt;
      const minWaitLeftMs = Math.max(0, retryMinMs - elapsedMs);

      if (elapsedMs > maxTransitionMs) {
        globalThis.cookieMathAscensionTransition = null;
        return {
          pending: false,
          onAscend: false,
          expired: true,
          message: 'Ascension transition lock expired; Commander may retry.'
        };
      }

      return {
        pending: true,
        onAscend: false,
        elapsedMs,
        message: minWaitLeftMs > 0
          ? `Ascension command was sent once; waiting at least ${Math.ceil(minWaitLeftMs / 1000)}s before any retry.`
          : `Ascension command was sent once; waiting for the legacy screen animation (${Math.ceil(elapsedMs / 1000)}s).`
      };
    }
  });

  return results[0]?.result || {
    pending: false,
    onAscend: false,
    message: 'No ascension transition status returned.'
  };
}

function shouldSuppressBigCookieClicks(command) {
  if (
    command?.actionType === 'ASCEND' ||
    command?.actionType === 'BUY_ASCENSION_UPGRADE' ||
    command?.actionType === 'REINCARNATE'
  ) {
    return true;
  }

  return command?.actionType === 'DO_ACHIEVEMENT_ACTION' && (
      command.achievementAction === 'PRESERVE_TRUE_NEVERCLICK' ||
      command.achievementAction === 'PRESERVE_NEVERCLICK' ||
      Boolean(neverclickRuleForText(command.targetName))
    );
}

async function applyCommand(tabId, command) {
  if (!VALID_ACTION_TYPES.has(command.actionType)) {
    return { ok: false, message: `Invalid math action: ${command.actionType}` };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [command, ASCENSION_TRANSITION_MAX_MS, ASCENSION_RETRY_MIN_MS],
    func: async (cmd, maxAscensionTransitionMs, ascensionRetryMinMs) => {
      if (typeof Game === 'undefined') {
        return { ok: false, message: 'Cookie Clicker Game object was not found.' };
      }

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const normalizePromptText = (value) => String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const isVisible = (element) => {
        if (!element) return false;

        const style = globalThis.getComputedStyle
          ? globalThis.getComputedStyle(element)
          : null;

        return (!style || (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
        )) && Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      };
      const promptRoots = () => {
        const roots = [
          document.getElementById('prompt'),
          document.getElementById('promptContent'),
          ...document.querySelectorAll('[id^="prompt"], [class*="prompt"]')
        ].filter(Boolean);

        return [...new Set(roots)].filter((root) => {
          const text = normalizePromptText(root.innerText || root.textContent || '');
          return text && isVisible(root);
        });
      };
      const clickPromptButton = async (label, requiredText = []) => {
        const normalizedLabel = normalizePromptText(label);
        const normalizedRequiredText = requiredText
          .map(normalizePromptText)
          .filter(Boolean);

        for (const root of promptRoots()) {
          const promptText = normalizePromptText(root.innerText || root.textContent || '');
          if (!normalizedRequiredText.every((text) => promptText.includes(text))) {
            continue;
          }

          const buttons = [...root.querySelectorAll('button, a, input[type="button"], input[type="submit"], .option')]
            .filter(isVisible);
          const button = buttons.find((candidate) => {
            const candidateText = normalizePromptText(
              candidate.value || candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label')
            );
            return candidateText === normalizedLabel;
          }) || buttons.find((candidate) => {
            const candidateText = normalizePromptText(
              candidate.value || candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label')
            );
            return candidateText.includes(normalizedLabel);
          });

          if (button) {
            button.click();
            await sleep(200);
            return true;
          }
        }

        return false;
      };
      const normalizeUpgradeName = (value) => normalizePromptText(value)
        .replace(/&reg;|\u00ae/g, 'r')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      const findUpgradeByName = (name) => {
        const rawName = String(name || '').trim();
        if (Game.Upgrades?.[rawName]) return Game.Upgrades[rawName];

        const normalizedName = normalizeUpgradeName(rawName);
        return Object.values(Game.Upgrades || {}).find((upgrade) => (
          normalizeUpgradeName(upgrade?.name) === normalizedName
        )) || null;
      };
      const refreshAscensionTree = (justBought = null) => {
        try {
          if (typeof Game.BuildAscendTree === 'function') {
            Game.BuildAscendTree(justBought || undefined);
          }
        } catch (_err) {
          // The caller will report the purchase result; tree refresh is cosmetic.
        }

        try {
          if (typeof Game.UpdateAscend === 'function') {
            Game.UpdateAscend();
          }
        } catch (_err) {
          // Some ascension animations may not expose a fully initialized view yet.
        }
      };
      const centerAscensionTreeOnUpgrade = (upgrade) => {
        if (!Game.OnAscend || !upgrade) return false;

        const posX = Number(upgrade.posX);
        const posY = Number(upgrade.posY);
        if (!Number.isFinite(posX) || !Number.isFinite(posY)) {
          return false;
        }

        Game.AscendZoomT = 1;
        Game.AscendZoom = 1;
        Game.AscendOffXT = -(posX + 28);
        Game.AscendOffYT = -(posY + 28);
        Game.AscendOffX = Game.AscendOffXT;
        Game.AscendOffY = Game.AscendOffYT;
        refreshAscensionTree();
        return true;
      };
      const missingPrestigeParents = (upgrade) => (
        Array.isArray(upgrade?.parents)
          ? upgrade.parents
            .filter((parent) => parent && parent !== -1 && !parent.bought)
            .map((parent) => parent.name || String(parent))
          : []
      );
      const ascensionScreenActions = new Set(['BUY_ASCENSION_UPGRADE', 'REINCARNATE']);

      if (Game.OnAscend && !ascensionScreenActions.has(cmd.actionType)) {
        return {
          ok: true,
          message:
            `Skipped ${cmd.actionType}; the legacy screen is active, so Commander must buy heavenly upgrades or reincarnate first.`
        };
      }

      if (cmd.actionType !== 'USE_SUGAR_LUMP') {
        const dismissedSugarPrompt = await clickPromptButton('no', ['sugar lump']);
        if (dismissedSugarPrompt) {
          return {
            ok: true,
            message: 'Dismissed a stale sugar-lump confirmation prompt before continuing.'
          };
        }
      }

      if (cmd.actionType === 'SAVE_UP' || cmd.actionType === 'WAIT') {
        return {
          ok: true,
          message: cmd.targetName
            ? `Saving up for "${cmd.targetName}".`
            : 'Waiting while the auto-clicker keeps running.'
        };
      }

      if (cmd.actionType === 'CLICK_BIG_COOKIE') {
        const clicker = globalThis.cookieMathBigCookieAutoClicker;
        return {
          ok: true,
          message: clicker?.running
            ? `Big cookie auto-clicker is already running at about ${clicker.clicksPerSecond} clicks/sec.`
            : 'Big cookie click command accepted; auto-clicker will resume on the next tick.'
        };
      }

      if (cmd.actionType === 'CLICK_GOLDEN_COOKIE') {
        const shimmers = Array.isArray(Game.shimmers) ? [...Game.shimmers] : [];
        let goldenCookiesClicked = 0;

        for (const shimmer of shimmers) {
          if (shimmer?.type !== 'golden') continue;

          if (typeof shimmer.pop === 'function') {
            shimmer.pop();
            goldenCookiesClicked++;
          } else if (typeof shimmer.l?.click === 'function') {
            shimmer.l.click();
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

      if (cmd.actionType === 'DO_ACHIEVEMENT_ACTION') {
        const achievementTarget = String(cmd.targetName || '').trim().toLowerCase();
        const isTrueNeverclick = cmd.achievementAction === 'PRESERVE_TRUE_NEVERCLICK' ||
          /\btrue\s+neverclick\b/.test(achievementTarget);
        const isNeverclick = cmd.achievementAction === 'PRESERVE_NEVERCLICK' ||
          /\bneverclick\b/.test(achievementTarget);

        if (isTrueNeverclick || isNeverclick) {
          const clickLimit = isTrueNeverclick ? 0 : 15;
          const label = isTrueNeverclick ? 'True Neverclick' : 'Neverclick';
          const cookieClicks = Number(Game.cookieClicks) || 0;

          if (cookieClicks > clickLimit) {
            return {
              ok: true,
              message: `${label} is no longer possible this ascension because Game.cookieClicks is ${cookieClicks}, above the ${clickLimit} click limit.`
            };
          }

          return {
            ok: true,
            message: `Preserving ${label}: big-cookie auto-clicker is disabled while Game.cookieClicks is ${cookieClicks}/${clickLimit}.`
          };
        }

        if (cmd.achievementAction === 'CLICK_BIG_COOKIE') {
          const clicker = globalThis.cookieMathBigCookieAutoClicker;
          return {
            ok: true,
            message: clicker?.running
              ? `Continuing big-cookie clicks toward achievement: ${cmd.targetName}.`
              : `Achievement action queued for ${cmd.targetName}; auto-clicker will resume on the next tick.`
          };
        }

        return {
          ok: true,
          message: `Achievement action noted: ${cmd.targetName}.`
        };
      }

      if (cmd.actionType === 'POP_WRINKLERS') {
        const wrinklers = Array.isArray(Game.wrinklers) ? Game.wrinklers : [];
        let popped = 0;

        for (const wrinkler of wrinklers) {
          if (!wrinkler || !(wrinkler.phase > 0)) continue;

          try {
            if (typeof Game.PopWrinkler === 'function') {
              Game.PopWrinkler(wrinkler);
            } else {
              wrinkler.hp = 0;
            }
            popped++;
          } catch (_err) {
            // One wrinkler may disappear while another is being popped.
          }
        }

        return {
          ok: popped > 0,
          message: popped > 0
            ? `Popped ${popped} wrinkler(s).`
            : 'No wrinklers were available to pop.'
        };
      }

      if (cmd.actionType === 'COLLECT_SUGAR_LUMP') {
        const before = Number(Game.lumps) || 0;

        if (typeof Game.clickLump !== 'function') {
          return { ok: false, message: 'Sugar lump harvest function was not available.' };
        }

        Game.clickLump();

        const after = Number(Game.lumps) || 0;
        return {
          ok: after > before,
          message: after > before
            ? `Collected ${after - before} sugar lump(s).`
            : 'Tried to collect the sugar lump, but no lump was gained.'
        };
      }

      if (cmd.actionType === 'USE_SUGAR_LUMP') {
        const building = Game.Objects[cmd.targetName];
        if (!building) {
          return { ok: false, message: `Building not found for sugar lump: ${cmd.targetName}` };
        }

        if (typeof building.levelUp !== 'function') {
          return { ok: false, message: `This Cookie Clicker build did not expose levelUp() for ${cmd.targetName}.` };
        }

        const beforeLevel = Number(building.level) || 0;
        const beforeLumps = Number(Game.lumps) || 0;
        const promptTargetText = `level up your ${cmd.targetName}`;
        let confirmedPrompt = await clickPromptButton('yes', ['sugar lump', promptTargetText]);

        if (confirmedPrompt) {
          await sleep(200);
        } else {
          const dismissedStalePrompt = await clickPromptButton('no', ['sugar lump']);
          if (dismissedStalePrompt) {
            await sleep(100);
          }
        }

        if ((Number(building.level) || 0) <= beforeLevel) {
          building.levelUp();
          await sleep(100);
          confirmedPrompt = await clickPromptButton('yes', ['sugar lump', promptTargetText]) || confirmedPrompt;

          if (confirmedPrompt) {
            await sleep(250);
          }
        }

        const afterLevel = Number(building.level) || 0;
        const afterLumps = Number(Game.lumps) || 0;

        return {
          ok: afterLevel > beforeLevel,
          message: afterLevel > beforeLevel
            ? `${confirmedPrompt ? 'Confirmed the sugar-lump prompt and s' : 'S'}pent ${beforeLumps - afterLumps} sugar lump(s) to level ${cmd.targetName}.`
            : confirmedPrompt
              ? `Clicked the sugar-lump confirmation for ${cmd.targetName}, but its level did not change yet.`
              : `Could not level ${cmd.targetName} with sugar lumps.`
        };
      }

      if (cmd.actionType === 'ASCEND') {
        if (Game.OnAscend) {
          globalThis.cookieMathAscensionTransition = null;
          return { ok: true, message: 'Already on the ascension screen.' };
        }

        if (typeof Game.Ascend !== 'function') {
          return { ok: false, message: 'Ascend function was not available.' };
        }

        const transition = globalThis.cookieMathAscensionTransition || null;
        const transitionAgeMs = transition?.startedAt
          ? Date.now() - transition.startedAt
          : Number.POSITIVE_INFINITY;

        if (transition?.startedAt && transitionAgeMs < maxAscensionTransitionMs) {
          const minWaitLeftMs = Math.max(0, ascensionRetryMinMs - transitionAgeMs);
          return {
            ok: true,
            pending: true,
            message: minWaitLeftMs > 0
              ? `Ascension is already in progress; waiting at least ${Math.ceil(minWaitLeftMs / 1000)}s before any retry.`
              : `Ascension is already in progress; waiting for the legacy screen (${Math.ceil(transitionAgeMs / 1000)}s).`
          };
        }

        globalThis.cookieMathAscensionTransition = {
          startedAt: Date.now()
        };
        Game.Ascend(1);

        if (Game.OnAscend) {
          globalThis.cookieMathAscensionTransition = null;
        }

        return {
          ok: true,
          pending: !Boolean(Game.OnAscend),
          message: Boolean(Game.OnAscend)
            ? 'Ascended to the legacy screen.'
            : 'Ascension command sent once; waiting for Cookie Clicker to finish the legacy-screen transition.'
        };
      }

      if (cmd.actionType === 'BUY_ASCENSION_UPGRADE') {
        if (!Game.OnAscend) {
          return {
            ok: true,
            pending: true,
            message: `Waiting for the ascension screen before buying heavenly upgrade: ${cmd.targetName}.`
          };
        }

        if (Game.promptOn && typeof Game.ClosePrompt === 'function') {
          Game.ClosePrompt();
          await sleep(100);
        }

        refreshAscensionTree();

        const upgrade = findUpgradeByName(cmd.targetName);
        if (!upgrade) {
          return { ok: false, message: `Ascension upgrade not found: ${cmd.targetName}` };
        }

        if (String(upgrade.pool || '') !== 'prestige') {
          return { ok: false, message: `${cmd.targetName} is not a heavenly upgrade.` };
        }

        if (upgrade.bought) {
          centerAscensionTreeOnUpgrade(upgrade);
          return { ok: true, message: `Ascension upgrade already bought: ${upgrade.name}` };
        }

        if (typeof upgrade.showIf === 'function' && !upgrade.showIf()) {
          return {
            ok: false,
            message: `Heavenly upgrade is currently hidden by its unlock condition: ${upgrade.name}`
          };
        }

        const missingParents = missingPrestigeParents(upgrade);
        if (missingParents.length) {
          return {
            ok: false,
            message: `Cannot buy ${upgrade.name} yet; missing parent upgrade(s): ${missingParents.join(', ')}.`
          };
        }

        if (upgrade.canBePurchased === false) {
          return {
            ok: false,
            message: `Cannot buy ${upgrade.name} yet; Cookie Clicker says it is not purchasable in the ascension tree.`
          };
        }

        const livePrice = typeof upgrade.getPrice === 'function'
          ? Number(upgrade.getPrice())
          : Number.NaN;
        const price = Number.isFinite(livePrice)
          ? livePrice
          : Number(upgrade.basePrice) || 0;
        const chips = Number(Game.heavenlyChips) || 0;
        if (chips < price) {
          return {
            ok: false,
            message: `Cannot buy ${upgrade.name}; it costs ${price} heavenly chip(s), but only ${chips} are available.`
          };
        }

        const before = Boolean(upgrade.bought);
        const beforeChips = Number(Game.heavenlyChips) || 0;
        const focused = centerAscensionTreeOnUpgrade(upgrade);
        const attempts = [];
        const treeElement = document.getElementById(`heavenlyUpgrade${upgrade.id}`);

        if (typeof Game.PurchaseHeavenlyUpgrade === 'function') {
          Game.PurchaseHeavenlyUpgrade(upgrade.id);
          attempts.push('ascension tree API');
          await sleep(150);
        }

        if (!upgrade.bought && treeElement && typeof treeElement.click === 'function') {
          treeElement.click();
          attempts.push('tree click');
          await sleep(150);
        }

        if (!upgrade.bought && typeof upgrade.buy === 'function') {
          upgrade.buy(1);
          attempts.push('direct heavenly buy');
          await sleep(150);
        }

        const after = Boolean(upgrade.bought);
        refreshAscensionTree(after ? upgrade : null);

        const spent = Math.max(0, beforeChips - (Number(Game.heavenlyChips) || 0));
        return {
          ok: after && !before,
          message: after && !before
            ? `Bought ascension upgrade: ${upgrade.name}${focused ? ' after centering it in the tree' : ''}. Spent ${spent} heavenly chip(s).`
            : `Could not buy ascension upgrade: ${upgrade.name}. Tried ${attempts.join(', ') || 'no available purchase method'}.`
        };
      }

      if (cmd.actionType === 'REINCARNATE') {
        if (!Game.OnAscend) {
          return { ok: true, message: 'Already in a normal run.' };
        }

        if (typeof Game.Reincarnate !== 'function') {
          return { ok: false, message: 'Reincarnate function was not available.' };
        }

        if (Game.promptOn && typeof Game.ClosePrompt === 'function') {
          Game.ClosePrompt();
          await sleep(100);
        }

        Game.Reincarnate(1);

        return {
          ok: !Game.OnAscend,
          message: !Game.OnAscend
            ? 'Started the next run after ascension.'
            : 'Tried to reincarnate, but the game stayed on the ascension screen.'
        };
      }

      if (cmd.actionType === 'BUY_UPGRADE') {
        const upgrade = Game.Upgrades[cmd.targetName];
        if (!upgrade) {
          return { ok: false, message: `Upgrade not found: ${cmd.targetName}` };
        }

        const before = Boolean(upgrade.bought);
        if (typeof upgrade.buy === 'function') {
          upgrade.buy();
        }

        return {
          ok: Boolean(upgrade.bought) && !before,
          message: Boolean(upgrade.bought) && !before
            ? `Bought upgrade: ${cmd.targetName}`
            : `Could not buy upgrade: ${cmd.targetName}`
        };
      }

      if (cmd.actionType === 'BUY_BUILDING') {
        const building = Game.Objects[cmd.targetName];
        if (!building) {
          return { ok: false, message: `Building not found: ${cmd.targetName}` };
        }

        const before = Number(building.amount) || 0;
        if (typeof building.buy === 'function') {
          building.buy(1);
        }

        return {
          ok: (Number(building.amount) || 0) > before,
          message: (Number(building.amount) || 0) > before
            ? `Bought building: ${cmd.targetName}`
            : `Could not buy building: ${cmd.targetName}`
        };
      }

      return { ok: false, message: `Unsupported action: ${cmd.actionType}` };
    }
  });

  return results[0]?.result || { ok: false, message: 'No execution result returned.' };
}

function formatAdvice(analysis) {
  const best = analysis.best;
  const state = analysis.state;
  const engine = analysis.engine;
  const effectiveCps = engine?.model
    ? engineIncomePerSecond(engine.model)
    : (Number(state.cps) || 0) + (Number(state.clickCps) || 0);

  return [
    'MATH ADVICE',
    `Objective: ${formatObjective(analysis.options.objective)}`,
    `Current: ${formatNumber(state.cookies)} cookies, ${formatNumber(state.cps)} passive CpS`,
    `Modeled income: ${formatNumber(effectiveCps)} cookies/sec including auto-clicks`,
    analysis.baseline.label,
    engine?.plan ? `Planner: ${engine.plan.routeCount} routes, beam width ${engine.plan.beamWidth}, max depth ${engine.plan.maxDepth}` : '',
    '',
    best?.noPurchase
      ? 'Best move: buy nothing and keep clicking'
      : best
      ? `Best move: ${formatCandidateMove(best)}`
      : 'Best move: keep clicking and wait for a stronger purchase.',
    best
      ? `Why: ${best.reason} ${best.scoreLabel || ''}`.trim()
      : `Why: no visible purchase has positive value for ${formatObjective(analysis.options.objective)} right now.`,
    best && !best.noPurchase
      ? `Cost: ${formatNumber(best.price)}; wait: ${formatSeconds(best.waitSeconds)}; payback: ${formatSeconds(best.paybackSeconds)}`
      : best?.noPurchase
        ? `Wait estimate: ${formatSeconds(best.waitSeconds)}`
      : '',
    '',
    topCandidateLines(engine?.rankedChoices || analysis.candidates),
    engine?.warnings?.length ? `Notes:\n${engine.warnings.map((warning) => `- ${warning}`).join('\n')}` : '',
    '',
    analysis.ascension
  ].filter(Boolean).join('\n');
}

function topCandidateLines(candidates) {
  const top = candidates
    .slice(0, 5);

  if (!top.length) {
    return 'Top options: none with positive projected value right now.';
  }

  return [
    'Top options:',
    ...top.map((candidate, index) => (
      candidate.noPurchase
        ? `${index + 1}. Buy nothing / wait - ${candidate.scoreLabel}; wait ${formatSeconds(candidate.waitSeconds)}`
        : `${index + 1}. ${formatCandidateMove(candidate)} - ${candidate.scoreLabel || formatNumber(candidate.score)}; wait ${formatSeconds(candidate.waitSeconds)}`
    ))
  ].join('\n');
}

function formatMathDetails(analysis) {
  const engine = analysis.engine;
  const model = engine?.model;

  if (!engine?.plan || !model) {
    return 'No planner math is available yet.';
  }

  const topOptions = (engine.rankedChoices || [])
    .slice(0, 10)
    .map((candidate, index) => formatOptionMath(candidate, index, analysis.options))
    .join('\n\n');
  const ascensionRoutePool = [
    ...(engine.ascensionPlan?.routes || []),
    ...(engine.plan.routes || [])
  ];
  const ascensionRoutes = topAscensionRoutes(ascensionRoutePool)
    .slice(0, 10)
    .map((route, index) => formatAscensionRouteMath(route, index, analysis.options))
    .join('\n\n');
  const ascensionPlanLine = engine.ascensionPlan
    ? `Ascension recovery search: ${engine.ascensionPlan.routeCount} routes, beam width ${engine.ascensionPlan.beamWidth}, max depth ${engine.ascensionPlan.maxDepth}`
    : 'Ascension recovery search: not run';

  return [
    'MATH INSPECTOR',
    `Objective: ${formatObjective(analysis.options.objective)}`,
    `Current cookies: ${formatNumber(analysis.state.cookies)}`,
    `Modeled income: ${formatNumber(engineIncomePerSecond(model))}/sec`,
    `Milk: ${formatNumber(model.milkProgress * 100)}%; kitten-sensitive multipliers owned: ${model.ownedKittenMilkFactors.length}`,
    model.goldenCookiesBlocked
      ? `Golden cookies blocked by: ${model.goldenCookieBlockers.join(', ') || 'live switch'}`
      : 'Golden cookies: available',
    analysis.baseline.label,
    `Planner: ${engine.plan.routeCount} routes, beam width ${engine.plan.beamWidth}, max depth ${engine.plan.maxDepth}`,
    ascensionPlanLine,
    '',
    'TOP 10 OPTIONS',
    topOptions || 'No positive options were modeled yet.',
    '',
    'ASCENSION-INCLUDING ROUTES',
    ascensionRoutes || 'No tested route includes ascension. Turn on Ascend and Ascension upgrades if you want those routes considered.'
  ].join('\n');
}

function topAscensionRoutes(routes) {
  return routes.filter(routeIncludesAscensionStep);
}

function routeIncludesAscensionStep(route) {
  return (route?.model?.history || []).some((step) => (
    step.actionType === 'ASCEND' ||
    step.actionType === 'BUY_ASCENSION_UPGRADE' ||
    step.actionType === 'REINCARNATE'
  ));
}

function formatOptionMath(candidate, index, options) {
  const move = candidate.noPurchase ? 'Buy nothing / wait' : formatCandidateMove(candidate);
  const lines = [
    `${index + 1}. ${move}`,
    `Score: ${candidate.scoreLabel || describeRouteScore(candidate.route, options)}`,
    candidate.noPurchase
      ? `Wait estimate: ${formatSeconds(candidate.waitSeconds)}`
      : `Cost: ${formatNumber(candidate.price)}; wait: ${formatSeconds(candidate.waitSeconds)}; payback: ${formatSeconds(candidate.paybackSeconds)}`,
    `Income: ${formatNumber(candidate.incomeBefore)}/sec -> ${formatNumber(candidate.incomeAfter)}/sec (${formatSignedNumber(candidate.incomeDelta)}/sec)`,
    candidate.reason ? `Reason: ${candidate.reason}` : '',
    formatRoutePath(candidate.route, options, 4)
  ];

  return lines.filter(Boolean).join('\n');
}

function formatAscensionRouteMath(route, index, options) {
  const history = route?.model?.history || [];
  const firstStep = history[0];
  const ascensionIndex = history.findIndex((step) => (
    step.actionType === 'ASCEND' ||
    step.actionType === 'BUY_ASCENSION_UPGRADE' ||
    step.actionType === 'REINCARNATE'
  ));
  const ascensionStep = ascensionIndex >= 0 ? history[ascensionIndex] : null;

  return [
    `${index + 1}. First move: ${firstStep ? formatStepMove(firstStep) : 'Buy nothing / wait'}`,
    `Score: ${describeRouteScore(route, options)}; utility ${formatNumber(route.utility || 0)}`,
    ascensionStep
      ? `Ascension part: step ${ascensionIndex + 1}/${history.length} - ${formatStepMove(ascensionStep)} at ${formatSeconds(ascensionStep.boughtAtSeconds)}`
      : '',
    `End state: ${formatRouteEndState(route, options)}; income ${formatNumber(engineIncomePerSecond(route.model))}/sec`,
    formatRoutePath(route, options, 6)
  ].filter(Boolean).join('\n');
}

function formatRoutePath(route, options, maxSteps) {
  const steps = route?.model?.history || [];
  if (!steps.length) {
    return `Route: no purchases; ${describeRouteScore(route, options)}.`;
  }

  const shown = steps.slice(0, maxSteps).map((step, index) => (
    `${index + 1}) ${formatStepMove(step)} after ${formatSeconds(step.waitSeconds)}; ` +
    `cost ${formatNumber(step.price)}; income ${formatNumber(step.incomeBefore)}/sec -> ${formatNumber(step.incomeAfter)}/sec`
  ));
  const hiddenCount = steps.length - shown.length;

  return [
    'Route:',
    ...shown.map((line) => `  ${line}`),
    hiddenCount > 0 ? `  ... ${hiddenCount} more step(s)` : ''
  ].filter(Boolean).join('\n');
}

function formatStepMove(step) {
  if (step.actionType === 'BUY_BUILDING') return `Buy building "${step.targetName}"`;
  if (step.actionType === 'BUY_UPGRADE') return `Buy upgrade "${step.targetName}"`;
  if (step.actionType === 'POP_WRINKLERS') return 'Pop wrinklers';
  if (step.actionType === 'COLLECT_SUGAR_LUMP') return 'Collect sugar lump';
  if (step.actionType === 'USE_SUGAR_LUMP') return `Spend sugar lump(s) on "${step.targetName}"`;
  if (step.actionType === 'ASCEND') return 'Ascend';
  if (step.actionType === 'BUY_ASCENSION_UPGRADE') return `Buy ascension upgrade "${step.targetName}"`;
  if (step.actionType === 'REINCARNATE') return 'Start next run';
  if (step.actionType === 'DO_ACHIEVEMENT_ACTION') return `Do achievement action for "${step.targetName}"`;
  return step.targetName ? `${step.actionType} "${step.targetName}"` : step.actionType;
}

function formatRouteEndState(route, options) {
  if (options.objective.type === 'target') {
    return Number.isFinite(route.secondsToTarget)
      ? `target in ${formatSeconds(route.secondsToTarget)}`
      : 'target not reached';
  }

  return `${formatNumber(route.projectedCookies)} cookies by deadline`;
}

function formatSignedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  return `${number >= 0 ? '+' : '-'}${formatNumber(Math.abs(number))}`;
}

function formatCandidateMove(candidate) {
  if (candidate.actionType === 'POP_WRINKLERS') return 'Pop wrinklers';
  if (candidate.actionType === 'COLLECT_SUGAR_LUMP') return 'Collect sugar lump';
  if (candidate.actionType === 'USE_SUGAR_LUMP') return `Spend sugar lump(s) on "${candidate.targetName}"`;
  if (candidate.actionType === 'ASCEND') return 'Ascend';
  if (candidate.actionType === 'BUY_ASCENSION_UPGRADE') return `Buy ascension upgrade "${candidate.targetName}"`;
  if (candidate.actionType === 'REINCARNATE') return 'Start next run';
  if (candidate.actionType === 'DO_ACHIEVEMENT_ACTION') return `Do achievement action for "${candidate.targetName}"`;

  return `${candidate.affordable ? 'Buy' : 'Save for'} ${candidate.kind} "${candidate.targetName}"`;
}

function formatExecutionMessage(analysis, execution, clickStats = {}) {
  const command = analysis.command;
  const prefix = execution?.ok ? 'EXECUTING' : 'SKIPPED';

  return [
    `${prefix}: ${formatActionLabel(command)}`,
    command.explanation,
    execution?.message || '',
    formatClickSummary(clickStats),
    `Objective: ${formatObjective(analysis.options.objective)}`
  ].filter(Boolean).join('\n').trim();
}

function formatActionLabel(command) {
  if (command.actionType === 'SAVE_UP') {
    return command.targetName ? `SAVING UP for ${command.targetName}` : 'SAVING UP';
  }

  if (command.actionType === 'WAIT') {
    return 'WAITING / BUYING NOTHING';
  }

  if (command.actionType === 'POP_WRINKLERS') {
    return 'POP_WRINKLERS';
  }

  if (command.actionType === 'COLLECT_SUGAR_LUMP') {
    return 'COLLECT_SUGAR_LUMP';
  }

  if (command.actionType === 'USE_SUGAR_LUMP') {
    return command.targetName ? `USE_SUGAR_LUMP on ${command.targetName}` : 'USE_SUGAR_LUMP';
  }

  if (command.actionType === 'ASCEND') {
    return 'ASCEND';
  }

  if (command.actionType === 'BUY_ASCENSION_UPGRADE') {
    return command.targetName ? `BUY_ASCENSION_UPGRADE ${command.targetName}` : 'BUY_ASCENSION_UPGRADE';
  }

  if (command.actionType === 'REINCARNATE') {
    return 'REINCARNATE';
  }

  if (command.actionType === 'DO_ACHIEVEMENT_ACTION') {
    return command.targetName ? `DO_ACHIEVEMENT_ACTION ${command.targetName}` : 'DO_ACHIEVEMENT_ACTION';
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
  if (options?.objective?.type) {
    return {
      strategy: String(options.strategy || 'balanced').trim() || 'balanced',
      objective: options.objective,
      allowAchievementActions: options.allowAchievementActions !== false,
      allowWrinklers: options.allowWrinklers !== false,
      allowSugarLumpCollect: options.allowSugarLumpCollect !== false,
      allowSugarLumpSpend: options.allowSugarLumpSpend !== false,
      allowAscension: options.allowAscension !== false,
      allowAscensionUpgrades: options.allowAscensionUpgrades !== false
    };
  }

  const timeGoal = String(options.timeGoal || '').trim();
  const targetGoal = String(options.targetGoal || '').trim();

  if (timeGoal && targetGoal) {
    throw new Error('Use either a time goal or a cookie target, not both.');
  }

  return {
    strategy: String(options.strategy || 'balanced').trim() || 'balanced',
    allowAchievementActions: options.allowAchievementActions !== false,
    allowWrinklers: options.allowWrinklers !== false,
    allowSugarLumpCollect: options.allowSugarLumpCollect !== false,
    allowSugarLumpSpend: options.allowSugarLumpSpend !== false,
    allowAscension: options.allowAscension !== false,
    allowAscensionUpgrades: options.allowAscensionUpgrades !== false,
    objective: targetGoal
      ? { type: 'target', targetCookies: parseCookieAmount(targetGoal), raw: targetGoal }
      : { type: 'maximize', horizonSeconds: parseDuration(timeGoal || '10m'), raw: timeGoal || '10m' }
  };
}

function parseDuration(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return 600;

  const colon = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const hours = Number(colon[1]) || 0;
    const minutes = Number(colon[2]) || 0;
    const seconds = Number(colon[3]) || 0;
    return Math.max(1, (hours * 3600) + (minutes * 60) + seconds);
  }

  let total = 0;
  const pattern = /([\d.]+)\s*(d|day|days|h|hr|hour|hours|m|min|minute|minutes|s|sec|second|seconds)/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value)) continue;

    if (unit.startsWith('d')) total += value * 86400;
    else if (unit.startsWith('h')) total += value * 3600;
    else if (unit === 'm' || unit.startsWith('min')) total += value * 60;
    else total += value;
  }

  if (total > 0) {
    return Math.max(1, total);
  }

  const numericMinutes = Number(text);
  if (Number.isFinite(numericMinutes) && numericMinutes > 0) {
    return numericMinutes * 60;
  }

  throw new Error(`Could not read time goal "${input}". Try "10m", "1h 30m", or "2d".`);
}

function parseCookieAmount(input) {
  const text = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\s*cookies?$/, '');
  if (!text) {
    throw new Error('Cookie target is empty.');
  }

  const direct = Number(text);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const match = text.match(/^([\d.]+)\s*([a-z]+)$/);
  if (!match) {
    throw new Error(`Could not read cookie target "${input}". Try "1 trillion" or "1e12".`);
  }

  const value = Number(match[1]);
  const suffix = match[2];
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Could not read cookie target "${input}".`);
  }

  const multipliers = {
    k: 1e3,
    thousand: 1e3,
    m: 1e6,
    million: 1e6,
    b: 1e9,
    billion: 1e9,
    t: 1e12,
    trillion: 1e12,
    qa: 1e15,
    quadrillion: 1e15,
    qi: 1e18,
    quintillion: 1e18,
    sx: 1e21,
    sextillion: 1e21,
    sp: 1e24,
    septillion: 1e24,
    oc: 1e27,
    octillion: 1e27,
    no: 1e30,
    nonillion: 1e30,
    dc: 1e33,
    decillion: 1e33,
    ud: 1e36,
    undecillion: 1e36,
    dd: 1e39,
    duodecillion: 1e39,
    td: 1e42,
    tredecillion: 1e42,
    qd: 1e45,
    quattuordecillion: 1e45,
    qid: 1e48,
    quindecillion: 1e48,
    sd: 1e51,
    sexdecillion: 1e51,
    spd: 1e54,
    septendecillion: 1e54,
    od: 1e57,
    octodecillion: 1e57,
    nd: 1e60,
    novemdecillion: 1e60,
    vg: 1e63,
    vigintillion: 1e63
  };

  const multiplier = multipliers[suffix];
  if (!multiplier) {
    throw new Error(`Unknown cookie target suffix "${suffix}".`);
  }

  return value * multiplier;
}

function formatObjective(objective) {
  if (objective.type === 'target') {
    return `reach ${formatNumber(objective.targetCookies)} cookies`;
  }

  return `maximize cookies after ${formatSeconds(objective.horizonSeconds)}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  if (Math.abs(number) < 1000) return number.toFixed(number >= 100 ? 0 : 2).replace(/\.?0+$/, '');

  const units = [
    ['', 1],
    ['thousand', 1e3],
    ['million', 1e6],
    ['billion', 1e9],
    ['trillion', 1e12],
    ['quadrillion', 1e15],
    ['quintillion', 1e18],
    ['sextillion', 1e21],
    ['septillion', 1e24],
    ['octillion', 1e27],
    ['nonillion', 1e30],
    ['decillion', 1e33],
    ['undecillion', 1e36],
    ['duodecillion', 1e39],
    ['tredecillion', 1e42],
    ['quattuordecillion', 1e45],
    ['quindecillion', 1e48],
    ['sexdecillion', 1e51],
    ['septendecillion', 1e54],
    ['octodecillion', 1e57],
    ['novemdecillion', 1e60],
    ['vigintillion', 1e63]
  ];

  let chosen = units[0];
  for (const unit of units) {
    if (Math.abs(number) >= unit[1]) {
      chosen = unit;
    }
  }

  const scaled = number / chosen[1];
  return `${scaled.toFixed(scaled >= 100 ? 1 : 2).replace(/\.?0+$/, '')} ${chosen[0]}`.trim();
}

function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds <= 0) return 'now';

  const rounded = Math.ceil(seconds);
  const days = Math.floor(rounded / 86400);
  const hours = Math.floor((rounded % 86400) / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  const parts = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || !parts.length) parts.push(`${secs}s`);

  return parts.slice(0, 3).join(' ');
}
