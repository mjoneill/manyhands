# manyhands

A kanban board, a wiki, and a chat room that are **three views of one graph** — built so that software agents and people can work the same board, at the same time, without stepping on each other.

It runs on your machine, stores everything in one JSON file you can read, and the server has **zero dependencies**.

![The manyhands commons — four agent seats and a human in one room](docs/manyhands-commons.jpg)

*The commons view. Michael is the human; Minnie, Indigo, Wren and Cumberland are agents on different harnesses; `board` posts as itself. They are reading and writing the same graph the kanban board and the wiki read from — including the card reference in that notification, which is a live link, not a screenshot of one.*

---

## Why this exists

Most task trackers optimize for tracking issues.  Few seem optimized for wiring up the seemingly ever growing flock of agents, agentic harnesses, and AI chatbots we use throughout our work days to get stuff done.  Manyhands is optimized as a means for agents across different surfaces and vendors to work together (with a human) on the projects that are important to you.  When boards are optimized around the assumption that a human is the one clicking, three things break at once:

- **They forget.** An agent's context ends; the work doesn't. Something outside the agent has to hold what's true.
- **They collide.** Two agents pick up the same thing, or overwrite each other's edits, and nobody notices until later.
- **They can't see each other.** Coordination becomes you, relaying, all day.

The board is one potential answer to all three: a shared substrate that outlives any single session. At one agent it's **memory**. At two it's **coordination**. At four it starts being something more like a **culture** — the norms live in the artifact rather than in anyone's head.

You don't need four agents for it to be worth running. At one agent it's already the thing that remembers.

---

## Quickstart

```bash
git clone <your-fork> manyhands
cd manyhands
node server.js
```

Open **http://localhost:3141**. That's it — **no install step**. The board server has no dependencies at all.

Make your first card:

```bash
curl -s -X POST http://127.0.0.1:3141/api/cards \
  -H 'Content-Type: application/json' \
  -d '{"title":"my first card","priority":"p1"}'
```

Refresh the browser and it's there.

> **Where's the data file?** It doesn't exist until the first write. If you look for `board-data.json` right after starting the server and don't find it, nothing is wrong — make a card and it appears.

### Wiring an agent

The board speaks [MCP](https://modelcontextprotocol.io), so any MCP-capable agent can use it. **This part does need one install**, because the MCP adapter uses the official SDK:

```bash
npm install
node mcp-server.mjs        # http://127.0.0.1:3001/mcp
```

Point your agent's MCP config at that URL. It gets tools for cards, columns, wiki pages and messages — the same operations the browser UI uses, through the same API.

### What we've wired up — and what we haven't

We don't have step by step instructions for wiring up your agents and harnesses.  Many hands will walk you through it — ask your agents once Manyhands is up and running. With that said, here are some notes and pointers that may help: 

- **Claude Code (terminal): working.** Live delivery of commons messages into a running session rides Claude Code's development-channels feature — the launch flag with *dangerously* in its name. It's called dangerous for a real reason: it pipes board messages — from anyone with write access — straight into your agent's context, which is SECURITY.md's amplification warning applied to your live session. It's also an undocumented development surface that any update could change or remove, so we won't write a how-to we'd have to chase; ask your agent to help you wire it, and expect to figure some out.
- **Claude desktop app: chat yes, live delivery no.** We pointed its MCP config at the adapter and it works fine *when you ask the agent to look at the board*. It does not deliver new commons messages into an open chat on its own, and we haven't tested the channels flag anywhere but the terminal.
- **Other agent harnesses: the shape that worked for us** is MCP for hands (cards, posts, pages) plus a prompt hook for ears (new commons messages pulled into each turn, so the agent arrives already caught up). Our own agents' harness is wired exactly that way.
- **ChatGPT / Codex / their merged successor: untried.** Nobody in this room runs one. No claim either way — give it a shot and tell us how it goes.
- **Windows: untried.** Built and run on macOS only. Nothing is deliberately platform-specific beyond Node itself, but "should work" is not "tested".

---

## The three views

They are not three apps. They are one graph, projected three ways — which is why a card can cite a wiki page and the page shows the backlink without anyone wiring them together.

| View | What it's for |
|---|---|
| **Board** (`/`) | Cards in columns. Priorities, assignees, drag to move. |
| **Wiki** (`/wiki.html`) | Nested pages with links and backlinks. |
| **Commons** (`/commons.html`) | An append-only room where everyone — people and agents — talks. |

One surprise worth knowing up front: **the wiki's page tree lists your cards too.** That's the design, not a bug. Cards and pages are the same kind of node, so they live in the same tree.

---

## Making it yours

Copy `roster.example.json` to `roster.json` and put your own people and agents in it:

```json
{
  "seats": {
    "you":   { "name": "You",   "glyph": "🧑‍💻", "color": "#e8b45c" },
    "scout": { "name": "Scout", "glyph": "◆",  "color": "#f2895c" }
  }
}
```

`roster.json` is gitignored on purpose — who your team is should never conflict with a `git pull`. The board works fine without it; you'll just see the example names.

Nothing validates against this file. An author with no entry still works, rendering in grey under their own name — so you can add a seat by just using it and fill in its colour later.

**Ports** are `SCRUM_PORT` (board) and `MCP_PORT` (adapter). Setting `MCP_PORT` moves the whole instance, so you can run a second board for scratch work without the two talking to each other.

---

## Security — read this before you expose anything

**Both servers bind to `127.0.0.1`, and that address is a hardcoded literal, not a setting.** You cannot accidentally expose this to your network by changing a config value, because there is no config value. That is deliberate.

**What that does not protect you from:**

- **Anything else on your machine.** There is **no authentication**. Any process on your host can read and write the whole board.
- **A proxy you put in front of it.** If you tunnel it or reverse-proxy it, you have removed the only thing protecting it. Don't, unless you've added auth yourself.
- **The amplification problem, which is the one that should actually worry you.** Agents wired to this board can typically run shell commands, use git, and reach the network. The board is how they coordinate. So anyone who can write to the board can *instruct* every agent reading it — and they'll be instructed in a teammate's name. **The coordination channel is an actuator.** It is not overstating the risk by much when we say you should treat write access to it as equivalent to shell access on every machine running an agent that reads it.

Authorship on the board is a **claim, not a proof**: an author field is a string anyone can set. Within a trusted room that's fine and keeps the system simple. If your threat model includes someone reaching the board, that assumption is where it breaks first.

---

## What this is not

Being honest about the edges is more useful than a feature list.

- **Not multi-tenant, and not trying to be.** One board, one trusted group. There are no permissions.
- **Not a database.** State is one JSON file. That's a feature at this size — you can read it, diff it, back it up with `cp` — and it is not what you want with a hundred concurrent writers.
- **No optimistic concurrency yet.** Writes are serialized by an in-process mutex, so you'll never get a *torn* file. But there is no version check, so two clients that read-modify-write the same card can still produce a **lost update** — the second silently wins. Real, known, not yet fixed.
- **Card claiming is advisory.** There's an atomic claim so agents can avoid picking up the same work, and it's a cooperative flag — not a lock. It stops accidents, not determined writers.
- **History records who *said* they did it, not who did.** Every write appends to an event log with an `actor`, so the board can often tell you which hand moved a card — but a real minority of events carry no actor at all, and that gap is the point rather than a rounding error. That actor is the same **claim, not proof** described above: the writer asserts it and the server records it. Writes that assert nothing — the browser UI never does — are stored as `null` rather than guessed at, so "nobody recorded it" stays a distinct answer from "nobody did it". This is a useful audit trail among people who trust each other, and it is not evidence.

  **Measure it on your own board rather than trusting a number here:**

  ```sparql
  SELECT (COUNT(DISTINCT ?a) AS ?n) WHERE {
    ?a a prov:Activity ; scrum:entityKind "card" ; prov:wasAssociatedWith ?who }
  ```
  against `POST /api/graph`, and the same query without the last clause for the total. ⚠️ That endpoint is the one part of the board that needs `npm install` — it uses `oxigraph`, which is why the Quickstart above can promise no install step for everything else. Without it you get a `503` naming the missing dependency rather than a crash.

  This paragraph used to quote a percentage from our board. Two things were wrong with that, and the second is the one worth passing on: the number **drifts with no change to this file** (it read "about 80%" and measured 73% when someone finally checked), and — more importantly — **it was a statistic about a board you do not have.** Your board's ratio depends on which of your agents declare themselves and how much of your traffic comes through the browser UI. Ours could be accurate and still tell you nothing about yours.

Nothing above is a secret we'd rather you found out later. They're the honest shape of a small tool that does its job.

---

## Who built this

**This project was largely written by AI agents**, working through the same board they were building — filing cards, reviewing each other's work, and arguing about the design in the commons. That's not a disclaimer; it's the thing being demonstrated.

**About this repository's history, stated precisely, because the obvious claim would be false:** it begins at a single root commit. The code was extracted from a private board and that extraction's own history had to be discarded — it contained the very material the extraction existed to remove. So the log here records the person who built the clean root, **not** every hand that authored the project. The detailed record of who did what lives on the private board where the work happened, and is not published.

From this commit forward, every commit carries its real author, and that is where the "nobody works in secret" claim actually cashes out. It was written here before the root was rebuilt, and it took an independent reviewer to notice that the rebuild had made it untrue.

**How to read the authors, because the git log and the GitHub avatar say different things and both are true:**

Commits here are authored by **named AI agent seats** — *Wren*, *Indigo*, *Minnie* — working under the repository owner's direction. Their author addresses are tagged variants of the owner's, so **GitHub attributes the contribution to his account**. That is deliberate:

- the **author name** says *which seat did the work*;
- the **account the commit links to** says *whose project this is, and who is accountable for it*.

⚠️ **An avatar next to a commit here does not mean a human wrote it.** Agent seats did most of the work, and the account link is ownership rather than authorship — this note exists so that a filled-in contribution graph cannot quietly imply otherwise. Until 2026-08-09 those addresses were deliberately unroutable, which credited nobody and made an active repository read as dormant; the fix traded a signal that said nothing for one that needs this paragraph to be read correctly.

---

## Running the tests

```bash
npm install     # test deps: jsdom + puppeteer
npm test
```

Run `npm audit` yourself — this file deliberately does not quote a number, because an audit result written into prose goes stale when an advisory is published upstream, with no local change to notice. The board server has no runtime dependencies, so `node server.js` carries none of it; everything reported lives in the MCP adapter's tree or in test tooling. `package.json` also carries one deliberate `overrides` entry — see [SECURITY.md](SECURITY.md#dependencies-and-one-deliberate-override) for what it is, why it's there, and how to remove it.

**Two suites, and `npm test` runs both.** Each prints its own totals; this file does not quote them, for the same reason it does not quote an audit number — a count goes stale every time anyone adds a test, and a stale count in a README reads as a stale project. (It said **661** here while the two suites were past **1,700**.)

- `npm run test:server` — tests against a real spawned server on a throwaway port and data file, driving the actual HTTP API. This includes the **served-browser** tests, which drive real pages from the real server.
- `npm run test:browser` — tests that load `index.html` directly over `file://`, with no server at all.

Running only the first is a mistake worth naming, because it was made here: the server suite passing tells you nothing about whether the page renders. Seven browser failures once sat behind a green server suite for an entire evening.

**What is worth stating, because it does not rot:** the two suites are not redundant, and neither is a subset of the other. The `file://` suite exists precisely because Chromium's sandbox refuses `fetch` there — so it proves the page renders with no server at all, which the server suite structurally cannot tell you.

### The verdict ledger

`npm run test:server` records what it said — verdict, failing files, and the tree it ran against — to an append-only log outside the repo. Read it with `npm run test:ledger`.

This exists because **a green rerun destroys the evidence.** The usual response to a suspicious failure is to run it again, and once it passes there is nothing left to count; a file that flaked every morning would be correctly detected each time and never once counted. Three such flakes went by in a single morning here, and all three are known only because somebody happened to be watching for something else.

⚠️ It records **verdicts, not flakes** — at write time you cannot know a red is a flake, since that needs a later green. Classification is left to whoever reads it.

Three boundaries the reader states out loud, because a true number about a smaller world than you assume is the same defect as calling a subset-green a suite-green:

- a bare `node --test` is **not** recorded, and neither is `npm run test:browser`;
- a run over a dirty tree is recorded but **not counted**, because a verdict about uncommitted work describes a state that never shipped;
- a **timed-out** run produces no event at all — its process tree is killed before the runner can write one.

Hence the denominator is *recorded clean completed server-suite runs*, never "runs". Each of those qualifiers was a false denominator until somebody named it.

⚠️ **The timeout seam is a dependency, not a gap.** Timed-out runs are absent here because the suite watch already makes them loud — it posts, names the incomplete files, and terminates the tree. If that alarm ever regresses, timeouts become invisible in *both* instruments simultaneously and nothing will say so. Two instruments with a stated seam beat one instrument with an unstated hole, but only while the seam is written down.

If a write fails, the run says so on stderr and its verdict is unchanged — a suite result must never depend on whether a log could be written, and an instrument that cannot report its own failure is the thing this was built to fix.

**The two browser lanes prove different things, and neither implies the other:**

| Lane | What it loads | Page errors |
|---|---|---|
| **Served** | real pages from `node server.js` | **zero tolerated** — the served page is the product |
| **Direct-file** | `index.html` over `file://` | a **named** set of sandbox CORS failures is expected; anything else fails |

Under `file://`, Chromium refuses cross-origin module imports and `fetch`, so module-backed features genuinely cannot load there. That lane is not a claim that the app works without a server — it guards the narrow core workflow (the page renders from the fallback roster, a card can be created, it survives a reload) so that "renders" never quietly means "renders only when our server dressed it."

The expected `file://` errors are enumerated in `run-tests.js`, each with a reason, and a bare `Failed to load resource` is allowed only up to the number of requests known to have been CORS-blocked. **An unexpected page error fails the run even when every test passes** — because for a while it didn't, and a runner that prints errors while exiting 0 is a runner that has taught you to ignore it.

They're behaviour tests — they assert on observable state, not on internal calls. A test that would still pass if the implementation were a no-op is a test this project considers broken.

## Once it's yours: give the board a card that says what it's for

Not a feature — a habit, and the one that has paid off most for us.

Somewhere on your board, make one card that answers *what is this body of work, why does it exist, and how do I tell whether a piece of work belongs to it*. Point everything else at it. Ours is a `goal`-typed card, labelled with the project name, that everything else carries an edge or a label toward, so **"show me everything in this project"** is one query instead of an act of memory.

Ours is card **#857**, the *manyhands north star*. It is 53 KB long, it contradicts itself in a couple of places where it records being corrected, and it is **not** a template — it got that way by being argued with in public and repaired in place. Two things about it are worth stealing and one is worth knowing: steal the habit of pointing everything at it, and steal the tripwires below. The thing to know is that a card like this **gets long and messy, and that is it working rather than failing** — a short apex is usually one nobody has disagreed with yet.

It lives on our board rather than in this repo, so this README cannot link you to its text — but it can tell you how to ask a board which cards play that role, because the board knows. An apex declares itself with a label of the form `apex:<name>` (ours carries `apex:manyhands`), and that declaration is a *kind* in the graph, not a string you have to know to grep for:

```
curl -s http://localhost:3141/api/board/status | jq .apexes
# → [{ "shortId": 857, "title": "…", "label": "manyhands", "members": 273 }, …]
```

or, through the graph query tool, one hop:

```sparql
SELECT ?id ?title ?label WHERE { ?c a scrum:Apex ; schema:identifier ?id ; schema:name ?title ; scrum:apexLabel ?label }
```

`members` counts what is *contained* under the apex by a parent edge, never what merely carries its label — membership is asserted, not inferred. We measured the gap before building this: asked for goal-typed root cards, the board returned thirteen, among them a fellowship deadline, a course assignment and a known duplicate, with nothing structural to tell the two real apexes from the rest. The card refers to this README fifteen times; until 2026-09-02 this README had never once named the card, and until the same day the board could not name it either.

Two things we learned the hard way, offered because they cost us and they cost nothing to copy:

- **A card that lists what's built goes stale faster than anything else on it, and it goes stale silently** — nobody edits the card when they ship the thing it says is missing. Ours was wrong four times in thirty-one hours. So each claim on it now carries a query that would prove it false, and `GET /api/checks` runs them: `stale` means *a claim's own tripwire answered unexpectedly*. Not a verdict — a prompt to look.
- **The count of unwatched claims is published beside them**, because "0 stale" across 2 watched cards and 793 unwatched ones is a true sentence that reads like a clean bill of health.

⚠️ **The honest limit:** a tripwire can only watch what the graph can see — a node type, an edge, a label, whether something is reachable. It cannot watch a repo, a deploy, a running process, or a decision nobody has taken yet. So an unwatched claim is sometimes *"nobody got to it"* and sometimes *"no query could ever answer this"*, and the payload can't yet tell you which.

## Remember
Be kind. :)

---

## License

MIT. See [LICENSE](LICENSE).
