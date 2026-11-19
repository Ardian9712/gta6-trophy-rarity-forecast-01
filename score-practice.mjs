// SPDX-License-Identifier: MIT
// Evaluation only: hypothetical rounded refresh rates, never a training target.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const [kitArgument, oldReference] = process.argv.slice(2);
if (!kitArgument || !oldReference) {
  throw new Error('Usage: node score-practice.mjs <kit-directory> <old-commit>');
}
const kit = path.resolve(kitArgument);
const work = path.join(root, 'out', 'first-refresh-comparison');
const beforePlayers = 638;
const afterPlayers = 3_868;
const refresh = Date.parse('2026-11-19T04:30:00Z');
const hour = 3_600_000;
const require = createRequire(import.meta.url);
fs.mkdirSync(work, { recursive: true });

function gitText(arguments_) {
  const command = spawnSync('git', arguments_, { cwd: root, encoding: 'utf8' });
  assert.ifError(command.error);
  assert.equal(command.status, 0, command.stderr);
  return command.stdout;
}

const oldCommit = gitText(['rev-parse', '--verify', `${oldReference}^{commit}`]).trim();
const oldSource = gitText(['show', `${oldCommit}:main.ts`]);
// An evaluation copy of this repository's own prior entry, kept under ignored out/.
const oldEntry = path.join(work, 'old-main.ts');
const newEntry = path.join(root, 'main.ts');
fs.writeFileSync(oldEntry, oldSource, 'utf8');
const oldImplementation = require(oldEntry);
const newImplementation = require(newEntry);
const practices = ['p00', 'p01'].map(id => JSON.parse(
  fs.readFileSync(path.join(kit, 'input', `${id}.in`), 'utf8')));

function execute(entry, input, output) {
  const environment = {
    ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output,
  };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_USE_ENV_PROXY;
  const started = performance.now();
  const processResult = spawnSync(process.execPath, [entry], {
    cwd: root, env: environment, encoding: 'utf8', timeout: 8_000,
    maxBuffer: 1_048_576,
  });
  const runtime = performance.now() - started;
  assert.ifError(processResult.error);
  assert.equal(processResult.status, 0, processResult.stderr || processResult.stdout);
  assert.ok(runtime < 8_000, 'forecast exceeded the runtime budget');
  return runtime;
}

function readForecast(directory, example) {
  const filename = path.join(directory, `${example.id}.out`);
  assert.ok(fs.lstatSync(filename).isFile());
  const bytes = fs.readFileSync(filename);
  assert.ok(bytes.length <= 65_536);
  const result = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(result), ['trophies']);
  assert.equal(result.trophies.length, example.trophies.length);
  const identifiers = new Set(example.trophies.map(trophy => trophy.id));
  for (const row of result.trophies) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'q']);
    assert.ok(identifiers.delete(row.id), 'duplicate or unknown trophy');
    assert.equal(row.q.length, example.levels.length);
    row.q.forEach((value, index) => {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
      if (index) assert.ok(value >= row.q[index - 1]);
    });
  }
  assert.equal(identifiers.size, 0);
  return { result, bytes };
}

function logit(percent) {
  const safe = Math.min(99.99, Math.max(0.01, percent));
  return Math.log(safe / (100 - safe));
}

function evaluate(example, forecast, truth) {
  const rows = new Map(forecast.trophies.map(row => [row.id, row.q]));
  let totalLoss = 0;
  let absoluteMedianMiss = 0;
  let covered = 0;
  let items = 0;
  example.trophies.forEach((trophy, index) => {
    const q = rows.get(trophy.id);
    const answer = truth[index];
    example.levels.forEach((tau, position) => {
      const difference = logit(answer) - logit(q[position]);
      totalLoss += 2 * Math.max(tau * difference, (tau - 1) * difference);
      items++;
    });
    absoluteMedianMiss += Math.abs(answer - q[2]);
    if (q[0] <= answer && answer <= q[q.length - 1]) covered++;
  });
  return { totalLoss, absoluteMedianMiss, covered, items,
    trophies: example.trophies.length };
}

function metrics(totals) {
  return {
    loss: totals.totalLoss / totals.items,
    typical_miss_pp: totals.absoluteMedianMiss / totals.trophies,
    coverage: totals.covered / totals.trophies,
    covered: totals.covered, trophies: totals.trophies,
  };
}

function aggregate(totals) {
  return metrics(totals.reduce((sum, value) => {
    for (const key of Object.keys(sum)) sum[key] += value[key];
    return sum;
  }, { totalLoss: 0, absoluteMedianMiss: 0, covered: 0, items: 0, trophies: 0 }));
}

function comparison(oldMetrics, newMetrics) {
  return {
    old: oldMetrics, new: newMetrics,
    delta_new_minus_old: {
      loss: newMetrics.loss - oldMetrics.loss,
      typical_miss_pp: newMetrics.typical_miss_pp - oldMetrics.typical_miss_pp,
      coverage: newMetrics.coverage - oldMetrics.coverage,
    },
  };
}

// Check the score's scale against the worked two-trophy example in RULES.txt.
const workedCase = { levels: practices[0].levels, trophies: [{ id: 1 }, { id: 2 }] };
const workedForecast = { trophies: workedCase.trophies.map(trophy => ({
  id: trophy.id, q: [10, 15, 20, 25, 35],
})) };
assert.equal(metrics(evaluate(workedCase, workedForecast, [22, 8])).loss.toFixed(6),
  '0.403404');

const practiceInput = path.join(kit, 'input');
const oldOutput = path.join(work, 'practice-old');
const newOutput = path.join(work, 'practice-new');
const runtimes = {
  old_practice_ms: execute(oldEntry, practiceInput, oldOutput),
  new_practice_ms: execute(newEntry, practiceInput, newOutput),
};
const oldTotals = [];
const newTotals = [];
const byCase = [];
for (const example of practices) {
  assert.equal(oldImplementation.collapsePages(example).length, 1);
  const last = example.history[example.history.length - 1];
  assert.equal(last.players_tracked, beforePlayers);
  // The documented 100% onboarding exception stays 100%, as in verify.mjs.
  // All other earned counts are preserved; answering rates are rounded to 2 decimals.
  const hypothesis = last.rates.map(rate => rate === 100 ? 100
    : Math.round(rate * beforePlayers / afterPlayers * 100) / 100);
  const oldForecast = readForecast(oldOutput, example).result;
  const newForecast = readForecast(newOutput, example).result;
  const previous = evaluate(example, oldForecast, hypothesis);
  const current = evaluate(example, newForecast, hypothesis);
  oldTotals.push(previous);
  newTotals.push(current);
  const oldRows = new Map(oldForecast.trophies.map(row => [row.id, row.q]));
  const largestMedianMove = Math.max(...newForecast.trophies.map(row =>
    Math.abs(row.q[2] - oldRows.get(row.id)[2])));
  byCase.push({ id: example.id, ...comparison(metrics(previous), metrics(current)),
    maximum_median_change_pp: largestMedianMove });
}

const base = practices[0];
const release = Date.parse(base.game.release_date);
const baseRates = base.history[base.history.length - 1].rates;
const iso = timestamp => new Date(timestamp).toISOString();
const roundRate = rate => Math.round(rate * 100) / 100;

function observation(timestamp, players, rates) {
  return { at: iso(timestamp), slot: iso(timestamp), players_tracked: players,
    trophies_earned: Math.round(rates.reduce((sum, rate) => sum + rate, 0) * players / 100),
    rates: rates.slice() };
}

function fixture(id, checkpoint, target, history) {
  return {
    schema: base.schema, id, at: iso(checkpoint), target: iso(target),
    horizon_minutes: (target - checkpoint) / 60_000, levels: base.levels.slice(),
    game: { name: 'Authored synthetic refresh fixture', platform: 'PS5',
      release_date: base.game.release_date, source: 'https://example.invalid/fixture' },
    trophies: base.trophies.map(trophy => ({ id: trophy.id, tier: trophy.tier,
      points: trophy.points, secret: false, name: `Synthetic trophy ${trophy.id}`,
      description: 'Synthetic test objective.' })),
    history, notes: 'Artificial test data; not a target answer.',
  };
}

const flatRead = observation(release + 2 * hour, beforePlayers, baseRates);
// The artificial count jump deliberately exercises nontrivial rolling calibration.
const batchHours = [-1 / 6, 4.5, 12, 24, 36, 48, 58];
const batchPlayers = [beforePlayers, afterPlayers, 6_500, 12_000, 17_000, 22_000, 26_500];
const pollHours = [-1 / 6, ...Array.from({ length: 118 }, (_, index) => index / 2)];
const richHistory = pollHours.map(time => {
  let batch = 0;
  for (let index = 1; index < batchHours.length; index++) {
    if (batchHours[index] <= time) batch = index;
  }
  const players = batchPlayers[batch];
  const rates = baseRates.map(rate => rate === 100 ? 100
    : roundRate(rate * beforePlayers / players * (batch === 0 ? 1 : 30)));
  return observation(release + time * hour, players, rates);
});
const finalShape = fixture('s-final-multi', Date.parse('2026-11-21T11:30:00Z'),
  Date.parse('2026-11-26T00:00:00Z'), richHistory);
const nonTriggerCases = [
  finalShape,
  fixture('u-target-before-window', release + 3 * hour, release + 4 * hour, [flatRead]),
  fixture('v-checkpoint-at-window', refresh, release + 5 * hour, [flatRead]),
  fixture('w-checkpoint-after-window', release + 5 * hour, release + 6 * hour, [flatRead]),
  fixture('x-early-multi', release + 3 * hour, refresh, [flatRead,
    observation(release + 2.5 * hour, afterPlayers, baseRates.map(rate =>
      rate === 100 ? 100 : roundRate(rate * beforePlayers / afterPlayers)))]),
];
const eligibleCases = [
  fixture('y-late-flat-refresh', release + 3 * hour, refresh, [flatRead]),
  fixture('z-late-flat-after-refresh', release + 3 * hour, release + 5 * hour, [flatRead]),
];
const syntheticInput = path.join(work, 'synthetic-input');
const syntheticOld = path.join(work, 'synthetic-old');
const syntheticNew = path.join(work, 'synthetic-new');
fs.mkdirSync(syntheticInput, { recursive: true });
for (const example of [...nonTriggerCases, ...eligibleCases]) {
  fs.writeFileSync(path.join(syntheticInput, `${example.id}.in`), JSON.stringify(example) + '\n');
}
runtimes.old_synthetic_ms = execute(oldEntry, syntheticInput, syntheticOld);
runtimes.new_synthetic_ms = execute(newEntry, syntheticInput, syntheticNew);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const identityChecks = nonTriggerCases.map(example => {
  const previous = readForecast(syntheticOld, example);
  const current = readForecast(syntheticNew, example);
  assert.ok(previous.bytes.equals(current.bytes), `${example.id}: trigger leaked`);
  return { id: example.id, distinct_pages: oldImplementation.collapsePages(example).length,
    byte_identical: true, sha256: digest(current.bytes) };
});
const finalPages = oldImplementation.collapsePages(finalShape);
assert.ok(finalPages.length >= 2);
const calibration = oldImplementation.historicalCalibration(finalShape.trophies,
  finalPages, release);
assert.ok(calibration.global > 1, 'fixture did not exercise widened historical calibration');

for (const example of eligibleCases) {
  const pages = newImplementation.collapsePages(example);
  const target = Date.parse(example.target);
  const model = newImplementation.buildModel(example.trophies, pages, release,
    target, Date.parse(example.at));
  const anchorPages = [{ ...pages[0], epoch: refresh, firstSeen: refresh,
    lastSeen: refresh, players: afterPlayers }];
  const normalContinuation = oldImplementation.buildModel(example.trophies,
    anchorPages, release, target);
  assert.equal(model.projectedPlayers, normalContinuation.projectedPlayers,
    'anticipated denominator did not use the old normal post-refresh growth');
  assert.equal(model.playerLogSd, normalContinuation.playerLogSd,
    'denominator uncertainty was not anchored at the refresh');
  if (target === refresh) {
    assert.equal(model.projectedPlayers, afterPlayers);
    assert.equal(model.playerLogSd, 0);
  }
  assert.ok(!readForecast(syntheticOld, example).bytes
    .equals(readForecast(syntheticNew, example).bytes), 'eligible trigger did not fire');
}

const combined = comparison(aggregate(oldTotals), aggregate(newTotals));
const report = {
  hypothesis: 'Approximate: preserve earned counts except the documented 100% trophy; '
    + 'change denominator 638 to 3868; round rates to two decimals. Not server answers.',
  old_commit: oldCommit, new_source_sha256: digest(fs.readFileSync(newEntry)),
  runtime: process.version, available_parallelism: availableParallelism(),
  scores: { combined, by_case: byCase },
  new_beats_old_on_hypothesis: combined.delta_new_minus_old.loss < 0,
  runtimes_ms: runtimes,
  non_trigger_checks: identityChecks,
  synthetic_final: { distinct_pages: finalPages.length, byte_identical: true,
    rolling_calibration_global: calibration.global },
  eligible_anchor_and_continuation_checks: 'PASS',
};
fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const rounded = number => Number(number.toFixed(6));
console.log(`Node ${process.version}; ${availableParallelism()} available CPU(s)`);
console.log(report.hypothesis);
console.table([...byCase, { id: 'combined', ...combined }].map(row => ({
  case: row.id, old_loss: rounded(row.old.loss), new_loss: rounded(row.new.loss),
  loss_delta: rounded(row.delta_new_minus_old.loss),
  old_typical_miss_pp: rounded(row.old.typical_miss_pp),
  new_typical_miss_pp: rounded(row.new.typical_miss_pp),
  old_coverage: row.old.coverage, new_coverage: row.new.coverage,
})));
console.log(`New beats old on this hypothesis: ${report.new_beats_old_on_hypothesis}`);
console.log(`Non-trigger byte identity: PASS (${identityChecks.length}/${identityChecks.length})`);
console.log(`Synthetic final: ${finalPages.length} distinct pages, byte-identical outputs`);
console.log('Eligible refresh anchor and normal continuation: PASS');
console.log('Runtimes (ms):', JSON.stringify(runtimes));
console.log('Report: out/first-refresh-comparison/report.json');
