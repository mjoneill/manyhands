Research a video, so that what you learn survives you.

The point is not a summary. It is that a later reader can find what was learned,
see what it rests on, and check it without asking you.

1. IDENTIFY — before capturing anything.
   oEmbed needs no login and gives title and channel. `yt-dlp --print` gives
   upload date, duration and description. Read the description: a paper, repo or
   docs link named there is a CONFIRMED source. A topic you searched for is a
   candidate, and the difference matters when you cite it later.

2. CAPTURE — archive the raw bytes BEFORE reading them.
   `yt-dlp --write-auto-sub --sub-lang en --skip-download` into
   research/YYYY-MM-DD-slug.en.vtt, then dedupe into
   research/YYYY-MM-DD-slug-transcript.md. Archive first: a source that becomes
   unavailable after you have read it leaves a claim you cannot re-check.

   ⛔ WHEN THE CAPTURE FAILS, READ THE FAILURE PRECISELY.
   A 429 is ONE endpoint refusing. Metadata calls keep working, so read the
   lines above the error before concluding the source is gone.
   And a refusal can arrive dressed as success: measured 2026-09-05, the caption
   track was DECLARED (one English auto track) while every format returned
   HTTP 200 with ZERO BYTES, and the player's own transcript panel rendered
   empty. That is byte-identical to "this video has no captions" unless you
   check the track list first. So: ask what tracks EXIST, then ask for content.
   If tracks exist and content is empty, say the source is being withheld —
   never that it is absent.
   A second client on the same address is not an independent instrument. Two
   clients agreeing tells you about the address, not about the source.

3. VERIFY — a video is evidence ABOUT a thing, never the thing.
   Check every technical claim against a PRIMARY source: the changelog, the
   docs, the paper, the binary. Name the source per claim in a table. Expect to
   find the video wrong somewhere; if you find nothing wrong, ask whether you
   checked or agreed.

4. DISCUSS — two readers, or it is one datum.
   Bring it to the room on the card's thread. Two seats reading the same
   summary is not two instruments. Different evidence, or say plainly that it
   is one.

5. NOTES — research/YYYY-MM-DD-slug-notes.md.
   State the SCOPE OF THE READ first: what you watched, what you skipped, what
   you could not verify. Then what it means for us. List candidate cards; do
   not file them yet.

6. DURABILITY — nothing closes without this step.
   Anything that informs what we are doing becomes a card or a durable artifact
   we actually use, derivedFrom the research card. A finding that lives only in
   a conversation is context-window exhaust. Give each recommendation an
   explicit verdict: ADOPT with a card number, ALREADY DO with the mechanism
   that proves it, or REJECT with one line of why. A rejected recommendation is
   evidence, not absence — record it so nobody re-derives it.

7. RECORD — the run, not the card, is the research record.
   run_create naming the source and the procedure VERSION you followed,
   artifact_add for each file as pointer + hash (never payload), run_generated
   for the cards and threads it produced. Then "what has this room researched"
   is one query, and it needs no filename and no card number.

A note on the shape of this document: it is one text with two homes. It is a
ProcedureVersion in the graph and a loadable skill on disk, and the file is
GENERATED from the version rather than copied. If the two ever differ, the
generator is broken — not the text.
