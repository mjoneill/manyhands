// #1764 (PR #140 review) — the pre-commit export must guard every IDENTITY the history gate guards before OR after the
// commit, not just every key: a same-key rename or a person→system change dropped the old name before the graph changed.
// Checked against the gate's rule as core/roster-graph.mjs states it (guardedNames: a non-system entry's key and name).
// The reviewer's probe against the real severance-check CLI is the independent check; this row keeps the property in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supersetSeats, guardedNames } from '../core/roster-graph.mjs';
import { validateRoster } from '../core/roster-config.mjs';

const P = { name: 'Prior Person', color: '#123456' };
const covers = (prev, next) => {
  const sup = validateRoster({ seats: supersetSeats(prev, next) });   // the export must still be a valid roster file
  const have = guardedNames(sup);
  const need = [...guardedNames(prev), ...guardedNames(next)];
  return need.filter((n) => !have.has(n));
};

test('#1764 S1 the superset guards the union of guarded identities across every transition', () => {
  const base = { amy: P, bo: { name: 'Bo Person', color: '#222222' } };
  const cases = {
    'same-key rename': { amy: { ...P, name: 'Amelia Person' }, bo: base.bo },
    'person to system': { amy: { ...P, kind: 'system' }, bo: base.bo },
    'system to person': { amy: P, bo: { ...base.bo } },
    'removal': { bo: base.bo },
    'addition': { ...base, cy: { name: 'Cy Person', color: '#333333' } },
    'rename AND remove another': { amy: { ...P, name: 'Amelia Person' } },
  };
  const prevFor = (name) => (name === 'system to person' ? { amy: { ...P, kind: 'system' }, bo: base.bo } : base);
  for (const [name, next] of Object.entries(cases)) assert.deepEqual(covers(prevFor(name), next), [], `${name}: every guarded name survives the pre-commit export`);
});

test('#1764 S2 CONTROL: a keys-only union (the reviewed defect) fails the same check, so S1 can fail', () => {
  const keysOnly = (prev, next) => { const out = { ...next }; for (const [k, v] of Object.entries(prev)) if (!(k in out)) out[k] = v; return out; };
  const prev = { amy: P, bo: { name: 'Bo Person', color: '#222222' } };
  const next = { amy: { ...P, name: 'Amelia Person' }, bo: prev.bo };
  const have = guardedNames(keysOnly(prev, next));
  assert.equal(have.has('prior person'), false, 'the keys-only union loses the old name (the defect this card fixes)');
  assert.equal(guardedNames(supersetSeats(prev, next)).has('prior person'), true, 'and the fixed superset keeps it');
});
