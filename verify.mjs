// SPDX-License-Identifier: MIT
// Independent contract checks and model sanity checks; never reads an answer.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repository = path.dirname(fileURLToPath(import.meta.url));
const kit = path.resolve(process.argv[2] || path.join(homedir(), 'workspace', 'makefun',
  'gta6-trophy-rarity-forecast-01-kit', 'gta6-trophy-rarity-forecast-01-kit'));
const input = path.join(kit, 'input');
const output = path.join(repository, 'out');
const require = createRequire(import.meta.url);
const implementation = require(path.join(repository, 'main.ts'));
const rounded = number => Math.round(number * 1_000_000) / 1_000_000;

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const location = (sorted.length - 1) * probability;
  const lower = Math.floor(location);
  const upper = Math.ceil(location);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (location - lower);
}

function scoreOdds(percent) {
  const safePercent = Math.max(0.01, Math.min(99.99, percent));
  return Math.log(safePercent / (100 - safePercent));
}

function runProgram(entrypoint, source, destination) {
  const start = performance.now();
  const childEnvironment = {
    ...process.env, MAKEFUN_INPUT_DIR: source, MAKEFUN_OUTPUT_DIR: destination,
  };
  // Match the plain grader runtime rather than host-injected Node preloads.
  delete childEnvironment.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [entrypoint], {
    cwd: repository,
    env: childEnvironment,
    encoding: 'utf8', timeout: 8_000, maxBuffer: 1_048_576,
  });
  const milliseconds = performance.now() - start;
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout || 'nonzero child exit');
  assert.ok(milliseconds < 8_000, `runtime ${milliseconds}ms exceeds the limit`);
  return rounded(milliseconds);
}

function validateForecast(bytes, example) {
  assert.ok(bytes.length <= 65_536, `${example.id}: output too large`);
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text, 'utf8').equals(bytes), `${example.id}: invalid UTF-8`);
  const forecast = JSON.parse(text);
  assert.deepEqual(Object.keys(forecast), ['trophies']);
  assert.equal(forecast.trophies.length, example.trophies.length);
  const expected = new Set(example.trophies.map(trophy => trophy.id));
  for (const row of forecast.trophies) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'q']);
    assert.ok(expected.delete(row.id), `${example.id}: duplicate or unknown id ${row.id}`);
    assert.ok(Array.isArray(row.q));
    assert.equal(row.q.length, 5);
    row.q.forEach((number, index) => {
      assert.ok(Number.isFinite(number) && number >= 0 && number <= 100,
        `${example.id}/${row.id}: out-of-range quantile`);
      if (index > 0) assert.ok(number >= row.q[index - 1],
        `${example.id}/${row.id}: crossed quantiles`);
    });
  }
  assert.equal(expected.size, 0, `${example.id}: missing trophies`);
  return forecast;
}

function loadOutput(directory, example) {
  const filename = path.join(directory, `${example.id}.out`);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  const bytes = fs.readFileSync(filename);
  return { bytes, forecast: validateForecast(bytes, example) };
}

function summarize(example, forecast, starter) {
  const starterRows = new Map(starter.trophies.map(row => [row.id, row]));
  const rows = new Map(forecast.trophies.map(row => [row.id, row]));
  const last = example.history[example.history.length - 1];
  const moves = [];
  const baselineMoves = [];
  const widths = [];
  const logitWidths = [];
  const details = [];
  let below = 0;
  let equal = 0;
  let above = 0;
  let coveredScenario = 0;
  const hypotheticalGrowth = 3_868 / 638;
  example.trophies.forEach((trophy, index) => {
    const row = rows.get(trophy.id);
    const baseline = starterRows.get(trophy.id);
    const observed = last.rates[index];
    const move = row.q[2] - observed;
    const baselineMove = row.q[2] - baseline.q[2];
    const width = row.q[4] - row.q[0];
    moves.push(move);
    baselineMoves.push(baselineMove);
    widths.push(width);
    logitWidths.push(scoreOdds(row.q[4]) - scoreOdds(row.q[0]));
    if (move < -1e-9) below++;
    else if (move > 1e-9) above++;
    else equal++;
    // This mechanism-only scenario is explicitly NOT an observed answer.
    const hypothetical = observed === 100 ? 100 : observed / hypotheticalGrowth;
    if (row.q[0] <= hypothetical && hypothetical <= row.q[4]) coveredScenario++;
    details.push({
      case: example.id, id: trophy.id, name: trophy.name, tier: trophy.tier,
      last: observed, starterMedian: baseline.q[2], median: row.q[2],
      moveVsLast: rounded(move), moveVsStarter: rounded(baselineMove),
      q05: row.q[0], q25: row.q[1], q75: row.q[3], q95: row.q[4],
      bandWidth: rounded(width),
    });
  });
  const pages = implementation.collapsePages(example);
  const model = implementation.buildModel(example.trophies, pages,
    Date.parse(example.game.release_date), Date.parse(example.target));
  const mean = values => values.reduce((sum, number) => sum + number, 0) / values.length;
  return {
    summary: {
      id: example.id, rows: details.length, distinct_pages: pages.length,
      median_direction: { below, unchanged: equal, above },
      median_move_vs_last_pp: rounded(quantile(moves, 0.5)),
      mean_move_vs_last_pp: rounded(mean(moves)),
      median_move_vs_starter_pp: rounded(quantile(baselineMoves, 0.5)),
      mean_absolute_move_vs_starter_pp: rounded(mean(baselineMoves.map(Math.abs))),
      median_90_band_width_pp: rounded(quantile(widths, 0.5)),
      mean_90_band_width_pp: rounded(mean(widths)),
      median_90_band_width_logit: rounded(quantile(logitWidths, 0.5)),
      hypothetical_count_preserving_refresh_in_band: `${coveredScenario}/${details.length}`,
      modeled_player_growth_factor: rounded(model.projectedPlayers / model.latest.players),
      modeled_players_at_target: rounded(model.projectedPlayers),
    }, details,
  };
}

function syntheticCase(identifier, horizonMinutes) {
  const launch = Date.parse('2026-11-19T00:00:00Z');
  const checkpoint = launch + 59.5 * 3_600_000;
  const tiers = { platinum: 300, gold: 90, silver: 30, bronze: 15 };
  const trophies = Array.from({ length: 55 }, (_, index) => {
    const id = index + 1;
    const tier = id === 1 ? 'platinum' : id === 3 || id === 4 ? 'gold'
      : id >= 5 && id <= 10 ? 'silver' : 'bronze';
    return { id, tier, points: tiers[tier], name: `Fixture trophy ${id}`,
      description: `Earn fixture objective ${id}.`, secret: id % 2 === 0 };
  });
  const batches = [
    { hour: -1 / 6, players: 638 }, { hour: 4.5, players: 3_868 },
    { hour: 12, players: 6_500 }, { hour: 24, players: 12_000 },
    { hour: 36, players: 17_000 }, { hour: 48, players: 22_000 },
    { hour: 58, players: 26_500 },
  ];
  const times = [-1 / 6, ...Array.from({ length: 118 }, (_, index) => index / 2)];
  const history = times.map(hour => {
    let batchIndex = 0;
    for (let index = 1; index < batches.length; index++) {
      if (batches[index].hour <= hour) batchIndex = index;
    }
    const batch = batches[batchIndex];
    const rates = trophies.map(trophy => {
      if (trophy.id === 2) return 100;
      if (trophy.id === 3) return 0;
      if (trophy.id === 5 && batchIndex < 2) return null;
      if (trophy.id === 6 && batchIndex === batches.length - 1) return null;
      const initialCount = trophy.id === 4 ? 350 : trophy.id === 55 ? 1 : 6 + trophy.id % 9;
      const elasticity = trophy.id === 4 ? 0.32 : 0.18 + (trophy.id % 4) * 0.04;
      const count = Math.floor(initialCount * (batch.players / 638) ** elasticity);
      return Math.round(10_000 * count / batch.players) / 100;
    });
    const slot = new Date(launch + hour * 3_600_000).toISOString();
    return { slot, at: new Date(Date.parse(slot) + 250).toISOString(),
      players_tracked: batch.players,
      trophies_earned: Math.round(rates.reduce((sum, rate) => sum + (rate || 0), 0)
        * batch.players / 100), rates };
  });
  return {
    schema: 'makefun/gta6-trophies-case/v1', id: identifier,
    at: new Date(checkpoint).toISOString(), horizon_minutes: horizonMinutes,
    target: new Date(checkpoint + horizonMinutes * 60_000).toISOString(),
    levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    game: { name: 'Synthetic release', platform: 'PS5', release_date: '2026-11-19',
      source: 'https://example.invalid/synthetic-fixture' },
    trophies, history, notes: 'Authored synthetic fixture, not an answering case.',
  };
}

function checkSyntheticHistory() {
  const source = path.join(output, 'synthetic-input');
  const destination = path.join(output, 'synthetic-output');
  fs.mkdirSync(source, { recursive: true });
  const short = syntheticCase('a-boundaries', 90);
  const far = syntheticCase('z-week-horizon', 6_510);
  fs.writeFileSync(path.join(source, `${short.id}.in`), JSON.stringify(short) + '\n');
  fs.writeFileSync(path.join(source, `${far.id}.in`), JSON.stringify(far) + '\n');
  fs.writeFileSync(path.join(source, 'NOTICE.txt'), 'Ignore this authored non-case file.\n');
  const runtime = runProgram(path.join(repository, 'main.ts'), source, destination);
  const shortOutput = loadOutput(destination, short);
  const farOutput = loadOutput(destination, far);
  assert.equal(fs.readdirSync(destination).filter(name => name.endsWith('.out')).length, 2);
  const rows = new Map(farOutput.forecast.trophies.map(row => [row.id, row]));
  assert.equal(rows.get(2).q[2], 100, '100% onboarding median should remain 100%');
  assert.ok(rows.get(2).q[0] > 99.9);
  assert.deepEqual(rows.get(3).q.slice(0, 3), [0, 0, 0]);
  assert.ok(rows.get(3).q[4] < 0.5, 'zero-rate upper tail should remain near zero');
  assert.ok(rows.get(6).q[2] > 0, 'missing latest rate should use its earlier observation');
  assert.ok(rows.get(55).q[2] < 0.01, 'scoring-floor trophy should still be able to dilute');

  const pages = implementation.collapsePages(far);
  assert.equal(pages.length, 7, 'repeated polls should collapse to seven refresh states');
  const calibration = implementation.historicalCalibration(far.trophies, pages,
    Date.parse(far.game.release_date));
  assert.ok(calibration.folds >= 3, 'history-only rolling calibration was not exercised');
  const commonModel = target => implementation.buildModel(far.trophies, pages,
    Date.parse(far.game.release_date), Date.parse(target));
  assert.ok(implementation.trophyDistribution(commonModel(far.target), 0).sd
    > implementation.trophyDistribution(commonModel(short.target), 0).sd,
  'long horizon should have a wider logit spread');

  const latest = far.history[far.history.length - 1];
  const eligible = far.trophies.filter((trophy, index) => latest.rates[index] > 0
    && latest.rates[index] < 100);
  const below = eligible.filter(trophy => rows.get(trophy.id).q[2]
    < latest.rates[trophy.id - 1]).length;
  assert.ok(below / eligible.length >= 0.9, 'long-horizon dilution direction failed');

  const duplicate = structuredClone(far);
  duplicate.history.push({ ...structuredClone(latest),
    at: new Date(Date.parse(far.at) - 60_000).toISOString(),
    slot: new Date(Date.parse(far.at) - 60_000).toISOString() });
  assert.equal(JSON.stringify(implementation.makeForecast(duplicate)),
    JSON.stringify(farOutput.forecast), 'extra unchanged poll inflated confidence');

  const future = structuredClone(far);
  future.history.push({ ...structuredClone(latest), at: far.target, slot: far.target,
    players_tracked: 1_000_000_000, rates: Array(55).fill(100) });
  assert.equal(JSON.stringify(implementation.makeForecast(future)),
    JSON.stringify(farOutput.forecast), 'post-checkpoint record affected the forecast');
  validateForecast(shortOutput.bytes, short);
  return { valid_cases: 2, distinct_refreshes: pages.length,
    rolling_calibration_epochs: calibration.folds,
    runtime_ms: runtime, zero_and_100_boundaries: 'PASS',
    missing_rates: 'PASS', scoring_floor_dilution: 'PASS', repeated_polls: 'PASS',
    post_checkpoint_exclusion: 'PASS', long_horizon_direction_and_spread: 'PASS' };
}

fs.mkdirSync(output, { recursive: true });
const examples = fs.readdirSync(input).filter(name => name.endsWith('.in')).sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(input, name), 'utf8')));
assert.deepEqual(examples.map(example => example.id), ['p00', 'p01']);
examples.forEach(example => assert.equal(example.trophies.length, 55));

const firstRuntime = runProgram(path.join(repository, 'main.ts'), input, output);
const first = new Map(examples.map(example => [example.id, loadOutput(output, example)]));
const secondRuntime = runProgram(path.join(repository, 'main.ts'), input, output);
const hashes = {};
for (const example of examples) {
  const rerun = loadOutput(output, example);
  assert.ok(first.get(example.id).bytes.equals(rerun.bytes),
    `${example.id}: repeated execution changed forecast bytes`);
  hashes[example.id] = createHash('sha256').update(rerun.bytes).digest('hex');
}
const starterOutput = path.join(output, 'starter');
const starterRuntime = runProgram(path.join(kit, 'starter', 'main.ts'), input, starterOutput);
const summaries = [];
const comparison = [];
for (const example of examples) {
  const starter = loadOutput(starterOutput, example);
  assert.ok(!first.get(example.id).bytes.equals(starter.bytes),
    `${example.id}: forecast is byte-identical to starter`);
  const result = summarize(example, first.get(example.id).forecast, starter.forecast);
  assert.ok(result.summary.median_direction.below >= 50,
    `${example.id}: medians do not reflect dilution`);
  assert.ok(result.summary.median_90_band_width_logit > 1,
    `${example.id}: refresh band is implausibly narrow`);
  assert.equal(result.summary.hypothetical_count_preserving_refresh_in_band, '55/55');
  summaries.push(result.summary);
  comparison.push(...result.details);
}
const synthetic = checkSyntheticHistory();
const report = {
  runtime: process.version, available_parallelism: availableParallelism(),
  main_runs_ms: [firstRuntime, secondRuntime],
  starter_run_ms: starterRuntime,
  validation: 'PASS: UTF-8 JSON, exact keys, 55 unique rows, five finite ordered 0–100 quantiles',
  deterministic: 'PASS: byte-identical second execution for both cases',
  sha256: hashes, cases: summaries, synthetic,
  scenario_notice: 'Hypothetical count-preserving refresh is not an answer or measured coverage.',
};
const columns = ['case', 'id', 'name', 'tier', 'last', 'starterMedian', 'median',
  'moveVsLast', 'moveVsStarter', 'q05', 'q25', 'q75', 'q95', 'bandWidth'];
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;
const csv = [columns.join(','), ...comparison.map(row => columns.map(column =>
  csvCell(row[column])).join(','))].join('\n') + '\n';
fs.writeFileSync(path.join(output, 'median-comparison.csv'), csv, 'utf8');
fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Runtime: ${process.version}`);
console.log(`CPU affinity: ${report.available_parallelism} available CPU(s)`);
console.log(report.validation);
console.log(report.deterministic);
console.log(`Main runs: ${firstRuntime}ms, ${secondRuntime}ms; starter: ${starterRuntime}ms`);
console.table(summaries.map(summary => ({
  case: summary.id, rows: summary.rows, below: summary.median_direction.below,
  median_move_pp: summary.median_move_vs_last_pp,
  mean_move_pp: summary.mean_move_vs_last_pp,
  typical_starter_move_pp: summary.median_move_vs_starter_pp,
  median_band_pp: summary.median_90_band_width_pp,
  mean_band_pp: summary.mean_90_band_width_pp,
  logit_band: summary.median_90_band_width_logit,
  hypothetical_refresh: summary.hypothetical_count_preserving_refresh_in_band,
})));
console.log('Synthetic checks:', JSON.stringify(synthetic));
console.log('SHA-256:', JSON.stringify(hashes));
console.log('Per-trophy comparison: out/median-comparison.csv (110 rows)');
console.log('Full verification report: out/verification.json');
console.log(report.scenario_notice);
