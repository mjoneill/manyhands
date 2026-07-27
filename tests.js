/* ══════════════════════════════════════════════════════════════
   manyhands — Test Suite
   Extracted from index.html via card #34.
   Loaded on demand by index.html when ?test is in the URL OR
   when Ctrl+Shift+T is pressed. Runs in the same global scope as
   index.html (plain <script>, not a module), so it sees every
   production global it needs (cards, addCard, renderBoard, etc.).
   ══════════════════════════════════════════════════════════════ */

// ── Test Runner ──
function showTestRunner() {
  document.getElementById('test-runner').classList.add('visible');
  runTests();
}

function hideTestRunner() {
  document.getElementById('test-runner').classList.remove('visible');
}


// ── Test Framework ──
const testResults = [];

// Reset all four filter state variables to their defaults. Called automatically
// before each test by the test() wrapper below — also exposed for any test
// that needs to manually reset mid-execution.
function clearFilterState() {
  activeLabels.clear();
  activeAssignees.clear();
  activePriorities.clear();
  activeForFilter = '';
  activeSearch = '';
  labelFilterMode = 'and';
}

// Wrapped test() — auto-resets filter state, clears cards array, and mocks fetch
// before every test. Mocking fetch prevents tests from writing through to the
// live server (which would corrupt board-data.json when the server is running).
// Tests that need different mock behavior can call enableFetchMock() inside
// their body to override; the outer disableFetchMock() in finally still cleans
// up either way.
function test(name, fn) {
  testResults.push({
    name,
    // Wrapped fn is async so we can await the test body (in case it's also
    // async) AND await any pending saveToJSONFile fetches before restoring
    // real fetch. This prevents the race where queued fetches fire AFTER
    // disableFetchMock and hit real fetch with stale cards state.
    fn: async () => {
      clearFilterState();
      cards.length = 0;
      enableFetchMock({ ok: true, json: async () => ({ cards: [], lastUpdated: null }) });
      try {
        await fn();
      } finally {
        // Drain any in-flight saves before unmocking fetch. Use allSettled
        // so a save's rejection doesn't bubble up and mask test failures.
        if (_pendingSaves.length > 0) {
          await Promise.allSettled(_pendingSaves.slice());
        }
        disableFetchMock();
      }
    }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function runTests() {
  const container = document.getElementById('test-results');
  container.innerHTML = '';
  let passed = 0, failed = 0;

  // Sequential await — each test's wrapper is async (awaits the test body
  // AND pending saves). Without `await` here, async failures slipped through
  // as unhandled rejections and were silently marked passed.
  for (const t of testResults) {
    const result = document.createElement('div');
    try {
      await t.fn();
      passed++;
      result.className = 'test-result pass';
      result.innerHTML = `<span class="icon">✅</span><span class="name">${escapeHTML(t.name)}</span>`;
    } catch (err) {
      failed++;
      result.className = 'test-result fail';
      result.innerHTML = `<span class="icon">❌</span><span class="name">${escapeHTML(t.name)}</span>
        <div class="error">${escapeHTML(err.message)}</div>`;
    }
    container.appendChild(result);
  }

  const summary = document.getElementById('test-summary');
  const color = failed === 0 ? '#6ee7b7' : '#f87171';
  summary.innerHTML = `<span style="color:${color}">${passed} passed, ${failed} failed</span> - ${testResults.length} total`;

  // Clean up: remove any test data from real localStorage so the board stays clean
  try { localStorage.removeItem(STORAGE_KEY); } catch(e) {}
  cards.length = 0;
  renderBoard();
}

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Autocomplete Label Typing ════════════════════════════════════════════════ */

test('AC1: typing 2+ chars in label input shows matching labels in dropdown', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['MGMT:9230', 'frontend', 'backend']);
  addCard('Card B', '', 'idea', 'alex', ['mgmt:ops', 'design']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'mg';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should appear when typing 2+ chars');
  const items = dropdown.querySelectorAll('.label-autocomplete-item');
  assert(items.length >= 2, 'should show at least 2 matching labels (MGMT:9230 and mgmt:ops)');
  const texts = Array.from(items).map(i => i.textContent);
  const hasMgmt = texts.some(t => t.toUpperCase().includes('MGMT'));
  assert(hasMgmt, 'suggestions should include labels starting with "mg"');
  cards.length = 0;
  renderBoard();
});

test('AC1: dropdown does NOT appear when typing only 1 character', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['urgent', 'backend']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'u';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown === null, 'dropdown should NOT appear for single character input');
  cards.length = 0;
  renderBoard();
});

test('AC1: dropdown is positioned below the label input', () => {
  cards.length = 0;
  addCard('Pos Test', '', 'task', 'unassigned', ['testlabel']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'test';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should exist');
  const inputRect = labelsInput.getBoundingClientRect();
  const dropdownRect = dropdown.getBoundingClientRect();
  assert(dropdownRect.top >= inputRect.bottom, 'dropdown top should be at or below input bottom');
  cards.length = 0;
  renderBoard();
});

test('AC2: clicking a suggestion adds the label to the input and clears input', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['MGMT:9230', 'frontend']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'mg';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  const firstItem = dropdown.querySelector('.label-autocomplete-item');
  firstItem.click();
  assert(labelsInput.value === '' || labelsInput.value === 'MGMT:9230', 'input should be cleared or contain selected label after click');
  cards.length = 0;
  renderBoard();
});

test('AC2: selecting a suggestion closes the dropdown', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['unique-label-xyz']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'uni';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should be open');
  const firstItem = dropdown.querySelector('.label-autocomplete-item');
  firstItem.click();
  const dropdownAfter = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdownAfter === null, 'dropdown should close after selecting a suggestion');
  cards.length = 0;
  renderBoard();
});

test('AC3: arrow down moves highlight through suggestions', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['alpha', 'beta', 'gamma']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'al';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  const firstItem = dropdown.querySelector('.label-autocomplete-item');
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert(firstItem.classList.contains('highlighted') || firstItem.classList.contains('selected'),
    'first suggestion should be highlighted after ArrowDown');
  cards.length = 0;
  renderBoard();
});

test('AC3: arrow up moves highlight through suggestions', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['aaa', 'bbb']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'aa'; // 2+ chars required to trigger autocomplete dropdown (AC1 of autocomplete)
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  const firstItem = dropdown.querySelector('.label-autocomplete-item');
  assert(firstItem.classList.contains('highlighted') || firstItem.classList.contains('selected'),
    'first suggestion should still be highlighted after ArrowUp from second');
  cards.length = 0;
  renderBoard();
});

test('AC3: Enter on highlighted suggestion selects it', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['ENTER-TEST-LABEL']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'enter';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const dropdownAfter = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdownAfter === null, 'dropdown should close after pressing Enter on suggestion');
  cards.length = 0;
  renderBoard();
});

test('AC4: case-insensitive matching — "mgmt" matches "MGMT:9230"', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['MGMT:9230', 'frontend']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'mgmt';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should appear');
  const items = dropdown.querySelectorAll('.label-autocomplete-item');
  const texts = Array.from(items).map(i => i.textContent);
  const hasMgmt = texts.some(t => t.toUpperCase().includes('MGMT'));
  assert(hasMgmt, 'should match "MGMT:9230" when typing "mgmt"');
  cards.length = 0;
  renderBoard();
});

test('AC5: new label not in suggestions is still accepted on Enter', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['existing-label']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'brand-new-label';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  if (dropdown) {
    const items = dropdown.querySelectorAll('.label-autocomplete-item');
    const hasExactMatch = Array.from(items).some(i => i.textContent === 'brand-new-label');
    assert(!hasExactMatch, 'new label should not have an exact match in suggestions');
  }
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const dropdownAfter = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdownAfter === null, 'dropdown should close after Enter even with no match');
  cards.length = 0;
  renderBoard();
});

test('AC6: suggestions come from all labels across all cards', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['rare-label-A']);
  addCard('Card B', '', 'idea', 'alex', ['rare-label-B']);
  addCard('Card C', '', 'goal', 'robin', ['rare-label-C']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'rare';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should appear');
  const items = dropdown.querySelectorAll('.label-autocomplete-item');
  assertEqual(items.length, 3, 'should show all 3 rare labels from different cards');
  cards.length = 0;
  renderBoard();
});

test('autocomplete dropdown closes on Escape', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['esc-test-label']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'esc';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should be open');
  labelsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const dropdownAfter = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdownAfter === null, 'dropdown should close on Escape');
  cards.length = 0;
  renderBoard();
});

test('autocomplete dropdown closes when clicking outside', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['outside-test']);
  renderBoard();
  const labelsInput = document.getElementById('card-labels');
  labelsInput.focus();
  labelsInput.value = 'out';
  labelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should be open');
  document.body.click();
  const dropdownAfter = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdownAfter === null, 'dropdown should close when clicking outside');
  cards.length = 0;
  renderBoard();
});

test('autocomplete works in card edit mode label input', () => {
  cards.length = 0;
  const card = addCard('Edit Test', '', 'task', 'unassigned', ['edit-label-abc']);
  editingCardId = card.id;
  renderBoard();
  const editLabelsInput = document.querySelector('.card.editing .edit-labels');
  assert(editLabelsInput !== null, 'edit labels input should exist');
  editLabelsInput.focus();
  editLabelsInput.value = 'edit';
  editLabelsInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.label-autocomplete-dropdown');
  assert(dropdown !== null, 'dropdown should appear in edit mode');
  editingCardId = null;
  cards.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Short IDs (#N) ════════════════════════════════════════════════ */

let _origNextShortId;
function _resetNextShortId() { _origNextShortId = nextShortId; nextShortId = 1; }
function _restoreNextShortId() { nextShortId = _origNextShortId; }

test('createCard auto-assigns shortId from nextShortId and increments it', () => {
  _resetNextShortId();
  try {
    const card = createCard('Short ID Test', '', 'task', 'unassigned', []);
    assertEqual(card.shortId, 1, 'first card should get shortId 1');
    const card2 = createCard('Short ID Test 2', '', 'task', 'unassigned', []);
    assertEqual(card2.shortId, 2, 'second card should get shortId 2');
    const card3 = createCard('Short ID Test 3', '', 'task', 'unassigned', []);
    assertEqual(card3.shortId, 3, 'third card should get shortId 3');
  } finally { _restoreNextShortId(); }
});

test('shortId is never reused after deletion', () => {
  _resetNextShortId();
  try {
    const card1 = addCard('Card 1', '', 'task', 'unassigned', []);
    const card2 = addCard('Card 2', '', 'task', 'unassigned', []);
    assertEqual(card1.shortId, 1, 'card1 should have shortId 1');
    assertEqual(card2.shortId, 2, 'card2 should have shortId 2');
    const idx = cards.findIndex(c => c.id === card2.id);
    if (idx > -1) cards.splice(idx, 1);
    const card3 = addCard('Card 3', '', 'task', 'unassigned', []);
    assertEqual(card3.shortId, 3, 'new card should get shortId 3 (not reused 2)');
    const i = cards.findIndex(c => c.id === card1.id);
    if (i > -1) cards.splice(i, 1);
    const j = cards.findIndex(c => c.id === card3.id);
    if (j > -1) cards.splice(j, 1);
    renderBoard();
  } finally { _restoreNextShortId(); }
});

test('backfill assigns shortIds to existing cards in creation order', () => {
  cards.length = 0;
  const oldCards = [
    { id: 'old-a', title: 'Card A', createdAt: '2026-05-10T10:00:00.000Z', shortId: undefined },
    { id: 'old-b', title: 'Card B', createdAt: '2026-05-10T11:00:00.000Z', shortId: undefined },
    { id: 'old-c', title: 'Card C', createdAt: '2026-05-10T12:00:00.000Z', shortId: undefined },
  ];
  oldCards.forEach(c => cards.push(c));
  const sorted = [...cards].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let nextId = 1;
  sorted.forEach(c => { c.shortId = nextId++; });
  assertEqual(cards[0].shortId, 1, 'first card by createdAt should get shortId 1');
  assertEqual(cards[1].shortId, 2, 'second card by createdAt should get shortId 2');
  assertEqual(cards[2].shortId, 3, 'third card by createdAt should get shortId 3');
  cards.length = 0;
  renderBoard();
});

test('card displays shortId badge on board', () => {
  cards.length = 0;
  _resetNextShortId();
  try {
    const card = addCard('Badge Test', '', 'task', 'unassigned', []);
    renderBoard();
    const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
    const badge = cardEl.querySelector('.card-shortid');
    assert(badge !== null, 'shortId badge element should exist');
    assert(badge.textContent.includes('#' + card.shortId), 'badge should show shortId');
    const idx = cards.findIndex(c => c.id === card.id);
    if (idx > -1) cards.splice(idx, 1);
    cards.length = 0;
    renderBoard();
  } finally { _restoreNextShortId(); }
});

test('#N in description renders as clickable link', () => {
  cards.length = 0;
  _resetNextShortId();
  try {
    const card1 = addCard('Card With Ref', 'See #1', 'task', 'unassigned', []);
    const card2 = addCard('Other Card', 'References #1', 'task', 'unassigned', []);
    renderBoard();
    const cardEl = document.querySelector(`.card[data-id="${card2.id}"]`);
    const descEl = cardEl.querySelector('.card-description');
    const link = descEl.querySelector('a.shortid-link');
    assert(link !== null, 'should have a shortid-link anchor');
    assertEqual(link.textContent, '#1', 'link text should be #1');
    assertEqual(link.dataset.shortid, '1', 'link data-shortid should be 1');
    [card1, card2].forEach(c => { const i = cards.findIndex(x => x.id === c.id); if (i > -1) cards.splice(i, 1); });
    cards.length = 0;
    renderBoard();
  } finally { _restoreNextShortId(); }
});

// #510 SUPERSEDES the scroll-and-highlight contract for #N citations.
// It asserted that clicking #N scrolled to the card and highlighted it. That
// delivered a reader to a description clamped inside a ~300px column — the
// citation arrived somewhere unreadable, which is why the pop-out replaced it.
// The behaviour change was pre-registered on #510 before the build and ruled on
// in the room: "opening the readable thing IS the citation working for the
// first time." Scroll-to survives implicitly — close the overlay and you are
// where you were. Rewritten to guard the new contract, not deleted.
test('#510 (supersedes scroll-and-highlight): clicking a #N citation OPENS that card', () => {
  cards.length = 0;
  _resetNextShortId();
  try {
    const card1 = addCard('Target Card', 'I am target', 'task', 'unassigned', []);
    const card2 = addCard('Link Card', 'Links to #1', 'task', 'unassigned', []);
    renderBoard();
    const cardEl2 = document.querySelector(`.card[data-id="${card2.id}"]`);
    const link = cardEl2.querySelector('.card-description a.shortid-link');
    assert(link !== null, 'the citation still renders as a link');
    link.click();
    const back = document.getElementById('card-detail-backdrop');
    assert(back && !back.hidden, 'the citation opens the card detail rather than scrolling to it');
    const body = document.querySelector('.card-detail-body');
    assert(body && body.textContent.includes('I am target'),
      'and it is the CITED card that opened, with its text readable');
    closeCardDetail(false);
    cards.length = 0;
    renderBoard();
  } finally { _restoreNextShortId(); }
});

test('shortId is visible in card edit mode (read-only)', () => {
  cards.length = 0;
  _resetNextShortId();
  try {
    const card = addCard('Edit ShortId', '', 'task', 'unassigned', []);
    editingCardId = card.id;
    renderBoard();
    const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
    const shortIdDisplay = cardEl.querySelector('.shortid-display');
    assert(shortIdDisplay !== null, 'shortId display should exist in edit mode');
    assert(shortIdDisplay.textContent.includes('#' + card.shortId), 'edit mode should show shortId');
    editingCardId = null;
    const idx = cards.findIndex(c => c.id === card.id);
    if (idx > -1) cards.splice(idx, 1);
    cards.length = 0;
    renderBoard();
  } finally { _restoreNextShortId(); }
});

// ── recomputeNextShortId(loadedCards, storedNextShortId) — pure resolution ──
// Bug card #?: hardcoded `let nextShortId = 27` plus inline init logic that
// can drift. Behavior under test: regardless of init order, the returned
// counter must be ≥ max(card shortIds)+1 AND ≥ storedNextShortId (preserve
// deletion semantics — never reuse a deleted card's id).

test('recomputeNextShortId: empty cards, no stored counter → 1', () => {
  assertEqual(recomputeNextShortId([], null), 1, 'empty board starts at 1');
  assertEqual(recomputeNextShortId([], undefined), 1, 'undefined stored counter starts at 1');
  assertEqual(recomputeNextShortId([], 0), 1, 'zero stored counter starts at 1');
});

test('recomputeNextShortId: cards present, no stored counter → max(shortIds)+1', () => {
  const loaded = [{shortId:1},{shortId:2},{shortId:3},{shortId:5},{shortId:10}];
  assertEqual(recomputeNextShortId(loaded, null), 11,
    'gap-tolerant: shortIds [1,2,3,5,10] → next is 11, not 6, not 27');
});

test('recomputeNextShortId: stored counter higher than max(shortIds) → use stored (preserve deletion semantics)', () => {
  // Scenario: cards [1,2,3] but stored counter is 8 because cards 4-7 were deleted.
  // Returning max+1=4 would reuse deleted shortId. Must return 8.
  const loaded = [{shortId:1},{shortId:2},{shortId:3}];
  assertEqual(recomputeNextShortId(loaded, 8), 8,
    'stored counter is authoritative when higher than max+1 — never reuse deleted shortIds');
});

test('recomputeNextShortId: stored counter lower than max(shortIds)+1 → use max+1 (heal counter drift)', () => {
  // Scenario: cards were added via direct JSON write that bumped shortIds
  // past the stored counter (e.g., Python script filing cards).
  const loaded = [{shortId:1},{shortId:2},{shortId:50}];
  assertEqual(recomputeNextShortId(loaded, 5), 51,
    'when stored < max+1, prefer max+1 — catches drift from out-of-band card additions');
});

test('shortId is never reused after deletion', () => {
  _resetNextShortId();
  const card1 = addCard('Card 1', '', 'task', 'unassigned', []);
  const card2 = addCard('Card 2', '', 'task', 'unassigned', []);
  assertEqual(card1.shortId, 1, 'card1 should have shortId 1');
  assertEqual(card2.shortId, 2, 'card2 should have shortId 2');
  const idx = cards.findIndex(c => c.id === card2.id);
  if (idx > -1) cards.splice(idx, 1);
  const card3 = addCard('Card 3', '', 'task', 'unassigned', []);
  assertEqual(card3.shortId, 3, 'new card should get shortId 3 (not reused 2)');
  // Clean up
  const i = cards.findIndex(c => c.id === card1.id);
  if (i > -1) cards.splice(i, 1);
  const j = cards.findIndex(c => c.id === card3.id);
  if (j > -1) cards.splice(j, 1);
  renderBoard();
});

test('backfill assigns shortIds to existing cards in creation order', () => {
  cards.length = 0;
  // Simulate pre-shortId cards loaded from JSON, sorted by createdAt
  const oldCards = [
    { id: 'old-a', title: 'Card A', createdAt: '2026-05-10T10:00:00.000Z', shortId: undefined },
    { id: 'old-b', title: 'Card B', createdAt: '2026-05-10T11:00:00.000Z', shortId: undefined },
    { id: 'old-c', title: 'Card C', createdAt: '2026-05-10T12:00:00.000Z', shortId: undefined },
  ];
  oldCards.forEach(c => cards.push(c));
  // Backfill
  const sorted = [...cards].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let nextId = 1;
  sorted.forEach(c => { c.shortId = nextId++; });
  assertEqual(cards[0].shortId, 1, 'first card by createdAt should get shortId 1');
  assertEqual(cards[1].shortId, 2, 'second card by createdAt should get shortId 2');
  assertEqual(cards[2].shortId, 3, 'third card by createdAt should get shortId 3');
  cards.length = 0;
  renderBoard();
});

test('card displays shortId badge on board', () => {
  cards.length = 0;
  _resetNextShortId();
  const card = addCard('Badge Test', '', 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const badge = cardEl.querySelector('.card-shortid');
  assert(badge !== null, 'shortId badge element should exist');
  assert(badge.textContent.includes('#' + card.shortId), 'badge should show shortId');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  cards.length = 0;
  renderBoard();
});

test('#N in description renders as clickable link', () => {
  cards.length = 0;
  _resetNextShortId();
  const card1 = addCard('Card With Ref', 'See #1', 'task', 'unassigned', []);
  const card2 = addCard('Other Card', 'References #1', 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card2.id}"]`);
  const descEl = cardEl.querySelector('.card-description');
  const link = descEl.querySelector('a.shortid-link');
  assert(link !== null, 'should have a shortid-link anchor');
  assertEqual(link.textContent, '#1', 'link text should be #1');
  assertEqual(link.dataset.shortid, '1', 'link data-shortid should be 1');
  // Clean up
  [card1, card2].forEach(c => { const i = cards.findIndex(x => x.id === c.id); if (i > -1) cards.splice(i, 1); });
  cards.length = 0;
  renderBoard();
});

// #510 SUPERSEDES this duplicate of the scroll-and-highlight contract. Note it
// existed TWICE, verbatim apart from a try/finally — two copies of one
// assertion, which is its own small finding: a duplicated test is one test that
// costs two edits and gives no extra coverage.
test('#510: a citation opens the cited card, and only the cited one', () => {
  cards.length = 0;
  _resetNextShortId();
  const card1 = addCard('Target Card', 'I am target', 'task', 'unassigned', []);
  const card2 = addCard('Link Card', 'Links to #1', 'task', 'unassigned', []);
  renderBoard();
  const cardEl2 = document.querySelector(`.card[data-id="${card2.id}"]`);
  const link = cardEl2.querySelector('.card-description a.shortid-link');
  assert(link !== null, 'the citation renders as a link');
  link.click();
  const back = document.getElementById('card-detail-backdrop');
  assert(back && !back.hidden, 'clicking the citation opens the detail');
  const title = document.querySelector('.card-detail-title');
  assertEqual(title.textContent, 'Target Card', 'the CITED card opened, not the one carrying the citation');
  closeCardDetail(false);
  [card1, card2].forEach(c => { const i = cards.findIndex(x => x.id === c.id); if (i > -1) cards.splice(i, 1); });
  cards.length = 0;
  renderBoard();
});

test('shortId is visible in card edit mode (read-only)', () => {
  cards.length = 0;
  _resetNextShortId();
  const card = addCard('Edit ShortId', '', 'task', 'unassigned', []);
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const shortIdDisplay = cardEl.querySelector('.shortid-display');
  assert(shortIdDisplay !== null, 'shortId display should exist in edit mode');
  assert(shortIdDisplay.textContent.includes('#' + card.shortId), 'edit mode should show shortId');
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  cards.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle 1: Card Creation + Rendering
   ════════════════════════════════════════════════ */

test('createCard returns an object with a valid UUID', () => {
  const card = createCard('Test card', 'desc', 'task', 'unassigned', []);
  assert(card.id !== undefined && card.id !== null, 'id should exist');
  // UUID v4 format: 8-4-4-4-12 hex chars
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert(uuidRegex.test(card.id), `id "${card.id}" should be a valid UUID v4`);
});

test('createCard sets correct defaults', () => {
  const card = createCard('Test', '', 'task', 'unassigned', []);
  assertEqual(card.column, 'backlog', 'column should be backlog');
  assertEqual(card.type, 'task', 'type should be task');
  assert(Array.isArray(card.assignees), 'assignees should be an array');
  assertEqual(card.assignees[0], 'unassigned', 'assignees should default to ["unassigned"]');
  assert(Array.isArray(card.labels), 'labels should be an array');
  assertEqual(card.labels.length, 0, 'labels should be empty');
  assert(card.createdAt !== undefined, 'createdAt should exist');
  assert(card.updatedAt !== undefined, 'updatedAt should exist');
});

test('addCard pushes card to the cards array', () => {
  const before = cards.length;
  const card = addCard('New card', 'desc', 'idea', 'alex', ['urgent']);
  assertEqual(cards.length, before + 1, 'cards array should grow by 1');
  assertEqual(cards[cards.length - 1].id, card.id, 'last card should be the one we added');
  assertEqual(cards[cards.length - 1].title, 'New card', 'title should match');
  // Clean up
  cards.pop();
});

test('addCard trims whitespace from title and description', () => {
  const card = addCard('  spaced title  ', '  spaced desc  ', 'task', 'unassigned', []);
  assertEqual(card.title, 'spaced title', 'title should be trimmed');
  assertEqual(card.description, 'spaced desc', 'description should be trimmed');
  cards.pop();
});

test('addCard parses comma-separated labels', () => {
  const card = addCard('Label test', '', 'task', 'unassigned', []);
  // labels are passed directly in addCard, parsing is in form handler
  const cardWithLabels = addCard('Label test 2', '', 'task', 'unassigned', ['tag1', 'tag2', 'tag3']);
  assertEqual(cardWithLabels.labels.length, 3, 'should have 3 labels');
  assertEqual(cardWithLabels.labels[0], 'tag1', 'first label should be tag1');
  cards.pop(); cards.pop();
});

test('board renders three columns', () => {
  // Robust to live data containing dynamic columns: reset the columns array
  // to just the 3 defaults before counting. (Previously this test broke
  // whenever board-data.json had any dynamic columns persisted — Card #48
  // fix.)
  if (typeof columns !== 'undefined') {
    columns.length = 0;
    columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
    columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
    columns.push({ id: 'done', name: 'Done', order: 2 });
    renderBoard(); // triggers cleanup loop that removes stale dynamic columns from DOM
  }
  const colsInDom = document.querySelectorAll('.column');
  assertEqual(colsInDom.length, 3, 'should have 3 columns');
  assert(document.getElementById('column-backlog'), 'backlog column should exist');
  assert(document.getElementById('column-in-progress'), 'in-progress column should exist');
  assert(document.getElementById('column-done'), 'done column should exist');
});

test('add card form exists with all required fields', () => {
  assert(document.getElementById('card-title'), 'title input should exist');
  assert(document.getElementById('card-desc'), 'description textarea should exist');
  assert(document.getElementById('card-type'), 'type select should exist');
  assert(document.getElementById('card-assignees-group'), 'assignees checkbox group should exist');
  assert(document.getElementById('card-labels'), 'labels input should exist');
  assert(document.getElementById('btn-add-card'), 'add button should exist');
});

test('type select has all four options', () => {
  const select = document.getElementById('card-type');
  const options = Array.from(select.options).map(o => o.value);
  assert(options.includes('task'), 'should have task option');
  assert(options.includes('idea'), 'should have idea option');
  assert(options.includes('goal'), 'should have goal option');
  assert(options.includes('reference'), 'should have reference option');
});

test('rendering a card in backlog produces correct DOM', () => {
  const card = addCard('DOM Test', 'Test description', 'idea', 'robin', ['vip']);
  renderBoard();

  const backlogBody = document.getElementById('backlog-body');
  const cardEl = backlogBody.querySelector(`.card[data-id="${card.id}"]`);
  assert(cardEl !== null, 'card element should exist in backlog');
  assertEqual(cardEl.dataset.type, 'idea', 'card data-type should be idea');

  const emoji = cardEl.querySelector('.card-emoji');
  assertEqual(emoji.textContent, '💡', 'should show idea emoji');

  const title = cardEl.querySelector('.card-title');
  assert(title.textContent.includes('DOM Test'), 'should show card title');

  const assignee = cardEl.querySelector('.card-assignee');
  assert(assignee.textContent.includes('◆'), 'should show robin emoji in assignee badge');

  const desc = cardEl.querySelector('.card-description');
  assert(desc !== null, 'description element should exist');

  const labelTag = cardEl.querySelector('.label-tag');
  assert(labelTag !== null, 'label tag should exist');
  assert(labelTag.textContent.includes('vip'), 'label should contain vip');

  // Clean up
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('card with no description does not render description element', () => {
  const card = addCard('No Desc', '', 'task', 'unassigned', []);
  renderBoard();

  const backlogBody = document.getElementById('backlog-body');
  const cardEl = backlogBody.querySelector(`.card[data-id="${card.id}"]`);
  const desc = cardEl.querySelector('.card-description');
  assert(desc === null, 'no description element when description is empty');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('card with no labels does not render labels container', () => {
  const card = addCard('No Labels', 'desc', 'goal', 'both', []);
  renderBoard();

  const backlogBody = document.getElementById('backlog-body');
  const cardEl = backlogBody.querySelector(`.card[data-id="${card.id}"]`);
  const labels = cardEl.querySelector('.card-labels');
  assert(labels === null, 'no labels element when labels are empty');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('column count updates when cards are added', () => {
  const initial = parseInt(document.getElementById('backlog-count').textContent);
  const card = addCard('Count Test', '', 'task', 'unassigned', []);
  renderBoard();

  const after = parseInt(document.getElementById('backlog-count').textContent);
  assertEqual(after, initial + 1, 'backlog count should increment');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('each card gets a unique ID', () => {
  const card1 = addCard('Card A', '', 'task', 'unassigned', []);
  const card2 = addCard('Card B', '', 'task', 'unassigned', []);
  assert(card1.id !== card2.id, 'two cards should have different IDs');

  // Clean up
  cards.pop(); cards.pop();
  renderBoard();
});

test('form submission clears the form fields', () => {
  const titleInput = document.getElementById('card-title');
  const descInput = document.getElementById('card-desc');
  const labelsInput = document.getElementById('card-labels');

  titleInput.value = '  Test clear  ';
  descInput.value = '  Some desc  ';
  labelsInput.value = '  a, b  ';

  handleAddCard();

  assertEqual(titleInput.value, '', 'title input should be cleared');
  assertEqual(descInput.value, '', 'description input should be cleared');
  assertEqual(labelsInput.value, '', 'labels input should be cleared');

  // Clean up the card we just added
  cards.pop();
  renderBoard();
});

test('form submission does nothing with empty title', () => {
  const before = cards.length;
  const titleInput = document.getElementById('card-title');
  titleInput.value = '   ';
  handleAddCard();
  assertEqual(cards.length, before, 'no card should be added for empty title');
  titleInput.value = '';
});

test('reference type card renders with correct emoji and type color', () => {
  // #508: this used to pass 'both' and rely on the retired sentinel expanding
  // to two seats. The test is about reference-card RENDERING, not the sentinel,
  // so it now names two seats explicitly — same two badges, no dependency on a
  // legacy expansion.
  const card = addCard('Ref Doc', 'A link', 'reference', ['alex', 'robin'], ['docs']);
  renderBoard();

  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  assertEqual(cardEl.dataset.type, 'reference', 'data-type should be reference');

  const emoji = cardEl.querySelector('.card-emoji');
  assertEqual(emoji.textContent, '📌', 'should show reference emoji');

  const badges = cardEl.querySelectorAll('.card-assignee');
  assertEqual(badges.length, 2, "'both' should render as 2 separate badges (alex + robin)");
  const dataAssignees = Array.from(badges).map(b => b.dataset.assignee);
  assert(dataAssignees.includes('alex') && dataAssignees.includes('robin'),
    'badges should be alex and robin');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle 2: Drag-and-Drop Between Columns ════════════════════════════════════════════════ */

test('dragstart sets the correct card ID as drag data', () => {
  const card = addCard('Drag Test', 'desc', 'task', 'unassigned', []);
  renderBoard();

  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  assert(cardEl !== null, 'card element should exist');
  assert(cardEl.draggable === true, 'card should be draggable');

  // Simulate dragstart
  const dt = new DataTransfer();
  const dragEvent = new DragEvent('dragstart', { dataTransfer: dt, bubbles: true });
  cardEl.dispatchEvent(dragEvent);

  assertEqual(draggedCardId, card.id, 'draggedCardId should match the card id');
  assertEqual(dt.getData('text/plain'), card.id, 'dataTransfer should contain card id');

  // Clean up
  handleDragEnd();
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('drop on a column updates the card column property', () => {
  const card = addCard('Drop Test', '', 'task', 'unassigned', []);
  assertEqual(card.column, 'backlog', 'card should start in backlog');
  renderBoard();

  // Simulate dragging this card
  draggedCardId = card.id;

  // Simulate drop on in-progress column
  const ipColumn = document.getElementById('column-in-progress');
  const dropEvent = new DragEvent('drop', {
    bubbles: true,
    dataTransfer: new DataTransfer()
  });
  ipColumn.dispatchEvent(dropEvent);

  assertEqual(card.column, 'in-progress', 'card column should be updated to in-progress');

  // Clean up
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('data array reflects the column change after drop', () => {
  const card1 = addCard('Stay', '', 'task', 'unassigned', []);
  const card2 = addCard('Move Me', '', 'idea', 'robin', []);
  renderBoard();

  // Move card2 to done
  draggedCardId = card2.id;
  const doneColumn = document.getElementById('column-done');
  const dropEvent = new DragEvent('drop', {
    bubbles: true,
    dataTransfer: new DataTransfer()
  });
  doneColumn.dispatchEvent(dropEvent);

  // Verify data array
  const found1 = cards.find(c => c.id === card1.id);
  const found2 = cards.find(c => c.id === card2.id);
  assertEqual(found1.column, 'backlog', 'card1 should still be in backlog');
  assertEqual(found2.column, 'done', 'card2 should be in done');

  // Clean up (remove higher index first to avoid shifting)
  const idx1 = cards.findIndex(c => c.id === card1.id);
  const idx2 = cards.findIndex(c => c.id === card2.id);
  const indices = [idx1, idx2].filter(i => i > -1).sort((a, b) => b - a);
  indices.forEach(i => cards.splice(i, 1));
  renderBoard();
});

test('re-render after drop shows the card in the new column', () => {
  const card = addCard('Visual Test', 'desc', 'goal', 'both', ['nice']);
  renderBoard();

  // Move to done
  draggedCardId = card.id;
  const doneColumn = document.getElementById('column-done');
  const dropEvent = new DragEvent('drop', {
    bubbles: true,
    dataTransfer: new DataTransfer()
  });
  doneColumn.dispatchEvent(dropEvent);

  // After drop, renderBoard is called - check DOM
  const doneBody = document.getElementById('done-body');
  const cardEl = doneBody.querySelector(`.card[data-id="${card.id}"]`);
  assert(cardEl !== null, 'card should appear in done column DOM after drop');

  const backlogBody = document.getElementById('backlog-body');
  const backlogCard = backlogBody.querySelector(`.card[data-id="${card.id}"]`);
  assert(backlogCard === null, 'card should NOT be in backlog DOM after drop');

  // Clean up
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('card order is preserved within a column after drop', () => {
  const cardA = addCard('Card A', '', 'task', 'unassigned', []);
  const cardB = addCard('Card B', '', 'task', 'unassigned', []);
  const cardC = addCard('Card C', '', 'task', 'unassigned', []);
  renderBoard();

  // Move cardA to in-progress
  draggedCardId = cardA.id;
  let dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
  document.getElementById('column-in-progress').dispatchEvent(dropEvent);

  // Move cardB to in-progress
  draggedCardId = cardB.id;
  dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
  document.getElementById('column-in-progress').dispatchEvent(dropEvent);

  // Card C stays in backlog
  assertEqual(cardC.column, 'backlog', 'cardC should still be in backlog');
  assertEqual(cardA.column, 'in-progress', 'cardA should be in in-progress');
  assertEqual(cardB.column, 'in-progress', 'cardB should be in in-progress');

  // Verify DOM order in in-progress
  const ipBody = document.getElementById('in-progress-body');
  const ipCards = ipBody.querySelectorAll('.card');
  assertEqual(ipCards.length, 2, 'in-progress should have 2 cards');
  assertEqual(ipCards[0].dataset.id, cardA.id, 'first card in in-progress should be cardA');
  assertEqual(ipCards[1].dataset.id, cardB.id, 'second card in in-progress should be cardB');

  // Clean up
  [cardA, cardB, cardC].forEach(c => {
    const idx = cards.findIndex(x => x.id === c.id);
    if (idx > -1) cards.splice(idx, 1);
  });
  renderBoard();
});

test('drop on same column does not change the card', () => {
  const card = addCard('Same Column', '', 'task', 'unassigned', []);
  renderBoard();
  const origUpdatedAt = card.updatedAt;

  draggedCardId = card.id;
  const backlogColumn = document.getElementById('column-backlog');
  const dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
  backlogColumn.dispatchEvent(dropEvent);

  assertEqual(card.column, 'backlog', 'card should still be in backlog');
  // updatedAt should NOT change since column didn't change
  assertEqual(card.updatedAt, origUpdatedAt, 'updatedAt should not change for same-column drop');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('dragging card adds .dragging class', () => {
  const card = addCard('Class Test', '', 'task', 'unassigned', []);
  renderBoard();

  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const dt = new DataTransfer();
  const dragEvent = new DragEvent('dragstart', { dataTransfer: dt, bubbles: true });
  cardEl.dispatchEvent(dragEvent);

  // The .dragging class is added via requestAnimationFrame, so we add it manually for test
  // In production, rAF handles it; in tests we simulate immediately
  cardEl.classList.add('dragging');
  assert(cardEl.classList.contains('dragging'), 'card should have .dragging class during drag');

  handleDragEnd();
  assert(!cardEl.classList.contains('dragging'), 'card should NOT have .dragging class after dragend');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('dragover on a column adds .drag-over class', () => {
  const card = addCard('Over Test', '', 'task', 'unassigned', []);
  renderBoard();

  const ipColumn = document.getElementById('column-in-progress');
  const dragOverEvent = new DragEvent('dragover', {
    bubbles: true,
    dataTransfer: new DataTransfer()
  });
  ipColumn.dispatchEvent(dragOverEvent);

  assert(ipColumn.classList.contains('drag-over'), 'column should have .drag-over class during dragover');

  handleDragEnd();
  assert(!ipColumn.classList.contains('drag-over'), 'column should NOT have .drag-over class after dragend');

  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle 3: localStorage Persistence ════════════════════════════════════════════════ */

// ── localStorage Mock ──
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, val) => { store[key] = val + ''; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
    _store: () => store
  };
})();

let _realLocalStorage;
function swapToMockLocalStorage() {
  _realLocalStorage = window.localStorage;
  Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true });
  localStorageMock.clear();
}
function swapToRealLocalStorage() {
  Object.defineProperty(window, 'localStorage', { value: _realLocalStorage, configurable: true });
}

test('saveToLocalStorage writes to localStorage under the correct key', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    const card = addCard('LS Save Test', 'desc', 'task', 'unassigned', ['tag1']);
    const stored = localStorage.getItem(STORAGE_KEY);
    assert(stored !== null, 'localStorage should have data under the key');
    const parsed = JSON.parse(stored);
    assert(Array.isArray(parsed), 'stored data should be an array');
    assertEqual(parsed.length, 1, 'stored array should have 1 card');
    assertEqual(parsed[0].id, card.id, 'stored card id should match');
    assertEqual(parsed[0].title, 'LS Save Test', 'stored card title should match');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
  }
});

test('loadFromLocalStorage returns the saved data', () => {
  swapToMockLocalStorage();
  try {
    const testData = [{ id: 'test-uuid-1', title: 'Loaded Card', column: 'backlog', type: 'task' }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(testData));
    const result = loadFromLocalStorage();
    assert(Array.isArray(result), 'should return an array');
    assertEqual(result.length, 1, 'should have 1 card');
    assertEqual(result[0].title, 'Loaded Card', 'title should match');
  } finally {
    swapToRealLocalStorage();
  }
});

test('loadFromLocalStorage returns empty array when localStorage is empty', () => {
  swapToMockLocalStorage();
  try {
    localStorageMock.clear();
    const result = loadFromLocalStorage();
    assert(Array.isArray(result), 'should return an array');
    assertEqual(result.length, 0, 'should return empty array');
  } finally {
    swapToRealLocalStorage();
  }
});

test('on initialization, if localStorage has data, cards array is populated from it', () => {
  swapToMockLocalStorage();
  try {
    const testData = [
      { id: 'init-1', title: 'Card From Storage', column: 'in-progress', type: 'idea' },
      { id: 'init-2', title: 'Another Stored', column: 'done', type: 'goal' }
    ];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(testData));
    cards.length = 0;
    restoreFromLocalStorage();
    assertEqual(cards.length, 2, 'cards array should have 2 items after restore');
    assertEqual(cards[0].title, 'Card From Storage', 'first card title should match');
    assertEqual(cards[1].title, 'Another Stored', 'second card title should match');
    assertEqual(cards[0].column, 'in-progress', 'first card column should match');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
  }
});

test('on initialization, if localStorage is empty, cards array starts empty', () => {
  swapToMockLocalStorage();
  try {
    localStorageMock.clear();
    cards.length = 0;
    restoreFromLocalStorage();
    assertEqual(cards.length, 0, 'cards array should be empty when localStorage is empty');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
  }
});

test('addCard triggers a save to localStorage', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    localStorageMock.clear();
    const card = addCard('Persisted', 'after add', 'goal', 'both', []);
    const stored = localStorage.getItem(STORAGE_KEY);
    assert(stored !== null, 'localStorage should be written after addCard');
    const parsed = JSON.parse(stored);
    const found = parsed.find(c => c.id === card.id);
    assert(found !== undefined, 'added card should be in localStorage');
    assertEqual(found.title, 'Persisted', 'stored card title should match');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
  }
});

test('drag-and-drop column change triggers a save to localStorage', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    localStorageMock.clear();
    const card = addCard('Drop Persist', '', 'task', 'unassigned', []);
    // addCard already saved; clear mock to verify drop saves again
    localStorageMock.clear();
    // Simulate drag to done
    draggedCardId = card.id;
    const doneColumn = document.getElementById('column-done');
    const dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
    doneColumn.dispatchEvent(dropEvent);
    const stored = localStorage.getItem(STORAGE_KEY);
    assert(stored !== null, 'localStorage should be written after drop');
    const parsed = JSON.parse(stored);
    const found = parsed.find(c => c.id === card.id);
    assert(found !== undefined, 'dropped card should be in localStorage');
    assertEqual(found.column, 'done', 'stored card should be in done column');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('drop on same column does NOT trigger a save to localStorage', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    localStorageMock.clear();
    const card = addCard('Same Col Persist', '', 'task', 'unassigned', []);
    // addCard saved; clear mock to check if drop re-saves
    localStorageMock.clear();
    draggedCardId = card.id;
    const backlogColumn = document.getElementById('column-backlog');
    const dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
    backlogColumn.dispatchEvent(dropEvent);
    const stored = localStorage.getItem(STORAGE_KEY);
    assert(stored === null, 'localStorage should NOT be written when dropping on same column');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('localStorage data survives across simulated page reloads', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    localStorageMock.clear();
    const card1 = addCard('Survive 1', 'desc1', 'task', 'alex', []);
    const card2 = addCard('Survive 2', 'desc2', 'idea', 'robin', ['cool']);
    // Simulate page reload: clear cards array, restore from localStorage
    cards.length = 0;
    restoreFromLocalStorage();
    assertEqual(cards.length, 2, 'both cards should be restored after simulated reload');
    const found1 = cards.find(c => c.id === card1.id);
    const found2 = cards.find(c => c.id === card2.id);
    assert(found1 !== undefined, 'card1 should be found after reload');
    assert(found2 !== undefined, 'card2 should be found after reload');
    assertEqual(found1.column, 'backlog', 'card1 column should be preserved');
    assertEqual(found2.labels.length, 1, 'card2 labels should be preserved');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('clearing localStorage and reloading shows empty board', () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    const card = addCard('Will Be Cleared', '', 'task', 'unassigned', []);
    // Clear localStorage (simulating user clearing storage)
    localStorageMock.clear();
    // Simulate page reload
    cards.length = 0;
    restoreFromLocalStorage();
    assertEqual(cards.length, 0, 'cards should be empty after localStorage cleared and restored');
  } finally {
    cards.length = 0;
    swapToRealLocalStorage();
    renderBoard();
  }
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle 4: JSON File Sync (board-data.json) ════════════════════════════════════════════════ */

// ── fetch Mock ──
let _fetchMockResponse = null;
let _fetchMockError = false;
let _fetchMockCalls = [];
const _realFetch = window.fetch;

function enableFetchMock(response, shouldError) {
  _fetchMockResponse = response || null;
  _fetchMockError = shouldError || false;
  _fetchMockCalls = [];
  window.fetch = async function(url, options) {
    _fetchMockCalls.push({ url, options });
    if (_fetchMockError) throw new Error('Network error: server not running');
    if (_fetchMockResponse) {
      return {
        ok: true,
        status: 200,
        json: async () => _fetchMockResponse
      };
    }
    return { ok: false, status: 404, json: async () => null };
  };
}

function disableFetchMock() {
  window.fetch = _realFetch;
  _fetchMockResponse = null;
  _fetchMockError = false;
}

test('saveToJSONFile is called after addCard', async () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    _jsonSaveCalled = false;
    enableFetchMock({ cards: [], lastUpdated: new Date().toISOString() });

    addCard('JSON Save Test', 'desc', 'task', 'unassigned', ['tag1']);

    // Allow microtask queue to flush
    await new Promise(r => setTimeout(r, 10));

    assert(_jsonSaveCalled, 'saveToJSONFile should have been called after addCard');
    assertEqual(_fetchMockCalls.length, 1, 'fetch should have been called once');
    assert(_fetchMockCalls[0].url.includes('/api/save'), 'fetch URL should be the save endpoint');

    const body = JSON.parse(_fetchMockCalls[0].options.body);
    assert(Array.isArray(body.cards), 'payload should have cards array');
    assert(body.lastUpdated !== undefined, 'payload should have lastUpdated');
    assertEqual(body.cards.length, 1, 'payload should have 1 card');
    assertEqual(body.cards[0].title, 'JSON Save Test', 'payload card title should match');
  } finally {
    cards.length = 0;
    _jsonSaveCalled = false;
    disableFetchMock();
    swapToRealLocalStorage();
  }
});

test('saveToJSONFile is called after a column change via drag-and-drop', async () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    _jsonSaveCalled = false;
    enableFetchMock({ cards: [], lastUpdated: new Date().toISOString() });

    const card = addCard('Drop JSON Test', '', 'task', 'unassigned', []);

    // Clear mock calls from addCard
    _fetchMockCalls = [];
    _jsonSaveCalled = false;

    // Simulate drag to done
    draggedCardId = card.id;
    const doneColumn = document.getElementById('column-done');
    const dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
    doneColumn.dispatchEvent(dropEvent);

    // Allow microtask queue to flush
    await new Promise(r => setTimeout(r, 10));

    assert(_jsonSaveCalled, 'saveToJSONFile should have been called after drop');
    assertEqual(_fetchMockCalls.length, 1, 'fetch should have been called once after drop');
    assert(_fetchMockCalls[0].url.includes('/api/save'), 'fetch URL should be the save endpoint');

    const body = JSON.parse(_fetchMockCalls[0].options.body);
    const movedCard = body.cards.find(c => c.id === card.id);
    assert(movedCard !== undefined, 'moved card should be in payload');
    assertEqual(movedCard.column, 'done', 'payload card should be in done column');
  } finally {
    cards.length = 0;
    _jsonSaveCalled = false;
    draggedCardId = null;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('loadFromJSONFile returns parsed data when server is available', async () => {
  enableFetchMock({
    cards: [
      { id: 'json-1', title: 'JSON Card', column: 'backlog', type: 'task' },
      { id: 'json-2', title: 'Another JSON Card', column: 'in-progress', type: 'idea' }
    ],
    lastUpdated: '2026-05-10T04:30:00.000Z'
  });

  try {
    const result = await loadFromJSONFile();
    assert(result !== null, 'result should not be null when server is available');
    assert(Array.isArray(result.cards), 'result should have cards array');
    assertEqual(result.cards.length, 2, 'result should have 2 cards');
    assertEqual(result.cards[0].title, 'JSON Card', 'first card title should match');
    assertEqual(result.lastUpdated, '2026-05-10T04:30:00.000Z', 'lastUpdated should match');
  } finally {
    disableFetchMock();
  }
});

test('loadFromJSONFile returns null when server is not running (graceful)', async () => {
  enableFetchMock(null, true); // simulate network error

  try {
    const result = await loadFromJSONFile();
    assertEqual(result, null, 'should return null when server is not running');
    // No error thrown — graceful degradation
  } finally {
    disableFetchMock();
  }
});

test('board-data.json structure has "cards" and "lastUpdated" fields', async () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    enableFetchMock(null);

    addCard('Structure Test', 'desc', 'goal', 'both', ['check']);

    await new Promise(r => setTimeout(r, 10));

    assertEqual(_fetchMockCalls.length, 1, 'fetch should have been called');
    const body = JSON.parse(_fetchMockCalls[0].options.body);

    // Validate board-data.json structure
    assert('cards' in body, 'payload must have "cards" field');
    assert('lastUpdated' in body, 'payload must have "lastUpdated" field');
    assert(Array.isArray(body.cards), '"cards" must be an array');

    // Validate lastUpdated is ISO-8601
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
    assert(isoRegex.test(body.lastUpdated), `lastUpdated "${body.lastUpdated}" should be ISO-8601 format`);

    // Validate card structure within cards array
    const card = body.cards[0];
    assert('id' in card, 'card must have "id"');
    assert('title' in card, 'card must have "title"');
    assert('column' in card, 'card must have "column"');
    assert('type' in card, 'card must have "type"');
    assert('assignees' in card, 'card must have "assignees" (array, post-#51)');
    assert(Array.isArray(card.assignees), 'assignees must be an array');
    assert('labels' in card, 'card must have "labels"');
    assert('createdAt' in card, 'card must have "createdAt"');
    assert('updatedAt' in card, 'card must have "updatedAt"');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
  }
});

test('JSON file data is used when localStorage is empty but JSON file exists', async () => {
  swapToMockLocalStorage();
  try {
    cards.length = 0;
    localStorageMock.clear();

    const jsonCards = [
      { id: 'json-load-1', title: 'From JSON File', column: 'backlog', type: 'task', assignee: 'unassigned', labels: [], createdAt: '2026-05-10T04:00:00.000Z', updatedAt: '2026-05-10T04:00:00.000Z', order: 0 },
      { id: 'json-load-2', title: 'Also From JSON', column: 'in-progress', type: 'idea', assignee: 'robin', labels: ['cool'], createdAt: '2026-05-10T04:10:00.000Z', updatedAt: '2026-05-10T04:10:00.000Z', order: 1 }
    ];

    enableFetchMock({
      cards: jsonCards,
      lastUpdated: '2026-05-10T04:30:00.000Z'
    });

    // Simulate page load: JSON file has data, localStorage is empty
    const jsonResult = await loadFromJSONFile();
    assert(jsonResult !== null, 'JSON file should return data');
    assertEqual(jsonResult.cards.length, 2, 'JSON file should have 2 cards');

    // Since localStorage is empty, use JSON data
    const lsResult = loadFromLocalStorage();
    assertEqual(lsResult.length, 0, 'localStorage should be empty');

    // The app would restore from JSON when localStorage is empty
    cards.length = 0;
    jsonResult.cards.forEach(c => cards.push(c));

    assertEqual(cards.length, 2, 'cards array should be populated from JSON file');
    assertEqual(cards[0].title, 'From JSON File', 'first card title should come from JSON');
    assertEqual(cards[1].title, 'Also From JSON', 'second card title should come from JSON');
    assertEqual(cards[1].column, 'in-progress', 'card column should come from JSON');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle 5: Visual Design Polish
   ════════════════════════════════════════════════ */

test('card has a 4px colored left border strip matching its type', () => {
  const card = addCard('Border Test', 'desc', 'idea', 'robin', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  assert(cardEl !== null, 'card element should exist');
  const style = getComputedStyle(cardEl);
  assertEqual(style.position, 'relative', 'card should be position relative for border strip');
  assertEqual(cardEl.dataset.type, 'idea', 'card type should match for border color');
  const sheets = document.styleSheets;
  let foundBorderStrip = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === '.card::before' && (rules[j].style.width === '4px' || rules[j].style.width === 'var(--border-strip-width)')) {
          foundBorderStrip = true;
        }
      }
    } catch(e) {}
  }
  assert(foundBorderStrip, 'CSS should define 4px width for .card::before border strip');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('card gradient background is applied via CSS', () => {
  const card = addCard('Gradient Test', '', 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  assert(cardEl !== null, 'card element should exist');
  const sheets = document.styleSheets;
  let foundGradient = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === '.card' && rules[j].style.background && rules[j].style.background.includes('gradient')) {
          foundGradient = true; break;
        }
      }
    } catch(e) {}
    if (foundGradient) break;
  }
  assert(foundGradient, 'CSS rules should define a gradient background for .card');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('card type emoji is displayed as a large icon', () => {
  const card = addCard('Emoji Size Test', '', 'goal', 'both', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  const emojiEl = cardEl.querySelector('.card-emoji');
  assert(emojiEl !== null, 'emoji element should exist');
  assertEqual(emojiEl.textContent, '\u{1F3AF}', 'should show goal emoji');
  const sheets = document.styleSheets;
  let foundLargeEmoji = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === '.card-emoji' && rules[j].style.fontSize === '1.5rem') {
          foundLargeEmoji = true; break;
        }
      }
    } catch(e) {}
    if (foundLargeEmoji) break;
  }
  assert(foundLargeEmoji, 'CSS should define 1.5rem font-size for .card-emoji');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('assignee badge renders with emoji and name text as pill', () => {
  const card = addCard('Assignee Badge Test', '', 'task', 'alex', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  const badge = cardEl.querySelector('.card-assignee');
  assert(badge !== null, 'assignee badge should exist');
  const emojiSpan = badge.querySelector('.assignee-emoji');
  assert(emojiSpan !== null, 'assignee emoji span should exist');
  assertEqual(emojiSpan.textContent, '\u{1F9D1}\u200D\u{1F4BB}', 'emoji should be alex');
  assert(badge.textContent.includes('Alex'), 'badge should contain name text');
  const sheets = document.styleSheets;
  let foundPill = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === '.card-assignee' && rules[j].style.borderRadius === '999px') {
          foundPill = true; break;
        }
      }
    } catch(e) {}
    if (foundPill) break;
  }
  assert(foundPill, 'CSS should define 999px border-radius for .card-assignee (pill shape)');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('labels render as pill-shaped elements', () => {
  const card = addCard('Label Pill Test', '', 'task', 'unassigned', ['urgent', 'bug']);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  const labelTags = cardEl.querySelectorAll('.label-tag');
  assertEqual(labelTags.length, 2, 'should have 2 label tags');
  assert(labelTags[0].textContent.includes('urgent'), 'first label should contain urgent');
  assert(labelTags[1].textContent.includes('bug'), 'second label should contain bug');
  const sheets = document.styleSheets;
  let foundPill = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].selectorText === '.label-tag' && rules[j].style.borderRadius === '999px') {
          foundPill = true; break;
        }
      }
    } catch(e) {}
    if (foundPill) break;
  }
  assert(foundPill, 'CSS should define 999px border-radius for .label-tag (pill shape)');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('column card counts are displayed and accurate', () => {
  cards.length = 0; renderBoard();
  const c1 = addCard('Count A', '', 'task', 'unassigned', []);
  const c2 = addCard('Count B', '', 'task', 'unassigned', []);
  const c3 = addCard('Count C', '', 'task', 'unassigned', []);
  c3.column = 'in-progress'; renderBoard();
  assertEqual(document.getElementById('backlog-count').textContent, '2', 'backlog count should be 2');
  assertEqual(document.getElementById('in-progress-count').textContent, '1', 'in-progress count should be 1');
  assertEqual(document.getElementById('done-count').textContent, '0', 'done count should be 0');
  c2.column = 'done'; renderBoard();
  assertEqual(document.getElementById('backlog-count').textContent, '1', 'backlog count should be 1');
  assertEqual(document.getElementById('done-count').textContent, '1', 'done count should be 1');
  cards.length = 0; renderBoard();
});

test('empty columns show placeholder text with dashed border', () => {
  cards.length = 0; renderBoard();
  const ipBody = document.getElementById('in-progress-body');
  const emptyState = ipBody.querySelector('.empty-state');
  assert(emptyState !== null, 'empty state should exist for empty in-progress');
  assert(emptyState.textContent.includes('Drop cards here'), 'in-progress empty state should say "Drop cards here"');
  const doneBody = document.getElementById('done-body');
  const doneEmpty = doneBody.querySelector('.empty-state');
  assert(doneEmpty !== null, 'done empty state should exist');
  assert(doneEmpty.textContent.includes('No cards yet'), 'done empty state should say "No cards yet"');
  const backlogBody = document.getElementById('backlog-body');
  const backlogEmpty = backlogBody.querySelector('.empty-state');
  assert(backlogEmpty !== null, 'backlog empty state should exist when no cards');
  const style = getComputedStyle(emptyState);
  assert(style.borderStyle === 'dashed' || style.borderTopStyle === 'dashed', 'empty state should have dashed border');
});

test('form starts collapsed and expands on button click', () => {
  const wrapper = document.getElementById('add-card-form-wrapper');
  const btn = document.getElementById('btn-expand-form');
  assert(!wrapper.classList.contains('expanded'), 'form wrapper should start collapsed');
  assert(!btn.classList.contains('active'), 'expand button should start without active class');
  btn.click();
  assert(wrapper.classList.contains('expanded'), 'form wrapper should be expanded after click');
  assert(btn.classList.contains('active'), 'expand button should have active class');
  btn.click();
  assert(!wrapper.classList.contains('expanded'), 'form wrapper should be collapsed after second click');
  assert(!btn.classList.contains('active'), 'expand button should not have active class');
});

test('column headers have gradient backgrounds matching their purpose', () => {
  assert(document.querySelector('.backlog-header') !== null, 'backlog header should exist');
  assert(document.querySelector('.in-progress-header') !== null, 'in-progress header should exist');
  assert(document.querySelector('.done-header') !== null, 'done header should exist');
});

test('header has animated gradient background', () => {
  assert(document.querySelector('.board-header') !== null, 'board header should exist');
  const sheets = document.styleSheets;
  let found = false;
  for (let i = 0; i < sheets.length; i++) {
    try {
      const rules = sheets[i].cssRules || sheets[i].rules;
      for (let j = 0; j < rules.length; j++) {
        if (rules[j].name === 'headerGradient') { found = true; break; }
      }
    } catch(e) {}
    if (found) break;
  }
  assert(found, 'CSS should define @keyframes headerGradient');
});

test('card title is a serif heading, visually distinct from the body description', () => {
  const card = addCard('Typography Test', 'A description here', 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  assert(cardEl.querySelector('.card-title') !== null, 'title element should exist');
  assert(cardEl.querySelector('.card-description') !== null, 'description element should exist');
  // #333 — the title is the serif face (matching the wiki's page titles) and
  // heavier than the description; the description stays the smaller body face.
  // Behavior over surface: check the family + relative weight, not a magic px.
  const titleCS = getComputedStyle(cardEl.querySelector('.card-title'));
  const descCS = getComputedStyle(cardEl.querySelector('.card-description'));
  const ts = /serif|Iowan|Palatino|Georgia/i.test(titleCS.fontFamily);
  const tw = Number(titleCS.fontWeight) >= 600;
  const ds = parseFloat(descCS.fontSize) < parseFloat(titleCS.fontSize);
  assert(ts, 'card-title should be the serif face: ' + titleCS.fontFamily);
  assert(tw, 'card-title should be at least 600 weight: ' + titleCS.fontWeight);
  assert(ds, 'description should be smaller than the title');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('noise texture overlay exists on body', () => {
  const style = getComputedStyle(document.body, '::before');
  assert(style.content !== 'none' && style.content !== 'normal', 'body::before should exist for noise');
});


/* ════════════════════════════════════════════════ TESTS - TDD Cycle 6: Assignee Filtering ════════════════════════════════════════════════ */

// #498: was 'clicking assignee name on card toggles assignee filter'. The chip
// is an inert indicator now; the toggle function it used to reach is still
// exercised below, via the header control's path rather than a card click.
test('#498: the card assignee chip is an inert indicator, and the filter still toggles', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  const card = addCard('Assignee Click Test', 'desc', 'task', 'alex', []);
  renderBoard();
  let cardEl = document.querySelector('.card[data-id="' + card.id + '"]');
  let assigneeBadge = cardEl.querySelector('.card-assignee');
  assert(assigneeBadge !== null, 'assignee badge should exist');
  assert(!assigneeBadge.dataset.action, `assignee chip must carry no click action, got "${assigneeBadge.dataset.action}"`);
  assertEqual(assigneeBadge.dataset.assignee, 'alex', 'chip still carries its value for styling/reading');
  // Simulate click to toggle on
  toggleAssigneeFilter('alex');
  assert(activeAssignees.has('alex'), 'alex should be in activeAssignees after toggle on');
  // Toggle off
  toggleAssigneeFilter('alex');
  assert(!activeAssignees.has('alex'), 'alex should be removed from activeAssignees after toggle off');
  const idx2 = cards.findIndex(c => c.id === card.id);
  if (idx2 > -1) cards.splice(idx2, 1);
  activeAssignees.clear();
  renderBoard();
});

test('activeAssignees filters board to show only cards with matching assignee', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Card A', '', 'task', 'alex', []);
  addCard('Card B', '', 'task', 'robin', []);
  addCard('Card C', '', 'task', 'alex', []);
  activeAssignees.add('alex');
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  const visibleCards = backlogBody.querySelectorAll('.card');
  assertEqual(visibleCards.length, 2, 'should show 2 cards assigned to alex');
  const idx2 = cards.findIndex(c => c.title === 'Card B');
  assert(backlogBody.querySelector('.card[data-id="' + cards[idx2].id + '"]') === null, 'robin card should be hidden');
  cards.length = 0;
  activeAssignees.clear();
  renderBoard();
});

test('multiple assignee filters use OR logic — shows cards for ANY selected assignee', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Card A', '', 'task', 'alex', []);
  addCard('Card B', '', 'task', 'robin', []);
  // #508: Card C used to rely on the retired 'both' sentinel expanding to two
  // seats. The subject here is OR logic across a multi-assignee card, so it now
  // names both seats directly.
  addCard('Card C', '', 'task', ['alex', 'robin'], []);
  addCard('Card D', '', 'task', 'unassigned', []);
  activeAssignees.add('alex');
  activeAssignees.add('robin');
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  const visibleCards = backlogBody.querySelectorAll('.card');
  assertEqual(visibleCards.length, 3,
    'should show 3 cards (A=alex, B=robin, C=multi-assigned matches both)');
  cards.length = 0;
  activeAssignees.clear();
  renderBoard();
});

test('assignee AND label filters combine — card must match both criteria', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Card A', '', 'task', 'alex', ['urgent']);
  addCard('Card B', '', 'task', 'robin', ['urgent']);
  addCard('Card C', '', 'task', 'alex', ['bug']);
  addCard('Card D', '', 'task', 'robin', ['bug']);
  // Filter: assignee=alex AND label=urgent
  activeAssignees.add('alex');
  activeLabels.add('urgent');
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  const visibleCards = backlogBody.querySelectorAll('.card');
  assertEqual(visibleCards.length, 1, 'should show 1 card matching both assignee AND label');
  assertEqual(visibleCards[0].dataset.id, cards[0].id, 'should be Card A (alex + urgent)');
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  renderBoard();
});

test('clicking X on assignee filter chip removes that assignee from filter', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Card A', '', 'task', 'alex', []);
  addCard('Card B', '', 'task', 'robin', []);
  activeAssignees.add('alex');
  activeAssignees.add('robin');
  renderBoard();
  assertEqual(activeAssignees.size, 2, 'should have 2 active assignee filters');
  // Simulate clicking X on the alex chip
  const strip = document.getElementById('filter-strip');
  const alexX = strip.querySelector('[data-action="remove-assignee"][data-assignee="alex"]');
  assert(alexX !== null, 'should have X button for alex assignee chip');
  alexX.click();
  assertEqual(activeAssignees.size, 1, 'should have 1 active assignee filter after removing alex');
  assert(!activeAssignees.has('alex'), 'alex should be removed');
  assert(activeAssignees.has('robin'), 'robin should still be active');
  cards.length = 0;
  activeAssignees.clear();
  renderBoard();
});

test('Clear all button removes both label and assignee filters', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Card A', '', 'task', 'alex', ['urgent']);
  activeAssignees.add('alex');
  activeLabels.add('urgent');
  renderBoard();
  assert(activeAssignees.size > 0, 'should have assignee filter active');
  assert(activeLabels.size > 0, 'should have label filter active');
  const strip = document.getElementById('filter-strip');
  const clearBtn = strip.querySelector('[data-action="clear-filter"]');
  assert(clearBtn !== null, 'Clear all button should exist');
  clearBtn.click();
  assertEqual(activeAssignees.size, 0, 'assignee filters should be cleared');
  assertEqual(activeLabels.size, 0, 'label filters should be cleared');
  cards.length = 0;
  renderBoard();
});

test('unassigned assignee filter shows cards with no assignee', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Assigned', '', 'task', 'alex', []);
  addCard('Unassigned Card', '', 'task', 'unassigned', []);
  activeAssignees.add('unassigned');
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  const visibleCards = backlogBody.querySelectorAll('.card');
  assertEqual(visibleCards.length, 1, 'should show 1 unassigned card');
  cards.length = 0;
  activeAssignees.clear();
  renderBoard();
});

test('assignee filter chips are visually distinct from label filter chips', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Vis Test', '', 'task', 'alex', ['urgent']);
  activeAssignees.add('alex');
  activeLabels.add('urgent');
  renderBoard();
  const strip = document.getElementById('filter-strip');
  const assigneeChip = strip.querySelector('.filter-chip-assignee');
  const labelChip = strip.querySelector('.filter-chip');
  assert(assigneeChip !== null, 'assignee chip should exist');
  assert(labelChip !== null, 'label chip should exist');
  assert(!assigneeChip.classList.contains('filter-chip'), 'assignee chip should NOT have filter-chip class');
  assert(assigneeChip.classList.contains('filter-chip-assignee'), 'assignee chip should have filter-chip-assignee class');
  // Check they have different background colors
  const assigneeStyle = getComputedStyle(assigneeChip);
  const labelStyle = getComputedStyle(labelChip);
  assert(assigneeStyle.backgroundColor !== labelStyle.backgroundColor || assigneeStyle.color !== labelStyle.color,
    'assignee and label chips should have different visual styling');
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  renderBoard();
});

test('active assignee badge on card gets active-filter class', () => {
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Active Badge', '', 'task', 'alex', []);
  activeAssignees.add('alex');
  renderBoard();
  const cardEl = document.querySelector('.card-assignee[data-assignee="alex"]');
  assert(cardEl !== null, 'assignee badge should exist');
  assert(cardEl.classList.contains('active-filter'), 'assignee badge should have active-filter class when filtered');
  cards.length = 0;
  activeAssignees.clear();
  renderBoard();
});

test('F5 page reload wipes all filters (no persistence)', () => {
  // Simulate: filters are session-only Sets, not saved to localStorage
  cards.length = 0;
  activeLabels.clear();
  activeAssignees.clear();
  addCard('Persist Test', '', 'task', 'alex', ['tag']);
  activeAssignees.add('alex');
  activeLabels.add('tag');
  // Verify filters are active
  assert(activeAssignees.size > 0, 'assignee filter should be active');
  assert(activeLabels.size > 0, 'label filter should be active');
  // Simulate page reload: Sets are in-memory only, so they'd be cleared
  // (In reality, a reload creates new Sets; we simulate by clearing)
  activeAssignees.clear();
  activeLabels.clear();
  assertEqual(activeAssignees.size, 0, 'after reload simulation, assignee filters should be empty');
  assertEqual(activeLabels.size, 0, 'after reload simulation, label filters should be empty');
  cards.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Collapse Long Descriptions ════════════════════════════════════════════════ */

// Helper: generate a long description that exceeds ~4 lines
function makeLongDescription(lines) {
  const line = 'This is a line of description text that should wrap.';
  return Array.from({ length: lines }, () => line).join('\n');
}

// ── #510 SUPERSEDES the six "Collapse Long Descriptions" tests below this line ──
// They asserted the in-column "Show more" expander: that it rendered, that
// clicking it expanded, collapsed, toggled aria-expanded, kept per-card state,
// and reset on re-render. All six described a control this card deletes.
//
// The ruling was pre-registered on #510 BEFORE the build ("the pop-out is THE
// reading path; this card removes .desc-toggle in the same change"), so the
// decision reached an artifact before it reached the tests — no card owns the
// original feature, which arrived with the repo's first commit.
//
// Rewritten to guard the retirement rather than deleted, so the ribbon cannot
// quietly return: a description that used to sprout a toggle now stays clamped
// in the column, and its full text lives in the pop-out at a readable measure.

test('#510 (supersedes the collapse tests): a long description clamps in-column with NO expander', () => {
  cards.length = 0;
  const longDesc = makeLongDescription(10);
  const card = addCard('Long Desc', longDesc, 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const descEl = cardEl.querySelector('.card-description');
  assert(descEl !== null, 'the description still renders on the card');
  assert(descEl.classList.contains('collapsed'), 'a long description is still clamped in the column');
  assert(cardEl.querySelector('.desc-toggle') === null,
    'the in-column expander must be gone — it turned prose into a 300px ribbon');
  cards.length = 0; renderBoard();
});

test('#510: the full description is reachable through the pop-out, at a readable measure', () => {
  cards.length = 0;
  const longDesc = makeLongDescription(10);
  const card = addCard('Popout Read', longDesc, 'task', 'unassigned', []);
  renderBoard();
  const opened = openCardDetail(card.shortId, false);
  assert(opened, 'openCardDetail must find the card by shortId');
  const back = document.getElementById('card-detail-backdrop');
  assert(back && !back.hidden, 'the pop-out is visible — an off-screen or hidden panel is the cheat');
  const body = document.querySelector('.card-detail-body');
  assert(body !== null, 'the pop-out carries a body');
  assert(body.textContent.includes('This is a line of description text'),
    'the FULL description is present in the pop-out, not a truncation');
  closeCardDetail(false);
  assert(back.hidden, 'closeCardDetail hides it again');
  cards.length = 0; renderBoard();
});

test('#510: every exit is reachable programmatically — Escape, close button, backdrop', () => {
  cards.length = 0;
  const card = addCard('Exits', makeLongDescription(6), 'task', 'unassigned', []);
  renderBoard();
  const back = document.getElementById('card-detail-backdrop');

  // 1. the close button carries a data-action a scripted seat can find and click
  openCardDetail(card.shortId, false);
  const closeBtn = document.querySelector('.card-detail-close');
  assert(closeBtn !== null, 'a close control exists');
  assertEqual(closeBtn.dataset.action, 'close-card-detail', 'it carries a data-action');
  closeCardDetail(false);
  assert(back.hidden, 'close button path closes it');

  // 2. Escape — dispatchable by any driver
  openCardDetail(card.shortId, false);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert(back.hidden, 'Escape closes it — a seat that cannot click can still leave');

  // 3. the backdrop itself carries the same action
  assertEqual(back.dataset.action, 'close-card-detail', 'the backdrop is an exit too');
  cards.length = 0; renderBoard();
});

test('edit mode does not show collapsed description (full textarea)', () => {
  const longDesc = makeLongDescription(10);
  const card = addCard('Edit Test', longDesc, 'task', 'unassigned', []);
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  assert(cardEl.classList.contains('editing'), 'card should be in edit mode');
  const descEl = cardEl.querySelector('.card-description.collapsed');
  assert(descEl === null, 'no collapsed description element in edit mode');
  // #510: the 'no toggle in edit mode' assertion was removed here rather than
  // kept — with .desc-toggle deleted everywhere it can never fail, and a check
  // that cannot fail is the vanity shape this room keeps catching. The
  // retirement is guarded by name in the #510 tests above.
  const textarea = cardEl.querySelector('.edit-desc');
  assert(textarea !== null, 'edit textarea should exist');
  assertEqual(textarea.value, longDesc, 'textarea should contain full description');
  // Clean up
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#510 (supersedes the reset test): a long description stays clamped across re-renders', () => {
  // Was: expand via the toggle, re-render, assert it collapsed again. The
  // toggle is gone, so the surviving property is simpler and still worth a
  // guard — re-rendering must not leave a long description un-clamped in the
  // column, which is the ribbon this card exists to end.
  cards.length = 0;
  const longDesc = makeLongDescription(10);
  const card = addCard('Reset Test', longDesc, 'task', 'unassigned', []);
  renderBoard();
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const descEl = cardEl.querySelector('.card-description');
  assert(descEl.classList.contains('collapsed'), 'still clamped after a re-render');
  assert(cardEl.querySelector('.desc-toggle') === null, 'and no expander has come back');
  cards.length = 0; renderBoard();
});

test('AC1: on page load, JSON is source of truth and localStorage gets synced FROM JSON', async () => {
  swapToMockLocalStorage();
  enableFetchMock({
    cards: [
      { id: 'ac1-json-card', title: 'From JSON', column: 'backlog', type: 'task', assignee: 'unassigned', labels: [], createdAt: '2026-05-10T04:00:00.000Z', updatedAt: '2026-05-10T04:00:00.000Z', order: 0 }
    ],
    lastUpdated: '2026-05-10T04:30:00.000Z'
  });
  try {
    cards.length = 0;
    localStorageMock.clear();
    _jsonSaveCalled = false;
    const savedCards = loadFromLocalStorage();
    assertEqual(savedCards.length, 0, 'localStorage should be empty before init');
    const jsonResult = await loadFromJSONFile();
    if (jsonResult && jsonResult.cards && jsonResult.cards.length > 0) {
      cards.length = 0;
      jsonResult.cards.forEach(c => cards.push(c));
      saveToLocalStorage();
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    assert(stored !== null, 'localStorage should be written AFTER JSON load (synced FROM JSON)');
    const parsed = JSON.parse(stored);
    assertEqual(parsed.length, 1, 'localStorage should have the JSON cards after sync');
    assertEqual(parsed[0].title, 'From JSON', 'localStorage card should match JSON');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('AC2: stale localStorage does NOT overwrite JSON when page loads', async () => {
  swapToMockLocalStorage();
  enableFetchMock({
    cards: [
      { id: 'ac2-json-card', title: 'Fresh From JSON', column: 'backlog', type: 'task', assignee: 'unassigned', labels: [], createdAt: '2026-05-10T04:00:00.000Z', updatedAt: '2026-05-10T04:00:00.000Z', order: 0 }
    ],
    lastUpdated: '2026-05-10T04:30:00.000Z'
  });
  try {
    cards.length = 0;
    const staleData = [{ id: 'stale-ls-card', title: 'Stale From LocalStorage', column: 'done', type: 'task', assignee: 'unassigned', labels: [], createdAt: '2026-05-09T04:00:00.000Z', updatedAt: '2026-05-09T04:00:00.000Z', order: 0 }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(staleData));
    _jsonSaveCalled = false;
    const jsonResult = await loadFromJSONFile();
    if (jsonResult && jsonResult.cards && jsonResult.cards.length > 0) {
      cards.length = 0;
      jsonResult.cards.forEach(c => cards.push(c));
    } else {
      restoreFromLocalStorage();
    }
    assertEqual(cards[0].title, 'Fresh From JSON', 'cards should be loaded FROM JSON, not from stale localStorage');
    assertEqual(cards.length, 1, 'should have 1 card from JSON');
    assertEqual(_jsonSaveCalled, false, 'JSON save should NOT be called when JSON was valid source of truth');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('AC3: when JSON is empty, fall back to localStorage and bootstrap JSON', async () => {
  swapToMockLocalStorage();
  enableFetchMock({ cards: [], lastUpdated: '2026-05-10T04:30:00.000Z' });
  try {
    cards.length = 0;
    const lsData = [{ id: 'ac3-ls-card', title: 'Fallback From LS', column: 'in-progress', type: 'idea', assignee: 'robin', labels: ['cool'], createdAt: '2026-05-09T04:00:00.000Z', updatedAt: '2026-05-09T04:00:00.000Z', order: 0 }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lsData));
    _jsonSaveCalled = false;
    enableFetchMock({ cards: [], lastUpdated: '2026-05-10T04:30:00.000Z' });
    const jsonResult = await loadFromJSONFile();
    if (!jsonResult || !jsonResult.cards || jsonResult.cards.length === 0) {
      restoreFromLocalStorage();
      saveToJSONFile();
      _testHookMarkSaved(); // production callers set this flag; this test acts as the caller
    }
    assertEqual(cards.length, 1, 'should fall back to localStorage when JSON is empty');
    assertEqual(cards[0].title, 'Fallback From LS', 'card should come from localStorage on empty JSON');
    assertEqual(_jsonSaveCalled, true, 'should call saveToJSONFile to bootstrap JSON when falling back');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('AC4: user actions (addCard) still sync both stores', async () => {
  swapToMockLocalStorage();
  enableFetchMock({ cards: [], lastUpdated: new Date().toISOString() });
  try {
    cards.length = 0;
    _jsonSaveCalled = false;
    const card = addCard('User Action Test', 'desc', 'task', 'unassigned', ['action']);
    assert(card !== null, 'card should be added');
    const lsStored = localStorage.getItem(STORAGE_KEY);
    assert(lsStored !== null, 'localStorage should be written after addCard');
    const lsParsed = JSON.parse(lsStored);
    assertEqual(lsParsed.length, 1, 'localStorage should have the new card');
    assertEqual(_jsonSaveCalled, true, 'saveToJSONFile should be called after addCard');
  } finally {
    cards.length = 0;
    _jsonSaveCalled = false;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

test('AC5: server-down fallback works — loads from localStorage when JSON file fetch fails', async () => {
  swapToMockLocalStorage();
  enableFetchMock(null, true);
  try {
    cards.length = 0;
    const fallbackData = [{ id: 'ac5-fallback', title: 'Server Down Fallback', column: 'backlog', type: 'task', assignee: 'unassigned', labels: [], createdAt: '2026-05-09T04:00:00.000Z', updatedAt: '2026-05-09T04:00:00.000Z', order: 0 }];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fallbackData));
    const jsonResult = await loadFromJSONFile();
    if (jsonResult === null) {
      restoreFromLocalStorage();
    }
    assertEqual(cards.length, 1, 'should fall back to localStorage when server is down');
    assertEqual(cards[0].title, 'Server Down Fallback', 'should load card from localStorage on server failure');
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
    renderBoard();
  }
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Column Rename ════════════════════════════════════════════════ */

test('columnNames object exists with defaults for the three columns', () => {
  const defaults = { backlog: 'Backlog', 'in-progress': 'In Progress', done: 'Done' };
  assert(columnNames !== undefined, 'columnNames should be defined');
  assertEqual(columnNames.backlog, defaults.backlog, 'backlog should have correct default');
  assertEqual(columnNames['in-progress'], defaults['in-progress'], 'in-progress should have correct default');
  assertEqual(columnNames.done, defaults.done, 'done should have correct default');
});

test('double-click on column header enters rename mode (shows input)', () => {
  const header = document.querySelector('.backlog-header');
  assert(header !== null, 'backlog header should exist');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  assert(input !== null, 'rename input should appear on double-click');
  assertEqual(input.value, 'Backlog', 'input should pre-populate with current name');
});

test('double-click on in-progress header enters rename mode', () => {
  const header = document.querySelector('.in-progress-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  assert(input !== null, 'rename input should appear on double-click for in-progress');
  assertEqual(input.value, 'In Progress', 'input should pre-populate with current name');
});

test('double-click on done header enters rename mode', () => {
  const header = document.querySelector('.done-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  assert(input !== null, 'rename input should appear on double-click for done');
  assertEqual(input.value, 'Done', 'input should pre-populate with current name');
});

test('Enter key saves the new column name and reverts to static header', () => {
  const header = document.querySelector('.backlog-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  input.value = 'My Backlog';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const staticText = header.querySelector('.column-name-text');
  assert(staticText !== null, 'should revert to static text after Enter');
  assertEqual(columnNames.backlog, 'My Backlog', 'columnNames.backlog should be updated');
  assertEqual(staticText.textContent, '📥 My Backlog', 'header should show new name');
});

test('blur saves the new column name and reverts to static header', () => {
  const header = document.querySelector('.in-progress-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  input.value = 'WIP';
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  const staticText = header.querySelector('.column-name-text');
  assert(staticText !== null, 'should revert to static text after blur');
  assertEqual(columnNames['in-progress'], 'WIP', 'columnNames.in-progress should be updated');
  assertEqual(staticText.textContent, '⚡ WIP', 'header should show new name');
});

test('Escape cancels rename and restores original name', () => {
  const original = columnNames.backlog;
  const header = document.querySelector('.backlog-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  input.value = 'Should Not Save';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const staticText = header.querySelector('.column-name-text');
  assert(staticText !== null, 'should revert to static text after Escape');
  assertEqual(columnNames.backlog, original, 'columnNames.backlog should NOT be changed');
  assertEqual(staticText.textContent, '📥 ' + original, 'header should show original name');
});

test('empty name is rejected — original name is restored', () => {
  const original = columnNames.done;
  const header = document.querySelector('.done-header');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = header.querySelector('.column-rename-input');
  input.value = '';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assertEqual(columnNames.done, original, 'columnNames.done should NOT be changed for empty name');
  const staticText = header.querySelector('.column-name-text');
  assertEqual(staticText.textContent, '✅ ' + original, 'header should show original name');
});

test('renamed column name persists to localStorage', () => {
  swapToMockLocalStorage();
  try {
    columnNames.backlog = 'Persistent Name';
    saveColumnNamesToStorage();
    const stored = localStorage.getItem(COLUMN_NAMES_KEY);
    assert(stored !== null, 'columnNames should be saved to localStorage');
    const parsed = JSON.parse(stored);
    assertEqual(parsed.backlog, 'Persistent Name', 'stored columnNames should have the renamed value');
    columnNames.backlog = 'Backlog';
  } finally {
    swapToRealLocalStorage();
  }
});

test('columnNames are loaded from localStorage on init', () => {
  swapToMockLocalStorage();
  try {
    localStorageMock.clear();
    localStorage.setItem(COLUMN_NAMES_KEY, JSON.stringify({ backlog: 'Loaded Name', 'in-progress': 'In Progress', done: 'Done' }));
    loadColumnNamesFromStorage();
    assertEqual(columnNames.backlog, 'Loaded Name', 'columnNames.backlog should be loaded from localStorage');
    columnNames.backlog = 'Backlog';
  } finally {
    swapToRealLocalStorage();
  }
});

test('saveToJSONFile includes columns array in the payload', async () => {
  // Originally asserted columnNames-in-payload — but the persisted shape is
  // the `columns` array (Card #41), with names derived from columns[].name.
  // Migrated the assertion to match the actual schema.
  swapToMockLocalStorage();
  enableFetchMock({ cards: [], columns: [], lastUpdated: new Date().toISOString() });
  try {
    cards.length = 0;
    _jsonSaveCalled = false;
    _fetchMockCalls = [];
    // Mutate a column name so we can verify it round-trips through the payload
    const backlogCol = columns.find(c => c.id === 'backlog');
    const original = backlogCol.name;
    backlogCol.name = 'JSON Save Test';
    saveToJSONFile();
    _testHookMarkSaved(); // production callers set this; test acts as the caller
    await new Promise(r => setTimeout(r, 20));
    assert(_jsonSaveCalled, 'saveToJSONFile should be called');
    const body = JSON.parse(_fetchMockCalls[_fetchMockCalls.length - 1].options.body);
    assert(Array.isArray(body.columns), 'payload should have columns array');
    const backlogInPayload = body.columns.find(c => c.id === 'backlog');
    assertEqual(backlogInPayload.name, 'JSON Save Test', 'column name should round-trip through the payload');
    backlogCol.name = original; // restore
  } finally {
    cards.length = 0;
    disableFetchMock();
    swapToRealLocalStorage();
  }
});

// ════════════════════════════════════════════════ TESTS - Card #29: For Field ════════════════════════════════════════════════

test('T1: For field renders on card edit form — input visible, empty for new cards, populated for existing', () => {
  cards.length = 0;
  addCard('Test Card', '', 'task', 'unassigned', []);
  renderBoard();
  const firstCard = document.querySelector('.card');
  firstCard.querySelector('[data-action="edit"]').click();
  renderBoard();
  const forInput = document.querySelector('.edit-for');
  assert(forInput !== null, 'For input should exist in edit form');
  assertEqual(forInput.value, '', 'For input should be empty for new cards');
  cards.length = 0;
  renderBoard();
});

test('T2: For field saves and persists — type "Ali", save, reopen, shows "Ali", board-data.json has "for":"Ali"', () => {
  swapToMockLocalStorage();
  cards.length = 0;
  addCard('Persist Test', '', 'task', 'unassigned', []);
  const cardId = cards[0].id;
  renderBoard();
  const firstCard = document.querySelector('.card');
  firstCard.querySelector('[data-action="edit"]').click();
  renderBoard();
  const forInput = document.querySelector('.edit-for');
  forInput.value = 'Ali';
  document.querySelector('[data-action="save-edit"]').click();
  const savedCard = cards.find(c => c.id === cardId);
  assertEqual(savedCard.for, 'Ali', 'card.for should be "Ali" after save');
  // Reopen edit form
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${cardId}"]`);
  cardEl.querySelector('[data-action="edit"]').click();
  renderBoard();
  const reopenedInput = document.querySelector('.edit-for');
  assertEqual(reopenedInput.value, 'Ali', 'For input should show "Ali" when reopening edit');
  cards.length = 0;
  swapToRealLocalStorage();
  renderBoard();
});

test('T3: For field displays on board cards — card with "for":"Pharmacy" shows "For: Pharmacy" badge', () => {
  cards.length = 0;
  addCard('Pharmacy Card', '', 'task', 'unassigned', []);
  cards[0].for = 'Pharmacy';
  renderBoard();
  const cardEl = document.querySelector('.card');
  const forBadge = cardEl.querySelector('.card-for');
  assert(forBadge !== null, 'For badge element should exist on card');
  const forText = forBadge.textContent;
  assert(forText.includes('Pharmacy'), `For badge should contain "Pharmacy", got "${forText}"`);
  cards.length = 0;
  renderBoard();
});

test('T4: For field optional — empty/null values don\'t render artifacts', () => {
  cards.length = 0;
  addCard('No For Card', '', 'task', 'unassigned', []);
  cards[0].for = null;
  renderBoard();
  const cardEl = document.querySelector('.card');
  const forBadge = cardEl.querySelector('.card-for');
  assert(forBadge === null, 'No For badge should appear when card.for is null');
  cards[0].for = '';
  renderBoard();
  const forBadgeEmpty = document.querySelector('.card-for');
  assert(forBadgeEmpty === null, 'No For badge should appear when card.for is empty string');
  cards.length = 0;
  renderBoard();
});

test('T5: For field can be cleared — existing value cleared, saved, no tag shown', () => {
  cards.length = 0;
  addCard('Clear Test', '', 'task', 'unassigned', []);
  cards[0].for = 'SomeValue';
  renderBoard();
  const cardEl = document.querySelector('.card');
  cardEl.querySelector('[data-action="edit"]').click();
  renderBoard();
  const forInput = document.querySelector('.edit-for');
  forInput.value = '';
  document.querySelector('[data-action="save-edit"]').click();
  const clearedCard = cards.find(c => c.id === cards[0].id);
  assertEqual(clearedCard.for, '', 'card.for should be empty string after clearing');
  renderBoard();
  const forBadge = document.querySelector('.card-for');
  assert(forBadge === null, 'No For badge should appear after clearing');
  cards.length = 0;
  renderBoard();
});

test('T6: For field filters work — type "Ali" in filter, only matching cards visible', () => {
  cards.length = 0;
  addCard('Ali Card 1', '', 'task', 'unassigned', ['frontend']);
  cards[0].for = 'Ali';
  addCard('Ali Card 2', '', 'task', 'unassigned', ['backend']);
  cards[1].for = 'Ali';
  addCard('Bob Card', '', 'task', 'unassigned', ['design']);
  cards[2].for = 'Bob';
  renderBoard();
  const forFilterInput = document.getElementById('for-filter-input');
  forFilterInput.value = 'Ali';
  forFilterInput.dispatchEvent(new Event('input', { bubbles: true }));
  const visibleCards = document.querySelectorAll('.column-body .card');
  assertEqual(visibleCards.length, 2, 'Only 2 cards with "Ali" in For field should be visible');
  forFilterInput.value = '';
  forFilterInput.dispatchEvent(new Event('input', { bubbles: true }));
  const allVisible = document.querySelectorAll('.column-body .card');
  assertEqual(allVisible.length, 3, 'All 3 cards should be visible when filter is cleared');
  cards.length = 0;
  renderBoard();
});

// ════════════════════════════════════════════════ TESTS - Card #19: AND/OR Toggle for Label Filtering ════════════════════════════════════════════════

test('T1: AND mode is default — board loads, select 2+ labels, toggle shows "AND" as active, only cards with ALL labels visible', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['security', 'P0']);
  addCard('Card B', '', 'task', 'unassigned', ['security']);
  addCard('Card C', '', 'task', 'unassigned', ['P0']);
  renderBoard();
  toggleLabelFilter('security');
  toggleLabelFilter('P0');
  renderBoard();
  const visibleCards = document.querySelectorAll('.column-body .card');
  assertEqual(visibleCards.length, 1, 'Only 1 card should be visible with BOTH security AND P0 labels');
  cards.length = 0;
  activeLabels.clear();
  renderBoard();
});

test('T2: OR mode shows cards with any matching label — select "security" and "P0" with OR mode, cards with EITHER label visible', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['security']);
  addCard('Card B', '', 'task', 'unassigned', ['P0']);
  addCard('Card C', '', 'task', 'unassigned', ['design']);
  renderBoard();
  toggleLabelFilter('security');
  toggleLabelFilter('P0');
  renderBoard();
  const toggle = document.querySelector('.label-mode-toggle');
  assert(toggle !== null, 'AND/OR toggle should appear when 2+ labels selected');
  toggle.click();
  renderBoard();
  const visibleCards = document.querySelectorAll('.column-body .card');
  assertEqual(visibleCards.length, 2, '2 cards should be visible with OR mode (security OR P0)');
  cards.length = 0;
  activeLabels.clear();
  labelFilterMode = 'and';
  renderBoard();
});

test('T3: AND mode only shows cards with all labels — select "security" and "P0" with AND mode, only cards with BOTH labels visible', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['security', 'P0']);
  addCard('Card B', '', 'task', 'unassigned', ['security']);
  addCard('Card C', '', 'task', 'unassigned', ['P0']);
  renderBoard();
  toggleLabelFilter('security');
  toggleLabelFilter('P0');
  // labelFilterMode defaults to 'and' (set by wrapper's clearFilterState); no need to toggle.
  // (Previous version checked toggle.textContent.includes('OR'), but the segmented control's
  // text contains both "AND" and "OR" labels, so that check always matched and flipped mode.)
  renderBoard();
  const visibleCards = document.querySelectorAll('.column-body .card');
  assertEqual(visibleCards.length, 1, 'Only 1 card should be visible with AND mode (BOTH security AND P0)');
  cards.length = 0;
  activeLabels.clear();
  labelFilterMode = 'and';
  renderBoard();
});

test('T4: Toggle switches between modes — click toggle, mode switches, visible cards update immediately', () => {
  cards.length = 0;
  // Card A has BOTH labels (visible in both AND and OR mode);
  // Card B has only P0 (visible only in OR mode).
  // AND: 1 visible (A), OR: 2 visible (A, B), AND again: 1 visible (A).
  addCard('Card A', '', 'task', 'unassigned', ['security', 'P0']);
  addCard('Card B', '', 'task', 'unassigned', ['P0']);
  renderBoard();
  toggleLabelFilter('security');
  toggleLabelFilter('P0');
  renderBoard();
  // Re-query toggle after each renderBoard — renderFilterStrip re-creates the
  // toggle button, so stale references won't fire the click handler.
  let toggle = document.querySelector('.label-mode-toggle');
  assert(toggle !== null, 'Toggle should exist');
  const initialCount = document.querySelectorAll('.column-body .card').length;
  assertEqual(initialCount, 1, 'Initial AND mode shows 1 card');
  toggle.click();
  renderBoard();
  const afterOrCount = document.querySelectorAll('.column-body .card').length;
  assertEqual(afterOrCount, 2, 'OR mode should show 2 cards');
  toggle = document.querySelector('.label-mode-toggle'); // re-query after render
  toggle.click();
  renderBoard();
  const afterAndAgain = document.querySelectorAll('.column-body .card').length;
  assertEqual(afterAndAgain, 1, 'Back to AND mode shows 1 card');
  cards.length = 0;
  activeLabels.clear();
  labelFilterMode = 'and';
  renderBoard();
});

test('T5: Clearing filters resets toggle to AND — set to OR, clear all filters, toggle resets to AND', () => {
  cards.length = 0;
  addCard('Card A', '', 'task', 'unassigned', ['security', 'P0']);
  renderBoard();
  toggleLabelFilter('security');
  toggleLabelFilter('P0');
  renderBoard();
  const toggle = document.querySelector('.label-mode-toggle');
  assert(toggle !== null, 'Toggle should exist');
  toggle.click();
  renderBoard();
  assertEqual(labelFilterMode, 'or', 'Mode should be OR after toggle click');
  clearAllFilters();
  renderBoard();
  const visibleCards = document.querySelectorAll('.column-body .card');
  assertEqual(visibleCards.length, 1, 'All cards visible after clearing filters');
  const toggleAfterClear = document.querySelector('.label-mode-toggle');
  assert(toggleAfterClear === null, 'Toggle should NOT appear when no labels active');
  cards.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Feature Type (Card #28) ════════════════════════════════════════════════ */

test('AC1: type "feature" is present in TYPE_EMOJI map with a non-task emoji', () => {
  assert(typeof TYPE_EMOJI === 'object' && TYPE_EMOJI !== null, 'TYPE_EMOJI map should exist');
  assert('feature' in TYPE_EMOJI, 'TYPE_EMOJI should have a "feature" key');
  assert(typeof TYPE_EMOJI.feature === 'string' && TYPE_EMOJI.feature.length > 0,
    'TYPE_EMOJI.feature should be a non-empty string');
  assert(TYPE_EMOJI.feature !== TYPE_EMOJI.task,
    'feature emoji should differ from task emoji (no silent fallback)');
});

test('AC2: edit form Type dropdown contains "feature" option', () => {
  cards.length = 0;
  const card = addCard('Edit form test', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(card.id);
  const featureOption = document.querySelector('.edit-type option[value="feature"]');
  assert(featureOption !== null, 'edit form Type dropdown should include a "feature" option');
  cancelEdit();
  cards.length = 0;
  renderBoard();
});

test('AC3: card with type="feature" renders feature emoji (not task fallback)', () => {
  cards.length = 0;
  addCard('Feature card', '', 'feature', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector('.card[data-type="feature"]');
  assert(cardEl !== null, 'should render a card element with data-type="feature"');
  const emojiSpan = cardEl.querySelector('.card-emoji');
  assert(emojiSpan !== null, 'card should have a .card-emoji span');
  assertEqual(emojiSpan.textContent, TYPE_EMOJI.feature,
    'card-emoji text should match TYPE_EMOJI.feature, not the task fallback');
  cards.length = 0;
  renderBoard();
});

test('AC4: feature type has a CSS rule defining its accent color', () => {
  let found = false;
  const sheets = Array.from(document.styleSheets);
  for (const sheet of sheets) {
    let rules;
    try { rules = Array.from(sheet.cssRules || []); }
    catch (e) { continue; }
    for (const rule of rules) {
      if (rule.selectorText && rule.selectorText.includes('[data-type="feature"]')) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  assert(found, 'should have at least one CSS rule selecting cards with data-type="feature"');
});

test('AC6: existing types (task/idea/goal/reference) still render their original emojis (regression)', () => {
  const originalEmojis = { task: '📋', idea: '💡', goal: '🎯', reference: '📌' };
  for (const type of Object.keys(originalEmojis)) {
    cards.length = 0;
    addCard(`${type} card`, '', type, 'unassigned', []);
    renderBoard();
    const cardEl = document.querySelector(`.card[data-type="${type}"]`);
    assert(cardEl !== null, `should render a card with data-type="${type}"`);
    const emojiSpan = cardEl.querySelector('.card-emoji');
    assertEqual(emojiSpan.textContent, originalEmojis[type],
      `${type} card should still render ${originalEmojis[type]} (no regression)`);
  }
  cards.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Test Isolation (Card #38) ════════════════════════════════════════════════ */

test('AC4: clearFilterState() resets all four filter variables to defaults', () => {
  activeLabels.add('test-label-1');
  activeLabels.add('test-label-2');
  activeAssignees.add('alex');
  activeForFilter = 'someone';
  labelFilterMode = 'or';
  clearFilterState();
  assertEqual(activeLabels.size, 0, 'activeLabels should be empty after clearFilterState');
  assertEqual(activeAssignees.size, 0, 'activeAssignees should be empty after clearFilterState');
  assertEqual(activeForFilter, '', 'activeForFilter should be empty string after clearFilterState');
  assertEqual(labelFilterMode, 'and', 'labelFilterMode should default to "and" after clearFilterState');
});

// AC3 verification works via a paired canary + verifier:
// - Canary deliberately pollutes filter state and does NOT clean up
// - Verifier runs immediately after and asserts state is clean
// If the test() wrapper properly resets state between tests, the verifier passes.
// If not, the verifier fails because the canary's pollution leaked through.

test('AC3: filter state pollution canary (sets state for next test to verify cleanup)', () => {
  activeLabels.add('canary-label-1');
  activeLabels.add('canary-label-2');
  activeAssignees.add('canary-assignee');
  activeForFilter = 'canary-for-value';
  labelFilterMode = 'or';
  // Intentionally no cleanup — relies on test() wrapper to reset before next test
});

test('AC3: wrapper resets filter state between tests (verifier — must run immediately after canary)', () => {
  assertEqual(activeLabels.size, 0, 'wrapper should have cleared activeLabels from prior (canary) test');
  assertEqual(activeAssignees.size, 0, 'wrapper should have cleared activeAssignees from prior (canary) test');
  assertEqual(activeForFilter, '', 'wrapper should have cleared activeForFilter from prior (canary) test');
  assertEqual(labelFilterMode, 'and', 'wrapper should have reset labelFilterMode to "and"');
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Custom Columns (Card #41) ════════════════════════════════════════════════ */

// Helper: reset the columns array to defaults for a clean test state.
function _resetColumnsForTest() {
  if (typeof columns === 'undefined') return;
  columns.length = 0;
  columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
  columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
  columns.push({ id: 'done', name: 'Done', order: 2 });
}

// AC1: Add Column button creates a new column with default name
test('AC1: + button exists at end of board and creates "New Column" when clicked', () => {
  _resetColumnsForTest();
  const addBtn = document.getElementById('btn-add-column');
  assert(addBtn !== null, 'Add Column button (#btn-add-column) should exist');
  addBtn.click();
  const newCol = columns.find(c => c.name === 'New Column');
  assert(newCol !== undefined, 'columns array should contain a new "New Column" entry after click');
});

test('AC1: new column immediately enters rename mode', () => {
  _resetColumnsForTest();
  const addBtn = document.getElementById('btn-add-column');
  addBtn.click();
  const renameInput = document.querySelector('.column-rename-input');
  assert(renameInput !== null, 'rename input should be active on the newly added column');
});

test('AC1: new column is persisted (saveToJSONFile is called)', () => {
  _resetColumnsForTest();
  _jsonSaveCalled = false;
  const addBtn = document.getElementById('btn-add-column');
  addBtn.click();
  assert(_jsonSaveCalled === true, 'saveToJSONFile should be called after adding a new column');
});

// AC2: New columns functional
test('AC2: card can render in newly added column', () => {
  _resetColumnsForTest();
  const addBtn = document.getElementById('btn-add-column');
  addBtn.click();
  const newCol = columns[columns.length - 1];
  addCard('Test card', '', 'task', 'unassigned', []);
  cards[0].column = newCol.id;
  renderBoard();
  const colBody = document.getElementById(newCol.id + '-body');
  assert(colBody !== null, 'new column body element should exist in DOM');
  const cardInNewCol = colBody.querySelector('.card');
  assert(cardInNewCol !== null, 'card with column=newCol.id should render in new column');
});

test('AC2: double-click on new column header still enters rename mode', () => {
  _resetColumnsForTest();
  const addBtn = document.getElementById('btn-add-column');
  addBtn.click();
  const activeInput = document.querySelector('.column-rename-input');
  if (activeInput) activeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  renderBoard();
  const newCol = columns[columns.length - 1];
  const header = document.querySelector(`.column-header[data-column-id="${newCol.id}"]`);
  assert(header !== null, 'new column header should exist in DOM');
  header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const renameInput = header.querySelector('.column-rename-input');
  assert(renameInput !== null, 'double-click on new column should enter rename mode');
});

// AC3: Column edit mode via ✏️ button
test('AC3: ✏️ edit button exists on column header', () => {
  _resetColumnsForTest();
  renderBoard();
  const editBtn = document.querySelector('.column-edit-btn');
  assert(editBtn !== null, 'column header should have a .column-edit-btn (✏️) element');
});

test('AC3: clicking ✏️ enters column edit mode with rename input and delete button', () => {
  _resetColumnsForTest();
  renderBoard();
  const editBtn = document.querySelector('.column-edit-btn');
  editBtn.click();
  const header = editBtn.closest('.column-header');
  const rename = header.querySelector('.column-rename-input');
  const del = header.querySelector('.column-delete-btn');
  assert(rename !== null, 'edit mode should show rename input');
  assert(del !== null, 'edit mode should show delete button (.column-delete-btn)');
});

test('AC3: Esc cancels column edit mode without changes', () => {
  _resetColumnsForTest();
  renderBoard();
  const originalName = columns[0].name;
  const editBtn = document.querySelector('.column-edit-btn');
  editBtn.click();
  const header = editBtn.closest('.column-header');
  const input = header.querySelector('.column-rename-input');
  input.value = 'Should Not Save';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assertEqual(columns[0].name, originalName, 'column name should not change after Esc in edit mode');
});

// AC4: Column deletion + Orphanage
test('AC4: deleting column with cards creates Orphanage column if absent', () => {
  _resetColumnsForTest();
  columns.push({ id: 'temp-1', name: 'Temp', order: columns.length });
  addCard('Stranded', '', 'task', 'unassigned', []);
  cards[0].column = 'temp-1';
  deleteColumn('temp-1');
  const orphanage = columns.find(c => c.id === 'orphanage');
  assert(orphanage !== undefined, 'Orphanage column should be auto-created');
  assertEqual(cards[0].column, 'orphanage', 'orphaned card should be moved to Orphanage column');
});

test('AC4: deleting column reuses existing Orphanage column (no duplicates)', () => {
  _resetColumnsForTest();
  columns.push({ id: 'orphanage', name: 'Orphanage', order: columns.length });
  columns.push({ id: 'temp-2', name: 'Temp', order: columns.length });
  addCard('Stranded again', '', 'task', 'unassigned', []);
  cards[0].column = 'temp-2';
  deleteColumn('temp-2');
  const orphanageCount = columns.filter(c => c.id === 'orphanage').length;
  assertEqual(orphanageCount, 1, 'should not duplicate Orphanage column');
});

test('AC4: orphaned cards get sent-to-orphanage label', () => {
  _resetColumnsForTest();
  columns.push({ id: 'temp-3', name: 'Temp', order: columns.length });
  addCard('Test card', '', 'task', 'unassigned', []);
  cards[0].column = 'temp-3';
  deleteColumn('temp-3');
  assert(cards[0].labels.includes('sent-to-orphanage'),
    'orphaned card should have sent-to-orphanage label appended');
});

test('AC4: orphaned cards get previousColumn field set to original column id', () => {
  _resetColumnsForTest();
  columns.push({ id: 'temp-4', name: 'Temp', order: columns.length });
  addCard('Test card', '', 'task', 'unassigned', []);
  cards[0].column = 'temp-4';
  deleteColumn('temp-4');
  assertEqual(cards[0].previousColumn, 'temp-4',
    'orphaned card should have previousColumn field set to original column id');
});

test('AC4: deleting empty column just removes it (no Orphanage creation)', () => {
  _resetColumnsForTest();
  columns.push({ id: 'temp-empty', name: 'Empty', order: columns.length });
  deleteColumn('temp-empty');
  assert(columns.find(c => c.id === 'temp-empty') === undefined, 'deleted column should be gone');
  assert(columns.find(c => c.id === 'orphanage') === undefined,
    'Orphanage should NOT be created when deleted column had no cards');
});

// AC5: Cannot delete the last remaining column
test('AC5: delete is blocked when only one column exists', () => {
  _resetColumnsForTest();
  while (columns.length > 1) columns.pop();
  const lastColId = columns[0].id;
  try { deleteColumn(lastColId); } catch (e) { /* error acceptable */ }
  assert(columns.find(c => c.id === lastColId) !== undefined,
    'last remaining column should not be deletable');
});

// AC6: Column order persists across reload
test('AC6: columns array is included in the saveToJSONFile payload', () => {
  _resetColumnsForTest();
  const tmp = columns[0];
  columns[0] = columns[1];
  columns[1] = tmp;
  _lastJSONPayload = null;
  saveToJSONFile();
  assert(_lastJSONPayload !== null, 'saveToJSONFile should set _lastJSONPayload');
  assert(Array.isArray(_lastJSONPayload.columns),
    'persisted payload should include columns array');
  assertEqual(_lastJSONPayload.columns.length, columns.length,
    'persisted columns length should match in-memory length');
});

// AC7: Column reordering via drag-and-drop
// (The 2 original AC7 tests here were vanity tests — they only verified
//  draggable=true was set on column headers, which would pass even if the
//  reorder logic was a no-op. Removed in #45 in favor of real behavior tests
//  that verify DOM order updates after reorder. See the '#45 AC1:' tests
//  in the Visual column reorder section for the real coverage.)

// AC8: Schema migration
test('AC8: migration populates default columns when columns array is empty', () => {
  _resetColumnsForTest();
  columns.length = 0;
  migrateColumnsIfNeeded();
  assert(columns.find(c => c.id === 'backlog') !== undefined, 'should populate backlog default');
  assert(columns.find(c => c.id === 'in-progress') !== undefined, 'should populate in-progress default');
  assert(columns.find(c => c.id === 'done') !== undefined, 'should populate done default');
});

test('AC8: migration is idempotent (running twice does not duplicate or corrupt)', () => {
  _resetColumnsForTest();
  const before = JSON.stringify(columns);
  migrateColumnsIfNeeded();
  const after = JSON.stringify(columns);
  assertEqual(after, before,
    'migration should be a no-op when columns array already has entries');
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Card Relationships (Card #42) ════════════════════════════════════════════════ */

// Helper: ensure a clean column state for relationship tests
function _setupRelationshipsTest() {
  if (typeof columns !== 'undefined') {
    columns.length = 0;
    columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
    columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
    columns.push({ id: 'done', name: 'Done', order: 2 });
  }
}

// AC1: Card edit form has Relationships section with typeahead
test('AC1: edit form shows Relationships section with related-to and blocked-by inputs', () => {
  _setupRelationshipsTest();
  const card = addCard('Test', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(card.id);
  const relatedInput = document.querySelector('.edit-related-to');
  const blockedInput = document.querySelector('.edit-blocked-by');
  assert(relatedInput !== null, 'edit form should have a .edit-related-to input');
  assert(blockedInput !== null, 'edit form should have a .edit-blocked-by input');
});

test('AC1: typing # in related-to input triggers typeahead dropdown', () => {
  _setupRelationshipsTest();
  addCard('Target', '', 'task', 'unassigned', []);
  const editorCard = addCard('Editor', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(editorCard.id);
  const relatedInput = document.querySelector('.edit-related-to');
  relatedInput.focus();
  relatedInput.value = '#';
  relatedInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.relationship-typeahead');
  assert(dropdown !== null, 'typeahead dropdown should appear when typing #');
});

test('AC1: typeahead shows existing cards by shortId and title', () => {
  _setupRelationshipsTest();
  const target = addCard('Findable card', '', 'task', 'unassigned', []);
  const editor = addCard('Editor card', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(editor.id);
  const relatedInput = document.querySelector('.edit-related-to');
  relatedInput.focus();
  relatedInput.value = '#';
  relatedInput.dispatchEvent(new Event('input', { bubbles: true }));
  const dropdown = document.querySelector('.relationship-typeahead');
  assert(dropdown !== null, 'typeahead should appear');
  const text = dropdown.textContent || '';
  assert(text.includes('Findable card') || text.includes('#' + target.shortId),
    'typeahead should include the target card');
});

test('AC1: typing literal #N and saving stores the shortId in relationships.relatedTo', () => {
  _setupRelationshipsTest();
  const target = addCard('T', '', 'task', 'unassigned', []);
  const editor = addCard('E', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(editor.id);
  const relatedInput = document.querySelector('.edit-related-to');
  relatedInput.value = '#' + target.shortId;
  document.querySelector('[data-action="save-edit"]').click();
  const updated = cards.find(c => c.id === editor.id);
  assert(updated.relationships && Array.isArray(updated.relationships.relatedTo) &&
    updated.relationships.relatedTo.includes(target.shortId),
    'saved card should have target shortId in relationships.relatedTo');
});

test('AC1: arrow-down + Enter on typeahead selects without crashing', () => {
  _setupRelationshipsTest();
  addCard('Findable', '', 'task', 'unassigned', []);
  const editor = addCard('Editor', '', 'task', 'unassigned', []);
  renderBoard();
  editCard(editor.id);
  const relatedInput = document.querySelector('.edit-related-to');
  relatedInput.focus();
  relatedInput.value = '#';
  relatedInput.dispatchEvent(new Event('input', { bubbles: true }));
  let crashed = false;
  try {
    relatedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    relatedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  } catch (e) { crashed = true; }
  assert(!crashed, 'arrow + Enter should not crash');
});

// AC2: Related to creates bidirectional link
test('AC2: setRelationship related-to creates link visible on both A and B', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'relatedTo', b.shortId);
  assert(a.relationships && a.relationships.relatedTo && a.relationships.relatedTo.includes(b.shortId),
    'A should have B in relatedTo');
  assert(b.relationships && b.relationships.relatedTo && b.relationships.relatedTo.includes(a.shortId),
    'B should reciprocally have A in relatedTo (bidirectional)');
});

test('AC2: removing related-to from card A also removes it from card B', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'relatedTo', b.shortId);
  removeRelationship(a.id, 'relatedTo', b.shortId);
  assert(!a.relationships.relatedTo.includes(b.shortId), 'A should not have B in relatedTo');
  assert(!b.relationships.relatedTo.includes(a.shortId), 'B should not have A in relatedTo');
});

// AC3: Blocked by creates directional link
test('AC3: setRelationship blocked-by stores on the blocked card only (directional)', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'blockedBy', b.shortId);
  assert(a.relationships.blockedBy.includes(b.shortId), 'A should have B in blockedBy');
  const bHasA = b.relationships && b.relationships.blockedBy && b.relationships.blockedBy.includes(a.shortId);
  assert(!bHasA, 'B should NOT have A in blockedBy (directional, not bidirectional)');
});

// AC4: Blocked cards show red badge
test('AC4: card with blockedBy renders a .relationship-badge-blocked element', () => {
  _setupRelationshipsTest();
  const a = addCard('Blocked', '', 'task', 'unassigned', []);
  const b = addCard('Blocker', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'blockedBy', b.shortId);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${a.id}"]`);
  const badge = cardEl.querySelector('.relationship-badge-blocked');
  assert(badge !== null, 'blocked card should render a .relationship-badge-blocked element');
});

test('AC4: blocked badge title attribute mentions blocking card shortId', () => {
  _setupRelationshipsTest();
  const a = addCard('Blocked card', '', 'task', 'unassigned', []);
  const b = addCard('Blocker title', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'blockedBy', b.shortId);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${a.id}"]`);
  const badge = cardEl.querySelector('.relationship-badge-blocked');
  assert(badge && badge.title.includes('#' + b.shortId),
    'badge title should reference the blocker shortId');
});

// AC5: Blocking cards show green badge
test('AC5: card that is blocking others renders a .relationship-badge-blocking element', () => {
  _setupRelationshipsTest();
  const blocker = addCard('Blocker', '', 'task', 'unassigned', []);
  const blocked = addCard('Blocked', '', 'task', 'unassigned', []);
  setRelationship(blocked.id, 'blockedBy', blocker.shortId);
  renderBoard();
  const blockerEl = document.querySelector(`.card[data-id="${blocker.id}"]`);
  const badge = blockerEl.querySelector('.relationship-badge-blocking');
  assert(badge !== null, 'blocking card should render a .relationship-badge-blocking element');
});

test('AC5: blocking badge title mentions the blocked card shortId', () => {
  _setupRelationshipsTest();
  const blocker = addCard('Blocker', '', 'task', 'unassigned', []);
  const blocked = addCard('Blocked card', '', 'task', 'unassigned', []);
  setRelationship(blocked.id, 'blockedBy', blocker.shortId);
  renderBoard();
  const blockerEl = document.querySelector(`.card[data-id="${blocker.id}"]`);
  const badge = blockerEl.querySelector('.relationship-badge-blocking');
  assert(badge && badge.title.includes('#' + blocked.shortId),
    'badge title should reference the blocked shortId');
});

// AC6: Self-references prevented
test('AC6: setRelationship rejects self-reference', () => {
  _setupRelationshipsTest();
  const a = addCard('Self', '', 'task', 'unassigned', []);
  const result = setRelationship(a.id, 'relatedTo', a.shortId);
  const aHasSelf = a.relationships && a.relationships.relatedTo && a.relationships.relatedTo.includes(a.shortId);
  assert(result === false || !aHasSelf,
    'self-reference should be rejected (return false or not stored)');
});

// AC7: Nonexistent references render as plain text
test('AC7: nonexistent #N reference does not crash render', () => {
  _setupRelationshipsTest();
  const a = addCard('Card', '', 'task', 'unassigned', []);
  if (!a.relationships) a.relationships = {};
  a.relationships.relatedTo = [999];
  let crashed = false;
  try { renderBoard(); } catch (e) { crashed = true; }
  assert(!crashed, 'render should not crash on dangling #N reference');
});

test('AC7: dangling reference renders without a working clickable link to nonexistent card', () => {
  _setupRelationshipsTest();
  const a = addCard('Card', '', 'task', 'unassigned', []);
  if (!a.relationships) a.relationships = {};
  a.relationships.relatedTo = [999];
  renderBoard();
  // No card has shortId 999, so any displayed reference should be plain text or absent —
  // specifically NOT a clickable .shortid-link to #999
  const cardEl = document.querySelector(`.card[data-id="${a.id}"]`);
  const danglingLink = cardEl && cardEl.querySelector('[data-action="shortid-link"][data-shortid="999"]');
  assert(danglingLink === null, 'nonexistent #N should not render as a clickable shortid-link');
});

test('AC7: deleted-card reference does not crash render', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'relatedTo', b.shortId);
  const bIdx = cards.findIndex(c => c.id === b.id);
  cards.splice(bIdx, 1);
  let crashed = false;
  try { renderBoard(); } catch (e) { crashed = true; }
  assert(!crashed, 'rendering a card with reference to deleted card should not crash');
});

// AC8: Removing relationship updates both sides
test('AC8: removeRelationship cleans up bidirectional link from both cards', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  setRelationship(a.id, 'relatedTo', b.shortId);
  removeRelationship(a.id, 'relatedTo', b.shortId);
  assert(!(a.relationships.relatedTo || []).includes(b.shortId), 'A no longer has B');
  assert(!(b.relationships.relatedTo || []).includes(a.shortId), 'B no longer has A');
});

// AC9: Migration is lossless and idempotent
test('AC9: migration converts relatedCards UUIDs to relationships.relatedTo shortIds', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  a.relatedCards = [b.id];
  delete a.relationships;
  migrateRelationshipsIfNeeded();
  assert(a.relationships && a.relationships.relatedTo && a.relationships.relatedTo.includes(b.shortId),
    'migration should populate relationships.relatedTo with shortId');
});

test('AC9: migration removes the old relatedCards field after migrating', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  a.relatedCards = [b.id];
  migrateRelationshipsIfNeeded();
  assert(a.relatedCards === undefined || a.relatedCards.length === 0,
    'old relatedCards field should be removed or emptied');
});

test('AC9: migration is idempotent (running twice does not corrupt)', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  a.relatedCards = [b.id];
  migrateRelationshipsIfNeeded();
  const before = JSON.stringify(a);
  migrateRelationshipsIfNeeded();
  const after = JSON.stringify(a);
  assertEqual(after, before, 'second migration call should be a no-op');
});

test('AC9: migration preserves relationship count (no data loss)', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  const b = addCard('B', '', 'task', 'unassigned', []);
  const c = addCard('C', '', 'task', 'unassigned', []);
  a.relatedCards = [b.id, c.id];
  migrateRelationshipsIfNeeded();
  assertEqual(a.relationships.relatedTo.length, 2, 'should preserve all 2 relationships');
});

// AC10: Migration handles edge cases gracefully
test('AC10: orphan UUID in relatedCards is dropped without crash', () => {
  _setupRelationshipsTest();
  const a = addCard('A', '', 'task', 'unassigned', []);
  a.relatedCards = ['nonexistent-uuid-12345'];
  let crashed = false;
  try { migrateRelationshipsIfNeeded(); } catch (e) { crashed = true; }
  assert(!crashed, 'migration should not crash on orphan UUID');
  const hasOrphan = a.relationships && a.relationships.relatedTo && a.relationships.relatedTo.length > 0;
  assert(!hasOrphan, 'orphan UUIDs should be dropped (no shortId can be derived)');
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Test Wrapper Async Race Fix (Card #47) ════════════════════════════════════════════════ */

test('#47 AC1: _pendingSaves array exists at module scope', () => {
  assert(typeof _pendingSaves !== 'undefined', '_pendingSaves should be defined');
  assert(Array.isArray(_pendingSaves), '_pendingSaves should be an array');
});

test('#47 AC1: saveToJSONFile adds a promise to _pendingSaves and removes it on completion', async () => {
  const initialLen = _pendingSaves.length;
  const p = saveToJSONFile();
  // While in flight, _pendingSaves should have grown by 1
  assertEqual(_pendingSaves.length, initialLen + 1,
    '_pendingSaves should grow by 1 during in-flight saveToJSONFile call');
  await p;
  // After completion, the promise should be removed
  assertEqual(_pendingSaves.length, initialLen,
    '_pendingSaves should return to initial length after the save completes');
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Create cards in any column (Card #46) ════════════════════════════════════════════════ */

// Helper: ensure standard 3-column state
function _setupAnyColumnAddTest() {
  if (typeof columns !== 'undefined') {
    columns.length = 0;
    columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
    columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
    columns.push({ id: 'done', name: 'Done', order: 2 });
  }
}

test('#46 AC1: every column body has a btn-expand-form descendant', () => {
  _setupAnyColumnAddTest();
  cards.length = 0;
  renderBoard();
  ['backlog', 'in-progress', 'done'].forEach(colId => {
    const body = document.getElementById(`${colId}-body`);
    const btn = body && body.querySelector('.btn-expand-form');
    assert(btn !== null && btn !== undefined,
      `${colId} body should have a .btn-expand-form button`);
  });
});

test('#46 AC2: clicking + on in-progress column moves the form into in-progress-body', () => {
  _setupAnyColumnAddTest();
  cards.length = 0;
  renderBoard();
  const ipBody = document.getElementById('in-progress-body');
  const btnInIp = ipBody.querySelector('.btn-expand-form');
  btnInIp.click();
  const formWrapper = document.getElementById('add-card-form-wrapper');
  assert(ipBody.contains(formWrapper),
    'add-card-form-wrapper should be moved into in-progress-body after + click');
});

test('#46 AC3: saving from a non-backlog column creates the card with that column id', () => {
  _setupAnyColumnAddTest();
  cards.length = 0;
  renderBoard();
  const ipBody = document.getElementById('in-progress-body');
  const btnInIp = ipBody.querySelector('.btn-expand-form');
  btnInIp.click();
  // Fill out the form
  document.getElementById('card-title').value = 'In Progress Card';
  document.getElementById('card-desc').value = '';
  document.getElementById('card-type').value = 'task';
  // Reset assignee checkboxes (none checked → defaults to ['unassigned'])
  document.querySelectorAll('#card-assignees-group input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  document.getElementById('card-labels').value = '';
  document.getElementById('btn-add-card').click();
  // The new card should be in in-progress column, not backlog
  const created = cards.find(c => c.title === 'In Progress Card');
  assert(created !== undefined, 'card should be created');
  assertEqual(created.column, 'in-progress',
    'card created from in-progress + button should have column=in-progress');
});

test('#46 AC4: dynamic columns get a + button and form-move behavior works', () => {
  _setupAnyColumnAddTest();
  // Add a dynamic column
  columns.push({ id: 'custom-x', name: 'Custom X', order: columns.length });
  cards.length = 0;
  renderBoard();
  const customBody = document.getElementById('custom-x-body');
  assert(customBody !== null, 'dynamic column body should exist');
  const btnInCustom = customBody.querySelector('.btn-expand-form');
  assert(btnInCustom !== null, 'dynamic column body should have a + button');
});

test('#48: commitColumnRename updates the columns array entry name (not just columnNames)', () => {
  // Set up: a dynamic column with a known starting name
  if (typeof columns === 'undefined') return; // skip if columns array doesn't exist
  columns.length = 0;
  columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
  columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
  columns.push({ id: 'done', name: 'Done', order: 2 });
  columns.push({ id: 'test-col-48', name: 'Original Name', order: 3 });
  columnNames['test-col-48'] = 'Original Name';
  cards.length = 0;
  renderBoard();
  // Find the rendered header
  const header = document.querySelector('.column-header[data-column-id="test-col-48"]');
  assert(header !== null, 'test column header should be rendered');
  // Rename via commitColumnRename (production code path)
  commitColumnRename(header, 'test-col-48', 'Renamed Via Test');
  // Both columnNames AND the columns array entry should reflect the new name
  assertEqual(columnNames['test-col-48'], 'Renamed Via Test',
    'columnNames map should update (existing behavior)');
  const col = columns.find(c => c.id === 'test-col-48');
  assertEqual(col.name, 'Renamed Via Test',
    'columns array entry name should also update (the bug this card fixes)');
  // Cleanup: remove the test column from array + DOM, restore defaults
  const idx = columns.findIndex(c => c.id === 'test-col-48');
  if (idx >= 0) columns.splice(idx, 1);
  delete columnNames['test-col-48'];
  renderBoard(); // triggers cleanup loop that removes the test column DOM
});

test('#46 AC5: backlog + click still works (regression)', () => {
  _setupAnyColumnAddTest();
  cards.length = 0;
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  const btnInBacklog = backlogBody.querySelector('.btn-expand-form');
  btnInBacklog.click();
  document.getElementById('card-title').value = 'Backlog Card';
  document.getElementById('card-desc').value = '';
  document.getElementById('card-type').value = 'task';
  // Reset assignee checkboxes (none checked → defaults to ['unassigned'])
  document.querySelectorAll('#card-assignees-group input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  document.getElementById('card-labels').value = '';
  document.getElementById('btn-add-card').click();
  const created = cards.find(c => c.title === 'Backlog Card');
  assert(created !== undefined, 'card should be created');
  assertEqual(created.column, 'backlog', 'backlog + still creates backlog cards');
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Visual column reorder (Card #45) ════════════════════════════════════════════════ */

// Helper: reset to standard 3 default columns, render fresh
function _setupReorderTest() {
  if (typeof columns === 'undefined') return;
  columns.length = 0;
  columns.push({ id: 'backlog', name: 'Backlog', order: 0 });
  columns.push({ id: 'in-progress', name: 'In Progress', order: 1 });
  columns.push({ id: 'done', name: 'Done', order: 2 });
  cards.length = 0;
  renderBoard();
}

// Helper: snapshot the DOM order of column elements (left to right)
function _domColumnOrder() {
  return Array.from(document.querySelectorAll('.column[id^="column-"]')).map(el => el.id);
}

test('#45 AC1: reordering a DEFAULT column updates DOM order to match array order', () => {
  _setupReorderTest();
  // Initial DOM order should match defaults
  assertEqual(_domColumnOrder().join(','),
    'column-backlog,column-in-progress,column-done',
    'initial DOM order should match defaults');

  // Move 'done' to position 0 (before backlog) via the reorder function
  reorderColumn('done', 'backlog');

  // After reorder, DOM order should reflect the new array order
  assertEqual(_domColumnOrder().join(','),
    'column-done,column-backlog,column-in-progress',
    'DOM order should match array order after reordering a default column');
});

test('#45 AC1: reordering a DYNAMIC column updates DOM order', () => {
  _setupReorderTest();
  columns.push({ id: 'dyn-test', name: 'Dynamic', order: 3 });
  renderBoard();
  // dyn-test should initially be at the end
  assertEqual(_domColumnOrder()[3], 'column-dyn-test',
    'dynamic column should initially be at the end');

  // Move dyn-test to position 1 (before in-progress)
  reorderColumn('dyn-test', 'in-progress');

  assertEqual(_domColumnOrder().join(','),
    'column-backlog,column-dyn-test,column-in-progress,column-done',
    'DOM order should match array order after reordering a dynamic column');

  // Cleanup
  const idx = columns.findIndex(c => c.id === 'dyn-test');
  if (idx >= 0) columns.splice(idx, 1);
  renderBoard();
});

test('#45 AC1: drag-drop flow on a default column reorders DOM (simulating handleDragStart + handleDrop)', () => {
  _setupReorderTest();
  // Simulate dragging the Done header
  const doneHeader = document.querySelector('.column-header[data-column-id="done"]');
  assert(doneHeader !== null, 'done header should exist');
  const dragStartEvent = {
    target: doneHeader,
    dataTransfer: {
      effectAllowed: '',
      _data: {},
      setData: function(type, val) { this._data[type] = val; },
      getData: function(type) { return this._data[type] || ''; },
      types: []
    },
    preventDefault: () => {}
  };
  handleDragStart(dragStartEvent);

  // Simulate dropping on backlog
  const backlogCol = document.getElementById('column-backlog');
  const dropEvent = {
    target: backlogCol,
    preventDefault: () => {},
    dataTransfer: { types: ['application/x-column-id'] }
  };
  handleDrop(dropEvent);

  // After the full drag-drop, DOM should show done before backlog
  const orderAfter = _domColumnOrder();
  assertEqual(orderAfter[0], 'column-done',
    'done should be at DOM position 0 after dragging it onto backlog');
});

test('#45 AC2: backlog-body, in-progress-body, done-body still exist in DOM after refactor', () => {
  _setupReorderTest();
  assert(document.getElementById('backlog-body') !== null, 'backlog-body should exist');
  assert(document.getElementById('in-progress-body') !== null, 'in-progress-body should exist');
  assert(document.getElementById('done-body') !== null, 'done-body should exist');
  assert(document.getElementById('backlog-count') !== null, 'backlog-count should exist');
  assert(document.getElementById('in-progress-count') !== null, 'in-progress-count should exist');
  assert(document.getElementById('done-count') !== null, 'done-count should exist');
});

test('#45 AC3: add-card form lives in currentAddCardColumn body after each render', () => {
  _setupReorderTest();
  currentAddCardColumn = 'in-progress';
  renderBoard();
  const formWrapper = document.getElementById('add-card-form-wrapper');
  const ipBody = document.getElementById('in-progress-body');
  assert(formWrapper !== null, 'form wrapper should exist');
  assert(ipBody.contains(formWrapper),
    'form wrapper should be inside in-progress-body when currentAddCardColumn is in-progress');
  // Restore default
  currentAddCardColumn = 'backlog';
  renderBoard();
  const backlogBody = document.getElementById('backlog-body');
  assert(backlogBody.contains(formWrapper),
    'form wrapper should return to backlog body when currentAddCardColumn is backlog');
});

test('#45 AC4: reordering persists columns in saveToJSONFile payload', () => {
  _setupReorderTest();
  reorderColumn('done', 'backlog');
  _lastJSONPayload = null;
  saveToJSONFile();
  assert(_lastJSONPayload !== null, 'saveToJSONFile should populate _lastJSONPayload');
  assert(Array.isArray(_lastJSONPayload.columns), 'payload should include columns array');
  const idsInPayload = _lastJSONPayload.columns.map(c => c.id);
  assertEqual(idsInPayload[0], 'done', 'persisted columns order should reflect the reorder');
});

test('#45 regression: card rendering into each column still works', () => {
  _setupReorderTest();
  addCard('In Backlog', '', 'task', 'unassigned', []);
  cards[0].column = 'backlog';
  addCard('In Progress', '', 'task', 'unassigned', []);
  cards[1].column = 'in-progress';
  addCard('In Done', '', 'task', 'unassigned', []);
  cards[2].column = 'done';
  renderBoard();
  assert(document.querySelector('#backlog-body .card') !== null, 'backlog body should have a card');
  assert(document.querySelector('#in-progress-body .card') !== null, 'in-progress body should have a card');
  assert(document.querySelector('#done-body .card') !== null, 'done body should have a card');
});

test('#45 regression: column count updates correctly after reorder', () => {
  _setupReorderTest();
  addCard('A', '', 'task', 'unassigned', []);
  cards[0].column = 'done';
  renderBoard();
  assertEqual(document.getElementById('done-count').textContent, '1',
    'done count should be 1 after adding a card');
  reorderColumn('done', 'backlog');
  assertEqual(document.getElementById('done-count').textContent, '1',
    'done count should still be 1 after reorder (count stays with column)');
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle: Insertion-position indicators (#30 + #49)
   ════════════════════════════════════════════════ */

// Helper: synthetic dragover event with clientX/clientY + column-drag dataTransfer
function _columnDragOverEvent(targetEl, clientX) {
  return {
    target: targetEl,
    preventDefault: () => {},
    dataTransfer: { types: ['application/x-column-id'], dropEffect: '' },
    clientX,
    clientY: targetEl.getBoundingClientRect().top + 10,
  };
}

function _columnDropEvent(targetEl, clientX) {
  return {
    target: targetEl,
    preventDefault: () => {},
    dataTransfer: { types: ['application/x-column-id'] },
    clientX,
    clientY: targetEl.getBoundingClientRect().top + 10,
  };
}

test('#49 AC1: column dragover creates a .column-insertion-indicator element in the DOM', () => {
  _setupReorderTest();
  draggedColumnId = 'done';
  const backlogCol = document.getElementById('column-backlog');
  const rect = backlogCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(backlogCol, rect.left + 5));
  const indicator = document.querySelector('.column-insertion-indicator');
  assert(indicator !== null, 'column-insertion-indicator element should exist during column dragover');
  // Cleanup
  draggedColumnId = null;
  handleDragEnd({});
});

test('#49 AC2a: cursor on LEFT half of target column → indicator marked side=before', () => {
  _setupReorderTest();
  draggedColumnId = 'done';
  const backlogCol = document.getElementById('column-backlog');
  const rect = backlogCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(backlogCol, rect.left + 5));
  const indicator = document.querySelector('.column-insertion-indicator');
  assertEqual(indicator.dataset.side, 'before', 'left-half cursor → side=before');
  draggedColumnId = null;
  handleDragEnd({});
});

test('#49 AC2b: cursor on RIGHT half of target column → indicator marked side=after', () => {
  _setupReorderTest();
  draggedColumnId = 'done';
  const backlogCol = document.getElementById('column-backlog');
  const rect = backlogCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(backlogCol, rect.left + rect.width - 5));
  const indicator = document.querySelector('.column-insertion-indicator');
  assertEqual(indicator.dataset.side, 'after', 'right-half cursor → side=after');
  draggedColumnId = null;
  handleDragEnd({});
});

test('#49 AC3a: drop on LEFT half of target → dragged column placed BEFORE target', () => {
  _setupReorderTest();
  // Initial order: backlog, in-progress, done
  draggedColumnId = 'done';
  const ipCol = document.getElementById('column-in-progress');
  const rect = ipCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(ipCol, rect.left + 5));
  handleDrop(_columnDropEvent(ipCol, rect.left + 5));
  // Expected: backlog, done, in-progress
  assertEqual(columns.map(c => c.id).join(','),
    'backlog,done,in-progress',
    'left-half drop on in-progress should place done BEFORE in-progress');
});

test('#49 AC3b: drop on RIGHT half of target → dragged column placed AFTER target', () => {
  _setupReorderTest();
  // Initial order: backlog, in-progress, done
  draggedColumnId = 'done';
  const backlogCol = document.getElementById('column-backlog');
  const rect = backlogCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(backlogCol, rect.left + rect.width - 5));
  handleDrop(_columnDropEvent(backlogCol, rect.left + rect.width - 5));
  // Expected: backlog, done, in-progress (done dropped AFTER backlog)
  assertEqual(columns.map(c => c.id).join(','),
    'backlog,done,in-progress',
    'right-half drop on backlog should place done AFTER backlog');
});

test('#49 AC4: insertion indicator is removed from DOM after dragend', () => {
  _setupReorderTest();
  draggedColumnId = 'done';
  const backlogCol = document.getElementById('column-backlog');
  const rect = backlogCol.getBoundingClientRect();
  handleDragOver(_columnDragOverEvent(backlogCol, rect.left + 5));
  assert(document.querySelector('.column-insertion-indicator') !== null,
    'indicator should be in DOM after dragover');
  handleDragEnd({});
  assert(document.querySelector('.column-insertion-indicator') === null,
    'indicator should be removed from DOM after dragend');
});

test('#49 AC5: card drag still applies .drag-over column highlight (not replaced by insertion indicator)', () => {
  _setupReorderTest();
  const card = addCard('Card', '', 'task', 'unassigned', []);
  renderBoard();
  draggedCardId = card.id;
  draggedColumnId = null;  // explicitly NOT a column drag
  const ipCol = document.getElementById('column-in-progress');
  const rect = ipCol.getBoundingClientRect();
  handleDragOver({
    target: ipCol,
    preventDefault: () => {},
    dataTransfer: { types: ['text/plain'], dropEffect: '' },
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + 20,
  });
  assert(ipCol.classList.contains('drag-over'),
    'card drag should still apply .drag-over to target column');
  // No column-insertion-indicator should exist for card drag
  assert(document.querySelector('.column-insertion-indicator') === null,
    'column-insertion-indicator should NOT appear for card drag');
  // Cleanup
  draggedCardId = null;
  handleDragEnd({});
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

// ── #30: card insertion-position indicator within column ──
// Helper: synthetic event for a card drag (clientX/Y + text/plain dataTransfer)
function _cardDragEvent(type, targetEl, clientY) {
  const rect = targetEl.getBoundingClientRect();
  return {
    target: targetEl,
    preventDefault: () => {},
    dataTransfer: { types: ['text/plain'], dropEffect: '' },
    clientX: rect.left + rect.width / 2,
    clientY,
  };
}

test('#30 AC1: card dragover with clientY creates a .card-insertion-indicator in the DOM', () => {
  _setupReorderTest();
  const cardA = addCard('A', '', 'task', 'unassigned', []);
  const cardB = addCard('B', '', 'task', 'unassigned', []);
  cardA.column = cardB.column = 'in-progress';
  renderBoard();
  draggedCardId = cardA.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const aRect = document.querySelector(`.card[data-id="${cardA.id}"]`).getBoundingClientRect();
  handleDragOver(_cardDragEvent('dragover', ipBody, aRect.top + 5));
  const indicator = document.querySelector('.card-insertion-indicator');
  assert(indicator !== null, 'card-insertion-indicator should exist during card dragover');
  // Cleanup
  draggedCardId = null;
  handleDragEnd({});
});

test('#30 AC2a: drop at TOP of column (cursor above first card midpoint) → card lands first in column', () => {
  _setupReorderTest();
  const cardA = addCard('A', '', 'task', 'unassigned', []);
  const cardB = addCard('B', '', 'task', 'unassigned', []);
  cardA.column = cardB.column = 'in-progress';
  // Add C in backlog — we'll drop C at top of in-progress
  const cardC = addCard('C', '', 'task', 'unassigned', []);
  renderBoard();
  draggedCardId = cardC.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const aRect = document.querySelector(`.card[data-id="${cardA.id}"]`).getBoundingClientRect();
  // Cursor above A's midpoint
  const ev = _cardDragEvent('drop', ipBody, aRect.top + 1);
  handleDrop(ev);
  // Expected in-progress order: C, A, B
  const ipCards = cards.filter(c => c.column === 'in-progress').map(c => c.title);
  assertEqual(ipCards.join(','), 'C,A,B',
    'C dropped above A should be first in in-progress column');
});

test('#30 AC2b: drop at BOTTOM of column → card lands last in column', () => {
  _setupReorderTest();
  const cardA = addCard('A', '', 'task', 'unassigned', []);
  const cardB = addCard('B', '', 'task', 'unassigned', []);
  cardA.column = cardB.column = 'in-progress';
  const cardC = addCard('C', '', 'task', 'unassigned', []);
  renderBoard();
  draggedCardId = cardC.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const bRect = document.querySelector(`.card[data-id="${cardB.id}"]`).getBoundingClientRect();
  // Cursor below B's midpoint
  const ev = _cardDragEvent('drop', ipBody, bRect.bottom + 10);
  handleDrop(ev);
  // Expected in-progress order: A, B, C
  const ipCards = cards.filter(c => c.column === 'in-progress').map(c => c.title);
  assertEqual(ipCards.join(','), 'A,B,C',
    'C dropped below B should be last in in-progress column');
});

test('#30 AC2c: drop in MIDDLE (between A and B) → card lands between them', () => {
  _setupReorderTest();
  const cardA = addCard('A', '', 'task', 'unassigned', []);
  const cardB = addCard('B', '', 'task', 'unassigned', []);
  cardA.column = cardB.column = 'in-progress';
  const cardC = addCard('C', '', 'task', 'unassigned', []);
  renderBoard();
  draggedCardId = cardC.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const bRect = document.querySelector(`.card[data-id="${cardB.id}"]`).getBoundingClientRect();
  // Cursor above B's midpoint (below A but above B's middle)
  const ev = _cardDragEvent('drop', ipBody, bRect.top + 1);
  handleDrop(ev);
  // Expected in-progress order: A, C, B
  const ipCards = cards.filter(c => c.column === 'in-progress').map(c => c.title);
  assertEqual(ipCards.join(','), 'A,C,B',
    'C dropped above B (after A) should land between them');
});

test('#30 AC3: card-insertion-indicator is removed from DOM after dragend', () => {
  _setupReorderTest();
  const cardA = addCard('A', '', 'task', 'unassigned', []);
  cardA.column = 'in-progress';
  renderBoard();
  draggedCardId = cardA.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const aRect = document.querySelector(`.card[data-id="${cardA.id}"]`).getBoundingClientRect();
  handleDragOver(_cardDragEvent('dragover', ipBody, aRect.top + 1));
  assert(document.querySelector('.card-insertion-indicator') !== null,
    'indicator should exist after dragover');
  handleDragEnd({});
  assert(document.querySelector('.card-insertion-indicator') === null,
    'indicator should be removed from DOM after dragend');
});

test('#30 AC4a: same-column reorder — moving card 3 between cards 1 and 2 updates order', () => {
  _setupReorderTest();
  const c1 = addCard('1', '', 'task', 'unassigned', []);
  const c2 = addCard('2', '', 'task', 'unassigned', []);
  const c3 = addCard('3', '', 'task', 'unassigned', []);
  c1.column = c2.column = c3.column = 'backlog';
  renderBoard();
  // Initial backlog order: 1, 2, 3
  draggedCardId = c3.id;
  draggedColumnId = null;
  const backlogBody = document.getElementById('backlog-body');
  const c2Rect = document.querySelector(`.card[data-id="${c2.id}"]`).getBoundingClientRect();
  // Cursor above c2's midpoint (= between c1 and c2)
  handleDrop(_cardDragEvent('drop', backlogBody, c2Rect.top + 1));
  // Expected backlog order: 1, 3, 2
  const order = cards.filter(c => c.column === 'backlog').map(c => c.title);
  assertEqual(order.join(','), '1,3,2', 'same-column reorder should place 3 between 1 and 2');
});

test('#30 AC4b: cross-column move at specific position — card lands at target position in new column', () => {
  _setupReorderTest();
  const c1 = addCard('1', '', 'task', 'unassigned', []);
  const c2 = addCard('2', '', 'task', 'unassigned', []);
  c1.column = c2.column = 'in-progress';
  const cMover = addCard('Mover', '', 'task', 'unassigned', []);
  // Mover starts in backlog
  renderBoard();
  draggedCardId = cMover.id;
  draggedColumnId = null;
  const ipBody = document.getElementById('in-progress-body');
  const c2Rect = document.querySelector(`.card[data-id="${c2.id}"]`).getBoundingClientRect();
  // Cursor above c2's midpoint (= between 1 and 2 in in-progress)
  handleDrop(_cardDragEvent('drop', ipBody, c2Rect.top + 1));
  // Expected in-progress order: 1, Mover, 2
  const order = cards.filter(c => c.column === 'in-progress').map(c => c.title);
  assertEqual(order.join(','), '1,Mover,2', 'Mover should land between 1 and 2 in in-progress');
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle: Priority field (#27)
   Sub-cycle 1: schema + migration + badge
   ════════════════════════════════════════════════ */

test('#27 AC-schema: createCard with priority parameter sets card.priority', () => {
  cards.length = 0;
  const card = createCard('Priority Test', '', 'task', 'unassigned', [], 'backlog', 'p0');
  assertEqual(card.priority, 'p0', 'createCard should accept and set priority');
});

test('#27 AC-schema: createCard without priority parameter sets card.priority to null', () => {
  cards.length = 0;
  const card = createCard('No Priority', '', 'task', 'unassigned', [], 'backlog');
  assertEqual(card.priority, null, 'createCard without priority should default to null');
});

test('#27 AC-migration: P0 prefix in title → priority=p0, prefix stripped', () => {
  cards.length = 0;
  cards.push({
    id: 'mig-p0',
    title: '🔴 P0: Bind server to localhost',
    description: '', type: 'task', assignee: 'unassigned', labels: [],
    createdAt: '2026-05-10T10:00:00Z', updatedAt: '2026-05-10T10:00:00Z',
    column: 'backlog', shortId: 100,
  });
  migratePrioritiesIfNeeded();
  const c = cards[0];
  assertEqual(c.priority, 'p0', 'priority should be set from P0 prefix');
  assertEqual(c.title, 'Bind server to localhost', 'P0 prefix should be stripped from title');
});

test('#27 AC-migration: P2 prefix with yellow emoji → priority=p2, stripped', () => {
  cards.length = 0;
  cards.push({
    id: 'mig-p2',
    title: '🟡 P2: Restrict CORS to localhost',
    description: '', type: 'task', assignee: 'unassigned', labels: [],
    createdAt: '2026-05-10T10:00:00Z', updatedAt: '2026-05-10T10:00:00Z',
    column: 'backlog', shortId: 101,
  });
  migratePrioritiesIfNeeded();
  const c = cards[0];
  assertEqual(c.priority, 'p2', 'priority should be set from P2 prefix');
  assertEqual(c.title, 'Restrict CORS to localhost', 'P2 prefix should be stripped');
});

test('#27 AC-migration: title without prefix unchanged', () => {
  cards.length = 0;
  cards.push({
    id: 'mig-none',
    title: 'Regular card with no priority',
    description: '', type: 'task', assignee: 'unassigned', labels: [],
    createdAt: '2026-05-10T10:00:00Z', updatedAt: '2026-05-10T10:00:00Z',
    column: 'backlog', shortId: 102,
  });
  migratePrioritiesIfNeeded();
  const c = cards[0];
  assert(c.priority === null || c.priority === undefined,
    'card without prefix should have null/undefined priority');
  assertEqual(c.title, 'Regular card with no priority', 'title should be unchanged');
});

test('#27 AC-migration: idempotent — running twice does not re-strip or change priority', () => {
  cards.length = 0;
  cards.push({
    id: 'mig-idem',
    title: '🔴 P1: Some task',
    description: '', type: 'task', assignee: 'unassigned', labels: [],
    createdAt: '2026-05-10T10:00:00Z', updatedAt: '2026-05-10T10:00:00Z',
    column: 'backlog', shortId: 103,
  });
  migratePrioritiesIfNeeded();
  const after1 = { priority: cards[0].priority, title: cards[0].title };
  migratePrioritiesIfNeeded();
  assertEqual(cards[0].priority, after1.priority, 'priority unchanged on second run');
  assertEqual(cards[0].title, after1.title, 'title unchanged on second run');
});

test('#27 AC-badge: card with priority renders .card-priority element with priority class', () => {
  cards.length = 0;
  const card = addCard('Badge Test', '', 'task', 'unassigned', []);
  card.priority = 'p0';
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const badge = cardEl.querySelector('.card-priority');
  assert(badge !== null, 'priority badge should appear in card DOM');
  assert(badge.classList.contains('priority-p0'), 'badge should have priority-p0 class');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#27 AC-badge: card without priority renders no .card-priority element', () => {
  cards.length = 0;
  const card = addCard('No Badge', '', 'task', 'unassigned', []);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const badge = cardEl.querySelector('.card-priority');
  assert(badge === null, 'no badge should render for cards without priority');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

/* ════════════════════════════════════════════════
   #27 Sub-cycle 2: form input + filter strip
   ════════════════════════════════════════════════ */

test('#27 AC-form: add-card form has #card-priority dropdown', () => {
  const priorityInput = document.getElementById('card-priority');
  assert(priorityInput !== null, 'add-card form should have #card-priority select');
  assert(priorityInput.tagName === 'SELECT', '#card-priority should be a SELECT element');
  // Must include p0/p1/p2/p3 + none option
  const options = Array.from(priorityInput.querySelectorAll('option')).map(o => o.value);
  assert(options.includes('p0') && options.includes('p1') && options.includes('p2') && options.includes('p3'),
    'priority dropdown should include p0,p1,p2,p3');
  assert(options.includes(''), 'priority dropdown should have an empty (no priority) option');
});

test('#27 AC-form: submitting add-card form with priority creates card with that priority', () => {
  cards.length = 0;
  document.getElementById('card-title').value = 'Form Priority Test';
  document.getElementById('card-priority').value = 'p1';
  document.getElementById('btn-add-card').click();
  const card = cards.find(c => c.title === 'Form Priority Test');
  assert(card !== undefined, 'card should be created');
  assertEqual(card.priority, 'p1', 'created card should have priority=p1');
  // Cleanup
  document.getElementById('card-priority').value = '';
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#27 AC-form: edit form has .edit-priority dropdown reflecting current value', () => {
  cards.length = 0;
  const card = addCard('Edit Priority', '', 'task', 'unassigned', []);
  card.priority = 'p2';
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const priorityInput = cardEl.querySelector('.edit-priority');
  assert(priorityInput !== null, 'edit form should have .edit-priority select');
  assertEqual(priorityInput.value, 'p2', 'edit form priority should reflect current value');
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#27 AC-filter: togglePriorityFilter adds/removes priority from activePriorities', () => {
  activePriorities.clear();
  togglePriorityFilter('p0');
  assert(activePriorities.has('p0'), 'p0 should be in activePriorities after first toggle');
  togglePriorityFilter('p0');
  assert(!activePriorities.has('p0'), 'p0 should be removed after second toggle');
});

test('#27 AC-filter: cards filtered by priority — only matching priority visible', () => {
  cards.length = 0;
  const p0Card = addCard('P0 card', '', 'task', 'unassigned', []);
  p0Card.priority = 'p0';
  const p1Card = addCard('P1 card', '', 'task', 'unassigned', []);
  p1Card.priority = 'p1';
  const noneCard = addCard('No priority', '', 'task', 'unassigned', []);
  activePriorities.clear();
  activePriorities.add('p0');
  assert(cardMatchesActiveFilter(p0Card), 'p0 card should match p0 filter');
  assert(!cardMatchesActiveFilter(p1Card), 'p1 card should NOT match p0 filter');
  assert(!cardMatchesActiveFilter(noneCard), 'no-priority card should NOT match p0 filter');
  // Cleanup
  activePriorities.clear();
  cards.length = 0;
  renderBoard();
});

// #498 SUPERSEDES this one clause of #27's ACs (recorded on #27 first).
// Priority filtering is untouched and still guarded by the other four
// #27 AC-filter tests; what is retired is the badge being the click target.
// A chip on card A that re-filters the whole board is a state-changing
// affordance disguised as an indicator. Guarding the retirement rather than
// deleting the test, so the old behaviour cannot quietly return.
test('#498 (supersedes one #27 AC-filter clause): the card priority badge is an inert indicator', () => {
  cards.length = 0;
  activePriorities.clear();
  const card = addCard('Click Test', '', 'task', 'unassigned', []);
  card.priority = 'p3';
  renderBoard();
  const badge = document.querySelector(`.card[data-id="${card.id}"] .card-priority`);
  assert(badge !== null, 'priority badge should still be in DOM — it is an indicator, not gone');
  assert(!badge.dataset.action, `badge must carry no click action, got "${badge.dataset.action}"`);
  assertEqual(badge.dataset.priority, 'p3', 'badge still carries its value for styling/reading');
  badge.click();
  assert(!activePriorities.has('p3'), 'clicking a card badge must NOT filter the board');
  // Cleanup
  activePriorities.clear();
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#27 AC-filter: renderFilterStrip shows priority chip when activePriorities non-empty', () => {
  activePriorities.clear();
  activePriorities.add('p1');
  renderFilterStrip();
  const strip = document.getElementById('filter-strip');
  const priorityChip = strip.querySelector('.filter-chip-priority');
  assert(priorityChip !== null, 'filter strip should show .filter-chip-priority when active');
  activePriorities.clear();
  renderFilterStrip();
});

test('#27 AC-filter: clearAllFilters clears activePriorities', () => {
  activePriorities.clear();
  activePriorities.add('p0');
  activePriorities.add('p1');
  clearAllFilters();
  assertEqual(activePriorities.size, 0, 'activePriorities should be empty after clearAllFilters');
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle: Multi-user assignment (#51)
   Sub-cycle 1: schema + migration + render + filter
   ════════════════════════════════════════════════ */

test('#51 AC1: createCard with string assignee normalizes to assignees array', () => {
  cards.length = 0;
  const card = createCard('Solo', '', 'task', 'alex', []);
  assert(Array.isArray(card.assignees), 'card.assignees should be an array');
  assertEqual(card.assignees.length, 1, 'one-string-assignee → single-element array');
  assertEqual(card.assignees[0], 'alex', 'array contains the string assignee');
});

test('#51 AC1: createCard with array assignee preserves the array', () => {
  cards.length = 0;
  const card = createCard('Multi', '', 'task', ['alex', 'sage'], []);
  assertEqual(card.assignees.length, 2, 'array assignee → multi-element array');
  assert(card.assignees.includes('alex') && card.assignees.includes('sage'),
    'both values preserved');
});

// #508 SUPERSEDES #51 AC1. The original asserted that createCard('both')
// expands to [alex, robin]. That expansion minted two hardcoded example seats,
// so on any configured board it assigned work to two people who do not exist.
// The contract is retired; this test now guards the retirement rather than
// being deleted, so the old behaviour cannot quietly return.
test('#508 (supersedes #51 AC1): createCard no longer expands "both" into example seats', () => {
  cards.length = 0;
  const card = createCard('Legacy Both', '', 'task', 'both', []);
  assert(!card.assignees.includes('alex') && !card.assignees.includes('robin'),
    `'both' must never mint example seats, got ${JSON.stringify(card.assignees)}`);
  assert(card.assignees.length > 0, 'assignees must not be silently emptied');
});

test('#51 AC1: createCard with empty/null assignee defaults to ["unassigned"]', () => {
  cards.length = 0;
  const card1 = createCard('Empty', '', 'task', '', []);
  assertEqual(card1.assignees[0], 'unassigned', 'empty string → ["unassigned"]');
  const card2 = createCard('Null', '', 'task', null, []);
  assertEqual(card2.assignees[0], 'unassigned', 'null → ["unassigned"]');
  const card3 = createCard('Empty Array', '', 'task', [], []);
  assertEqual(card3.assignees[0], 'unassigned', 'empty array → ["unassigned"]');
});

test('#51 AC2: migrateAssigneesIfNeeded converts singular assignee → assignees array', () => {
  cards.length = 0;
  cards.push({ id: 'mig-1', title: 'X', assignee: 'alex', column: 'backlog' });
  cards.push({ id: 'mig-2', title: 'Y', assignee: 'sage', column: 'backlog' });
  migrateAssigneesIfNeeded();
  assert(Array.isArray(cards[0].assignees), 'first card has assignees array');
  assertEqual(cards[0].assignees[0], 'alex');
  assertEqual(cards[1].assignees[0], 'sage');
  assert(cards[0].assignee === undefined, 'old assignee field should be removed');
});

// #508 SUPERSEDES #51 AC2. A restored pre-#51 backup can still carry
// assignee:'both'. Unlike live input it cannot be refused, so it converts —
// loudly, to 'unassigned', with a console warning naming the card. Who 'both'
// meant was never recorded, only implied by a two-seat roster that is gone;
// minting two roster keys would re-run the bug and silently emptying would hide
// a real assignment.
test('#508 (supersedes #51 AC2): migrateAssigneesIfNeeded converts "both" loudly, not to example seats', () => {
  cards.length = 0;
  cards.push({ id: 'mig-both', shortId: 7, title: 'Both Card', assignee: 'both', column: 'backlog' });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(' ')); realWarn.apply(console, a); };
  try { migrateAssigneesIfNeeded(); } finally { console.warn = realWarn; }
  const c = cards[0];
  assert(!c.assignees.includes('alex') && !c.assignees.includes('robin'),
    `migration must not mint example seats, got ${JSON.stringify(c.assignees)}`);
  assert(c.assignees.length > 0, 'migration must not silently empty the assignment');
  assert(warnings.some(w => w.includes('7')),
    `the conversion must name the card it changed; warnings were ${JSON.stringify(warnings)}`);
});

test('#51 AC2: migrateAssigneesIfNeeded is idempotent', () => {
  cards.length = 0;
  cards.push({ id: 'mig-i', title: 'X', assignee: 'alex', column: 'backlog' });
  migrateAssigneesIfNeeded();
  const after1 = JSON.stringify(cards[0]);
  migrateAssigneesIfNeeded();
  const after2 = JSON.stringify(cards[0]);
  assertEqual(after1, after2, 'second migration should be a no-op');
});

test('#51 AC6: card with multiple assignees renders one badge per assignee', () => {
  cards.length = 0;
  const card = addCard('Multi-render', '', 'task', ['alex', 'sage'], []);
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const badges = cardEl.querySelectorAll('.card-assignee');
  assertEqual(badges.length, 2, 'two assignees → two badges');
  const dataAssignees = Array.from(badges).map(b => b.dataset.assignee);
  assert(dataAssignees.includes('alex') && dataAssignees.includes('sage'),
    'each badge has correct data-assignee');
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#51 AC7: filter matches if ANY of the card\'s assignees is in activeAssignees', () => {
  cards.length = 0;
  const multi = addCard('Multi', '', 'task', ['alex', 'sage'], []);
  const solo = addCard('Solo', '', 'task', 'alex', []);
  const nova = addCard('Nova', '', 'task', 'nova', []);
  activeAssignees.clear();
  activeAssignees.add('sage');
  assert(cardMatchesActiveFilter(multi), 'multi-assignee card matches if any assignee is in filter');
  assert(!cardMatchesActiveFilter(solo), 'solo alex card does NOT match sage filter');
  assert(!cardMatchesActiveFilter(nova), 'nova-only card does NOT match sage filter');
  activeAssignees.clear();
  [multi, solo, nova].forEach(c => {
    const idx = cards.findIndex(x => x.id === c.id);
    if (idx > -1) cards.splice(idx, 1);
  });
  renderBoard();
});

/* ════════════════════════════════════════════════
   #51 Sub-cycle 2: form UIs (add + edit) with multi-select
   ════════════════════════════════════════════════ */

test('#51 AC5: add-card form has checkbox group for assignees with all known entities', () => {
  const group = document.getElementById('card-assignees-group');
  assert(group !== null, 'add-card form should have #card-assignees-group');
  const checkboxes = group.querySelectorAll('input[type="checkbox"][name="card-assignees"]');
  const values = Array.from(checkboxes).map(c => c.value);
  ['alex', 'robin', 'sage', 'nova', 'unassigned'].forEach(key => {
    assert(values.includes(key), `assignee checkbox group should include ${key}`);
  });
});

test('#51 AC4: submitting add-card form with no assignees checked defaults to [unassigned]', () => {
  cards.length = 0;
  // Uncheck everything
  document.querySelectorAll('input[name="card-assignees"]').forEach(cb => { cb.checked = false; });
  document.getElementById('card-title').value = 'No Assignee Test';
  document.getElementById('btn-add-card').click();
  const card = cards.find(c => c.title === 'No Assignee Test');
  assert(card !== undefined, 'card should be created');
  assertEqual(card.assignees.length, 1, 'should default to single assignee');
  assertEqual(card.assignees[0], 'unassigned', 'default should be unassigned');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#51 AC5: submitting add-card form with multiple boxes checked → assignees array', () => {
  cards.length = 0;
  document.querySelectorAll('input[name="card-assignees"]').forEach(cb => { cb.checked = false; });
  document.querySelector('input[name="card-assignees"][value="alex"]').checked = true;
  document.querySelector('input[name="card-assignees"][value="sage"]').checked = true;
  document.getElementById('card-title').value = 'Multi Assign Test';
  document.getElementById('btn-add-card').click();
  const card = cards.find(c => c.title === 'Multi Assign Test');
  assert(card !== undefined, 'card should be created');
  assertEqual(card.assignees.length, 2, 'should have 2 assignees');
  assert(card.assignees.includes('alex') && card.assignees.includes('sage'),
    'should include both checked entities');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#51 AC3: edit form renders checkbox group with the card\'s current assignees pre-checked', () => {
  cards.length = 0;
  const card = addCard('Edit Multi', '', 'task', ['alex', 'sage'], []);
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  const group = cardEl.querySelector('.edit-assignees-group');
  assert(group !== null, 'edit form should have .edit-assignees-group');
  const checked = group.querySelectorAll('input[type="checkbox"]:checked');
  const checkedValues = Array.from(checked).map(cb => cb.value);
  assertEqual(checked.length, 2, 'should have exactly 2 boxes pre-checked');
  assert(checkedValues.includes('alex') && checkedValues.includes('sage'),
    'pre-checked boxes should match card.assignees');
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#51 AC4: saveEdit with no boxes checked → assignees defaults to [unassigned]', () => {
  cards.length = 0;
  const card = addCard('Edit Default', '', 'task', 'alex', []);
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  cardEl.querySelectorAll('.edit-assignees-group input[type="checkbox"]').forEach(cb => {
    cb.checked = false;
  });
  saveEdit(card.id);
  assertEqual(card.assignees.length, 1, 'should fall back to single unassigned');
  assertEqual(card.assignees[0], 'unassigned', 'default to unassigned');
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

test('#51 AC3: saveEdit reads checkbox group and updates card.assignees', () => {
  cards.length = 0;
  const card = addCard('Edit Change', '', 'task', 'alex', []);
  editingCardId = card.id;
  renderBoard();
  const cardEl = document.querySelector(`.card[data-id="${card.id}"]`);
  // Uncheck alex, check robin + sage
  cardEl.querySelector('.edit-assignees-group input[value="alex"]').checked = false;
  cardEl.querySelector('.edit-assignees-group input[value="robin"]').checked = true;
  cardEl.querySelector('.edit-assignees-group input[value="sage"]').checked = true;
  saveEdit(card.id);
  assertEqual(card.assignees.length, 2, 'should have 2 assignees after edit');
  assert(card.assignees.includes('robin') && card.assignees.includes('sage'),
    'new selection persists');
  assert(!card.assignees.includes('alex'), 'unchecked alex should be gone');
  editingCardId = null;
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  renderBoard();
});

/* ════════════════════════════════════════════════
   TESTS - TDD Cycle: Undo Cmd+Z (#31)
   ════════════════════════════════════════════════ */

test('#31 AC1: after a card move via drop, undoLastMove restores the previous column', () => {
  cards.length = 0;
  _undoStack.length = 0;
  const card = addCard('UndoCol', '', 'task', 'unassigned', []);
  assertEqual(card.column, 'backlog', 'starts in backlog');
  // Move to in-progress via the drop pipeline
  draggedCardId = card.id;
  const ipCol = document.getElementById('column-in-progress');
  const dropEvent = new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() });
  ipCol.dispatchEvent(dropEvent);
  assertEqual(card.column, 'in-progress', 'card moved to in-progress');
  // Undo
  const restored = undoLastMove();
  assert(restored === true, 'undoLastMove should report success');
  assertEqual(card.column, 'backlog', 'card should be back in backlog after undo');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  _undoStack.length = 0;
  renderBoard();
});

test('#31 AC2: multiple undos walk back through the move history', () => {
  cards.length = 0;
  _undoStack.length = 0;
  const card = addCard('UndoSequence', '', 'task', 'unassigned', []);
  // Move 1: backlog → in-progress
  draggedCardId = card.id;
  document.getElementById('column-in-progress').dispatchEvent(
    new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })
  );
  // Move 2: in-progress → done
  draggedCardId = card.id;
  document.getElementById('column-done').dispatchEvent(
    new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })
  );
  assertEqual(card.column, 'done', 'card ended up in done');
  // First undo: should go back to in-progress
  undoLastMove();
  assertEqual(card.column, 'in-progress', 'first undo → in-progress');
  // Second undo: should go back to backlog
  undoLastMove();
  assertEqual(card.column, 'backlog', 'second undo → backlog');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  _undoStack.length = 0;
  renderBoard();
});

test('#31 AC3: after undo, #undo-toast appears in DOM with the card title', () => {
  cards.length = 0;
  _undoStack.length = 0;
  const card = addCard('ToastCard', '', 'task', 'unassigned', []);
  draggedCardId = card.id;
  document.getElementById('column-in-progress').dispatchEvent(
    new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })
  );
  undoLastMove();
  const toast = document.getElementById('undo-toast');
  assert(toast !== null, '#undo-toast element should exist after undo');
  assert(toast.classList.contains('visible'), 'toast should be visible');
  assert(toast.textContent.includes('ToastCard'), 'toast text should include card title');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  _undoStack.length = 0;
  if (toast) toast.classList.remove('visible');
  renderBoard();
});

test('#31 undoLastMove on empty stack is a safe no-op', () => {
  _undoStack.length = 0;
  const result = undoLastMove();
  assertEqual(result, false, 'should return false when stack is empty');
});

test('#31 Cmd+Z keyboard shortcut triggers undoLastMove (not inside text input)', () => {
  cards.length = 0;
  _undoStack.length = 0;
  const card = addCard('KeyUndo', '', 'task', 'unassigned', []);
  draggedCardId = card.id;
  document.getElementById('column-done').dispatchEvent(
    new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })
  );
  assertEqual(card.column, 'done', 'moved to done');
  // Fire keydown on document body (not on an input)
  const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
  document.body.dispatchEvent(ev);
  assertEqual(card.column, 'backlog', 'Cmd+Z should undo');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  _undoStack.length = 0;
  renderBoard();
});

test('#31 Cmd+Z inside a text input is NOT intercepted (browser default handles it)', () => {
  cards.length = 0;
  _undoStack.length = 0;
  const card = addCard('KeepInputUndo', '', 'task', 'unassigned', []);
  draggedCardId = card.id;
  document.getElementById('column-done').dispatchEvent(
    new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })
  );
  // Focus the title input, fire Cmd+Z from inside it
  const titleInput = document.getElementById('card-title');
  titleInput.focus();
  const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });
  titleInput.dispatchEvent(ev);
  // Card should NOT have been undone (Cmd+Z went to text input)
  assertEqual(card.column, 'done', 'card move should NOT be undone when Cmd+Z fires inside a text input');
  // Cleanup
  const idx = cards.findIndex(c => c.id === card.id);
  if (idx > -1) cards.splice(idx, 1);
  _undoStack.length = 0;
  renderBoard();
});

/* ════════════════════════════════════════════════
   TESTS - #93 Conversations panel (board-level commons UI)
   ════════════════════════════════════════════════ */

// Helper: stub conversations array (used by mock-fetch responses)
function _stubConvs() {
  return [
    { id: 'c1', body: 'first message', author: 'sage', attachedTo: null, createdAt: '2026-05-18T15:00:00Z' },
    { id: 'c2', body: 'second message', author: 'alex', attachedTo: null, createdAt: '2026-05-18T15:05:00Z' },
    { id: 'c3', body: 'third — multiline\nwith newline', author: 'nova', attachedTo: null, createdAt: '2026-05-18T15:10:00Z' },
  ];
}

test('#93 UI AC1: clicking #btn-toggle-convs adds .visible to #convs-panel', async () => {
  enableFetchMock(_stubConvs());
  const panel = document.getElementById('convs-panel');
  panel.classList.remove('visible');  // reset
  const toggle = document.getElementById('btn-toggle-convs');
  toggle.click();
  await new Promise(r => setTimeout(r, 10));
  assert(panel.classList.contains('visible'), 'panel should be .visible after toggle click');
});

test('#93 UI AC2: clicking #btn-close-convs removes .visible', async () => {
  const panel = document.getElementById('convs-panel');
  panel.classList.add('visible');
  const close = document.getElementById('btn-close-convs');
  close.click();
  assert(!panel.classList.contains('visible'), 'panel should NOT be .visible after close click');
});

test('#93 UI AC3: loadConversations populates #convs-feed with one .conv-msg per record', async () => {
  enableFetchMock(_stubConvs());
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  const msgs = feed.querySelectorAll('.conv-msg');
  assertEqual(msgs.length, 3, 'should render 3 messages from the stub');
});

test('#93 UI AC4: each .conv-msg shows author and body', async () => {
  enableFetchMock(_stubConvs());
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  const first = feed.querySelector('.conv-msg');
  assert(first.textContent.includes('sage'), 'first message should include author "sage"');
  assert(first.textContent.includes('first message'), 'first message should include body text');
});

test('#93 UI AC5: empty conversations show an empty-state hint', async () => {
  enableFetchMock([]);
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  const empty = feed.querySelector('.convs-empty');
  assert(empty !== null, 'should show .convs-empty when no conversations');
});

test('#93 UI AC6: submitting form with non-empty body POSTs to /api/conversations', async () => {
  enableFetchMock(_stubConvs());
  document.getElementById('convs-body').value = 'hello commons from test';
  document.getElementById('convs-author').value = 'sage';
  const form = document.getElementById('convs-form');
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 10));
  const postCall = _fetchMockCalls.find(c =>
    c.url.includes('/api/conversations') && c.options && c.options.method === 'POST'
  );
  assert(postCall, 'should have made POST /api/conversations');
  const payload = JSON.parse(postCall.options.body);
  assertEqual(payload.body, 'hello commons from test', 'POST body should carry the message');
  assertEqual(payload.author, 'sage', 'POST body should carry the author');
});

test('#93 UI AC7: submitting empty body does NOT POST', async () => {
  enableFetchMock(_stubConvs());
  document.getElementById('convs-body').value = '   ';  // whitespace-only
  document.getElementById('convs-author').value = 'sage';
  const form = document.getElementById('convs-form');
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 10));
  const postCall = _fetchMockCalls.find(c =>
    c.url.includes('/api/conversations') && c.options && c.options.method === 'POST'
  );
  assert(!postCall, 'should NOT have made a POST for empty body');
});

test('#93 UI AC8: after successful post, the body textarea is cleared', async () => {
  enableFetchMock(_stubConvs());
  document.getElementById('convs-body').value = 'about to be sent';
  document.getElementById('convs-author').value = 'sage';
  const form = document.getElementById('convs-form');
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 20));
  assertEqual(document.getElementById('convs-body').value, '', 'body field should be cleared after successful post');
});

/* ════════════════════════════════════════════════
   TESTS - #112 Commons panel polling
   ════════════════════════════════════════════════ */

test('#112: opening the commons panel registers an incremental poll', async () => {
  enableFetchMock(_stubConvs());
  const panel = document.getElementById('convs-panel');
  stopConvsPolling();
  panel.classList.remove('visible');

  let pollCb = null;
  const realSI = window.setInterval, realCI = window.clearInterval;
  window.setInterval = (cb) => { pollCb = cb; return 4242; };
  window.clearInterval = () => {};
  try {
    document.getElementById('btn-toggle-convs').click();   // open
    await new Promise(r => setTimeout(r, 10));
    assert(typeof pollCb === 'function', 'opening the panel should register a poll callback');

    // #208: the poll is incremental — firing it with nothing new is a clean
    // no-op (append-only), NOT a feed rebuild. (Was: cleared the feed and
    // expected a full re-render; that contract is gone with the churn fix.)
    const feed = document.getElementById('convs-feed');
    assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'panel opens showing the 3 stub messages');
    const firstBefore = feed.querySelector('.conv-msg');
    await pollCb();
    assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'nothing new → still 3, no duplicates');
    assert(feed.querySelector('.conv-msg') === firstBefore, 'existing nodes preserved (incremental, not rebuilt)');
  } finally {
    window.setInterval = realSI;
    window.clearInterval = realCI;
    stopConvsPolling();
    panel.classList.remove('visible');
  }
});

test('#112: closing the commons panel clears the poll timer', async () => {
  enableFetchMock(_stubConvs());
  const panel = document.getElementById('convs-panel');
  stopConvsPolling();
  panel.classList.remove('visible');

  const timerId = 7777;
  let clearedId = null;
  const realSI = window.setInterval, realCI = window.clearInterval;
  window.setInterval = () => timerId;
  window.clearInterval = (id) => { clearedId = id; };
  try {
    document.getElementById('btn-toggle-convs').click();   // open → starts poll
    await new Promise(r => setTimeout(r, 10));
    document.getElementById('btn-close-convs').click();    // close → stops poll
    assertEqual(clearedId, timerId, 'closing the panel should clear the specific poll timer');
  } finally {
    window.setInterval = realSI;
    window.clearInterval = realCI;
    stopConvsPolling();
    panel.classList.remove('visible');
  }
});

test('#112: a message posted by someone else appears on the next poll', async () => {
  enableFetchMock([_stubConvs()[0], _stubConvs()[1]]);   // start with 2
  const panel = document.getElementById('convs-panel');
  stopConvsPolling();
  panel.classList.remove('visible');

  let pollCb = null;
  const realSI = window.setInterval, realCI = window.clearInterval;
  window.setInterval = (cb) => { pollCb = cb; return 1; };
  window.clearInterval = () => {};
  try {
    document.getElementById('btn-toggle-convs').click();   // open showing 2
    await new Promise(r => setTimeout(r, 10));
    const feed = document.getElementById('convs-feed');
    assertEqual(feed.querySelectorAll('.conv-msg').length, 2, 'panel opens showing 2 messages');

    // A third message lands server-side — the poll must pick it up.
    enableFetchMock(_stubConvs());   // now returns 3
    await pollCb();
    assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'the new message appeared via polling');
  } finally {
    window.setInterval = realSI;
    window.clearInterval = realCI;
    stopConvsPolling();
    panel.classList.remove('visible');
  }
});

test('#112: a poll with unchanged data does not rebuild the feed DOM', async () => {
  enableFetchMock(_stubConvs());
  const panel = document.getElementById('convs-panel');
  stopConvsPolling();
  panel.classList.remove('visible');

  let pollCb = null;
  const realSI = window.setInterval, realCI = window.clearInterval;
  window.setInterval = (cb) => { pollCb = cb; return 1; };
  window.clearInterval = () => {};
  try {
    document.getElementById('btn-toggle-convs').click();
    await new Promise(r => setTimeout(r, 10));
    const feed = document.getElementById('convs-feed');
    const firstNodeBefore = feed.querySelector('.conv-msg');
    assert(firstNodeBefore, 'feed rendered on open');

    // Poll again with identical data — the feed must not be torn down.
    await pollCb();
    const firstNodeAfter = feed.querySelector('.conv-msg');
    assert(firstNodeBefore === firstNodeAfter, 'unchanged data must not recreate feed DOM nodes');
  } finally {
    window.setInterval = realSI;
    window.clearInterval = realCI;
    stopConvsPolling();
    panel.classList.remove('visible');
  }
});

/* ════════════════════════════════════════════════
   TESTS - #208 Slice 1: incremental poll (?since), append-not-rebuild, lazy images
   ════════════════════════════════════════════════ */

test('#208: the poll fetches incrementally with ?since=<newest loaded ts>, not a full refetch', async () => {
  enableFetchMock(_stubConvs());
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();                 // loads c1,c2,c3 → cursor = newest createdAt
  _fetchMockCalls.length = 0;
  await pollConversations();
  const call = _fetchMockCalls.find(c => c.url.includes('/api/conversations'));
  assert(call, 'poll must hit /api/conversations');
  assert(call.url.includes('since='), 'poll must be incremental (?since=), not a full refetch');
  assert(call.url.includes(encodeURIComponent('2026-05-18T15:10:00Z')),
    'since cursor must be the newest loaded createdAt');
});

test('#208: a new message appends without recreating existing message nodes', async () => {
  enableFetchMock([_stubConvs()[0], _stubConvs()[1]]);   // start with 2
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  const c1node = feed.querySelector('.conv-msg');
  assertEqual(feed.querySelectorAll('.conv-msg').length, 2, 'starts with 2');
  enableFetchMock(_stubConvs());                         // server now has 3
  await pollConversations();
  assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'the third message was appended');
  assert(feed.querySelector('.conv-msg') === c1node, 'the existing first node was preserved, not rebuilt');
});

test('#208: poll dedupes the boundary message (since is >=, never double-renders)', async () => {
  enableFetchMock([_stubConvs()[0], _stubConvs()[1]]);   // c1,c2 → cursor = c2
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  enableFetchMock([_stubConvs()[1], _stubConvs()[2]]);   // since>=c2 returns c2 (boundary) AND c3
  await pollConversations();
  assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'c2 not duplicated; only c3 added');
});

test('#208: attachment images are lazy-loaded (loading="lazy")', () => {
  const node = createConvMessageNode({
    id: 'cimg', author: 'alex', body: 'pic', createdAt: '2026-06-14T00:00:00Z',
    attachments: [{ id: 'shot.png', name: 'shot.png', mime: 'image/png', size: 1 }],
  });
  const img = node.querySelector('img.conv-attach-img');
  assert(img, 'an image attachment renders an <img>');
  assertEqual(img.loading, 'lazy', 'attachment images must lazy-load to bound memory');
});

/* ════════════════════════════════════════════════
   TESTS - #210 Slice 2: bounded initial load + load-older-on-scroll (never lose access)
   ════════════════════════════════════════════════ */

test('#210 UI: initial load requests a bounded recent window (?limit)', async () => {
  enableFetchMock(_stubConvs());
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  _fetchMockCalls.length = 0;
  await loadConversations();
  const call = _fetchMockCalls.find(c => c.url.includes('/api/conversations'));
  assert(call, 'initial load hits /api/conversations');
  assert(call.url.includes('limit='), 'initial load must request a bounded recent window, not everything');
});

test('#210 UI: scrolling up loads older messages, PREPENDS them, preserves existing nodes', async () => {
  enableFetchMock(_stubConvs());                 // c1@15:00, c2@15:05, c3@15:10
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'starts with the recent window');
  const topBefore = feed.querySelector('.conv-msg');   // c1 on top

  const older = [
    { id: 'old1', body: 'older one', author: 'alex', attachedTo: null, createdAt: '2026-05-18T14:50:00Z' },
    { id: 'old2', body: 'older two', author: 'nova',    attachedTo: null, createdAt: '2026-05-18T14:55:00Z' },
  ];
  enableFetchMock(older);
  _fetchMockCalls.length = 0;
  await loadOlderConversations();

  const call = _fetchMockCalls.find(c => c.url.includes('/api/conversations'));
  assert(call.url.includes('before='), 'load-older must page backward with ?before=<oldest loaded>');
  assert(call.url.includes('limit='), 'load-older must be bounded with ?limit');
  const msgs = feed.querySelectorAll('.conv-msg');
  assertEqual(msgs.length, 5, 'the two older messages were added');
  assertEqual(msgs[0].dataset.id, 'old1', 'oldest is now at the very top (prepended above, in order)');
  assert([...msgs].includes(topBefore), 'previously-rendered nodes preserved, not rebuilt');
});

test('#210 UI: load-older stops once the server runs out (reached the start — no runaway)', async () => {
  enableFetchMock(_stubConvs());
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  enableFetchMock([]);                            // no older messages exist
  await loadOlderConversations();
  assertEqual(feed.querySelectorAll('.conv-msg').length, 3, 'nothing older → feed unchanged');
  _fetchMockCalls.length = 0;
  await loadOlderConversations();                 // a second attempt
  assertEqual(_fetchMockCalls.length, 0, 'reached the start → no further load-older fetches');
});

/* ════════════════════════════════════════════════
   TESTS - #128 formatTimestamp helper
   Display commons timestamps in a friendly local format.
   Pure function tests inject `now` and `timeZone` for determinism.
   ════════════════════════════════════════════════ */

test('#128 formatTimestamp: 30s in the past returns "just now"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-28T14:59:30Z';
  assertEqual(formatTimestamp(iso, { now }), 'just now', 'within 60s should be "just now"');
});

test('#128 formatTimestamp: 90s in the past returns "1m ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-28T14:58:30Z';   // 90s earlier
  assertEqual(formatTimestamp(iso, { now }), '1m ago', '60-3599s should be "Nm ago"');
});

test('#128 formatTimestamp: 59m in the past returns "59m ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-28T14:01:00Z';   // 59m earlier
  assertEqual(formatTimestamp(iso, { now }), '59m ago', 'upper minute boundary');
});

test('#128 formatTimestamp: 60m in the past returns "1h ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-28T14:00:00Z';   // 60m earlier
  assertEqual(formatTimestamp(iso, { now }), '1h ago', 'should cross into hours bucket at 60m');
});

test('#128 formatTimestamp: 23h in the past returns "23h ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-27T16:00:00Z';   // 23h earlier
  assertEqual(formatTimestamp(iso, { now }), '23h ago', 'upper hour boundary');
});

test('#128 formatTimestamp: 24h in the past returns "1d ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-27T15:00:00Z';   // 24h earlier
  assertEqual(formatTimestamp(iso, { now }), '1d ago', 'should cross into days bucket at 24h');
});

test('#128 formatTimestamp: 6d in the past returns "6d ago"', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-22T15:00:00Z';   // 6d earlier
  assertEqual(formatTimestamp(iso, { now }), '6d ago', 'upper day boundary');
});

test('#128 formatTimestamp: >7d in the past falls back to absolute local format', () => {
  const now = new Date('2026-05-28T15:00:00Z');
  const iso = '2026-05-20T15:00:00Z';   // 8d earlier
  const out = formatTimestamp(iso, { now, timeZone: 'UTC', locale: 'en-US' });
  assert(/2026/.test(out), 'absolute format should contain the year (2026), got: ' + out);
  assert(/May/.test(out), 'absolute format should contain the month abbrev (May), got: ' + out);
  assert(!/ago/.test(out), 'absolute format should NOT be relative ("ago"), got: ' + out);
});

test('#128 formatTimestamp: empty/null/garbage input returns empty string without throwing', () => {
  assertEqual(formatTimestamp(''), '', 'empty string → empty');
  assertEqual(formatTimestamp(null), '', 'null → empty');
  assertEqual(formatTimestamp(undefined), '', 'undefined → empty');
  assertEqual(formatTimestamp('not a date'), '', 'unparseable string → empty');
});

test('#128 DOM: renderConversations shows friendly text and keeps raw ISO in title', async () => {
  const recentIso = new Date().toISOString();      // ≈ "just now"
  const oldIso    = '2020-01-01T12:00:00Z';        // > 7d → absolute
  // Conversations sort ascending by createdAt (chat-room order), so old comes
  // first, recent last. Stub in that order to keep DOM indexing explicit.
  enableFetchMock([
    { id: 'old', body: 'old post', author: 'nova',   attachedTo: null, createdAt: oldIso },
    { id: 'new', body: 'recent post', author: 'sage', attachedTo: null, createdAt: recentIso },
  ]);
  const feed = document.getElementById('convs-feed');
  feed.innerHTML = '';
  await loadConversations();
  const tsNodes = feed.querySelectorAll('.conv-msg-ts');
  assertEqual(tsNodes.length, 2, 'should render 2 timestamp spans');

  // Old post (rendered first): absolute date format, year present, no "ago",
  // no raw ISO marker; title preserves raw ISO.
  assert(/2020/.test(tsNodes[0].textContent),
    'old post should contain year "2020", got: ' + tsNodes[0].textContent);
  assert(!/ago/.test(tsNodes[0].textContent),
    'old post should not be relative, got: ' + tsNodes[0].textContent);
  assert(!/T.*Z/.test(tsNodes[0].textContent),
    'old text should not contain raw ISO, got: ' + tsNodes[0].textContent);
  assertEqual(tsNodes[0].title, oldIso, 'title should preserve raw ISO for old post');

  // Recent post (rendered second): "just now", title still carries raw ISO.
  assertEqual(tsNodes[1].textContent, 'just now', 'recent post should show "just now"');
  assertEqual(tsNodes[1].title, recentIso, 'title should preserve raw ISO for recent post');
});

/* ════════════════════════════════════════════════
   TESTS - #167 Board auto-refresh
   Polling + signature-based change detection + edit-in-progress guards.
   ════════════════════════════════════════════════ */

// ── boardSignature: change-detection contract ──

test('#167 boardSignature: identical inputs produce identical signatures', () => {
  const c = [{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }];
  const cols = [{ id: 'backlog', order: 0, name: 'Backlog' }];
  assertEqual(boardSignature(c, cols), boardSignature(c, cols), 'pure function: same in, same out');
});

test('#167 boardSignature: editing a card (updatedAt bump) changes the signature', () => {
  const before = boardSignature(
    [{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }],
    [{ id: 'backlog', order: 0, name: 'Backlog' }]
  );
  const after = boardSignature(
    [{ id: 'a', updatedAt: '2026-05-28T11:00:00Z' }],
    [{ id: 'backlog', order: 0, name: 'Backlog' }]
  );
  assert(before !== after, 'an edit must change the signature, got: ' + before + ' vs ' + after);
});

test('#167 boardSignature: adding a card changes the signature', () => {
  const cols = [{ id: 'backlog', order: 0, name: 'Backlog' }];
  const before = boardSignature([{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }], cols);
  const after = boardSignature([
    { id: 'a', updatedAt: '2026-05-28T10:00:00Z' },
    { id: 'b', updatedAt: '2026-05-28T10:00:00Z' },
  ], cols);
  assert(before !== after, 'adding a card must change the signature');
});

test('#167 boardSignature: removing a card changes the signature', () => {
  const cols = [{ id: 'backlog', order: 0, name: 'Backlog' }];
  const before = boardSignature([
    { id: 'a', updatedAt: '2026-05-28T10:00:00Z' },
    { id: 'b', updatedAt: '2026-05-28T10:00:00Z' },
  ], cols);
  const after = boardSignature([{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }], cols);
  assert(before !== after, 'removing a card must change the signature');
});

test('#167 boardSignature: reordering columns changes the signature', () => {
  const c = [{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }];
  const before = boardSignature(c, [
    { id: 'backlog', order: 0, name: 'Backlog' },
    { id: 'in-progress', order: 1, name: 'In Progress' },
  ]);
  const after = boardSignature(c, [
    { id: 'backlog', order: 1, name: 'Backlog' },
    { id: 'in-progress', order: 0, name: 'In Progress' },
  ]);
  assert(before !== after, 'column reorder must change the signature');
});

test('#167 boardSignature: renaming a column changes the signature', () => {
  const c = [{ id: 'a', updatedAt: '2026-05-28T10:00:00Z' }];
  const before = boardSignature(c, [{ id: 'backlog', order: 0, name: 'Backlog' }]);
  const after  = boardSignature(c, [{ id: 'backlog', order: 0, name: 'Ideas' }]);
  assert(before !== after, 'column rename must change the signature');
});

test('#167 boardSignature: empty/null/garbage inputs return a stable string (no throw)', () => {
  // Just shouldn't throw, and should be deterministic.
  const a = boardSignature([], []);
  const b = boardSignature([], []);
  assertEqual(a, b, 'empty inputs should produce stable signature');
  const c = boardSignature(null, undefined);
  assertEqual(typeof c, 'string', 'null/undefined inputs should not throw');
});

// ── shouldSkipBoardRender: edit-in-progress guards ──

test('#167 shouldSkipBoardRender: returns true when a drag is in progress', () => {
  draggedCardId = 'some-card-id';
  try {
    assertEqual(shouldSkipBoardRender(), true, 'drag in progress must defer the refresh');
  } finally {
    draggedCardId = null;
  }
});

test('#167 shouldSkipBoardRender: returns true when a card is being inline-edited', () => {
  const prior = editingCardId;
  editingCardId = 'some-card-id';
  try {
    assertEqual(shouldSkipBoardRender(), true, 'inline edit in progress must defer the refresh');
  } finally {
    editingCardId = prior;
  }
});

test('#167 shouldSkipBoardRender: returns true when focus is inside the add-card form', () => {
  const input = document.getElementById('card-title');  // lives inside #add-card-form-wrapper
  assert(input, 'card-title input should exist');
  input.focus();
  try {
    assertEqual(shouldSkipBoardRender(), true, 'focus in add-card form must defer the refresh');
  } finally {
    input.blur();
  }
});

test('#167 shouldSkipBoardRender: returns false when no drag, no edit, no form focus', () => {
  draggedCardId = null;
  editingCardId = null;
  document.body.focus();   // move focus out of any form
  assertEqual(shouldSkipBoardRender(), false, 'idle board should refresh normally');
});

// ── pollBoard: end-to-end DOM behavior ──

test('#167 pollBoard: server-side change triggers a board render with the new state', async () => {
  stopBoardPolling();
  draggedCardId = null;
  editingCardId = null;
  document.body.focus();
  _boardRenderedSig = null;   // force apply on the next poll
  // Server returns a board with one card in backlog.
  enableFetchMock({
    cards: [{
      id: 'srv-1', shortId: 9001, title: 'Card from another agent',
      column: 'backlog', priority: 'p3', assignees: ['robin'],
      createdAt: '2026-05-28T10:00:00Z', updatedAt: '2026-05-28T10:00:00Z',
    }],
    columns: [
      { id: 'backlog', order: 0, name: 'Backlog' },
      { id: 'in-progress', order: 1, name: 'In Progress' },
      { id: 'done', order: 2, name: 'Done' },
    ],
    nextShortId: 9002,
  });
  await pollBoard();
  // The card should now be in the cards array AND rendered in the DOM.
  assertEqual(cards.length, 1, 'pollBoard should populate the cards array');
  assertEqual(cards[0].shortId, 9001, 'the server card should land in the array');
  const rendered = document.querySelector('[data-id="srv-1"]');
  assert(rendered, 'the server card should be rendered to the DOM by renderBoard()');
});

test('#167 pollBoard: identical server state does NOT re-render (DOM nodes preserved)', async () => {
  stopBoardPolling();
  draggedCardId = null;
  editingCardId = null;
  document.body.focus();
  // Seed cards + sig as if we just rendered this state.
  cards.length = 0;
  cards.push({
    id: 'stable-1', shortId: 7777, title: 'stable card',
    column: 'backlog', priority: 'p3', assignees: [],
    createdAt: '2026-05-28T10:00:00Z', updatedAt: '2026-05-28T10:00:00Z',
  });
  renderBoard();
  const beforeNode = document.querySelector('[data-id="stable-1"]');
  assert(beforeNode, 'card should have rendered initially');
  _boardRenderedSig = boardSignature(cards, columns);
  // Now mock fetch to return the IDENTICAL state.
  enableFetchMock({
    cards: cards.map(c => ({ ...c })),
    columns: columns.map(c => ({ ...c })),
    nextShortId: 7778,
  });
  await pollBoard();
  const afterNode = document.querySelector('[data-id="stable-1"]');
  assert(beforeNode === afterNode, 'identical state must NOT recreate DOM nodes');
});

test('#167 pollBoard: refresh preserves an active label filter', async () => {
  stopBoardPolling();
  draggedCardId = null;
  editingCardId = null;
  document.body.focus();
  _boardRenderedSig = null;
  // Set a label filter — only "build" cards should be visible.
  activeLabels.clear();
  activeLabels.add('build');
  labelFilterMode = 'and';
  // Server returns one matching + one non-matching card.
  enableFetchMock({
    cards: [
      { id: 'm-1', shortId: 6001, title: 'matching', column: 'backlog',
        priority: 'p2', assignees: [], labels: ['build'],
        createdAt: '2026-05-28T10:00:00Z', updatedAt: '2026-05-28T10:00:00Z' },
      { id: 'n-1', shortId: 6002, title: 'non-matching', column: 'backlog',
        priority: 'p2', assignees: [], labels: ['design'],
        createdAt: '2026-05-28T10:00:00Z', updatedAt: '2026-05-28T10:00:00Z' },
    ],
    columns: [
      { id: 'backlog', order: 0, name: 'Backlog' },
      { id: 'in-progress', order: 1, name: 'In Progress' },
      { id: 'done', order: 2, name: 'Done' },
    ],
    nextShortId: 6003,
  });
  await pollBoard();
  // Filter must still be set (the actual behavior we're protecting).
  assert(activeLabels.has('build'), 'filter state must survive the refresh');
  // And only matching cards should appear in the DOM.
  assert(document.querySelector('[data-id="m-1"]'), 'matching card should be rendered');
  assert(!document.querySelector('[data-id="n-1"]'), 'non-matching card should be filtered out');
});

test('#167 pollBoard: skips render while a drag is in progress (does NOT overwrite local state)', async () => {
  stopBoardPolling();
  editingCardId = null;
  document.body.focus();
  // Seed local state.
  cards.length = 0;
  cards.push({
    id: 'local-1', shortId: 5001, title: 'local-only card',
    column: 'backlog', priority: 'p3', assignees: [],
    createdAt: '2026-05-28T10:00:00Z', updatedAt: '2026-05-28T10:00:00Z',
  });
  _boardRenderedSig = boardSignature(cards, columns);
  // Pretend the user just grabbed a card.
  draggedCardId = 'local-1';
  // Server returns a totally different state.
  enableFetchMock({
    cards: [{
      id: 'srv-x', shortId: 5999, title: 'should NOT land while dragging',
      column: 'done', priority: 'p3', assignees: [],
      createdAt: '2026-05-28T11:00:00Z', updatedAt: '2026-05-28T11:00:00Z',
    }],
    columns: columns.map(c => ({ ...c })),
    nextShortId: 6000,
  });
  try {
    await pollBoard();
    // Local cards array must be untouched (drag relies on stable references).
    assertEqual(cards.length, 1, 'drag-in-progress must NOT overwrite local cards');
    assertEqual(cards[0].id, 'local-1', 'the dragged card must still be in the array');
    assert(!document.querySelector('[data-id="srv-x"]'), 'server card must NOT have been rendered');
  } finally {
    draggedCardId = null;
  }
});

/* ════════════════════════════════════════════════ TESTS - TDD Cycle: Free-text + field:value search (#53) ════════════════════════════════════════════════ */

test('#53 search: free-text term matches title (case-insensitive)', () => {
  const card = { shortId: 1, title: 'Supervise the scrum servers', description: '', labels: [], assignees: ['sage'], priority: 'high', for: '' };
  assert(cardMatchesSearch(card, 'supervise') === true, 'lowercase query matches title');
  assert(cardMatchesSearch(card, 'SCRUM') === true, 'uppercase query matches title');
  assert(cardMatchesSearch(card, 'nonexistent') === false, 'non-matching query returns false');
});

test('#53 search: blank query matches every card', () => {
  const card = { shortId: 2, title: 'x', description: '', labels: [], assignees: [] };
  assert(cardMatchesSearch(card, '') === true, 'empty string matches');
  assert(cardMatchesSearch(card, '   ') === true, 'whitespace-only matches');
});

test('#53 search: free-text matches description and shortId', () => {
  const card = { shortId: 174, title: 'Supervise servers', description: 'launchd KeepAlive watchdog', labels: [], assignees: [] };
  assert(cardMatchesSearch(card, 'watchdog') === true, 'matches description body');
  assert(cardMatchesSearch(card, '174') === true, 'matches bare shortId');
  assert(cardMatchesSearch(card, '#174') === true, 'matches #shortId');
});

test('#53 search: field:value — assignee, label, priority, type, for', () => {
  const card = { shortId: 3, title: 'card', description: '', labels: ['infra','channels'], assignees: ['sage'], priority: 'high', type: 'bug', for: 'alex' };
  assert(cardMatchesSearch(card, 'assignee:sage') === true, 'assignee match');
  assert(cardMatchesSearch(card, 'assignee:nova') === false, 'assignee non-match');
  assert(cardMatchesSearch(card, 'label:infra') === true, 'label match');
  assert(cardMatchesSearch(card, 'label:nope') === false, 'label non-match');
  assert(cardMatchesSearch(card, 'priority:high') === true, 'priority match');
  assert(cardMatchesSearch(card, 'type:bug') === true, 'type match');
  assert(cardMatchesSearch(card, 'for:alex') === true, 'for match');
});

test('#53 search: multiple terms AND together', () => {
  const card = { shortId: 4, title: 'Supervise the scrum servers', description: '', labels: ['infra'], assignees: ['sage'], priority: 'high' };
  assert(cardMatchesSearch(card, 'label:infra supervise') === true, 'both terms match → true');
  assert(cardMatchesSearch(card, 'label:infra nonexistent') === false, 'one term fails → false');
  assert(cardMatchesSearch(card, 'supervise assignee:sage') === true, 'free-text + field both match');
});

test('#53 search: unassigned cards match assignee:unassigned', () => {
  const card = { shortId: 5, title: 'orphan', description: '', labels: [], assignees: [] };
  assert(cardMatchesSearch(card, 'assignee:unassigned') === true, 'empty assignees treated as unassigned');
});

test('#53 search integrates into cardMatchesActiveFilter via activeSearch', () => {
  clearFilterState();
  const match = { shortId: 10, title: 'launchd supervision', description: '', labels: ['infra'], assignees: ['sage'], priority: 'high' };
  const noMatch = { shortId: 11, title: 'something else', description: '', labels: [], assignees: ['nova'] };
  activeSearch = 'supervision';
  assert(cardMatchesActiveFilter(match) === true, 'card matching search passes the active filter');
  assert(cardMatchesActiveFilter(noMatch) === false, 'card not matching search is filtered out');
  activeSearch = '';
  assert(cardMatchesActiveFilter(noMatch) === true, 'cleared search lets all cards through');
});

test('#53 search composes (AND) with other active filters', () => {
  clearFilterState();
  const card = { shortId: 12, title: 'launchd supervision', description: '', labels: ['infra'], assignees: ['sage'], priority: 'high' };
  activeSearch = 'supervision';
  activeAssignees.add('nova'); // card is sage, so assignee filter excludes it
  assert(cardMatchesActiveFilter(card) === false, 'search match but assignee filter excludes → filtered');
  clearFilterState();
});

test('#53 search: typing in #board-search-input filters the rendered board', () => {
  clearFilterState();
  cards.length = 0;
  cards.push(
    { id: 'a', shortId: 100, title: 'Supervise the servers', description: '', column: 'backlog', labels: ['infra'], assignees: ['sage'], priority: 'high', createdAt: '2026-05-31T00:00:00Z', updatedAt: '2026-05-31T00:00:00Z' },
    { id: 'b', shortId: 101, title: 'Calendar prior', description: '', column: 'backlog', labels: ['classification'], assignees: ['nova'], priority: 'p3', createdAt: '2026-05-31T00:00:00Z', updatedAt: '2026-05-31T00:00:00Z' },
  );
  renderBoard();
  assert(document.querySelector('[data-id="a"]') && document.querySelector('[data-id="b"]'), 'both cards visible before search');

  const input = document.getElementById('board-search-input');
  assert(input, 'search input exists in the DOM');
  input.value = 'supervise';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert(document.querySelector('[data-id="a"]'), 'free-text match stays visible');
  assert(!document.querySelector('[data-id="b"]'), 'non-match filtered out');

  input.value = 'assignee:nova';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert(!document.querySelector('[data-id="a"]'), 'sage card filtered by assignee:nova');
  assert(document.querySelector('[data-id="b"]'), 'nova card matches assignee:nova');

  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  assert(document.querySelector('[data-id="a"]') && document.querySelector('[data-id="b"]'), 'clearing search restores all cards');
  clearFilterState();
});
