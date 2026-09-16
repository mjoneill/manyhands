// #1392 — does a served page grow while left open with its polls live?
//
// Usage: node tools/page-slope.mjs <url> [minutes=30] [out.csv]
//
// Headless Chromium on the page, polls live. Once a minute: a forced GC, then
// V8's retained heap, DOM node and listener counts (Performance.getMetrics)
// and the renderer's RSS from `ps`. Prints a per-minute table and a
// least-squares slope. A SLOPE is the finding, never a snapshot: the first
// minutes are the page filling in.
//
// The standing rule this card asked for: a page that polls is measured for
// slope before it ships. Three runs on 2026-09-15/16 (commons, board, card
// view; then commons for 24 h on the shipped delta poll) are on #1392.
//
// ⚠️ Known confound: HeapProfiler stays enabled for the run so the forced GC
// works; over a day that may itself move the renderer's RSS. Heap numbers are
// after GC and unaffected; treat an RSS slope as needing a profiler-off run.
// Prints a per-minute table and a least-squares slope (bytes/min, nodes/min).
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const [url, minutesArg = '30', out] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/page-slope.mjs <url> [minutes] [out.csv]'); process.exit(2); }
const minutes = Number(minutesArg);

const browser = await puppeteer.launch({ headless: true, args: ['--js-flags=--expose-gc'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const cdp = await page.createCDPSession();
await cdp.send('HeapProfiler.enable');
await cdp.send('Performance.enable');
page.on('dialog', (d) => d.accept());
await page.goto(url, { waitUntil: 'domcontentloaded' });   // prod polls: networkidle0 never idles

const rows = [];
const sample = async (minute) => {
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  // Renderer RSS from the OS — what V8's counters cannot see (images, fonts, canvas, wasm).
  let rssMB = null;
  try {
    const { execSync } = await import('node:child_process');
    const pid = browser.process().pid;
    const out = execSync(`pgrep -P ${pid} -f -- --type=renderer | head -1 | xargs -I{} ps -o rss= -p {}`, { encoding: 'utf8' }).trim();
    if (out) rssMB = +(Number(out) / 1024).toFixed(1);
  } catch (_) { /* leave null */ }
  const row = { minute, heapMB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, docs: m.Documents, frames: m.Frames, rssMB };
  rows.push(row);
  console.log(`${String(minute).padStart(4)} min  heap ${row.heapMB} MB  rss ${row.rssMB} MB  nodes ${row.nodes}  listeners ${row.listeners}  docs ${row.docs}`);
};

await sample(0);
for (let i = 1; i <= minutes; i++) {
  await new Promise((r) => setTimeout(r, 60_000));
  await sample(i);
}
await browser.close();

const slope = (key) => {
  const n = rows.length, xs = rows.map((r) => r.minute), ys = rows.map((r) => r[key]);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den ? num / den : 0;
};
console.log(`\nslope over ${minutes} min: heap ${slope('heapMB').toFixed(3)} MB/min · rss ${slope('rssMB').toFixed(3)} MB/min · nodes ${slope('nodes').toFixed(1)}/min · listeners ${slope('listeners').toFixed(1)}/min`);
console.log(`first→last: heap ${rows[0].heapMB}→${rows.at(-1).heapMB} MB · nodes ${rows[0].nodes}→${rows.at(-1).nodes} · listeners ${rows[0].listeners}→${rows.at(-1).listeners}`);
if (out) fs.writeFileSync(out, 'minute,heapMB,rssMB,nodes,listeners,docs,frames\n' + rows.map((r) => [r.minute, r.heapMB, r.rssMB, r.nodes, r.listeners, r.docs, r.frames].join(',')).join('\n') + '\n');
