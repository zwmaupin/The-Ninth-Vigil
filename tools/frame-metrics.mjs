#!/usr/bin/env node
/**
 * Frame metrics — the objective measurements, in one place.
 *
 *   node tools/frame-metrics.mjs --help
 *
 * Imported by `tools/sheet.mjs` (which reports them for every capture) and
 * `tools/diff.mjs` (which compares them between a capture and its baseline).
 *
 * WHY THIS IS A SEPARATE FILE. Two copies of the same thresholds drift, and
 * the drift is silent. KNOWN_ISSUES.md records exactly that failure already
 * happening elsewhere in this project: "HitFeel.js, Telegraph.js, StainMaterial.js
 * and director/Shrines.js budget against 'the crypt look is blackPoint 0.028 /
 * whitePoint 0.72 / contrast 1.38'. Those are the 'town' look's numbers; the
 * crypt was 0.014 / 0.84 / 1.30 before this change and is 0.014 / 0.90 / 1.30
 * now. Not corrected here because each module's ceiling would need
 * re-measuring, not re-commenting." Four modules kept their own copy of a
 * number that had moved, and the only way anyone found out was by reading
 * them one at a time. One file, imported, cannot drift from itself.
 *
 * The numbers are deliberately the same ones `tools/sheet.mjs` has always
 * used, so nothing about the existing analysis changes — only where it lives.
 */

/**
 * The thresholds. Each carries the reason it exists, because a threshold
 * without a reason is a number nobody dares to change.
 */
export const LIMITS = {
  /* Above this, the darkest 1% of the frame is no longer black: lifted blacks,
     the frame reads milky, and the rubric flags it. */
  p01Max: 0.06,
  /* Below this, the brightest 1% of the frame is not bright: no highlights,
     the frame reads flat and dull. This is the check `overworld` failed at
     p99=0.656 before the frost fix. */
  p99Min: 0.72,
  /* Below this the value range is too compressed to read as a lit scene. */
  stdevMin: 0.13,
  /* Above this the frame is brighter than the Diablo look, which is a dark
     one. Below this it is probably a rendering failure rather than a scene. */
  meanMax: 0.5,
  meanMin: 0.05,
  /* Above this, bloom or exposure is clipping too much of the frame. */
  blownPctMax: 4,
  /* Above this the palette is evenly saturated, which the rubric flags as
     "rainbow / evenly-saturated palette with no dominant key". */
  meanSatMax: 0.52,
  /* Below this there are too few distinct colours for the frame to read as
     textured rather than flat. */
  colorBucketsMin: 90,
};

/**
 * Measure a frame.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} img
 *        ImageData-shaped input, as returned by a canvas context.
 * @param {number} stride  sample every Nth 4-pixel group. The default of 1 is
 *        what `tools/sheet.mjs` has always done — every 4th pixel — and it
 *        is NOT arbitrary: the `colorBuckets` count and therefore the
 *        `colorBucketsMin` threshold are calibrated against that sampling
 *        density, so changing it changes what the number means. A 1600x900
 *        frame gives 360,000 samples, which is plenty for a histogram and
 *        fast enough to run eight of them inside a browser.
 */
export function computeMetrics(img, stride = 1) {
  const { data, width, height } = img;
  const hist = new Array(32).fill(0);
  let sum = 0, n = 0, satSum = 0, dark = 0, blown = 0;
  const uniq = new Set();

  for (let p = 0; p < data.length; p += 16 * stride) {
    const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
    hist[Math.min(31, (l * 32) | 0)]++;
    sum += l; n++;
    if (l < 0.02) dark++;
    if (l > 0.96) blown++;
    if (n % 37 === 0) uniq.add((data[p] >> 4) + ',' + (data[p + 1] >> 4) + ',' + (data[p + 2] >> 4));
  }

  const mean = sum / n;
  let varSum = 0;
  for (let k = 0; k < 32; k++) varSum += hist[k] * Math.pow(k / 32 - mean, 2);

  const p = (frac) => {
    let acc = 0;
    for (let k = 0; k < 32; k++) { acc += hist[k]; if (acc / n >= frac) return k / 32; }
    return 1;
  };

  return {
    mean: +mean.toFixed(3),
    stdev: +Math.sqrt(varSum / n).toFixed(3),
    p01: +p(0.01).toFixed(3), p50: +p(0.5).toFixed(3), p99: +p(0.99).toFixed(3),
    trueBlackPct: +((dark / n) * 100).toFixed(1),
    blownPct: +((blown / n) * 100).toFixed(2),
    meanSat: +(satSum / n).toFixed(3),
    colorBuckets: uniq.size,
  };
}

/**
 * Turn metrics into warnings.
 *
 * The ORDER matters for the report: a frame that is milky AND has no
 * highlights is one problem with two symptoms, and listing the black-point
 * failure first says so.
 *
 * @returns {string[]} one line per violated limit, empty when the frame is in range.
 */
export function evaluateMetrics(m) {
  const warn = [];
  if (m.p01 > LIMITS.p01Max) warn.push('LIFTED BLACKS — no true black, frame reads milky');
  if (m.p99 < LIMITS.p99Min) warn.push('NO HIGHLIGHTS — nothing bright, frame reads flat/dull');
  if (m.stdev < LIMITS.stdevMin) warn.push('LOW CONTRAST — value range too compressed');
  if (m.mean > LIMITS.meanMax) warn.push('TOO BRIGHT for the Diablo look (target mean 0.16-0.34)');
  if (m.mean < LIMITS.meanMin) warn.push('NEARLY BLACK — likely a rendering failure');
  if (m.blownPct > LIMITS.blownPctMax) warn.push('BLOWN OUT — bloom/exposure clipping too much of frame');
  if (m.meanSat > LIMITS.meanSatMax) warn.push('OVERSATURATED — not the desaturated gothic palette');
  if (m.colorBuckets < LIMITS.colorBucketsMin) warn.push('FLAT PALETTE — too few distinct colors, reads untextured');
  return warn;
}

/** One line, in the format sheet.mjs has always printed. */
export function formatMetricsLine(name, m) {
  return (
    `  ${name.padEnd(11)} mean=${String(m.mean).padEnd(6)} sd=${String(m.stdev).padEnd(6)} ` +
    `p01=${String(m.p01).padEnd(6)} p99=${String(m.p99).padEnd(6)} ` +
    `blk%=${String(m.trueBlackPct).padEnd(5)} sat=${String(m.meanSat).padEnd(6)} colors=${m.colorBuckets}`
  );
}

/**
 * Compare two sets of metrics and report which ones MOVED.
 *
 * The point of a diff is not "is the frame the same" — it is "which numbers
 * did this change move, and in which direction". A change that moves p99 up
 * by 0.05 is worth knowing about even if no pixel crossed a threshold.
 *
 * @returns {{moved: Array, regressions: string[]}}
 */
export function compareMetrics(before, after) {
  const moved = [];
  const regressions = [];

  for (const key of ['mean', 'stdev', 'p01', 'p50', 'p99', 'trueBlackPct', 'blownPct', 'meanSat', 'colorBuckets']) {
    const b = before[key], a = after[key];
    if (b === a) continue;
    const delta = +(a - b).toFixed(3);
    moved.push({ key, before: b, after: a, delta });
  }

  /* A regression is a metric that crossed a limit it was previously inside.
     That is the signal worth failing a build on: the frame was in range and
     now it is not. */
  const wasOk = (key, m, over) => {
    switch (key) {
      case 'p01': return m.p01 <= LIMITS.p01Max;
      case 'p99': return m.p99 >= LIMITS.p99Min;
      case 'stdev': return m.stdev >= LIMITS.stdevMin;
      case 'mean': return m.mean <= LIMITS.meanMax && m.mean >= LIMITS.meanMin;
      case 'blownPct': return m.blownPct <= LIMITS.blownPctMax;
      case 'meanSat': return m.meanSat <= LIMITS.meanSatMax;
      case 'colorBuckets': return m.colorBuckets >= LIMITS.colorBucketsMin;
      default: return true;
    }
  };

  for (const key of ['p01', 'p99', 'stdev', 'mean', 'blownPct', 'meanSat', 'colorBuckets']) {
    if (wasOk(key, before) && !wasOk(key, after)) {
      regressions.push(`${key}: ${before[key]} -> ${after[key]} (crossed out of range)`);
    }
  }

  return { moved, regressions };
}
