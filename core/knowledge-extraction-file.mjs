/**
 * #1854 slice 1 — a FILE the owner names goes through the same extraction job a shared link does (#1810).
 *
 * The file is converted ON THIS MACHINE (AGENTS rule: course and private files never go to online converters), the
 * converted text is kept on disk (pointer + hash, like a fetched page), and the job is the same checkpointed LangGraph
 * run, so publishing, the anchor check and the ledger are unchanged. The text goes to the cloud model like a fetched
 * page does (the owner's ruling for course material, decision 20ec81a8).
 *
 * Three things are new:
 *   - the job id comes from the ORIGINAL file's bytes, so a renamed copy is the same job and is never paid for twice;
 *   - the Source's url is `urn:sha256:<original>`: it names the file that was asked about, not the converted text;
 *   - each published claim is cited by PAGE. pdftotext ends every page with a form feed, and blocks are lines, so a
 *     block's page is one more than the form feeds before its text. (Publishing the page into the graph is a later
 *     slice; today it is in the summary, computable from the kept text by anyone.)
 *
 * Slice 1 converts PDF only. Every other format is refused before any model call, naming what is supported.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ingestSource } from './knowledge-extraction.mjs';

const ENTITY = 'https://scrumboard.local/entity/';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * #1854 slice 2: pdftotext breaks lines where the page did, mid-sentence, and a block is a LINE. A model quoting a whole
 * sentence then crosses a block and fails the anchor check (the first live run: 14 of 17 first-pass spans needed a
 * repair). Rejoin a wrapped line onto the next unless it ends a sentence, is much shorter than a typical line (a heading
 * or a paragraph's last line), or the next line is blank or starts a new page (a form feed). A trailing hyphen or dash
 * joins with no space. Page breaks are never crossed, so pageOfBlock is unchanged.
 */
export function rejoinWrapped(text) {
  const lines = String(text).split(/\r?\n/);
  const lens = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  const typical = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const ends = (l) => /[.!?:;]["'”’)\]]?\s*$/.test(l);
  const out = [];
  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : null;
    const joinable = prev !== null && prev.trim() && line.trim() && !line.startsWith('\f')
      && !ends(prev) && prev.trim().length >= 0.6 * typical;
    if (!joinable) { out.push(line); continue; }
    out[out.length - 1] = /[-\u2010\u2013\u2014]$/.test(prev.trimEnd()) ? prev.trimEnd() + line.trimStart() : `${prev.trimEnd()} ${line.trimStart()}`;
  }
  return out.join('\n');
}

/** What a format's conversion IS, versioned: a change to it is a new job for the same bytes (the text the model sees changed). */
export const CONVERSION = Object.freeze({ '.pdf': 'pdftotext+rejoin@2' });
const LEGACY_CONVERSION = 'pdftotext@1';   // slice 1's raw lines: its jobs keep their original ids

const CONVERTERS = Object.freeze({
  '.pdf': { from: 'application/pdf', converter: CONVERSION['.pdf'], run: (file, exec) => rejoinWrapped(exec('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) },
});

/** Convert a local file to text on this machine. Throws, naming the supported extensions, for anything else. */
export function convertFile(file, { exec = execFileSync } = {}) {
  const ext = path.extname(file).toLowerCase();
  const c = CONVERTERS[ext];
  if (!c) throw new Error(`no local converter for ${ext || 'a file without an extension'} yet (supported: ${Object.keys(CONVERTERS).join(', ')}); nothing was sent anywhere`);
  const text = c.run(file, exec);
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${c.converter} produced no text from ${path.basename(file)} (a scanned PDF needs OCR, which this machine does not have yet); nothing was sent anywhere`);
  return { text, from: c.from, converter: c.converter };
}

/** The 1-based page a block (a line) of converted text sits on: one more than the form feeds before its text. */
export function pageOfBlock(blocks, i) {
  let ff = 0;
  for (let k = 0; k <= i && k < blocks.length; k += 1) {
    const b = blocks[k];
    // a form feed inside block i that comes AFTER some of its text would put that text on the earlier page; pdftotext
    // writes the form feed at the start of the next page's first line, so counting every one up to and including block i is right
    for (const ch of b) if (ch === '\f') ff += 1;
  }
  return ff + 1;
}

/** The job id for a file: from its BYTES, never its path. */
export function fileJobId(file, conversion = CONVERSION[path.extname(file).toLowerCase()] ?? LEGACY_CONVERSION) {
  const base = `job-file-${sha256(fs.readFileSync(file))}`;
  return conversion === LEGACY_CONVERSION ? base : `${base}.${conversion.replace(/[^A-Za-z0-9]+/g, '-')}`;
}

/**
 * Run one named file through the extractor. `askedIn` is the post that asked for it (the Source's wasDerivedFrom).
 * A file whose job already has an outcome is not run again: the summary says so and nothing is paid.
 */
// nothing ticks a file: a failed run resumes from its checkpoint only when the same bytes are run again
const RETRY_HOW = 'run the same file again to resume';

export async function extractFile({ file, extractor, sourcesDir, modelKey, prompt, askedIn, exec, report = null, now = () => new Date().toISOString() }) {
  for (const [k, v] of Object.entries({ file, extractor, sourcesDir, modelKey, askedIn })) if (!v) throw new Error(`extractFile needs ${k}`);
  if (typeof prompt !== 'string') throw new Error('extractFile needs the prompt text');
  const converted = convertFile(file, exec ? { exec } : {});   // refuses an unsupported format BEFORE any state read or model call
  const original = sha256(fs.readFileSync(file));
  const jobId = fileJobId(file);
  const known = await extractor.state({ jobId });
  if (known.outcome) return { file: path.basename(file), jobId, runId: known.runId, skipped: `known: ${known.outcome}` };
  // #1862's announcer: a start, then a finish or a failure. A report never fails the run: its errors are only counted.
  let reportErrors = 0;
  const tell = async (e) => {
    if (typeof report !== 'function') return;
    try { const r = await report(e); if (r && r.ok === false) reportErrors += 1; } catch { reportErrors += 1; }
  };
  const label = `${path.basename(file)} (urn:sha256:${original})`;
  const finish = async (r, blocks) => {
    const published = r.published.map((p) => ({ ...p, page: pageOfBlock(blocks, p.block) }));
    await tell({ kind: 'finish', url: label, result: { ...r, published } });
    return { file: path.basename(file), jobId, runId: r.runId, outcome: r.outcome, converter: converted.converter, from: converted.from,
      original: `sha256:${original}`, published, rejected: r.rejected.length, ...(typeof report === 'function' ? { reportErrors } : {}) };
  };
  // A job that DIED mid-run has a checkpoint with a next node. The id comes from the bytes, so nothing else would ever
  // pick it up: resume it from the checkpoint (the model is not asked again).
  if (Array.isArray(known.next) && known.next.length) {
    await tell({ kind: 'start', url: label, modelKey, jobId, resumed: true });
    let r;
    try { r = await extractor.resume({ jobId }); } catch (e) { await tell({ kind: 'fail', url: label, reason: `resume: ${e?.message ?? e}`, retry: true, retryHow: RETRY_HOW }); throw e; }
    return finish(r, ingestSource({ text: converted.text }).blocks);
  }

  fs.mkdirSync(sourcesDir, { recursive: true });
  const kept = path.join(sourcesDir, `${sha256(converted.text)}.txt`);
  if (!fs.existsSync(kept)) fs.writeFileSync(kept, converted.text);
  const source = ingestSource({ text: converted.text, url: `urn:sha256:${original}`, contentUrl: `file://${path.resolve(kept)}`,
    encodingFormat: 'text/plain', retrievedAt: now(), wasDerivedFrom: `${ENTITY}${askedIn}` });
  await tell({ kind: 'start', url: label, modelKey, jobId });
  let r;
  try { r = await extractor.run({ source, modelKey, prompt, jobId }); } catch (e) {
    // the checkpoint survives a death mid-run: running the same file again resumes it (above)
    await tell({ kind: 'fail', url: label, reason: `run: ${e?.message ?? e}`, retry: true, retryHow: RETRY_HOW });
    throw e;
  }
  return { ...(await finish(r, source.blocks)), contentUrl: source.contentUrl };
}
