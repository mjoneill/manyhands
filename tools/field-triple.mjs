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
 * ⛔ `reads` MUST COMPARE VALUES, NOT PRESENCE.
 *
 * The first version asked "is the field non-undefined after the write?" That is
 * a false positive for every field the server gives a DEFAULT or that a fresh
 * card already carries. Measured: `createdBy` reported reads=true on PATCH
 * because the card was born with it — the patch was silently discarded and the
 * pre-existing value answered for it. `labels`, `for`, `column`, `order` and
 * `assignees` all have defaults and were exposed to the same error.
 *
 * ⇒ A presence check cannot distinguish "the write stored my value" from
 *   "something else put a value here first", and those are the two states this
 *   entire audit exists to tell apart. So the probe sends a value it can
 *   RECOGNISE and requires that exact value back.
 */
function storedMatches(actual, expected) {
  if (Array.isArray(expected) || (expected && typeof expected === 'object')) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return actual === expected;
}

/**
 * ⚠️ SOME PROBE VALUES CANNOT BE CONSTANTS.
 *
 * `relationships: {relatedTo: []}` is indistinguishable from the default the
 * server writes on every card — so a probe using it proves nothing, which is
 * the same presence-weakness `storedMatches` was added to kill, wearing a
 * different hat. A meaningful probe needs a REAL edge, and a real edge needs a
 * target card that exists.
 *
 * So a probe may express wellFormed/malformed/expectStored as a function of a
 * context carrying a freshly-created target's shortId.
 */
function resolveProbeValue(v, ctx) {
  return typeof v === 'function' ? v(ctx) : v;
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
  const { name, storedAs = name, with: companions = {} } = probe;
  const evidence = {};

  // A target exists for every probe, whether or not it is used: making it
  // unconditional keeps shortId allocation identical across probes, so one
  // probe's verdict can't depend on how many probes ran before it.
  const targetCard = await post(baseUrl, {});
  const ctx = { targetShortId: targetCard.body.shortId };
  const wellFormed = resolveProbeValue(probe.wellFormed, ctx);
  const malformed = resolveProbeValue(probe.malformed, ctx);

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

  const freshCard = await getFresh(baseUrl, good.body.shortId);
  const expected = probe.expectStored !== undefined ? resolveProbeValue(probe.expectStored, ctx) : wellFormed;
  evidence.storedValue = freshCard.body?.[storedAs];
  evidence.expectedValue = expected;
  const reads = freshCard.status === 200 && storedMatches(freshCard.body?.[storedAs], expected);

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
 * Measure the triple for one field on the /api/cards PATCH surface.
 *
 * ⚠️ Same three questions, DIFFERENT answers, and that is the point of running
 * both: `unknown` is route-relative. A field can be real on PATCH and unknown
 * on create (the `parked*` trio), or real on /api/nodes and unknown on
 * /api/cards (`body`). A single audit over "the card fields" would average two
 * surfaces together and report a defect on neither.
 *
 * The patch target is created fresh per probe so a field left behind by an
 * earlier probe cannot make a later one read as stored.
 */
export async function auditPatchField(baseUrl, probe) {
  const { name, storedAs = name, with: companions = {} } = probe;
  const evidence = {};

  const targetCard = await post(baseUrl, {});
  const ctx = { targetShortId: targetCard.body.shortId };
  const wellFormed = resolveProbeValue(probe.wellFormed, ctx);
  const malformed = resolveProbeValue(probe.malformed, ctx);

  const patch = async (shortId, body) => {
    const res = await fetch(`${baseUrl}/api/cards/${shortId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by: 'ada', ...body }),
    });
    return { status: res.status, body: await res.json() };
  };

  const fresh = async () => {
    const c = await post(baseUrl, {});
    return c.body.shortId;
  };

  // ── declares + reads ──
  const target = await fresh();
  const good = await patch(target, { ...companions, [name]: wellFormed });
  evidence.wellFormedStatus = good.status;
  if (good.status !== 200) {
    return {
      field: name, declares: null, accepts: null, reads: null, agrees: null,
      error: `well-formed patch did not apply (status ${good.status}): `
           + JSON.stringify(good.body?.error ?? good.body).slice(0, 200),
      evidence,
    };
  }
  const ignored = good.body.ignoredFields ?? [];
  evidence.ignoredFields = ignored;
  const declares = !ignored.includes(name);

  const after = await (await fetch(`${baseUrl}/api/cards/${target}`)).json();
  const expected = probe.expectStored !== undefined ? resolveProbeValue(probe.expectStored, ctx) : wellFormed;
  evidence.storedValue = after?.[storedAs];
  evidence.expectedValue = expected;
  const reads = storedMatches(after?.[storedAs], expected);

  // ── accepts, with the same non-self-certifying exemption as create ──
  if (probe.noRule) {
    const t2 = await fresh();
    const hostile = await patch(t2, { ...companions, [name]: { __noRuleProbe: true } });
    evidence.noRuleProbeStatus = hostile.status;
    evidence.noRuleProbeError = hostile.body?.error;
    if (hostile.status === 400) {
      return {
        field: name, declares, accepts: true, reads, noRule: true, noRuleClaimRefuted: true,
        agrees: false, evidence,
        error: `marked noRule, but a validation rule fired: ${JSON.stringify(hostile.body?.error).slice(0, 160)}`,
      };
    }
    return { field: name, declares, accepts: false, reads, noRule: true, agrees: declares === reads, evidence };
  }

  const t3 = await fresh();
  const bad = await patch(t3, { ...companions, [name]: malformed });
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
