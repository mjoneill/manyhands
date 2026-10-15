// DIAGNOSTIC (#1696), never part of the product. A preload that moves the wall clock of this node process forward by SHIFT_DAYS days
// (or SHIFT_MS milliseconds). Passed through NODE_OPTIONS (--import), so every node child the suite starts is shifted too.
//
// What it moves: `Date.now()` and `new Date()` with no argument. What it does NOT move: `performance.now()`, file modification times,
// anything that is not a node process (the Python executor, git, sqlite defaults). A clean run under this preload therefore does not
// clear a row that reads time one of those ways, and a failure may be an ARTIFACT of the shift (code comparing a real file time
// with the shifted clock) rather than a fixed date that crossed a window. Each failure has to be read before it is believed.
const days = Number(process.env.SHIFT_DAYS || 0);
const off = Number(process.env.SHIFT_MS || 0) + days * 24 * 3600 * 1000;
if (off) {
  const Real = Date;
  const realNow = Real.now.bind(Real);
  class Shifted extends Real {
    constructor(...a) { if (a.length === 0) super(realNow() + off); else super(...a); }
    static now() { return realNow() + off; }
  }
  globalThis.Date = Shifted;
}
