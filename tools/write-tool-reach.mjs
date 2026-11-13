// #1163 — THE CLASS behind #1106/#534/#548/#775/#790.
//
// A capability that ships at REST and is unreachable from the MCP tool the
// seats use protects nobody: the seats are the colliding writers. Six times
// in three weeks a handler read a body field the tool could not send. This
// module joins three things and reports every field a handler DEPENDS ON
// that its tool cannot reach:
//
//   1. the LIVE tools/list (what a caller can actually send — never a regex
//      over the zod source, which resolved 6 of 13 write tools on #1106)
//   2. the apiCall(method, path) each tool's registration block makes
//      (source of mcp-server.mjs, blocks are sequential)
//   3. the REST route table and the `body.<field>` reads of the handler it
//      names (source of server.js)
//
// "DEPENDS ON" is stated here so the failure message can quote it: a field
// the handler reads as `body.<f>` is a dependency UNLESS every read of it
// sits in an `||` chain beside a field the tool DOES declare (a fallback for
// something that is sent, e.g. decision_create's `decidedBy || by`). A
// naive set-difference flags that and gets baselined within a week.
//
// It prints its own n. A run that mapped zero write tools, or could not map
// one, is a FAILURE of the instrument, never a pass (#1162).

export const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

// Registrations and their helpers sit at ONE indentation inside the server's
// main function. A block runs from its `mcp.registerTool(` to the next
// statement at that depth; a helper definition (`const NAME =`, `function
// NAME(`) at that depth is indexed so a block that names a handler by
// reference (card_create → cardCreateHandler → plainCardCreate) is followed.
const STMT_AT_DEPTH = /^  (?:const|let|var|async function|function|mcp\.|if|for|while|return|await|export)\b/;

// #1888: two spaces is ALSO the body of every top-level function, so "at depth" alone indexed those functions'
// locals as helpers (a tool naming `reg` inherited a register call it never makes) and never indexed the top-level
// helpers themselves (a tool reaching a write only through one went unchecked). Each segment now carries the
// top-level function it sits in; the main function is the one whose body registers tools.
const TOP_DEF = /^(?:export\s+)?(?:(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(|(?:const|let|var)\s+([A-Za-z_]\w*)\s*=)/;
const CLOSER = /^[)}\]]/;

function segmentsAtDepth(mcpSource) {
  const lines = mcpSource.split('\n');
  const starts = [];
  lines.forEach((line, i) => { if (STMT_AT_DEPTH.test(line) || /^\S/.test(line)) starts.push(i); });
  const topOf = [];
  let top = -1;
  lines.forEach((line, i) => { if (/^\S/.test(line) && !CLOSER.test(line)) top = i; topOf[i] = top; });
  const segs = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    segs.push({ first: lines[from], top: topOf[from], source: lines.slice(from, to).join('\n') });
  }
  return { lines, segs };
}

/** The line index of the top-level function whose body registers tools (-1 when none does). */
function mainTop({ segs }) {
  const reg = segs.find((seg) => /^  mcp\.registerTool\(/.test(seg.first));
  return reg ? reg.top : -1;
}

export function parseDefinitions(mcpSource) {
  const parsed = segmentsAtDepth(mcpSource);
  const main = mainTop(parsed);
  const defs = new Map();
  for (const seg of parsed.segs) {
    if (seg.top !== main) continue; // a local of some other top-level function is not a helper of the tools
    const m = seg.first.match(/^  (?:const|let|var)\s+([A-Za-z_]\w*)\s*=/) || seg.first.match(/^  (?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(/);
    if (m) defs.set(m[1], stripComments(seg.source));
  }
  // top-level helpers, by name, with their whole body (up to the next top-level statement); never the main function
  const { lines } = parsed;
  lines.forEach((line, i) => {
    const m = line.match(TOP_DEF);
    if (!m || i === main) return;
    let end = i + 1;
    while (end < lines.length && !(/^\S/.test(lines[end]) && !CLOSER.test(lines[end]))) end++;
    const name = m[1] || m[2];
    if (!defs.has(name)) defs.set(name, stripComments(lines.slice(i, end).join('\n')));
  });
  return defs;
}

export function parseRegisterBlocks(mcpSource) {
  return segmentsAtDepth(mcpSource).segs
    .map((seg) => ({ seg, m: seg.first.match(/^  mcp\.registerTool\('([^']+)'/) }))
    .filter(({ m }) => m)
    .map(({ seg, m }) => ({ name: m[1], source: stripComments(seg.source) }));
}

/** apiCalls in a block plus those in every helper it names, transitively (bounded). */
export function apiCallsReachable(blockSource, defs, depth = 4) {
  const seen = new Set();
  const out = [];
  const visit = (src, d) => {
    out.push(...apiCallsIn(src));
    if (d === 0) return;
    for (const m of src.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const id = m[1];
      if (defs.has(id) && !seen.has(id)) { seen.add(id); visit(defs.get(id), d - 1); }
    }
  };
  visit(blockSource, depth);
  const key = (c) => `${c.method} ${c.path}`;
  return [...new Map(out.map((c) => [key(c), c])).values()];
}

export function apiCallsIn(blockSource) {
  // any `…apiCall(` sibling counts (apiCall, claimApiCall, …): same REST, different envelope
  const re = /\b[A-Za-z_]*[aA]piCall\(\s*'([A-Z]+)'\s*,\s*(`[^`]*`|'[^']*')/g;
  const out = [];
  let m;
  while ((m = re.exec(blockSource))) {
    const raw = m[2].slice(1, -1);
    out.push({ method: m[1], template: raw, path: normalizeTemplate(raw) });
  }
  return out;
}

export function normalizeTemplate(t) {
  // `${q}` and `?…` are query strings; `${…}` in the path is one segment.
  return t.replace(/\$\{q\}/g, '').replace(/\?.*$/, '').replace(/\$\{[^}]*\}/g, 'x');
}

export function parseRouteTable(serverSource) {
  const re = /\{\s*method:\s*'([A-Z]+)',\s*re:\s*(\/(?:\\\/|\\.|[^\/\n])+\/[a-z]*),\s*fn:[^}]*?\b(handle\w+)\s*\(/g;
  const routes = [];
  let m;
  while ((m = re.exec(serverSource))) {
    const lit = m[2];
    const last = lit.lastIndexOf('/');
    routes.push({ method: m[1], re: new RegExp(lit.slice(1, last), lit.slice(last + 1)), handler: m[3] });
  }
  return routes;
}

export function handlerSource(serverSource, name) {
  const start = serverSource.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  if (start < 0) return null;
  const end = serverSource.indexOf('\n}\n', start);
  return serverSource.slice(start, end < 0 ? undefined : end + 3);
}

export function bodyReads(handlerSrc) {
  const fields = new Map(); // field -> [lines]
  const lines = handlerSrc.split('\n');
  for (const line of lines) {
    const seen = new Set();
    for (const m of line.matchAll(/\bbody\.([A-Za-z_]\w*)/g)) seen.add(m[1]);
    for (const m of line.matchAll(/const\s*\{([^}]+)\}\s*=\s*body\b/g)) {
      for (const part of m[1].split(',')) {
        const k = part.split(':')[0].split('=')[0].trim();
        if (k) seen.add(k);
      }
    }
    for (const f of seen) {
      if (!fields.has(f)) fields.set(f, []);
      fields.get(f).push(line.trim());
    }
  }
  return fields;
}

export function isFallbackCovered(field, lines, declared) {
  // every read of `field` sits in an `||` chain beside a DECLARED field
  return lines.length > 0 && lines.every((line) =>
    line.includes('||') && [...line.matchAll(/\bbody\.([A-Za-z_]\w*)/g)].some((m) => m[1] !== field && declared.has(m[1])));
}

/**
 * @param {object} args
 * @param {string} args.mcpSource      source of mcp-server.mjs
 * @param {string} args.serverSource   source of server.js
 * @param {Array<{name:string, inputSchema?:{properties?:object}}>} args.tools  the LIVE tools/list
 */
export function analyzeWriteToolReach({ mcpSource, serverSource, tools }) {
  const declaredByTool = new Map(tools.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]));
  const routes = parseRouteTable(serverSource);
  const defs = parseDefinitions(mcpSource);
  const rows = [];
  const unmapped = [];
  for (const block of parseRegisterBlocks(mcpSource)) {
    if (!declaredByTool.has(block.name)) continue; // registered in source but not served: not a caller's surface
    const declared = declaredByTool.get(block.name);
    for (const call of apiCallsReachable(block.source, defs)) {
      if (!WRITE_METHODS.has(call.method)) continue;
      const route = routes.find((r) => r.method === call.method && r.re.test(call.path));
      if (!route) { unmapped.push({ tool: block.name, method: call.method, path: call.path }); continue; }
      const src = handlerSource(serverSource, route.handler);
      if (!src) { unmapped.push({ tool: block.name, method: call.method, path: call.path, handler: route.handler, reason: 'handler source not found' }); continue; }
      const reads = bodyReads(src);
      const fields = [];
      for (const [field, lines] of reads) {
        const status = declared.has(field) ? 'declared'
          : isFallbackCovered(field, lines, declared) ? 'fallback-covered'
          : 'GAP';
        fields.push({ field, status, lines });
      }
      rows.push({ tool: block.name, method: call.method, path: call.template, handler: route.handler, declared: [...declared].sort(), fields });
    }
  }
  const gaps = rows.flatMap((r) => r.fields.filter((f) => f.status === 'GAP').map((f) => ({ tool: r.tool, method: r.method, path: r.path, handler: r.handler, field: f.field, lines: f.lines })));
  const m = rows.reduce((a, r) => a + r.fields.length, 0);
  return { n: rows.length, m, rows, gaps, unmapped, dependsOn: 'a `body.<f>` read is a dependency unless every read sits in an || chain beside a field the tool declares' };
}

export function formatReport(r) {
  const out = [`write-tool-reach · n=${r.n} tool→route pairs · m=${r.m} fields · gaps=${r.gaps.length} · unmapped=${r.unmapped.length}`];
  for (const row of r.rows) {
    const g = row.fields.filter((f) => f.status === 'GAP').map((f) => f.field);
    const fb = row.fields.filter((f) => f.status === 'fallback-covered').map((f) => f.field);
    out.push(`  ${row.tool.padEnd(22)} ${row.method.padEnd(6)} ${row.path.padEnd(44)} ${row.handler.padEnd(28)} ${g.length ? 'GAP ' + g.join(',') : 'ok'}${fb.length ? '  (fallback: ' + fb.join(',') + ')' : ''}`);
  }
  for (const u of r.unmapped) out.push(`  UNMAPPED ${u.tool} ${u.method} ${u.path}${u.reason ? ' — ' + u.reason : ''}`);
  return out.join('\n');
}

// CLI: node tools/write-tool-reach.mjs --mcp http://127.0.0.1:3001/mcp
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--mcp');
  if (i < 0) { console.error('usage: node tools/write-tool-reach.mjs --mcp <mcp url>'); process.exit(2); }
  const { mcpSession } = await import('../tests/helpers/harness.mjs');
  const s = await mcpSession(process.argv[i + 1]);
  const tools = (await s.listTools()).result.tools;
  const r = analyzeWriteToolReach({ mcpSource: readFileSync(join(root, 'mcp-server.mjs'), 'utf8'), serverSource: readFileSync(join(root, 'server.js'), 'utf8'), tools });
  console.log(formatReport(r));
  process.exit(r.n === 0 || r.unmapped.length ? 2 : r.gaps.length ? 1 : 0);
}
