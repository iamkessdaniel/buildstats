// Prompt Score v0.1. One formula, shared by buildstats (local preview) and the
// Prompt Board server (which recomputes every score from the submitted totals
// and never trusts a client-side number).
//
// Practice score (0 to 1000) for one day of buildstats totals. Each component
// is mapped onto a fixed scale with diminishing returns, so a day is judged
// against the same anchors in every city and nobody's score moves because
// someone else had a big day.

export const VERSION = "0.1";

export const ANCHORS = {
  ptm: { full: 4, weight: 0.35 },       // AI PTM: 1.0x scores 0, 4.0x or more scores full
  leverage: { full: 30, weight: 0.2 },  // agent minutes per prompt (log scale)
  delegation: { full: 3, weight: 0.1 }, // agent hours per keyboard hour
  shipped: { full: 100, weight: 0.2 },  // commits that day (log scale, so volume has steep diminishing returns)
  peak: { full: 10, weight: 0.15 },     // most streams at once: 1 scores 0, 10 or more scores full
};
export const MIN_CLOCK_HOURS = 0.5;     // a day needs 30 active clock minutes to rank

const clamp = (x) => Math.max(0, Math.min(1, x));
const logScale = (v, full) => clamp(Math.log1p(Math.max(0, v || 0)) / Math.log1p(full));

export function components(d) {
  return {
    ptm: clamp(((d.parallelFactor || 0) - 1) / (ANCHORS.ptm.full - 1)),
    leverage: logScale(d.promptLeverageMin, ANCHORS.leverage.full),
    delegation: clamp((d.delegationRatio || 0) / ANCHORS.delegation.full),
    shipped: logScale(d.commits, ANCHORS.shipped.full),
    peak: clamp(((d.peakParallel || 0) - 1) / (ANCHORS.peak.full - 1)),
  };
}

export function practiceScore(d) {
  if (!d || (d.clockHours || 0) < MIN_CLOCK_HOURS) return { score: null, parts: null };
  const c = components(d);
  let s = 0;
  for (const k of Object.keys(ANCHORS)) s += ANCHORS[k].weight * c[k];
  return { score: Math.round(s * 1000), parts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) };
}

// Practice rating: the mean of the best 15 daily scores in the last 28 days.
// Rewards a steady habit; one huge day cannot carry a month.
export const RATING_WINDOW_DAYS = 28, RATING_BEST_DAYS = 15;
export function practiceRating(dailyScores) {
  const best = dailyScores.filter((x) => x != null).sort((a, b) => b - a).slice(0, RATING_BEST_DAYS);
  return best.length ? Math.round(best.reduce((a, b) => a + b, 0) / RATING_BEST_DAYS) : 0;
}

// Challenge points (0 to 1000) for one verified challenge entry: the entry's
// weighted category result, where each category result is the builder's
// percentile among verified entries in that challenge (1 = best).
export function challengePoints(categoryPercentiles, weights) {
  let s = 0, w = 0;
  for (const [cat, pct] of Object.entries(categoryPercentiles)) { const k = weights[cat] || 0; s += k * clamp(pct); w += k; }
  return w ? Math.round((s / w) * 1000) : 0;
}

// Prompt Score: half practice rating, half the mean of the best three
// verified challenge results this season. Before a builder's first verified
// challenge it equals the practice rating, flagged as provisional.
export function promptScore(rating, challengeResults = []) {
  const best = [...challengeResults].sort((a, b) => b - a).slice(0, 3);
  if (!best.length) return { score: rating, provisional: true };
  const ch = best.reduce((a, b) => a + b, 0) / 3;
  return { score: Math.round(0.5 * rating + 0.5 * ch), provisional: false };
}

// City and chapter ranking: the mean Prompt Score of a place's top ten
// builders, ranked once it has at least three, so a small city with strong
// builders can beat a big one.
export const PLACE_TOP_N = 10, PLACE_MIN_BUILDERS = 3;
export function placeScore(scores) {
  if (scores.length < PLACE_MIN_BUILDERS) return null;
  const top = [...scores].sort((a, b) => b - a).slice(0, PLACE_TOP_N);
  return Math.round(top.reduce((a, b) => a + b, 0) / top.length);
}
