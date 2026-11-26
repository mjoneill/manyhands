/**
 * #1961 — a Word file's claims are cited by an address a reader can find in the document: the heading path, then the
 * paragraph within that heading ("Evaluation › Method ¶2"), never "block N".
 *
 * textutil (slice 3's converter) cannot give this: its .docx reader drops heading styles, and its HTML output marks a
 * heading only as bold text. So the conversion reads the .docx's own XML (word/document.xml and word/styles.xml, unzipped on
 * this machine) and writes each heading as a Markdown-style "#" line. The address is then DERIVED from the kept text alone,
 * as a PDF's page is derived from its form feeds: the reading page needs nothing stored beside the text.
 *
 * Sabotage profiles (each must turn a row red):
 *   (a) treat every paragraph as body (ignore styles)      → H1, H3, H4 fail
 *   (b) keep a heading on the stack after a sibling        → S1 fails ("Scope" would stay above "Evaluation")
 *   (c) count the heading line itself as a paragraph       → S1 fails (¶ numbers off by one)
 *   (d) leave a body line that starts with "#" unescaped   → H2 fails (it would be read back as a heading)
 *   (e) publish no section from extractFile                → H4 fails
 *   (f) the reading page ignores sections                  → H5 fails
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { convertFile, extractFile, docxText, CONVERSION } from '../core/knowledge-extraction-file.mjs';
import { blocksOf, sectionOfBlock, addressOf } from '../core/knowledge-blocks.mjs';
import { finishBody } from '../core/knowledge-extraction-report.mjs';
import { pagesOf, shapeReading } from '../core/knowledge-reading.mjs';

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xdocx-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text, style = null) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
// Word's own style ids are "Heading1".., but a heading is known by the style's NAME ("heading 1"), which a localized or
// renamed id still carries. "Custom2" below is a heading only because its name says so.
const STYLES = `<w:styles ${W}>`
  + '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Custom2"><w:name w:val="heading 2"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>'
  + '</w:styles>';
const DOC = `<w:document ${W}><w:body>`
  + para('Introduction', 'Heading1')
  + para('Intro says one thing.')
  + para('Scope', 'Custom2')
  + para('Scope says &amp; limits &lt;this&gt;.')
  + para('Evaluation', 'Heading1')
  + para('')
  + para('Method', 'Custom2')
  + para('Method para one.')
  + `<w:p><w:r><w:t>Method para </w:t></w:r><w:r><w:t>two, in two runs.</w:t></w:r></w:p>`
  + '</w:body></w:document>';

test('H1 docxText writes one paragraph per line and each heading as "#" × its level, decoding entities and joining runs', () => {
  const text = docxText({ documentXml: DOC, stylesXml: STYLES });
  assert.deepEqual(blocksOf(text), [
    '# Introduction', 'Intro says one thing.', '## Scope', 'Scope says & limits <this>.',
    '# Evaluation', '', '## Method', 'Method para one.', 'Method para two, in two runs.',
  ]);
  assert.ok(!text.includes('\f'), 'a Word file has no pages of its own');
});

test('H2 a body paragraph that starts with "#" is escaped, so it is never read back as a heading', () => {
  const text = docxText({ documentXml: `<w:document ${W}><w:body>${para('Top', 'Heading1')}${para('# not a heading')}${para('After.')}</w:body></w:document>`, stylesXml: STYLES });
  const blocks = blocksOf(text);
  assert.equal(blocks[1], '\\# not a heading');
  assert.equal(addressOf(sectionOfBlock(blocks, 2)), 'Top ¶2');
});

test('S1 sectionOfBlock: the heading path above a block, and the paragraph within it (headings and blank lines not counted)', () => {
  const blocks = blocksOf(docxText({ documentXml: DOC, stylesXml: STYLES }));
  const at = (i) => addressOf(sectionOfBlock(blocks, i));
  assert.equal(at(1), 'Introduction ¶1');
  assert.equal(at(3), 'Introduction › Scope ¶1');
  assert.equal(at(7), 'Evaluation › Method ¶1');
  assert.equal(at(8), 'Evaluation › Method ¶2');
  assert.equal(at(6), 'Evaluation › Method', 'a claim on a heading line is addressed by the heading itself');
  assert.equal(sectionOfBlock(blocksOf('plain\ntext with no headings'), 1), null, 'a text with no heading lines has no section: the caller keeps the block');
});

test('S2 a heading that skips a level still nests under the nearest shallower one', () => {
  const blocks = blocksOf('# A\n### Deep\nBody.\n## Sibling\nMore.');
  assert.equal(addressOf(sectionOfBlock(blocks, 2)), 'A › Deep ¶1');
  assert.equal(addressOf(sectionOfBlock(blocks, 4)), 'A › Sibling ¶1');
});

// ── a real .docx on disk: the converter unzips its XML on this machine ──
const have = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch (e) { return e?.status != null; } };
const haveZip = have('zip', ['-h']) && have('unzip', ['-h']);
const SKIP = !haveZip && 'UNAVAILABLE: no zip/unzip on this machine (a skip is not a pass)';

function writeDocx(dir) {
  const src = path.join(dir, 'src'); fs.mkdirSync(path.join(src, 'word'), { recursive: true });
  fs.writeFileSync(path.join(src, '[Content_Types].xml'), '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  fs.writeFileSync(path.join(src, 'word', 'document.xml'), DOC);
  fs.writeFileSync(path.join(src, 'word', 'styles.xml'), STYLES);
  const out = path.join(dir, 'report.docx');
  execFileSync('zip', ['-q', '-r', out, '[Content_Types].xml', 'word'], { cwd: src });
  return out;
}

test('H3 a real .docx converts with its headings kept, under a NEW versioned conversion (a new job for the same bytes)', { skip: SKIP }, () => {
  const got = convertFile(writeDocx(tmp()));
  assert.equal(got.converter, CONVERSION['.docx']);
  assert.notEqual(got.converter, 'textutil-txt@1', 'the text the model sees changed, so the conversion is a new version');
  assert.equal(got.paged, false);
  assert.deepEqual(blocksOf(got.text).slice(0, 3), ['# Introduction', 'Intro says one thing.', '## Scope']);
});

test('H4 a .docx run publishes each claim\'s section address, names it in the finish post, and still names no page', { skip: SKIP }, async () => {
  const d = tmp(); const events = [];
  const ex = {
    promptVersion: () => 'v1',
    async state({ jobId }) { return { jobId, outcome: null, runId: null, next: [] }; },
    async run({ source, jobId }) {
      const block = source.blocks.indexOf('Method para two, in two runs.');
      return { jobId, runId: 'run-1', outcome: 'complete', rejected: [],
        published: [{ iri: 'urn:x:1', block, type: 'empirical', predicate: 'scrum:relatedTo', subject: 'concept:method', object: 'concept:runs' }] };
    },
  };
  const out = await extractFile({ file: writeDocx(d), extractor: ex, sourcesDir: path.join(d, 's'), modelKey: 'm', prompt: 'p', askedIn: 'post-1',
    report: async (e) => { events.push(e); return { ok: true }; } });
  assert.equal(out.published[0].section, 'Evaluation › Method ¶2');
  assert.equal(out.published[0].page, undefined);
  const body = finishBody(events.find((e) => e.kind === 'finish'));
  assert.match(body, /§ Evaluation › Method ¶2/, body);
  assert.doesNotMatch(body, /page \d/, body);
});

test('H5 the reading page gives a .docx claim its section, derived from the kept text alone; pages stay "none"', () => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'sources'));
  const text = docxText({ documentXml: DOC, stylesXml: STYLES });
  const hex = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(dir, 'sources', `${hex}.txt`), text);
  const pageOf = pagesOf({ sourceIri: `https://scrumboard.local/source/${hex}`, url: 'urn:sha256:' + 'b'.repeat(64), dataDir: dir });
  const claimRow = (id, block) => ({ a: { value: `https://scrumboard.local/assertion/${id}` }, pass: { value: `https://scrumboard.local/source/${hex}/block/${block}` } });
  const r = shapeReading({ header: { sourceIri: `https://scrumboard.local/source/${hex}`, source: { url: 'urn:sha256:' + 'b'.repeat(64) } },
    claimRows: [claimRow('a', 8), claimRow('b', 1)], linkRows: [], cardOf: () => null, pageOf });
  assert.equal(r.source.pages, 'none');
  assert.equal(r.source.hasPages, false);
  assert.deepEqual(r.claims.map((c) => [c.block, c.page, c.section]), [[1, null, 'Introduction ¶1'], [8, null, 'Evaluation › Method ¶2']]);
});

test('H6 kept text from the OLD textutil conversion (no heading lines) still reads as before: no section, block only', () => {
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'sources'));
  const text = 'A heading\nThe first paragraph.\nThe second paragraph.\n';
  const hex = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(dir, 'sources', `${hex}.txt`), text);
  const pageOf = pagesOf({ sourceIri: `https://scrumboard.local/source/${hex}`, url: 'urn:sha256:' + 'c'.repeat(64), dataDir: dir });
  const r = shapeReading({ header: { sourceIri: `https://scrumboard.local/source/${hex}`, source: { url: 'urn:sha256:' + 'c'.repeat(64) } },
    claimRows: [{ a: { value: 'https://scrumboard.local/assertion/a' }, pass: { value: `https://scrumboard.local/source/${hex}/block/2` } }], linkRows: [], cardOf: () => null, pageOf });
  assert.equal(r.source.pages, 'none');
  assert.equal(r.claims[0].section, null);
});
