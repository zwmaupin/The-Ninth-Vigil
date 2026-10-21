#!/usr/bin/env node
/**
 * Contact sheet + histogram analysis for the critic loop.
 *
 *   node tools/sheet.mjs                 # tile shots/*.png into shots/_sheet.png
 *   node tools/sheet.mjs --analyze       # also print objective frame statistics
 *   node tools/sheet.mjs --check         # analyze, and FAIL if any frame is out of range
 *
 * The analysis catches the failures a language model reviewing a PNG can miss:
 * lifted blacks, no true highlights, low contrast, oversaturation, dead frames.
 *
 * The thresholds and the metric definitions live in `tools/frame-metrics.mjs`,
 * which `tools/diff.mjs` imports too. One copy, so the two tools cannot drift
 * apart — the project has already paid for that lesson once, with four
 * modules each keeping their own copy of a grade constant that had moved.
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { computeMetrics, evaluateMetrics, formatMetricsLine } from './frame-metrics.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'shots');
const analyze = process.argv.includes('--analyze');
/* --check makes the analysis a GATE: it exits non-zero when any frame is out
   of range, so `npm run check` can fail a build rather than just report.
   The default stays a report, because a tool that fails on every pre-existing
   warning is a tool nobody runs. */
const check = process.argv.includes('--check');
if (check) { /* --check implies --analyze */ }
const doAnalyze = analyze || check;

const files = readdirSync(SHOTS)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
  .sort();

if (!files.length) {
  console.log('no shots found — run: node tools/shot.mjs --all');
  process.exit(1);
}

const imgs = files.map((f) => ({
  name: basename(f, '.png'),
  data: 'data:image/png;base64,' + readFileSync(resolve(SHOTS, f)).toString('base64'),
}));

const cols = Math.min(3, imgs.length);
const cellW = 640;
const cellH = 360;
const rows = Math.ceil(imgs.length / cols);

const html = `<!doctype html><html><body style="margin:0;background:#0a0a0c">
<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:2px;width:max-content">
${imgs
  .map(
    (i) => `<div style="position:relative;width:${cellW}px;height:${cellH}px;overflow:hidden">
  <img src="${i.data}" style="width:100%;height:100%;object-fit:cover;display:block">
  <div style="position:absolute;left:0;bottom:0;background:rgba(0,0,0,.72);color:#e8c88a;
    font:11px/1.9 monospace;padding:0 10px;letter-spacing:.16em">${i.name.toUpperCase()}</div>
</div>`
  )
  .join('\n')}
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: cols * cellW + (cols - 1) * 2, height: rows * cellH + (rows - 1) * 2 },
});
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: resolve(SHOTS, '_sheet.png') });

if (doAnalyze) {
  console.log('\nFRAME ANALYSIS (objective — catches what the eye rationalizes away)\n');
  let outOfRange = 0;
  for (const i of imgs) {
    const stats = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      return x.getImageData(0, 0, img.width, img.height);
    }, i.data);

    const m = computeMetrics(stats);
    const warn = evaluateMetrics(m);

    console.log(formatMetricsLine(i.name, m));
    for (const w of warn) console.log(`      ⚠  ${w}`);
    if (!warn.length) console.log('      ✓  objective value/color metrics in AAA range');
    if (warn.length) outOfRange++;
  }
  console.log('');

  if (check && outOfRange) {
    console.log(`sheet: FAILED — ${outOfRange} of ${imgs.length} frame(s) out of range.\n`);
    await browser.close();
    process.exit(1);
  }
  if (check) console.log(`sheet: OK — all ${imgs.length} frames in range.`);
}

await browser.close();
console.log(`contact sheet -> shots/_sheet.png  (${imgs.length} frames)`);
