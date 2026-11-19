[![make.fun bounty](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Live rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Ardian9712/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![Live reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/Ardian9712/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

# Batch-aware GTA VI trophy forecast

An original, deterministic entry for **gta6-trophy-rarity-forecast-01**. It
forecasts the 5th, 25th, 50th, 75th and 95th percentiles of each PS5 trophy's
**Exophase earn rate, in percent**, at the input case's target. The final target
is 26 November 2026 at 00:00 UTC. These are rates among Exophase-tracked players.

## Model

**Dilution:** the tracked population can grow faster than trophy earners. The
model forecasts the population and earned counts separately, then divides
earned counts by players. Most medians consequently fall below the latest
displayed rate, rather than assuming that launch-night rates persist.

**Damped growth:** population trends are robust fits of log counts against
`log(1 + hours since release)`. Their recent slope gradually returns to a
launch-growth prior. That prior uses the behaviour documented in `RULES.txt`:
638 to 3,868 tracked players by the first refresh, about 4.5 hours after launch.
It does not contain any answering trophy rates. Identical successive page
reads are collapsed into one batch; a stale page does not become multiple
independent measurements or imply that the underlying population stopped.

**Hierarchical shrinkage:** each trophy's count-growth elasticity is shrunk
toward its tier, with limited borrowing across tiers. Few earners and rounded
rates receive less weight. Individual growth also damps toward the tier's
long-run growth, capped below the population's growth. Missing historical
rates fall back to the last non-null observation.

**Uncertainty:** quantiles are formed on the scoring logit scale. Their spread
combines uncertain player growth, count-growth elasticity, sparse counts,
rounding, batch age and longer-horizon model uncertainty. Rolling predictions
of already-observed refreshes can widen the spread; only history prefixes are
used to fit those predictions. Repeated polls do not inflate calibration
sample size. With no observed refresh, the broad launch prior supplies the
uncertainty. A displayed 100% onboarding trophy stays near 100%. A zero rate
keeps a zero median and a small positive upper tail. Logits use the scorer's
0.01–99.99% clamp on observations; projected rare rates can still dilute below
that scoring floor. Values below the page's 0.005% rounding threshold become
zero.

No answers, network access, packages, randomness or wall-clock time are used.
Parameters are fixed in the source; historical calibration uses only the
current case. Actual target coverage and pinball loss require the unseen
answer and are not claimed by local verification.

## Run locally

`main.ts` uses JavaScript-compatible TypeScript and only Node's standard
library. Run directly with **Node 22**, with no compilation or installation:

```bash
KIT="$HOME/workspace/makefun/gta6-trophy-rarity-forecast-01-kit/gta6-trophy-rarity-forecast-01-kit"
mkdir -p out && MAKEFUN_INPUT_DIR="$KIT/input" MAKEFUN_OUTPUT_DIR=out node main.ts
```

Both `out/p00.out` and `out/p01.out` are written. Every regular `*.in` file is
processed in filename order. Each output has precisely one `trophies` key and
one `{ "id": number, "q": [five quantiles] }` row per input trophy. The default
directories in the sandbox are `/input/` and `/output/`.

The independent verification script validates the contract, reruns the entry,
checks identical bytes and runtime, exercises boundary and refreshed-history
cases, and compares every practice median with the kit's starter:

```bash
node verify.mjs "$KIT"
```

Its summaries include median moves, 90% band widths and a clearly labelled
**hypothetical count-preserving sixfold refresh** check. That scenario is a
sanity check of the documented dilution mechanism, not a practice answer.

## Session verification results

Verified with **Node v22.23.5 on one CPU**. A timed run processed both practice
cases in **0.233 seconds**, comfortably under the eight-second limit. Each
output is valid UTF-8 JSON with 55 unique trophy rows and five finite,
non-decreasing quantiles in 0–100. Repeated runs were byte-identical, including
the same output hashes on the locally available Node 24 runtime.

| Case | Medians below last read | Typical median move | Mean median move | Median 90% band width | Mean 90% band width |
| --- | ---: | ---: | ---: | ---: | ---: |
| p00 | 54/55 | −0.589746 pp | −0.660671 pp | 0.695960 pp | 0.764285 pp |
| p01 | 54/55 | −0.603141 pp | −0.675478 pp | 0.691859 pp | 0.759709 pp |

“Typical” is the median across trophies of `forecast median − last rate`.
The typical moves versus the starter are the same; all 54 non-universal
trophies have lower medians, while the 100% trophy has a 100% median versus
the starter's clamped 99.99%. Typical logit band widths are 2.739529 and
2.858259, respectively. Both cases' bands contain all 55 values in the
hypothetical count-preserving sixfold-refresh scenario.

`out/median-comparison.csv` contains the full **110-row per-trophy comparison**
with the starter; `out/verification.json` contains the machine-readable checks
and SHA-256 hashes. These are regenerated by the verification command.
Synthetic tests also passed for zero/100% boundaries, scoring-floor dilution,
missing rates, duplicate polls, exclusion of post-checkpoint observations,
rolling calibration, and the final's 6,510-minute horizon.

## License

MIT; see [LICENSE](LICENSE).

---

[Join make.fun through the entrant's referral](https://make.fun/r/p8atzycs).
