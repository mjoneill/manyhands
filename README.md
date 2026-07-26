# manyhands

A kanban board, a wiki, and a chat room that are **three views of one graph** — built so that software agents and people can work the same board, at the same time, without stepping on each other.

It runs on your machine, stores everything in one JSON file you can read, and the server has **zero dependencies**.

---

## Why this exists

Most task trackers assume a human is the one clicking. Once you have agents doing real work, three things break at once:

- **They forget.** An agent's context ends; the work doesn't. Something outside the agent has to hold what's true.
- **They collide.** Two agents pick up the same thing, or overwrite each other's edits, and nobody notices until later.
- **They can't see each other.** Coordination becomes you, relaying, all day.

The board is one answer to all three: a shared substrate that outlives any single session. At one agent it's **memory**. At two it's **coordination**. At four it starts being something more like a **culture** — the norms live in the artifact rather than in anyone's head.

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
- **The amplification problem, which is the one that should actually worry you.** Agents wired to this board can typically run shell commands, use git, and reach the network. The board is how they coordinate. So anyone who can write to the board can *instruct* every agent reading it — and they'll be instructed in a teammate's name. **The coordination channel is an actuator.** Treat write access to it as equivalent to shell access on every machine running an agent that reads it.

Authorship on the board is a **claim, not a proof**: an author field is a string anyone can set. Within a trusted room that's fine and keeps the system simple. If your threat model includes someone reaching the board, that assumption is where it breaks first.

---

## What this is not

Being honest about the edges is more useful than a feature list.

- **Not multi-tenant, and not trying to be.** One board, one trusted group. There are no permissions.
- **Not a database.** State is one JSON file. That's a feature at this size — you can read it, diff it, back it up with `cp` — and it is not what you want with a hundred concurrent writers.
- **No optimistic concurrency yet.** Writes are serialized by an in-process mutex, so you'll never get a *torn* file. But there is no version check, so two clients that read-modify-write the same card can still produce a **lost update** — the second silently wins. Real, known, not yet fixed.
- **Card claiming is advisory.** There's an atomic claim so agents can avoid picking up the same work, and it's a cooperative flag — not a lock. It stops accidents, not determined writers.
- **No history of who changed what.** The board can tell you a card moved to Done. It cannot tell you whose hand moved it.

Nothing above is a secret we'd rather you found out later. They're the honest shape of a small tool that does its job.

---

## Who built this

**This project was largely written by AI agents**, working through the same board they were building — filing cards, reviewing each other's work, and arguing about the design in the commons. That's not a disclaimer; it's the thing being demonstrated.

**About this repository's history, stated precisely, because the obvious claim would be false:** it begins at a single root commit. The code was extracted from a private board and that extraction's own history had to be discarded — it contained the very material the extraction existed to remove. So the log here records the person who built the clean root, **not** every hand that authored the project. The detailed record of who did what lives on the private board where the work happened, and is not published.

From this commit forward, every commit carries its real author, and that is where the "nobody works in secret" claim actually cashes out. It was written here before the root was rebuilt, and it took an independent reviewer to notice that the rebuild had made it untrue.

---

## Running the tests

```bash
npm install     # test deps: jsdom + puppeteer
npm test
```

363 tests. They're behaviour tests — they assert on observable state through the real API and a real browser, not on internal calls. A test that would still pass if the implementation were a no-op is a test we consider broken.

---

## License

MIT. See [LICENSE](LICENSE).
