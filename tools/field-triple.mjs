/**
 * #831 — the three-list invariant, measured BEHAVIOURALLY.
 *
 *   schema DECLARES field  ∧  validator ACCEPTS field  ∧  consumer READS field
 *   ⇒ all three must agree.
 *
 * ⚠️ WHY THIS DOES NOT PARSE SOURCE. The obvious implementation extracts three
 * lists out of server.js and diffs them. That implementation has a failure mode
 * the card calls out by name: three independently-parsed lists mean any one
 * extractor mis-parsing makes EVERY field report as failing, which is
 * indistinguishable from a codebase in which every field fails. A saturated
 * result from a brand-new check is a bug until proven otherwise, and a static
 * extractor is the easiest way to manufacture one.
 *
 * So each of the three predicates is instead a QUESTION PUT TO A RUNNING SERVER,
 * with an answer the server cannot give without actually exercising the surface:
 *
 *   declares(f)  POST a well-formed f. Is f ABSENT from the response's
 *                `ignoredFields`? The route naming f as its own vocabulary is
 *                the closest thing to a declaration a wire surface can make.
 *   accepts(f)   POST a MALFORMED f. Does it 400? Only a validator with a rule
 *                for f can produce that.
 *   reads(f)     POST a well-formed f, then GET the card FRESH. Is it stored?
 *                ⚠️ The 201 body is the write's own echo — it can carry a field
 *                the stored card never got. The fresh GET is the evidence.
 *
 * No list is read from source, so no extractor can saturate. The cost is that
 * every field needs a well-formed AND a malformed probe value, written by hand.
 * That cost is the point: writing a malformed value requires knowing what the
 * field means, which is the review a static list-diff skips.
 */

/** POST /api/cards, returning status + parsed body. */
async function post(baseUrl, body) {
  const res = await fetch(`${baseUrl}/api/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'triple-audit probe', createdBy: 'ada', ...body }),
  });
  return { status: res.status, body: await res.json() };
}

/** GET a card by shortId — the FRESH read, not the write's echo. */
async function getFresh(baseUrl, shortId) {
  const res = await fetch(`${baseUrl}/api/cards/${shortId}`);
  return { status: res.status, body: await res.json() };
}

/**
 * Measure the triple for one field on the /api/cards CREATE surface.
 *
 * @param {string} baseUrl
 * @param {{name: string, wellFormed: any, malformed: any, storedAs?: string, with?: object}} probe
 *   `storedAs` names the key to read back when the input key differs from the
 *   stored key (`assignee` → `assignees`). Defaults to `name`.
 *   `with` carries companion fields a field cannot legally travel without —
 *   `parkedBy` needs `parkedUntil` or the validator refuses the PAIR, and the
 *   probe would then measure the pairing rule instead of the field.
 * @returns {Promise<{field, declares, accepts, reads, agrees, evidence}>}
 */
export async function auditCreateField(baseUrl, probe) {
  const { name, wellFormed, malformed, storedAs = name, with: companions = {} } = probe;
  const evidence = {};

  // ── declares + reads: one well-formed write, two readings of it ──
  const good = await post(baseUrl, { ...companions, [name]: wellFormed });
  evidence.wellFormedStatus = good.status;

  // A well-formed probe that fails to create at all cannot answer anything.
  // Surfacing it as an error beats reporting three false negatives.
  if (good.status !== 201) {
    return {
      field: name,
      declares: null,
      accepts: null,
      reads: null,
      agrees: null,
      error: `well-formed probe did not create (status ${good.status}): `
           + JSON.stringify(good.body?.error ?? good.body).slice(0, 200),
      evidence,
    };
  }

  // CONTROL: a known key landed, so this is not a broken probe reading as data.
  evidence.controlTitleLanded = good.body.title === 'triple-audit probe';

  const ignored = good.body.ignoredFields ?? [];
  evidence.ignoredFields = ignored;
  const declares = !ignored.includes(name);

  const fresh = await getFresh(baseUrl, good.body.shortId);
  evidence.storedValue = fresh.body?.[storedAs];
  const reads = fresh.status === 200
    && fresh.body?.[storedAs] !== undefined
    && fresh.body?.[storedAs] !== null;

  // ── accepts: a separate write carrying a deliberately invalid value ──
  // ⚠️ A field marked noRule has no validation rule BY DESIGN — a free-form
  // string cannot be malformed. Sending a probe anyway would measure nothing
  // and report `accepts: false`, which is indistinguishable from "a rule exists
  // and my probe failed to trip it". Those are different states and the audit
  // must not collapse them, so the intent is recorded rather than inferred.
  // ⛔ AND THE EXEMPTION MUST NOT SELF-CERTIFY. `noRule` is author-declared, so
  // a wrong marking silently suppresses a real finding — which is this audit
  // committing the exact failure class it exists to detect. Measured: marking
  // `parkedReason` noRule hid a third VALIDATED_THEN_DISCARDED, because the
  // field does have a rule (non-string → 400 "parkedReason must be a string").
  // So the claim is TESTED: throw a type-hostile value at it and require that
  // no rule fires. If one does, the marking is refuted and the audit fails
  // loudly rather than reporting agreement it did not establish.
  if (probe.noRule) {
    const hostile = await post(baseUrl, { ...companions, [name]: { __noRuleProbe: true } });
    evidence.noRuleProbeStatus = hostile.status;
    evidence.noRuleProbeError = hostile.body?.error;
    if (hostile.status === 400) {
      return {
        field: name, declares, accepts: true, reads, noRule: true, noRuleClaimRefuted: true,
        agrees: false, evidence,
        error: `marked noRule, but a validation rule fired: ${JSON.stringify(hostile.body?.error).slice(0, 160)}`,
      };
    }
    return {
      field: name, declares, accepts: false, reads, noRule: true,
      agrees: declares === reads, evidence,
    };
  }

  const bad = await post(baseUrl, { ...companions, [name]: malformed });
  evidence.malformedStatus = bad.status;
  evidence.malformedError = bad.body?.error;
  const accepts = bad.status === 400;

  return { field: name, declares, accepts, reads, agrees: declares === accepts && accepts === reads, evidence };
}

/**
 * The invariant, stated as a verdict rather than a boolean, because the three
 * disagreement shapes want different fixes and collapsing them to "FAIL" loses
 * the only information that tells you what to do.
 */
export function verdictFor({ declares, accepts, reads, noRule, noRuleClaimRefuted }) {
  if (declares === null) return 'UNMEASURED';
  // A field with no rule by design is judged on the two lists that apply to it.
  // Holding it to `accepts` would report every free-form string as a defect —
  // an audit that flags correct code is worse than no audit, because the noise
  // is what gets the real findings ignored.
  if (noRule) {
    // The marking was refuted by measurement — never report agreement.
    if (noRuleClaimRefuted) return 'NORULE_CLAIM_REFUTED';
    if (declares && reads) return 'AGREE_SUPPORTED_NO_RULE';
    if (!declares && !reads) return 'AGREE_ABSENT';
    if (reads && !declares) return 'CONSUMED_UNDECLARED';
    return 'DECLARED_NOT_CONSUMED';
  }
  if (declares && accepts && reads) return 'AGREE_SUPPORTED';
  if (!declares && !accepts && !reads) return 'AGREE_ABSENT';
  if (accepts && !reads) return 'VALIDATED_THEN_DISCARDED';   // the #831 headline
  if (reads && !declares) return 'CONSUMED_UNDECLARED';       // the opposite lie
  if (reads && !accepts) return 'CONSUMED_UNVALIDATED';       // the `parent` shape
  if (declares && !reads) return 'DECLARED_NOT_CONSUMED';
  return 'DISAGREE_OTHER';
}

/** Run a set of probes and return rows plus a rendered table. */
export async function auditCreateSurface(baseUrl, probes) {
  const rows = [];
  for (const probe of probes) {
    const r = await auditCreateField(baseUrl, probe);
    rows.push({ ...r, verdict: verdictFor(r) });
  }
  return rows;
}

export function renderTable(rows) {
  const b = (v) => (v === null ? ' ?? ' : v ? ' yes' : '  . ');
  const w = Math.max(5, ...rows.map((r) => r.field.length));
  const lines = [
    `${'field'.padEnd(w)}  decl  acpt  read   verdict`,
    `${'-'.repeat(w)}  ----  ----  ----   -------`,
  ];
  for (const r of rows) {
    lines.push(`${r.field.padEnd(w)}  ${b(r.declares)}  ${b(r.accepts)}  ${b(r.reads)}   ${r.verdict}`);
  }
  return lines.join('\n');
}
