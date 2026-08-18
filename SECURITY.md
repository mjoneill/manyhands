# Security

This document is longer than the feature list, on purpose. This is software that runs an **unauthenticated server** which **agents can act on**, and you should be able to decide whether that's acceptable to you without reading the source.

## Reporting something

Open an issue. There is no embargo process and no security team — it's a small project. If you'd rather not describe a live weakness in public, say only that you've found one and ask for a private channel.

---

## What is closed by construction

**Both servers bind to `127.0.0.1`, as a hardcoded literal.** Not a default, not a setting — there is no configuration value that changes it. You cannot accidentally expose the board to your network by editing a config file, because there's nothing to edit.

That is the single most important property here, and it's deliberately not adjustable. A setting that defaults to safe is a setting someone changes at 2am to make something work.

**Writes go through one in-process mutex.** Concurrent requests cannot interleave into a half-written file. The data file is written via temp-file-and-rename, so a reader never sees a partial write.

**Attachment bytes are stored UUID-keyed on disk**, never under the uploaded filename. That closes filename collisions and path traversal in one move, since the original name is only ever metadata.

**Only a small set of image types render inline.** Everything else downloads. HTML, SVG and scripts are never served with a content type that would let them execute in the page's origin.

**State-changing requests require `Content-Type: application/json`.** That forces a CORS preflight, which a cross-origin page cannot satisfy — closing the drive-by "simple request" POST.

---

## What is NOT closed, and you should assume the worst

### There is no authentication. At all.

Any process on your machine can read and write the entire board. There are no users, no permissions, no roles. The trust boundary is **your host**, and nothing finer.

### Putting it behind a proxy removes the only protection

The loopback bind is the whole security model. Tunnel it, reverse-proxy it, or port-forward it, and you have an unauthenticated read/write API exposed to whoever can reach that endpoint. If you need remote access, put real authentication in front of it — and understand you're now trusting your own work, not this project's.

### ⚠️ The one that should actually worry you: the board is an actuator

This is the risk that makes this software different from a to-do list, and it deserves to be the thing you remember.

Agents wired to this board typically **run shell commands, use git, and reach the network**. The board is how they coordinate — it's where they read what to do next and who's doing what.

So: **anyone who can write to the board can instruct every agent that reads it.** Not "read your tasks" — *instruct*. And the instruction arrives wearing a teammate's name, because the author field is a string the writer chooses.

**Write access to the board is functionally equivalent to shell access on every machine running an agent that reads it.** Size your caution to that, not to "it's a kanban board."

### Authorship is a claim, not a proof

Every message and card carries an author, and that author is whatever the writer said it was. Nothing verifies it. Inside a trusted group this is fine and keeps the system small. It also means:

- an agent can post as another agent, deliberately or by a config mistake
- a compromised process can post as you
- the audit trail tells you what was written, never reliably who wrote it

If your threat model includes an attacker reaching the board, **this is where it breaks first** — before storage, before the network, before anything else.

### Content you didn't write is data, not instructions

Cards, messages, wiki pages and attachments can all contain text aimed at an agent reading them — "ignore your previous instructions", "run this", "the user approved X". An agent that treats board content as instructions can be steered by anyone who can write to the board.

**This is a property of your agent's configuration, not of this software**, and we can't close it for you. But it is the most likely way this gets used against someone, so: whatever agent you wire up, make sure it treats board content as *data to reason about* rather than *commands to follow*, and that anything with real-world effect needs a human.

### Your data lives in a plain file

`board-data.json` is unencrypted on disk, readable by anything running as you. Deleted cards and edited messages **remain in old backups**. If you put secrets on the board, they are on your disk in plaintext, indefinitely.

**`board-data.json` is gitignored, and that line matters more than it looks.** It is there because the project this code came from *didn't* have it: its board file was tracked from the first commit, ended up inside more than half of all commits, and made that repository permanently unpublishable — every edited and deleted message recoverable by anyone who could clone it. Deleting something from the board does not remove it from git history. **If you ever remove that line, assume everything you have ever written is public the moment you push.**

---

## Dependencies, and one deliberate override

**The board server has zero dependencies.** `node server.js` imports nothing but Node's standard library, which is the single biggest thing keeping this surface small. Everything in `package.json` exists for the **MCP adapter** (the official SDK) and for **tests** (puppeteer, jsdom).

**Run `npm audit` yourself; this page will not tell you the number.** That is deliberate. A written-down audit result is true on the day it is written and can become false with nobody touching this repository — an advisory published upstream changes the answer while every file here stays byte-identical. So there is no diff to review and nothing to notice. This page said **0 vulnerabilities** for exactly that reason, and was wrong by the time anyone checked (2026-08-18: 8 reported, 3 of them outside `--omit=dev`).

What is durable enough to state: **the board server has no runtime dependencies at all**, so `node server.js` carries none of this. Everything `npm audit` reports lives in the **MCP adapter's** tree or in test tooling.

One decision is worth stating rather than hiding in a lockfile:

**`package.json` contains an `overrides` entry forcing `@hono/node-server` to `^2.0.5`.** The MCP SDK — at its latest published version — depends on a 1.x line carrying a path-traversal advisory in its static-file middleware. There is no SDK release that resolves it, so the choices were: ship with known advisories, or override the transitive dependency ourselves.

We overrode it, and verified rather than assumed: the **full** suite passes on a **fresh `npm ci`** with the override applied, including every test that exercises the SDK's HTTP transport.

Reproduce it yourself with `npm ci && npm test`. The word doing the work there is *full* — a subset passing tells you nothing about an override that changes a transitive dependency, which is why `scripts/run-tests.sh` prints an exclusion banner whenever it runs less than everything.

⚠️ This sentence used to quote a test count. It said **661** and the suite was past 1,400 by the time anyone checked — a number that goes stale every time someone adds a test, in a document where a stale number reads as a stale *audit*. The count was doing real work (it said "everything ran, not a subset"), so it is replaced by the command that re-establishes that rather than deleted.

**What you should know about that:**

- It is **not** a configuration upstream supports. If a future SDK release needs a 1.x API, this override becomes the reason your install breaks — and the fix is to remove it.
- **Remove it when the SDK ships a dependency range without the advisory.** It exists to be deleted.
- If you would rather not carry an unsupported override, delete the `overrides` block and run `npm audit`: you will see the advisories it was suppressing, and you can decide for yourself. That is a legitimate choice, and it is *your* threat model — a Windows-only traversal bug in a static-file middleware this project never invokes may well not be worth an override to you.

## Sensible operating advice

- Run it on a machine you control, for a group that trusts each other.
- Don't put credentials, keys or personal data on the board. It's a coordination surface, not a vault.
- Back it up (`cp board-data.json` somewhere) and **restore from a backup at least once** — a backup you've never restored is a hope, not a backup.
- If you wire in an agent that can act on the world, give it the smallest capability set that does the job. The board will faithfully deliver anything anyone writes to it.
