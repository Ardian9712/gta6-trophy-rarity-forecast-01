// SPDX-License-Identifier: MIT
// JavaScript-compatible TypeScript: executable on Node 22 without a build step.
// All observations, clocks, and calibration inputs come from the current case.
'use strict';

const filesystem = require('node:fs');
const paths = require('node:path');

const HOUR_MS = 3_600_000;
const PROBABILITIES = Object.freeze([0.05, 0.25, 0.5, 0.75, 0.95]);
const NORMAL_SCORES = Object.freeze([
  -1.6448536269514722, -0.6744897501960817, 0,
  0.6744897501960817, 1.6448536269514722,
]);
const TIER_ELASTICITIES = Object.freeze({
  platinum: 0.06, gold: 0.12, silver: 0.15, bronze: 0.24,
});
const SETTINGS = Object.freeze({
  // Public launch behaviour in RULES.txt, not any answering trophy rates.
  launchPlayersBefore: 638,
  launchPlayersAfter: 3_868,
  launchRefreshHours: 4.5,
  clockOffsetHours: 1,
  populationPriorSd: 0.45,
  memoryHours: 30,
  populationDamping: 0.75,
  individualDamping: 1.1,
  individualPriorPrecision: 8,
});
const FIRST_REFRESH_AT = Date.parse('2026-11-19T04:30:00Z');

function bounded(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function percentile(values, probability) {
  if (values.length === 0) return 0;
  const ordered = values.slice().sort((a, b) => a - b);
  const position = probability * (ordered.length - 1);
  const left = Math.floor(position);
  const fraction = position - left;
  return ordered[left] * (1 - fraction)
    + ordered[Math.min(left + 1, ordered.length - 1)] * fraction;
}

function scoreLogOdds(percent) {
  const probability = bounded(percent / 100, 0.0001, 0.9999);
  return Math.log(probability) - Math.log1p(-probability);
}

function percentFromOdds(odds) {
  // The two forms avoid overflow even for a very rare or very common trophy.
  if (odds >= 0) return 100 / (1 + Math.exp(-odds));
  const exponential = Math.exp(odds);
  return 100 * exponential / (1 + exponential);
}

function releaseClock(timestamp, release) {
  const ageHours = Math.max(0, (timestamp - release) / HOUR_MS);
  return Math.log1p(ageHours / SETTINGS.clockOffsetHours);
}

function dampedDistance(distance, scale) {
  return -scale * Math.expm1(-Math.max(0, distance) / scale);
}

function validateCase(example, filename) {
  if (example.schema !== 'makefun/gta6-trophies-case/v1') {
    throw new Error(`${filename}: unsupported case schema`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(example.id)
      || example.id !== filename.slice(0, -3)) {
    throw new Error(`${filename}: case id does not match its filename`);
  }
  if (!Array.isArray(example.levels)
      || example.levels.length !== PROBABILITIES.length
      || example.levels.some((level, index) => level !== PROBABILITIES[index])) {
    throw new Error(`${filename}: unexpected quantile levels`);
  }
  const checkpoint = Date.parse(example.at);
  const target = Date.parse(example.target);
  const release = Date.parse(example.game.release_date);
  if (![checkpoint, target, release].every(Number.isFinite)
      || target < checkpoint || !Number.isFinite(example.horizon_minutes)
      || example.horizon_minutes < 0
      || Math.abs((target - checkpoint) / 60_000 - example.horizon_minutes) > 0.01) {
    throw new Error(`${filename}: inconsistent case clocks`);
  }
  if (!Array.isArray(example.trophies) || example.trophies.length === 0
      || !Array.isArray(example.history) || example.history.length === 0) {
    throw new Error(`${filename}: trophies and history are required`);
  }
  const identifiers = new Set();
  for (const trophy of example.trophies) {
    if (!Number.isSafeInteger(trophy.id) || trophy.id <= 0
        || identifiers.has(trophy.id) || !(trophy.tier in TIER_ELASTICITIES)) {
      throw new Error(`${filename}: invalid or duplicate trophy`);
    }
    identifiers.add(trophy.id);
  }
}

function collapsePages(example) {
  const checkpoint = Date.parse(example.at);
  const release = Date.parse(example.game.release_date);
  const reads = [];
  for (const read of example.history) {
    const timestamp = Date.parse(read.at);
    if (!Number.isFinite(timestamp) || !Number.isFinite(read.players_tracked)
        || read.players_tracked <= 0 || !Array.isArray(read.rates)
        || read.rates.length !== example.trophies.length
        || read.rates.some(rate => rate !== null
          && (!Number.isFinite(rate) || rate < 0 || rate > 100))) {
      throw new Error(`${example.id}: invalid history observation`);
    }
    // Do not learn from a record at or beyond the checkpoint, even if supplied.
    if (timestamp < checkpoint) reads.push({ read, timestamp });
  }
  reads.sort((a, b) => a.timestamp - b.timestamp);
  const pages = [];
  for (const { read, timestamp } of reads) {
    const signature = JSON.stringify([read.players_tracked, read.rates]);
    const previous = pages[pages.length - 1];
    if (previous && previous.signature === signature) {
      previous.lastSeen = timestamp;
      continue;
    }
    // A changed batch appeared between the previous poll and this poll.
    // Its midpoint is a better clock than the last poll of an unchanged batch.
    const epoch = previous
      ? Math.max(release, (previous.lastSeen + timestamp) / 2)
      : Math.max(release, timestamp);
    pages.push({
      signature, epoch, firstSeen: timestamp, lastSeen: timestamp,
      players: read.players_tracked, rates: read.rates.slice(),
    });
  }
  if (pages.length === 0) throw new Error(`${example.id}: no pre-checkpoint page`);
  return pages;
}

function fitLogTrend(pages, release, valueAt, noiseAt) {
  const end = pages[pages.length - 1].epoch;
  const samples = [];
  for (const page of pages) {
    const value = valueAt(page);
    if (value === null || !(value > 0)) continue;
    samples.push({
      x: releaseClock(page.epoch, release),
      y: Math.log(value),
      weight: Math.exp(-(end - page.epoch) / (SETTINGS.memoryHours * HOUR_MS)),
      noise: noiseAt(page),
    });
  }
  if (samples.length < 2) return { slope: 0, information: 0 };

  let weights = samples.map(sample => sample.weight);
  let slope = 0;
  let intercept = 0;
  let xx = 0;
  // Three Huber reweightings keep one refresh anomaly from setting a trend.
  for (let iteration = 0; iteration < 4; iteration++) {
    let total = 0;
    let sumX = 0;
    let sumY = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      total += weights[index];
      sumX += weights[index] * sample.x;
      sumY += weights[index] * sample.y;
    }
    const meanX = sumX / total;
    const meanY = sumY / total;
    xx = 0;
    let xy = 0;
    for (let index = 0; index < samples.length; index++) {
      const dx = samples[index].x - meanX;
      xx += weights[index] * dx * dx;
      xy += weights[index] * dx * (samples[index].y - meanY);
    }
    if (xx < 1e-10) return { slope: 0, information: 0 };
    slope = xy / xx;
    intercept = meanY - slope * meanX;
    if (iteration === 3) break;
    const residuals = samples.map(sample => sample.y - intercept - slope * sample.x);
    const middle = percentile(residuals, 0.5);
    const scale = Math.max(0.06,
      1.4826 * percentile(residuals.map(value => Math.abs(value - middle)), 0.5));
    weights = samples.map((sample, index) => sample.weight
      * Math.min(1, 1.5 * scale / Math.max(1e-12, Math.abs(residuals[index]))));
  }
  let variance = 0;
  let noise = 0;
  let totalWeight = 0;
  for (let index = 0; index < samples.length; index++) {
    const residual = samples[index].y - intercept - slope * samples[index].x;
    variance += weights[index] * residual * residual;
    noise += weights[index] * samples[index].noise;
    totalWeight += weights[index];
  }
  // Noise includes sparse earners and the page's two-decimal count rounding.
  const information = xx / (0.06 ** 2 + (variance + noise) / totalWeight);
  return { slope, information: Math.max(0, information) };
}

function lastKnownRate(pages, index) {
  for (let cursor = pages.length - 1; cursor >= 0; cursor--) {
    if (pages[cursor].rates[index] !== null) {
      return { page: pages[cursor], rate: pages[cursor].rates[index] };
    }
  }
  return { page: pages[pages.length - 1], rate: 0 };
}

function countNoise(players, percent) {
  const count = players * percent / 100;
  const stabilized = count + 0.5;
  const roundingHalfWidth = players * 0.00005;
  return 1 / stabilized + (roundingHalfWidth / stabilized) ** 2 / 3;
}

function buildModel(trophies, pages, release, target, checkpoint) {
  const latest = pages[pages.length - 1];
  const priorSlope = Math.log(SETTINGS.launchPlayersAfter / SETTINGS.launchPlayersBefore)
    / Math.log1p(SETTINGS.launchRefreshHours / SETTINGS.clockOffsetHours);
  const populationFit = fitLogTrend(pages, release,
    page => page.players, () => 0.08 ** 2);
  const populationPrecision = 1 / SETTINGS.populationPriorSd ** 2;
  const populationSlope = bounded(
    (populationFit.information * populationFit.slope + populationPrecision * priorSlope)
      / (populationFit.information + populationPrecision), 0.2, 2.5);
  const populationSlopeSd = Math.max(0.12,
    Math.sqrt(1 / (populationFit.information + populationPrecision)));
  // Only a complete case supplies its checkpoint. Historical calibration
  // prefixes retain their original population path, including in multi-page cases.
  const anticipateFirstRefresh = pages.length === 1
    && checkpoint < FIRST_REFRESH_AT && target >= FIRST_REFRESH_AT;
  const populationEpoch = anticipateFirstRefresh ? FIRST_REFRESH_AT : latest.epoch;
  const futureClock = Math.max(0,
    releaseClock(target, release) - releaseClock(populationEpoch, release));
  const transientClock = dampedDistance(futureClock, SETTINGS.populationDamping);
  const continuationLogGrowth = Math.max(0,
    priorSlope * futureClock + (populationSlope - priorSlope) * transientClock);
  const playerLogGrowth = anticipateFirstRefresh
    ? Math.log(SETTINGS.launchPlayersAfter / latest.players) + continuationLogGrowth
    : continuationLogGrowth;
  const elapsedHours = Math.max(0, (target - latest.epoch) / HOUR_MS);
  // The documented count has no growth-estimation error at the refresh itself.
  // Only growth after that anchor uses the existing uncertainty coefficients.
  const populationUncertaintyHours = anticipateFirstRefresh
    ? Math.max(0, (target - FIRST_REFRESH_AT) / HOUR_MS) : elapsedHours;
  const playerLogSd = Math.hypot(
    populationSlopeSd * futureClock,
    0.20 * (futureClock - transientClock),
    0.16 * Math.sqrt(Math.min(4, populationUncertaintyHours / 4)),
  );
  const observedPopulationSlope = populationFit.information > 0.1
    ? Math.max(0.1, populationFit.slope) : priorSlope;

  const individual = trophies.map((trophy, index) => {
    const known = lastKnownRate(pages, index);
    const fit = fitLogTrend(pages, release,
      page => page.rates[index] === null ? null
        : page.players * page.rates[index] / 100 + 0.5,
      page => countNoise(page.players, page.rates[index]));
    const information = known.rate > 0 && known.rate < 99.99
      ? fit.information * observedPopulationSlope ** 2 : 0;
    const rawElasticity = bounded(fit.slope / observedPopulationSlope, 0, 1.15);
    return { known, rawElasticity, information, tier: trophy.tier };
  });

  let globalNumerator = 4 * 0.21;
  let globalWeight = 4;
  const groups = {};
  for (const tier of Object.keys(TIER_ELASTICITIES)) {
    groups[tier] = { numerator: 0, weight: 0 };
  }
  for (const item of individual) {
    // Correlated trophies in one batch cannot contribute unlimited precision.
    const weight = Math.min(4, Math.sqrt(item.information));
    groups[item.tier].numerator += weight * item.rawElasticity;
    groups[item.tier].weight += weight;
    globalNumerator += weight * item.rawElasticity;
    globalWeight += weight;
  }
  const globalElasticity = globalNumerator / globalWeight;
  const tiers = {};
  for (const [tier, group] of Object.entries(groups)) {
    tiers[tier] = {
      elasticity: bounded((group.numerator + 5 * TIER_ELASTICITIES[tier]
        + globalElasticity) / (group.weight + 6), 0.01, 0.94),
      weight: group.weight,
    };
  }
  return {
    latest, individual, tiers, playerLogGrowth, playerLogSd, elapsedHours,
    organicLogGrowth: anticipateFirstRefresh ? continuationLogGrowth : undefined,
    projectedPlayers: anticipateFirstRefresh
      ? SETTINGS.launchPlayersAfter * Math.exp(continuationLogGrowth)
      : latest.players * Math.exp(playerLogGrowth),
  };
}

function trophyDistribution(model, index) {
  const item = model.individual[index];
  const { rate, page } = item.known;
  if (rate === 100) {
    return { certainStart: true, mean: scoreLogOdds(99.99),
      sd: Math.min(0.65, 0.18 + 0.06 * Math.log1p(model.elapsedHours / 6)) };
  }
  const tier = model.tiers[item.tier];
  const ownWeight = item.information
    / (item.information + SETTINGS.individualPriorPrecision);
  const elasticity = bounded(ownWeight * item.rawElasticity
    + (1 - ownWeight) * tier.elasticity, 0, 0.94);
  // Old non-null observations remain usable when a later read lacks a rate.
  const logGrowth = Math.max(0,
    Math.log(model.latest.players / page.players) + model.playerLogGrowth);
  const longRunElasticity = 0.85 * tier.elasticity;
  const spreadEarnerLogGrowth = bounded(longRunElasticity * logGrowth
    + (elasticity - longRunElasticity)
      * dampedDistance(logGrowth, SETTINGS.individualDamping), 0, 0.94 * logGrowth);
  // A refresh adds tracked players without multiplying the existing earners.
  // Only organic growth after the refresh enters the median's count growth.
  const organicLogGrowth = model.organicLogGrowth;
  const earnerLogGrowth = organicLogGrowth === undefined ? spreadEarnerLogGrowth
    : bounded(longRunElasticity * organicLogGrowth + (elasticity - longRunElasticity)
      * dampedDistance(organicLogGrowth, SETTINGS.individualDamping),
    0, 0.94 * organicLogGrowth);
  // Keep pass 1's rate-sensitivity and count/population-ratio references for SD.
  const projectedRate = bounded(rate * Math.exp(spreadEarnerLogGrowth - logGrowth), 0, 100);
  // Clamp the observed logit, then transport it by the count/denominator move.
  // Clamping the projected median instead would freeze every 0.01% trophy.
  const referenceRate = bounded(rate, 0.01, 99.99);
  const change = earnerLogGrowth - logGrowth;
  const referenceProjection = referenceRate * Math.exp(change);
  const mean = scoreLogOdds(rate) + change + Math.log1p(-referenceRate / 100)
    - Math.log1p(-referenceProjection / 100);
  const elasticitySd = Math.hypot(0.18 * Math.sqrt(1 - ownWeight),
    0.08 / (1 + Math.sqrt(tier.weight)));
  const sparseCountSd = Math.min(1.4,
    0.6 * Math.sqrt(countNoise(page.players, rate) * -Math.expm1(-logGrowth)));
  const structuralSd = 0.22 + 0.14 * Math.sqrt(Math.log1p(model.elapsedHours / 6));
  const probability = projectedRate / 100;
  const logitSensitivity = 1 / Math.max(0.12, 1 - probability);
  const sd = bounded(logitSensitivity * Math.hypot(
    (1 - spreadEarnerLogGrowth / Math.max(1e-12, logGrowth)) * model.playerLogSd,
    elasticitySd * logGrowth, sparseCountSd, structuralSd,
  ), 0.25, 2.5);
  return { certainStart: false, censoredZero: rate === 0, mean, sd };
}

function distributionQuantiles(distribution, temperature) {
  const quantiles = NORMAL_SCORES.map((score, index) => {
    if (distribution.certainStart && index >= 2) return 100;
    // A displayed zero has a genuine zero mass, not a small positive median.
    if (distribution.censoredZero && index <= 2) return 0;
    const percent = percentFromOdds(distribution.mean
      + score * Math.min(2.5, distribution.sd * temperature));
    // Exophase prints two decimals; sub-half-cent rates are reported as zero.
    if (percent < 0.005) return 0;
    return Math.round(bounded(percent, 0, 100) * 1_000_000) / 1_000_000;
  });
  for (let index = 1; index < quantiles.length; index++) {
    quantiles[index] = Math.max(quantiles[index], quantiles[index - 1]);
  }
  return quantiles;
}

function historicalCalibration(trophies, pages, release) {
  const scores = { all: [] };
  const epochs = { all: new Set() };
  const temperatures = {};
  for (const tier of Object.keys(TIER_ELASTICITIES)) {
    scores[tier] = [];
    epochs[tier] = new Set();
    temperatures[tier] = 1;
  }
  if (pages.length < 4) return { temperatures, folds: 0, global: 1 };

  // A fold holds out later batches from every fit, not just from calibration.
  // At most twelve target epochs, spread across the available history.
  const targets = new Set();
  const numberOfTargets = Math.min(12, pages.length - 1);
  for (let index = 1; index <= numberOfTargets; index++) {
    targets.add(Math.max(1, Math.round(index * (pages.length - 1) / numberOfTargets)));
  }
  for (const end of targets) {
    // Holding out roughly the last third also tests beyond the next poll.
    const prefixLength = Math.max(1, Math.floor(end * 0.65));
    const prefix = pages.slice(0, prefixLength);
    const prediction = buildModel(trophies, prefix, release, pages[end].firstSeen);
    for (let index = 0; index < trophies.length; index++) {
      const observed = pages[end].rates[index];
      const distribution = trophyDistribution(prediction, index);
      if (observed === null || observed <= 0 || observed >= 100
          || distribution.certainStart) continue;
      const normalized = Math.abs(scoreLogOdds(observed) - distribution.mean)
        / distribution.sd;
      const tier = trophies[index].tier;
      scores.all.push(normalized);
      scores[tier].push(normalized);
      epochs.all.add(end);
      epochs[tier].add(end);
    }
  }
  function widening(group) {
    if (epochs[group].size < 3 || scores[group].length < 6) return 1;
    const empirical = bounded(percentile(scores[group], 0.9) / NORMAL_SCORES[4], 1, 3);
    // Fifty correlated trophies do not count as fifty independent refreshes.
    const credibility = epochs[group].size / (epochs[group].size + 6);
    return 1 + credibility * (empirical - 1);
  }
  const global = widening('all');
  for (const tier of Object.keys(TIER_ELASTICITIES)) {
    const trophyCount = trophies.filter(trophy => trophy.tier === tier).length;
    const credibility = epochs[tier].size / (epochs[tier].size + 10)
      * Math.min(1, trophyCount / 4);
    temperatures[tier] = bounded(global + credibility * (widening(tier) - global), 1, 3);
  }
  return { temperatures, folds: epochs.all.size, global };
}

function makeForecast(example) {
  const pages = collapsePages(example);
  const release = Date.parse(example.game.release_date);
  const model = buildModel(example.trophies, pages, release,
    Date.parse(example.target), Date.parse(example.at));
  const calibration = historicalCalibration(example.trophies, pages, release);
  return { trophies: example.trophies.map((trophy, index) => ({
    id: trophy.id, q: distributionQuantiles(trophyDistribution(model, index),
      calibration.temperatures[trophy.tier]),
  })) };
}

function runDirectory() {
  const sourceDirectory = process.env.MAKEFUN_INPUT_DIR || '/input/';
  const destinationDirectory = process.env.MAKEFUN_OUTPUT_DIR || '/output/';
  filesystem.mkdirSync(destinationDirectory, { recursive: true });
  const filenames = filesystem.readdirSync(sourceDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.in'))
    .map(entry => entry.name).sort();
  for (const filename of filenames) {
    const example = JSON.parse(filesystem.readFileSync(
      paths.resolve(sourceDirectory, filename), 'utf8'));
    validateCase(example, filename);
    const result = JSON.stringify(makeForecast(example)) + '\n';
    if (Buffer.byteLength(result, 'utf8') > 65_536) {
      throw new Error(`${filename}: forecast exceeds the output size limit`);
    }
    filesystem.writeFileSync(paths.resolve(destinationDirectory, `${example.id}.out`),
      result, { encoding: 'utf8', flag: 'w' });
  }
}

if (require.main === module) runDirectory();
module.exports = {
  makeForecast, collapsePages, buildModel, trophyDistribution, historicalCalibration,
  scoreLogOdds,
};
