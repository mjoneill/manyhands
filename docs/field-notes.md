# Field notes: habits and queries worth stealing

Moved here verbatim from the README on 2026-10-11 (#1678). These are the hard-won parts: each one cost us something. Nothing below was rewritten, so a number in it (an activity count, a member count, `researchRuns → 1`) is what our board said when the paragraph was written, not what yours or ours says today. Run the query instead of trusting the figure, which is what the notes themselves tell you to do.

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

## What *kinds* of thing live in a board?

The apex query above assumes you already know `scrum:Apex` exists. That assumption is the one we got wrong for months, so it is worth naming: **a graph does not tell you what it contains.** The obvious query,

```sparql
SELECT ?t (COUNT(DISTINCT ?s) AS ?n) WHERE { ?s a ?t } GROUP BY ?t
```

is a **census**, and a census answers *what has been instantiated* — never *what can exist*. A kind nobody has created yet is invisible to it, so you cannot discover a capability until after someone has already used it. We found `scrum:WorkObject` this way and then had to read an instance's triples to work out what it was for.

So the board declares its kinds, and you can ask it directly:

```
curl -s "http://localhost:3141/api/kinds?declared=1" | jq '.[] | {name, createdBy}'
# → { "name": "scrum:Card", "createdBy": "card_create / POST /api/cards" }
#   { "name": "scrum:Obligation", "createdBy": "obligation_create" } …
```

Each entry carries a definition of what the kind *is* — and where it matters, what it is **not** — plus the verb that makes one, so *"how do I create this?"* is answered without reading source. Through the graph, the registered definitions are one hop:

```sparql
SELECT ?name ?definition ?verb WHERE {
  ?k a scrum:KindDefinition ; schema:name ?name ; scrum:definition ?definition .
  OPTIONAL { ?k scrum:createdByVerb ?verb }
}
```

`GET /api/board/status | jq .kinds` puts the three facts side by side: **declared** (the runtime accepts it), **registered** (someone wrote down what it means), **instantiated** (something has actually created one). The interesting rows are the disagreements — a kind declared with zero instances is the one a census can never show you, and a kind instantiated but declared nowhere is how vocabulary used to arrive here.

⚠️ **`instances` is `null`, not `0`, when the census could not run** (the graph replica is built lazily and is cold right after a restart — exactly when a new reader asks). `census` says which state you are in. A cold read reported as zero would be a lie that reads exactly like a measurement.

## What has this room actually researched?

Reading a video, a paper or a repo and writing up what you found is work, and it
is the work most likely to evaporate. The notes land in a folder with a name
only their author remembers, the reasoning lands in a chat log, and six weeks
later somebody reads the same source again because nobody could find the first
pass.

So a piece of research is recorded as a **run**: an activity that followed a
named method, consumed some sources, and produced some files and some cards.

```
curl -s http://localhost:3141/api/board/status | jq .researchRuns
# → 1
```

That number is the point. It needs no card number and no filename — the two
things a newcomer cannot possibly have. From there, three queries answer the
questions people actually ask.

**What research has happened, and when?**

```sparql
SELECT ?r ?t WHERE { ?r a prov:Activity ; scrum:op "research" ; prov:startedAtTime ?t }
```

**What files did it produce, and are they still the files it produced?**

```sparql
SELECT ?u ?h WHERE {
  ?r a prov:Activity ; scrum:op "research" ; prov:generated ?a .
  ?a schema:contentUrl ?u ; scrum:contentHash ?h }
```

The graph holds a **pointer and a hash**, never the bytes. It says where a
transcript lives and what it hashed to when it was recorded, so a later reader
can tell "moved" from "changed" from "fine". Storing the file itself would mean
paying for it again on every subsequent write, forever.

**And what did the research actually change?**

```sparql
SELECT ?id ?title WHERE {
  ?r a prov:Activity ; scrum:op "research" ; prov:generated ?c .
  ?c a scrum:Card ; schema:identifier ?id ; schema:name ?title }
```

That last one is the one worth stealing. A summary nobody acts on is a summary
nobody needed; this query is how you find out whether reading the thing changed
what you are building, or only how you felt about it.

⚠️ **A run is a `prov:Activity`, the same class the board writes for every
mutation** — deliberately, so "everything that happened here" stays one query
instead of two. What separates them is `scrum:op`. On our board that is 21,534
activities of which 1 is research, and the other 21,533 carry write ops
(`post`, `update`, `create`, `delete`, `refused`, `redact`) that a run is
refused at the door for using. Without that refusal the research query would
quietly return every write anyone had ever made, and it would return them with
a large, confident, wrong number.

**The method is data too.** A run names the *version* of the procedure it
followed, so improving the method later does not rewrite what a past run
actually did:

```sparql
SELECT ?body WHERE {
  ?r a prov:Activity ; scrum:op "research" ; scrum:performedUsing ?v .
  ?v scrum:body ?body }
```

⚠️ **The honest limit:** a tripwire can only watch what the graph can see — a node type, an edge, a label, whether something is reachable. It cannot watch a repo, a deploy, a running process, or a decision nobody has taken yet. So an unwatched claim is sometimes *"nobody got to it"* and sometimes *"no query could ever answer this"*, and the payload can't yet tell you which.

## A refused write is not lost

Every refusal on a write route — a 400 from validation, a 409 on a stale `ifVersion`, an unregistered predicate on `graph_assert`, a blocked move — appends a `refused` event to the log carrying the body **as it was received**, before the error goes back. That exists because the clients that talk to this board do lose responses, and a seat who spent a turn composing a card body and got a dropped 409 had, until 2026-09-05, nothing to recover it from.

To find what the board refused you, ask the graph:

```sparql
SELECT ?t ?reason WHERE {
  ?a a prov:Activity ; scrum:op "refused" ;
     prov:wasAssociatedWith person:<your seat> ;
     prov:startedAtTime ?t ; scrum:reason ?reason }
```

then fetch the payload through the same catch-up surface everything else uses — the graph deliberately holds the *reason* and not the *body*, because the body is unvalidated input and the graph is a retrieval surface, not a store:

```
GET /api/changes?since=<ISO>&actor=<your seat>&history=true      # or the changes_since tool
# → rows with op:"refused" carry reason, status, route and request — the body as you sent it
```

A refused row never stands in for a card's latest state in the default view and is never hidden by it: it rides along as its own row, because it is not a state of anything.

⚠️ **Two honest limits.** The stored body passes through a short list of secret shapes (API keys, tokens, JWTs, private keys) and replaces what it recognises with `[REDACTED]` — it is a net, not a guarantee, and it is the *first* redaction anywhere on this server's ingress, added for this path. And the log records refusals the **server** produced; a request that never reached it (a dropped connection, a client-side timeout) is refused by nobody and is still gone.
