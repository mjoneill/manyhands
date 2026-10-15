#!/usr/bin/env node
/**
 * scripts/scan-fixed-dates-1696.mjs — #1696. Finds a FIXED CALENDAR DATE that flows, inside one test file, into something a real-clock process consumes.
 *
 * Why: a fixed date is harmless when only pure functions see it, and a time bomb when it reaches a server or process that judges it against the real clock.
 * The instance: a fixed 2026-09-18 anchor gave credentials a fixed expiry that crossed a 72 h window on 2026-10-15 and turned a served test red.
 *
 * Usage:  node scripts/scan-fixed-dates-1696.mjs [--json] <file-or-directory>...
 *   a directory is searched (recursively) for *.test.mjs; a named file is read whatever its extension.
 * Exit:   0 every file was read and nothing is flagged · 1 something is flagged · 2 it could not check (a file did not parse, a path is unreadable,
 *         no path was given, or no file was found). It never reports a clean pass for a check it could not make.
 *
 * What it does. Each file is parsed (acorn) and split into its top-level statements (each test(...) call, each top-level const or function).
 *   DATE-DERIVED  a statement that contains a literal calendar date (an ISO 20yy-mm-dd string, outside a test's title) or references a name declared by a date-derived statement.
 *   CONSUMER      a statement that calls a real-clock starter (startRestServer, startMcpServer, startExecutor, startExecutorOnCopy, world, worldWithEnv, labelWorld, spawn,
 *                 spawnSync, execFile, execFileSync, fork, launch) or references a name declared by a statement that does.
 *   FLAGGED       a statement that is both. A helper that only builds a date, or only starts a process, is not flagged by itself.
 *
 * What it does NOT do, and says in every report: it is a LEXICAL GUARD, NOT A PROOF. It cannot follow a date computed at run time or read from data, a date defined in another
 * file (an import is not followed), a date written as numbers (Date.UTC(2026, 8, 18), new Date(2026, 8, 18), an epoch literal), with a field list a field set by assignment or under a computed key, or a default argument that every caller overrides (so a fixed-then-fixed file may still be flagged). A clean report is not a clearance.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const GUARD = 'This is a lexical guard, not a proof: it cannot follow a date computed at run time or read from data, nor one defined in another file (an import is not followed), nor a date written as numbers (Date.UTC(2026, 8, 18), new Date(2026, 8, 18), an epoch literal), nor (with a field list) a field set by assignment (card.expiresAt = WHEN) or under a computed key, '
  + 'nor tell that every caller overrides a fixed default. A clean report is not a clearance.';

const CONSUMERS = new Set(['startRestServer', 'startMcpServer', 'startExecutor', 'startExecutorOnCopy', 'world', 'worldWithEnv', 'labelWorld', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'launch']);
const TESTERS = new Set(['test', 'it', 'describe', 'suite']);
const ISO = /\b20\d\d-\d\d-\d\d/;

/** Every Identifier / literal in `node`, with the parent context needed to skip property keys and test titles. */
function walk(node, parent, key, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, node, k, visit);
    else if (v && typeof v.type === 'string') walk(v, node, k, visit);
  }
}

function declaredNames(stmt) {
  const out = [];
  const pattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') out.push(p.name);
    else if (p.type === 'ObjectPattern') for (const pr of p.properties) pattern(pr.type === 'RestElement' ? pr.argument : pr.value);
    else if (p.type === 'ArrayPattern') for (const e of p.elements) pattern(e);
    else if (p.type === 'AssignmentPattern') pattern(p.left);
    else if (p.type === 'RestElement') pattern(p.argument);
  };
  let s = stmt;
  if ((s.type === 'ExportNamedDeclaration' || s.type === 'ExportDefaultDeclaration') && s.declaration) s = s.declaration;
  if (s.type === 'VariableDeclaration') for (const d of s.declarations) pattern(d.id);
  else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) out.push(s.id.name);
  else if (s.type === 'ImportDeclaration') for (const sp of s.specifiers) out.push(sp.local.name);
  return out;
}

const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/** Names bound by a binding pattern. */
function patternNames(p, out) {
  if (!p) return out;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) patternNames(e, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

/** let / const / class / function names declared directly in a list of statements (block scope). */
function lexicalNames(body, out = new Set()) {
  for (const st of body) {
    if (st.type === 'VariableDeclaration' && st.kind !== 'var') for (const d of st.declarations) patternNames(d.id, out);
    else if ((st.type === 'ClassDeclaration' || st.type === 'FunctionDeclaration') && st.id) out.add(st.id.name);
  }
  return out;
}

/** var names declared anywhere in a function body, not entering nested functions (function scope). */
function varNames(node, out = new Set()) {
  if (!node || typeof node.type !== 'string' || isFn(node)) return out;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') for (const d of node.declarations) patternNames(d.id, out);
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) varNames(c, out); else if (v && typeof v.type === 'string') varNames(v, out);
  }
  return out;
}

/**
 * The Identifier nodes in `stmt` that are REFERENCES to a name not bound by a function parameter, a let/const/class/function in an enclosing block, a for-binding or a catch parameter inside
 * the same statement. A name bound locally is a different variable from a top-level name of the same spelling, so it must not make a chain to it. (The statement's own top-level declaration is not
 * a local scope: it is the name other statements refer to.)
 */
function freeIdentifiers(stmt) {
  const free = new Set();
  const visit = (n, parent, key, scopes) => {
    if (!n || typeof n.type !== 'string') return;
    let inner = scopes;
    const push = (names) => { inner = [...scopes, names]; };
    if (isFn(n)) {
      const names = new Set(); for (const pa of n.params) patternNames(pa, names);
      if (n.type === 'FunctionExpression' && n.id) names.add(n.id.name);
      if (n.body.type === 'BlockStatement') varNames(n.body, names);
      push(names);
    } else if (n.type === 'BlockStatement' || n.type === 'StaticBlock') push(lexicalNames(n.body));
    else if (n.type === 'SwitchStatement') push(lexicalNames(n.cases.flatMap((c) => c.consequent)));
    else if (n.type === 'CatchClause') push(patternNames(n.param, new Set()));
    else if ((n.type === 'ForStatement' && n.init && n.init.type === 'VariableDeclaration' && n.init.kind !== 'var') || ((n.type === 'ForInStatement' || n.type === 'ForOfStatement') && n.left.type === 'VariableDeclaration' && n.left.kind !== 'var')) {
      const d = n.type === 'ForStatement' ? n.init : n.left; const names = new Set(); for (const dd of d.declarations) patternNames(dd.id, names); push(names);
    } else if (n.type === 'ClassExpression' && n.id) push(new Set([n.id.name]));
    if (n.type === 'Identifier') {
      const isPropKey = parent && ((parent.type === 'MemberExpression' && key === 'property' && !parent.computed) || (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) || (parent.type === 'MethodDefinition' && key === 'key') || (parent.type === 'PropertyDefinition' && key === 'key' && !parent.computed));
      if (!isPropKey && !scopes.some((sc) => sc.has(n.name))) free.add(n);
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c, n, k, inner); else if (v && typeof v.type === 'string') visit(v, n, k, inner);
    }
  };
  visit(stmt, null, null, []);
  return free;
}

function titleOf(stmt, src) {
  if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression' && stmt.expression.callee.type === 'Identifier' && TESTERS.has(stmt.expression.callee.name)) {
    const a = stmt.expression.arguments[0];
    if (a && a.type === 'Literal' && typeof a.value === 'string') return a.value;
    if (a && a.type === 'TemplateLiteral') return a.quasis.map((q) => q.value.cooked).join('${}');
  }
  const d = declaredNames(stmt);
  if (stmt.type === 'FunctionDeclaration') return `function ${d[0]}`;
  if (stmt.type === 'VariableDeclaration') return `${stmt.kind} ${d.join(', ')}`;
  return src.slice(stmt.start, Math.min(stmt.end, stmt.start + 60)).replace(/\s+/g, ' ');
}

/** One file → its statements with names, references, date literals and consumer calls. */
function analyse(file, src) {
  const acorn = require('acorn');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true, allowAwaitOutsideFunction: true });
  const stmts = ast.body.map((stmt) => {
    const skip = new Set();   // test-title literals are text, not data
    walk(stmt, null, null, (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && TESTERS.has(n.callee.name) && n.arguments[0]) { skip.add(n.arguments[0]); }
    });
    const refs = new Set(); const dates = []; const calls = []; const props = []; const free = freeIdentifiers(stmt);
    walk(stmt, null, null, (n, parent, key) => {
      if (skip.has(n)) return;
      if (n.type === 'Identifier') {
        if (free.has(n)) refs.add(n.name);
      } else if (n.type === 'Literal' && typeof n.value === 'string' && ISO.test(n.value)) {
        dates.push({ line: n.loc.start.line, value: n.value });
      } else if (n.type === 'TemplateElement' && ISO.test(n.value.cooked ?? '')) {
        dates.push({ line: n.loc.start.line, value: n.value.cooked });
      } else if (n.type === 'Property' && !n.computed && n.kind === 'init') {
        const key = n.key.type === 'Identifier' ? n.key.name : (n.key.type === 'Literal' ? String(n.key.value) : null);
        if (key) {
          const vrefs = new Set(); let vdate = false;
          walk(n.shorthand ? n.key : n.value, null, null, (m, pp, kk) => {
            if (m.type === 'Identifier') { if (free.has(m)) vrefs.add(m.name); }
            else if (m.type === 'Literal' && typeof m.value === 'string' && ISO.test(m.value)) vdate = true;
          });
          props.push({ key, line: n.loc.start.line, vrefs, vdate });
        }
      }
      if (n.type === 'CallExpression') {
        const c = n.callee;
        const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier' ? c.property.name : null);
        if (name && CONSUMERS.has(name)) calls.push({ name, line: n.loc.start.line });
      }
    });
    return { file, line: stmt.loc.start.line, title: titleOf(stmt, src), text: src.slice(stmt.start, stmt.end), declares: declaredNames(stmt), refs, dates, calls, props };
  });
  return stmts;
}

/** Date-derived and consumer-reaching closures over one file's statements, then the flagged ones with a chain to each end. */
function flagFile(file, src, fields) {
  const stmts = analyse(file, src);
  const byName = new Map();
  for (const s of stmts) for (const n of s.declares) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(s); }
  const dateDerived = new Set(stmts.filter((s) => s.dates.length));
  const reaches = new Set(stmts.filter((s) => s.calls.length));
  const close = (set) => { for (let changed = true; changed;) { changed = false; for (const s of stmts) { if (set.has(s)) continue; for (const r of s.refs) { if ((byName.get(r) || []).some((d) => d !== s && set.has(d))) { set.add(s); changed = true; break; } } } } };
  close(dateDerived); close(reaches);
  /** Every statement in `set` reachable from `s` through referenced names (the statement itself first), each with the names on the way to it. */
  const reach = (s, set) => {
    const out = [{ at: s, names: [] }]; const seen = new Set([s]); let frontier = [{ s, names: [] }];
    while (frontier.length) {
      const next = [];
      for (const { s: cur, names } of frontier) {
        for (const r of cur.refs) for (const d of byName.get(r) || []) {
          if (seen.has(d) || !set.has(d)) continue;
          seen.add(d); const names2 = [...names, r];
          out.push({ at: d, names: names2 }); next.push({ s: d, names: names2 });
        }
      }
      frontier = next;
    }
    return out;
  };
  const flagged = [];
  for (const s of stmts) {
    if (!dateDerived.has(s) || !reaches.has(s)) continue;
    const dates = reach(s, dateDerived).filter((x) => x.at.dates.length); const calls = reach(s, reaches).filter((x) => x.at.calls.length);
    if (!dates.length || !calls.length) continue;
    // With a field list: a fixed date must be the value of a property named in the list, somewhere on the way (the statement itself or a statement it reaches).
    let field = null;
    if (fields) {
      for (const x of reach(s, dateDerived)) {
        for (const pr of x.at.props) {
          if (!fields.has(pr.key)) continue;
          if (pr.vdate || [...pr.vrefs].some((n) => (byName.get(n) || []).some((d) => dateDerived.has(d)))) { field = { name: pr.key, line: pr.line }; break; }
        }
        if (field) break;
      }
      if (!field) continue;
    }
    // The fingerprint binds an acceptance to the source it was read against: this statement and EVERY local statement it depends on, by text (not by line). That closure is wider than the
    // date and consumer chains on purpose: a number the expiry is computed from (WHEN + DAYS) is on neither chain, yet changing it moves the expiry. Flag eligibility is unchanged.
    const chain = [...new Set([...reach(s, new Set(stmts)).map((x) => x.at)])].sort((a, b) => a.line - b.line);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(chain.map((c) => c.text))).digest('hex').slice(0, 16);
    const dateLiterals = []; const seenLines = new Set();
    for (const x of dates) for (const d of x.at.dates) if (!seenLines.has(d.line)) { seenLines.add(d.line); dateLiterals.push(d); }
    flagged.push({
      file, line: s.line, statement: s.title, ...(field ? { field: field.name, fieldLine: field.line } : {}), dateLiteral: dateLiterals[0], dateLiterals, dates: [...new Set(dateLiterals.map((d) => d.value))].sort(), fingerprint, consumer: calls[0].at.calls[0],
      via: [...new Set([...dates.flatMap((x) => x.names), ...calls[0].names])],
    });
  }
  return flagged;
}

function collect(paths) {
  const files = []; const unreadable = [];
  const addDir = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) addDir(p); else if (e.name.endsWith('.test.mjs')) files.push(p); } };
  for (const p of paths) {
    try { const st = fs.statSync(p); if (st.isDirectory()) addDir(p); else files.push(p); } catch (e) { unreadable.push({ file: p, error: e.code === 'ENOENT' ? 'no such file or directory' : e.message }); }
  }
  return { files, unreadable };
}

export function scan(paths, fields = null) {
  const { files, unreadable } = collect(paths);
  const flagged = [];
  for (const f of files) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch (e) { unreadable.push({ file: f, error: e.message }); continue; }
    try { flagged.push(...flagFile(f, src, fields)); } catch (e) { unreadable.push({ file: f, error: String(e.message || e).split('\n')[0] }); }
  }
  return { guard: GUARD, files: files.length - unreadable.filter((u) => files.includes(u.file)).length, filesRequested: files.length, flagged, unreadable };
}

/** Read a JSON file the caller named; any failure is exit 2 with a message that names THAT file. */
function loadJson(file, what) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${what} ${file}: ${e.code === 'ENOENT' ? 'no such file' : String(e.message).split('\n')[0]}`); }
  return doc;
}

function main(argv) {
  const json = argv.includes('--json'); const paths = []; let fieldsFile = null; let baselineFile = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') continue;
    if (a === '--fields' || a === '--baseline') { const v = argv[++i]; if (!v) { console.error(`${a} needs a file`); return 2; } if (a === '--fields') fieldsFile = v; else baselineFile = v; continue; }
    if (a.startsWith('--')) { console.error(`unknown option ${a}`); return 2; }
    paths.push(a);
  }
  if (!paths.length) { console.error('usage: scan-fixed-dates-1696.mjs [--json] [--fields <list.json>] [--baseline <accepted.json>] <file-or-directory>...  (no path given: nothing was checked)'); return 2; }
  let fields = null; let fieldNames = null; let baseline = null;
  try {
    if (fieldsFile) {
      const doc = loadJson(fieldsFile, 'field list');
      if (!doc || !Array.isArray(doc.fields) || !doc.fields.length) throw new Error(`field list ${fieldsFile}: it has no fields array`);
      for (const e of doc.fields) if (!e || typeof e.name !== 'string' || !e.name) throw new Error(`field list ${fieldsFile}: an entry has no name`);
      fieldNames = doc.fields.map((e) => e.name); fields = new Set(fieldNames);
    }
    if (baselineFile) {
      const doc = loadJson(baselineFile, 'accepted-sites list');
      if (!doc || !Array.isArray(doc.accepted)) throw new Error(`accepted-sites list ${baselineFile}: it has no accepted array`);
      for (const e of doc.accepted) {
        if (!e || typeof e.file !== 'string' || typeof e.statement !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) throw new Error(`accepted-sites list ${baselineFile}: every entry needs a file, a statement and a reason`);
        for (const k of ['field', 'consumer', 'fingerprint']) if (typeof e[k] !== 'string' || !e[k]) throw new Error(`accepted-sites list ${baselineFile}: an entry for "${e.statement}" has no ${k}; an acceptance is bound to its dates, field, consumer and a source fingerprint`);
        if (!Array.isArray(e.dates) || !e.dates.length || e.dates.some((x) => typeof x !== 'string')) throw new Error(`accepted-sites list ${baselineFile}: an entry for "${e.statement}" has no dates; an acceptance is bound to its dates, field, consumer and a source fingerprint`);
      }
      baseline = doc.accepted;
    }
  } catch (e) { console.error(String(e.message)); return 2; }
  const r = scan(paths, fields);
  const uncovered = fields ? `Fields not on the list are uncovered, not safe: this covers only ${fieldNames.join(', ')} (list: ${fieldsFile}).` : undefined;
  let accepted = []; let staleBaseline = []; const changed = [];
  if (baseline) {
    const used = new Set(); const keep = [];
    const same = (e, f) => e.file === f.file && e.statement === f.statement && e.field === f.field && e.consumer === f.consumer.name && JSON.stringify(e.dates) === JSON.stringify(f.dates) && e.fingerprint === f.fingerprint;
    for (const f of r.flagged) {
      const i = baseline.findIndex((e, k) => !used.has(k) && same(e, f));
      if (i >= 0) { used.add(i); accepted.push({ ...f, reason: baseline[i].reason }); continue; }
      keep.push(f);
    }
    // A flagged site whose entry exists but no longer matches is CHANGED (needs review), never inherited as safe and never merely stale.
    for (const f of keep) {
      const k = baseline.findIndex((e, kk) => !used.has(kk) && e.file === f.file && e.statement === f.statement);
      if (k < 0) continue;
      used.add(k); const e = baseline[k]; const differs = [];
      if (e.field !== f.field) differs.push('field'); if (e.consumer !== f.consumer.name) differs.push('consumer');
      if (JSON.stringify(e.dates) !== JSON.stringify(f.dates)) differs.push('dates'); if (e.fingerprint !== f.fingerprint) differs.push('fingerprint');
      changed.push({ file: f.file, statement: f.statement, differs, accepted: { dates: e.dates, consumer: e.consumer, field: e.field, fingerprint: e.fingerprint, reason: e.reason }, now: { dates: f.dates, consumer: f.consumer.name, field: f.field, fingerprint: f.fingerprint } });
    }
    r.flagged = keep; staleBaseline = baseline.filter((_, k) => !used.has(k));
  }
  const code = r.unreadable.length || r.filesRequested === 0 ? 2 : (r.flagged.length || staleBaseline.length || changed.length ? 1 : 0);
  if (json) {
    const { filesRequested, ...out } = r;
    process.stdout.write(`${JSON.stringify({ ...out, ...(fields ? { fields: fieldNames, uncovered } : {}), ...(baseline ? { accepted, changed, staleBaseline } : {}) }, null, 2)}\n`);
    if (r.filesRequested === 0) process.stderr.write('no test file was found: nothing was checked\n');
    return code;
  }
  for (const f of r.flagged) console.log(`${f.file}:${f.dateLiteral.line} fixed date ${JSON.stringify(f.dateLiteral.value)} reaches ${f.consumer.name} (${f.file}:${f.consumer.line}) in "${f.statement}" (${f.file}:${f.line})${f.field ? ` through the field ${f.field} (${f.file}:${f.fieldLine})` : ''} via ${f.via.join(' -> ') || '(directly)'}`);
  for (const a of accepted) console.log(`accepted: "${a.statement}" (${a.file}:${a.line}) - ${a.reason}`);
  for (const c of changed) console.log(`CHANGED since accepted (${c.differs.join(', ')} differ): needs review, not inherited as safe: "${c.statement}" in ${c.file}`);
  for (const b of staleBaseline) console.log(`STALE accepted-sites entry, it matches no site (remove it): "${b.statement}" in ${b.file}`);
  for (const u of r.unreadable) console.log(`COULD NOT CHECK ${u.file}: ${u.error}`);
  if (r.filesRequested === 0) console.log('COULD NOT CHECK: no test file was found; nothing was checked');
  console.log(`${r.flagged.length} flagged site(s) in ${r.files} file(s) read; ${accepted.length} accepted; ${changed.length} changed; ${staleBaseline.length} stale; ${r.unreadable.length} unreadable.`);
  if (uncovered) console.log(uncovered);
  console.log(GUARD);
  return code;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('scan-fixed-dates-1696.mjs')) process.exitCode = main(process.argv.slice(2));
