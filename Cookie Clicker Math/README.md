# Cookie Math Commander

This is the deterministic/math version of the Cookie Clicker commander.

## Current version

- Reads the live Cookie Clicker `Game` object from the page.
- Detects Cookie Clicker by checking for `Game`, `Game.ObjectsById`, `Game.Upgrades`, and live cookie values.
- Supports Advice Mode and Commander Mode.
- Adds a Math Editor popup tab showing detailed math for the top 10 planner options and the best tested routes that include ascension steps.
- Supports one objective at a time:
  - maximize cookies after a time horizon, such as `10m`, `1h 30m`, or `2d`
  - reach a cookie target, such as `1 trillion`, `1e12`, or `1 quadrillion cookies`
- Auto-clicks the big cookie at about 44 clicks per second.
- Checks `Game.cookieClicks` before pursuing Neverclick/True Neverclick; if the current click count is already over the limit, it ignores that achievement for this ascension, and if the achievement is still possible, it disables the big-cookie auto-clicker instead of ruining it.
- Clicks visible golden cookies.
- Sends the ascend command once, disables clicking, and waits for Cookie Clicker's legacy-screen transition before trying ascension-screen actions.
- Runs a deterministic beam-search math planner over visible buildings and upgrades.
- Models passive CpS, auto-click income, building price scaling, upgrade multipliers, click upgrades, discounts, kitten milk factors, and progression value.
- Models normal achievements as +4% milk and applies the resulting multiplicative kitten CpS gain when kitten upgrades are owned.
- Detects Golden switch-style golden-cookie blocking and ignores golden-cookie achievements/frequency upgrades while golden cookies cannot spawn.

## Live game data vs JSON

The extension can read a lot directly from Cookie Clicker:

- current cookies
- current CpS
- buildings, owned amounts, next prices, and live per-building CpS
- visible upgrades and prices
- golden cookies currently on screen
- wrinklers and swallowed cookies
- milk, prestige, and visible ascension gain
- active temporary state like frenzy values
- bought upgrades and switch state, including Golden switch and kitten upgrades

That is enough for a practical optimizer.

For a near-perfect optimizer, JSON/model data is still better for exact rules:

- exact upgrade effects
- heavenly upgrade effects and costs
- unlock requirements
- building synergy formulas
- seasonal effects
- golden cookie expected values
- wrinkler strategy
- ascension planning

The first version uses live game data plus upgrade-description heuristics. A later version should add JSON rule tables for exact upgrade and ascension math.

## Math engine

The math engine lives in `background.js`.

- It converts the live game state into a simulation model.
- It generates candidate purchases from visible buildings and shop upgrades.
- It estimates each candidate's income effect from live CpS data and parsed upgrade descriptions.
- It simulates wait-then-buy routes using beam search.
- It runs a separate deeper ascension recovery search when Ascend is enabled, so ascension routes can be inspected beyond the normal short purchase horizon.
- It selects the first step of the route that best matches the chosen objective.
- It treats "buy nothing until the goal/deadline" as a real route, so it can intentionally wait instead of forcing a purchase.
- It treats saving up for unaffordable visible purchases as normal candidate routes.
- Short, Balanced, and Long profiles change the search depth and breadth.
- Optional action toggles allow achievement-driven actions, wrinkler popping, sugar lump collection, sugar lump spending, ascension, heavenly upgrade purchases, and reincarnation into the next run.

Riskier actions are controlled from the popup:

- `Milk achievements` lets the planner value actions that can unlock normal achievements for milk.
- `Pop wrinklers` allows popping active wrinklers when the route or achievements justify it.
- `Collect lumps` allows harvesting ripe sugar lumps.
- `Spend lumps` allows using sugar lumps to level buildings.
- `Ascend` allows entering the legacy screen when the route justifies a reset.
- `Ascension upgrades` allows buying heavenly upgrades and starting the next run from the legacy screen.

The engine recalculates after every Commander tick, so newly unlocked upgrades/buildings are picked up from the live game rather than predicted far ahead.

## Added wiki source JSON

The supplied Cookie Clicker Wiki text exports were converted into JSON source files in `data/wiki_sources/`.

- `index.json` lists every converted page.
- Each topic file keeps detected metadata, article lines, section groups, and tab-separated table rows.
- These files are reference/source data for the future exact math model; they are not yet guaranteed formula tables.
