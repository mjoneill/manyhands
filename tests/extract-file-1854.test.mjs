/**
 * #1854 slice 1 — a FILE the owner names goes through the same extraction job a shared link does,
 * converted on this machine, and every published claim is cited by PAGE.
 *
 * Sabotage profiles (each must turn a row red):
 *   (a) job id from the path, not the bytes  → X2 fails (a renamed copy would be paid for twice)
 *   (b) skip the known-outcome check          → X3 fails (a second run pays again)
 *   (c) count pages from 0                     → P1 fails
 *   (d) accept any extension                   → X4 fails (an unconverted binary would reach the model)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { convertFile, pageOfBlock, extractFile, fileJobId } from '../core/knowledge-extraction-file.mjs';
import { blocksOf } from '../core/knowledge-extraction.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xfile-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A real two-page PDF, written by hand: pdftotext repairs the cross-reference table, so offsets need not be exact. */
function twoPagePdf(dir, name = 'two.pdf') {
  const page = (n, text) => `${n} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents ${n + 1} 0 R /Resources << /Font << /F1 9 0 R >> >> >> endobj\n`
    + `${n + 1} 0 obj << /Length ${text.length + 30} >> stream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream endobj\n`;
  const pdf = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
    + '2 0 obj << /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >> endobj\n'
    + page(3, 'The first page says one thing plainly.')
    + page(5, 'The second page makes a different claim.')
    + '9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n'
    + 'trailer << /Root 1 0 R >>\n%%EOF\n';
  const f = path.join(dir, name);
  fs.writeFileSync(f, pdf);
  return f;
}
const havePdftotext = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** A fake extractor with the real one's surface: state, run. Records every run, so "paid twice" is countable. */
function fakeExtractor() {
  const jobs = new Map(); const runs = [];
  return {
    runs,
    async state({ jobId }) { const j = jobs.get(jobId); return { jobId, outcome: j?.outcome ?? null, runId: j?.runId ?? null, next: [] }; },
    async run({ source, jobId }) {
      runs.push({ jobId, source });
      const line = source.blocks.findIndex((b) => b.includes('second page'));
      const r = { runId: `run-${runs.length}`, outcome: 'complete', published: [{ iri: 'urn:x:1', block: line, type: 'empirical', predicate: 'scrum:relatedTo' }], rejected: [] };
      jobs.set(jobId, r); return { ...r, jobId };
    },
  };
}

test('P1 pageOfBlock: a block after the first form feed is on page 2, and the first block is on page 1', () => {
  const blocks = blocksOf('one\ntwo\n\fthree\nfour\n\ffive');
  assert.deepEqual(blocks.map((_, i) => pageOfBlock(blocks, i)), [1, 1, 2, 2, 3]);
});

test('C1 a real PDF converts on this machine to text that keeps its page breaks', { skip: !havePdftotext && 'pdftotext is not installed' }, () => {
  const got = convertFile(twoPagePdf(tmp()));
  assert.equal(got.converter, 'pdftotext');
  assert.equal(got.from, 'application/pdf');
  assert.match(got.text, /first page says one thing/);
  const blocks = blocksOf(got.text);
  const i = blocks.findIndex((b) => b.includes('second page'));
  assert.equal(pageOfBlock(blocks, i), 2, `the second page's text is cited as page 2: ${JSON.stringify(got.text)}`);
});

test('X1 a named PDF runs ONE extraction job; the summary cites each published claim by page; the source points at the original by hash', { skip: !havePdftotext && 'pdftotext is not installed' }, async () => {
  const d = tmp(); const ex = fakeExtractor();
  const file = twoPagePdf(d);
  const out = await extractFile({ file, extractor: ex, sourcesDir: path.join(d, 'sources'), modelKey: 'm', prompt: 'p', askedIn: 'post-1' });
  assert.equal(ex.runs.length, 1);
  assert.equal(out.outcome, 'complete');
  assert.deepEqual(out.published.map((p) => p.page), [2]);
  const src = ex.runs[0].source;
  const pdfHash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(src.url, `urn:sha256:${pdfHash}`, 'the source names the ORIGINAL bytes, not the converted text');
  assert.equal(src.wasDerivedFrom, 'https://scrumboard.local/entity/post-1');
  assert.ok(fs.existsSync(new URL(src.contentUrl)), 'the converted text is kept on disk');
});

test('X2 the job id comes from the file BYTES: a renamed copy is the same job', { skip: !havePdftotext && 'pdftotext is not installed' }, () => {
  const d = tmp();
  const a = twoPagePdf(d, 'a.pdf');
  const b = path.join(d, 'renamed.pdf'); fs.copyFileSync(a, b);
  assert.equal(fileJobId(a), fileJobId(b));
});

test('X3 a file whose job already has an outcome is NOT run again (each run is a paid call)', { skip: !havePdftotext && 'pdftotext is not installed' }, async () => {
  const d = tmp(); const ex = fakeExtractor(); const file = twoPagePdf(d);
  const args = { file, extractor: ex, sourcesDir: path.join(d, 'sources'), modelKey: 'm', prompt: 'p', askedIn: 'post-1' };
  await extractFile(args);
  const again = await extractFile(args);
  assert.equal(ex.runs.length, 1, 'one paid call, not two');
  assert.equal(again.skipped, 'known: complete');
});

test('X4 a format with no local converter is refused before any model call, naming what is supported', async () => {
  const d = tmp(); const ex = fakeExtractor();
  const f = path.join(d, 'deck.pptx'); fs.writeFileSync(f, 'PK\u0003\u0004 not text');
  await assert.rejects(extractFile({ file: f, extractor: ex, sourcesDir: d, modelKey: 'm', prompt: 'p', askedIn: 'post-1' }), /no local converter for \.pptx.*\.pdf/);
  assert.equal(ex.runs.length, 0);
});
