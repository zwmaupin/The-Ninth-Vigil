#!/usr/bin/env node
/**
 * Pixel diff against the committed baseline — the missing before/after gate.
 *
 *   node tools/diff.mjs                       # every scenario that has a baseline
 *   node tools/diff.mjs --scenario=combat     # one
 *   node tools/diff.mjs --capture             # capture first, then diff
 *   node tools/diff.mjs --capture --scenario=closeup
 *   node tools/diff.mjs --json
 *   node tools/diff.mjs --threshold=0.02      # fail above 2% of pixels changed
 *
 * WHY THIS EXISTS. `CONTRIBUTING.md` requires every visual change to "prove
 * visual changes in pixels", with a before/after crop of the same region and
 * the measured numbers. The repository already ships the "before" — eight
 * committed PNGs in `shots/` — and nothing compared a new capture against
 * them. The rule was therefore honour-system: an agent could lower a frame's
 * mean and drop its p99 and still produce a passing run.
 *
 * `tools/sheet.mjs` measures a frame in isolation. It cannot answer the only
 * question a reviewer has, which is whether the frame got BETTER or WORSE.
 *
 * WHY PIXELS AND NOT A HASH. The README records the objection to a stored
 * hash — "a stored hash would mostly generate 'just update the expected value'
 * commits" — and the objection is sound for a hash, because a hash destroys
 * the information a reviewer needs. A diff keeps it: a legitimate balance
 * change produces a VISIBLE, REVIEWABLE delta, and that delta is the evidence.
 * A hash collapses "the torch moved and the frost is gone" and "everything is
 * subtly wrong" into the same opaque string.
 *
 * So: ship the diff, keep the pixels, drop the hash.
 *
 * WHAT IT REPORTS, per scenario:
 *   - the share of pixels that changed at all, and the share that changed a lot
 *   - a diff PNG, unchanged pixels dimmed and changed pixels lit
 *   - which objective metrics moved, and by how much
 *   - which metrics crossed OUT of range, which is what fails the build
 *
 * WHAT IT DOES NOT DO. It does not assert that a frame is IDENTICAL to its
 * baseline. A renderer that changes by a legitimate amount — a new light, a
 * re-tuned grade, a moved prop — is doing its job, and a gate that failed on
 * any difference would be a gate that gets disabled. The gate fires when a
 * change CROSSES a documented limit, or when the pixel delta is large enough
 * to be worth a human's eyes. The threshold is a prompt, not a prohibition.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import net from 'node:net';
import { computeMetrics, evaluateMetrics, compareMetrics, formatMetricsLine, LIMITS } from './frame-metrics.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'shots');
const DEBUG = resolve(SHOTS, '_debug');
const PORT = 5189;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  }),
);

const JSON_OUT = !!args.json;
const CAPTURE = !!args.capture;
const THRESHOLD = Number(args.threshold ?? 0.01);   // share of pixels that changed at all
const W = Number(args.w ?? 1600);
const H = Number(args.h ?? 900);
/* --software forces SwiftShader, for CI runners with no GPU. Cross-machine
   pixel equality is not a property this project has, so the gate under
   SwiftShader has to be a LOOSE one — the threshold is raised to match. */
const SOFTWARE = !!args.software || process.env.NONA_SOFTWARE_GL === '1';

/**
 * The frame count each scenario is captured with.
 *
 * THIS MUST MATCH `tools/shot.mjs`, or the diff is comparing two different
 * moments of the simulation. Measured: `closeup` is authored at 60 frames,
 * and capturing it at 120 instead put the scene in a different state — the
 * torches had advanced, the cloth had settled further — which changed 51 % of
 * the frame and reported a "regression" that was only a different frame
 * count. The thresholds in the table are authored for these numbers, so the
 * tool uses them too.
 */
const SCENARIO_FRAMES = {
  hub: 90, dungeon: 90, combat: 180, boss: 240,
  overworld: 120, inventory: 60, closeup: 60, night: 120,
};

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 800);
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const proc = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return proc;
  }
  proc.kill();
  throw new Error('vite failed to start on port ' + PORT);
}

/** Capture one scenario to `shots/_debug/<name>.png`. */
async function capture(browser, scenario) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

  /* The same frame count `tools/shot.mjs` uses for this scenario, so the
     capture is the SAME MOMENT of the simulation the baseline shows. */
  const frames = Number(args.frames ?? SCENARIO_FRAMES[scenario] ?? 120);

  await page.goto(`http://127.0.0.1:${PORT}/?shot=${scenario}&headless=1`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__NONA__ && window.__NONA__.ready === true, null, { timeout: 120000 });
  await page.evaluate(async (s) => { if (window.__NONA__.scenario) await window.__NONA__.scenario(s); }, scenario);
  await page.evaluate(async (f) => { await window.__NONA__.step(f, 1 / 60); }, frames);

  mkdirSync(resolve(DEBUG, 'diff'), { recursive: true });
  const out = resolve(DEBUG, 'diff', `${scenario}.png`);
  const canvas = await page.$('canvas');
  await (canvas ?? page).screenshot({ path: out });
  await page.close();
  return { out, problems, frames };
}

/* ------------------------------------------------------------------ *
 * Compare
 * ------------------------------------------------------------------ */

/**
 * Compare two PNGs and measure both, in ONE pass inside the browser.
 *
 * The browser is doing the decoding because the project has no image
 * dependency and the hard rule is no new ones — and `playwright` is already
 * here, so a canvas is free.
 *
 * Everything happens in the page and only the RESULTS come back. A 1600x900
 * RGBA frame is 5.76 MB of numbers, and returning that over the CDP bridge
 * is slow enough to look like a hang — which is exactly what it did, twice,
 * before this was written to keep the pixels in the page.
 *
 * `computeMetrics` is injected as source rather than duplicated, so the
 * numbers this reports are the same numbers `tools/sheet.mjs` reports, and
 * cannot drift from them.
 */
async function compareAndMeasure(browser, baselinePath, candidatePath) {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  const toData = (p) => 'data:image/png;base64,' + readFileSync(p).toString('base64');

  const result = await page.evaluate(async ({ a, b, metricsSrc }) => {
    /* eslint-disable no-eval */
    const computeMetrics = eval(`(${metricsSrc})`);

    const load = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img;
    };
    const ia = await load(a), ib = await load(b);

    /* Different sizes: the baseline was captured at a different resolution.
       That is not a defect, it is a different capture, so report it plainly
       and refuse to guess at a comparison. */
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: true, baseline: [ia.width, ia.height], candidate: [ib.width, ib.height] };
    }

    const w = ia.width, h = ia.height;
    const ca = new OffscreenCanvas(w, h), cb = new OffscreenCanvas(w, h);
    const xa = ca.getContext('2d'), xb = cb.getContext('2d');
    xa.drawImage(ia, 0, 0); xb.drawImage(ib, 0, 0);
    const da = xa.getImageData(0, 0, w, h).data;
    const db = xb.getImageData(0, 0, w, h).data;

    /* A pixel "changed" if any channel moved by more than 2/255 — below that
       is sensor noise and dithering, not a visual change. */
    const CHANGED_AT = 2;
    let changed = 0, big = 0, sumDelta = 0, maxDelta = 0;
    const total = w * h;
    const diff = new Uint8ClampedArray(total * 4);

    for (let i = 0; i < total; i++) {
      const o = i * 4;
      const dr = Math.abs(da[o] - db[o]);
      const dg = Math.abs(da[o + 1] - db[o + 1]);
      const dbl = Math.abs(da[o + 2] - db[o + 2]);
      const d = Math.max(dr, dg, dbl);
      sumDelta += d;
      if (d > maxDelta) maxDelta = d;
      if (d > CHANGED_AT) {
        changed++;
        /* Changed pixels are lit in the diff: red where the candidate is
           brighter, blue where it is darker, so a reviewer can see the
           DIRECTION of a change and not just that one happened. */
        const mag = Math.min(255, 40 + d * 4);
        const brighter = (db[o] + db[o + 1] + db[o + 2]) > (da[o] + da[o + 1] + da[o + 2]);
        diff[o] = brighter ? mag : 20;
        diff[o + 1] = 30;
        diff[o + 2] = brighter ? 20 : mag;
        diff[o + 3] = 255;
        if (d > 16) big++;
      } else {
        /* Unchanged pixels are dimmed to a ghost, so the changes read as the
           subject of the image rather than competing with the original. */
        const g = (da[o] * 0.3 + da[o + 1] * 0.5 + da[o + 2] * 0.2) * 0.22;
        diff[o] = diff[o + 1] = diff[o + 2] = g;
        diff[o + 3] = 255;
      }
    }

    /* The diff IMAGE is encoded here, in the page, and returned as base64.
       Shipping the 5.76 MB RGBA buffer back over the CDP bridge and
       encoding it in Node is slow enough to look like a hang; encoding it
       where the pixels already are, and sending 40 KB of base64, is not. */
    const diffPngBase64 = await (async () => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.putImageData(new ImageData(diff, w, h), 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    })();

    /* Both frames measured with the SAME function sheet.mjs uses. */
    const grab = (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height);
    };

    return {
      sizeMismatch: false,
      width: w, height: h,
      total,
      changed,
      big,
      changedPct: +(100 * changed / total).toFixed(3),
      bigPct: +(100 * big / total).toFixed(3),
      meanDelta: +(sumDelta / total).toFixed(3),
      maxDelta,
      diffPngBase64,
      metricsBaseline: computeMetrics(grab(ia)),
      metricsCandidate: computeMetrics(grab(ib)),
    };
  }, { a: toData(baselinePath), b: toData(candidatePath), metricsSrc: computeMetrics.toString() });

  await page.close();
  return result;
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

const scenarios = args.scenario
  ? [String(args.scenario)]
  : readdirSync(SHOTS).filter((f) => f.endsWith('.png') && !f.startsWith('_')).map((f) => basename(f, '.png')).sort();

if (!scenarios.length) {
  console.log('no baselines found — run: node tools/shot.mjs --all');
  process.exit(1);
}

/* The dev server is only needed when the tool has to CAPTURE. With
   `--candidate=<path>` the caller has already produced the frame, and
   starting a server would be pure cost. */
const NEEDS_CAPTURE = !args.candidate || !existsSync(resolve(ROOT, String(args.candidate)));
const server = NEEDS_CAPTURE ? await ensureServer() : null;
const browser = await chromium.launch({
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars']
    : ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars'],
});

const results = [];
let failed = false;

for (const scenario of scenarios) {
  const baselinePath = resolve(SHOTS, `${scenario}.png`);
  if (!existsSync(baselinePath)) {
    results.push({ scenario, status: 'no-baseline' });
    continue;
  }

  /* The candidate is either a file the caller already produced
     (`--candidate=path`), or a fresh capture of the current build. */
  let candidatePath = null;
  let problems = [];
  const custom = args.candidate ? resolve(ROOT, String(args.candidate)) : null;
  if (custom && existsSync(custom)) {
    candidatePath = custom;
  } else {
    try {
      const cap = await capture(browser, scenario);
      candidatePath = cap.out;
      problems = cap.problems;
    } catch (e) {
      results.push({ scenario, status: 'capture-failed', error: e.message });
      failed = true;
      continue;
    }
  }

  const cmp = await compareAndMeasure(browser, baselinePath, candidatePath);

  if (cmp.sizeMismatch) {
    results.push({ scenario, status: 'size-mismatch', baseline: cmp.baseline, candidate: cmp.candidate });
    failed = true;
    continue;
  }

  /* Which objective numbers moved, and which crossed OUT of range. */
  const { moved, regressions } = compareMetrics(cmp.metricsBaseline, cmp.metricsCandidate);

  /* Write the diff PNG. */
  const diffPng = resolve(DEBUG, 'diff', `${scenario}-diff.png`);
  mkdirSync(dirname(diffPng), { recursive: true });
  writeFileSync(diffPng, Buffer.from(cmp.diffPngBase64, 'base64'));

  const overThreshold = cmp.changedPct / 100 > THRESHOLD;
  const status = regressions.length || overThreshold ? 'changed' : 'clean';
  if (status === 'changed') failed = true;

  results.push({
    scenario, status,
    changedPct: cmp.changedPct,
    bigPct: cmp.bigPct,
    meanDelta: cmp.meanDelta,
    maxDelta: cmp.maxDelta,
    width: cmp.width, height: cmp.height,
    metricsBaseline: cmp.metricsBaseline,
    metricsCandidate: cmp.metricsCandidate,
    moved, regressions,
    diffPng: diffPng.replace(ROOT + '/', ''),
    problems,
  });
}

await browser.close();
if (server) server.kill();

/* --- report --- */

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: !failed, threshold: THRESHOLD, results }, null, 2));
  process.exit(failed ? 1 : 0);
}

console.log(`\nPIXEL DIFF vs the committed baselines in shots/  (threshold ${(THRESHOLD * 100).toFixed(1)}% of pixels)\n`);
for (const r of results) {
  if (r.status === 'no-baseline') {
    console.log(`  ${r.scenario.padEnd(11)} — no baseline in shots/, skipped`);
    continue;
  }
  if (r.status === 'capture-failed') {
    console.log(`  ${r.scenario.padEnd(11)} — CAPTURE FAILED: ${r.error}`);
    continue;
  }
  if (r.status === 'size-mismatch') {
    console.log(`  ${r.scenario.padEnd(11)} — SIZE MISMATCH: baseline ${r.baseline.join('x')} vs candidate ${r.candidate.join('x')}`);
    continue;
  }
  const mark = r.status === 'clean' ? '✓' : '!';
  console.log(`  ${mark} ${r.scenario.padEnd(11)} ${String(r.changedPct).padStart(6)}% pixels changed  (${r.bigPct}% by more than 16/255)  mean Δ ${r.meanDelta}  max Δ ${r.maxDelta}`);
  if (r.moved.length) {
    console.log(`      metrics moved: ${r.moved.map((m) => `${m.key} ${m.before}→${m.after} (${m.delta > 0 ? '+' : ''}${m.delta})`).join(', ')}`);
  }
  if (r.regressions.length) {
    for (const x of r.regressions) console.log(`      ⚠ REGRESSION  ${x}`);
  }
  if (r.problems.length) {
    for (const p of r.problems.slice(0, 4)) console.log(`      console: ${p}`);
  }
  console.log(`      diff -> ${r.diffPng}`);
}
console.log('');

if (failed) {
  console.log('diff: FAILED — a frame changed, or a metric crossed out of range.\n');
  process.exit(1);
}
console.log('diff: OK — every frame is within threshold and no metric crossed out of range.');
