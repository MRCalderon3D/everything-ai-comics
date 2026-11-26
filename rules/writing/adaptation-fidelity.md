# Adaptation fidelity

## Purpose

Keep three things apart when prose becomes a comic: what the source says,
what the user changed, and what the adaptation added. Without that
separation, a user's change reaches the dialogue and misses the costume, and
an agent's invention gets quoted back later as if the author wrote it.

## Scope

Writing layer. Governs the fact registry in `story/story-bible.yaml`, the
source spans in `story/series-plan.yaml` and `issue.yaml`, and every script
decision that compresses, cuts, merges, reorders, or adds to the source.
Applies to original stories as well: there, the user's brief is the source.

## Core Principles

- Every canon fact carries one provenance tag: `source`, `user_change`, or
  `addition`.
- A user change outranks the source fact it replaces, everywhere.
- A change is finished when every artifact that depends on the fact has
  changed with it: wardrobe, dialogue, references, and prompts together.
- Every adaptation edit can be traced back to a place in the source.
- An addition is labelled as one until the user accepts it.

## Provenance tags

- `source`: stated in the source text. The fact carries a `source_ref`
  pointing at the passage (`story/source/night-ferry.txt#p2`).
- `user_change`: an explicit instruction from the user that departs from the
  source. The fact names the fact it supersedes in `replaces`.
- `addition`: something neither the source nor the user stated, proposed by
  the adaptation to make a page work: a line of dialogue, a design detail, a
  connecting action.
- A fact with unclear provenance is tagged `addition`. Inference from the
  source is still inference. NEVER tag a guess as `source`.
- The source text itself is stored unmodified under `story/source/`.

## Propagating a user change

When the user changes a fact, the agent MUST:

1. Record the change as a `user_change` fact with `replaces` set, and list
   every entity it touches in `affects`.
2. Walk the `affects` list and update each bible: description,
   `distinguishing_features`, `prompt_summary`, wardrobe outfits.
3. Supersede every approved master that shows the old fact, and regenerate
   it (`common/approval-policy.md`).
4. Search the page files for the old fact: ledger rows, wardrobe IDs, state
   tags, and lettering text that mentions it.
5. Rebuild the reference plans and recompile the prompts of every affected
   page.
6. Report the pages whose existing renders still show the old fact. They
   need a new version.

In the sample story, suppose the source puts Mara in a company uniform and
the user asks for a torn oilskin coat instead. The change touches
`CHAR_MARA`, creates `WARD_MARA_OILSKIN`, supersedes her turnaround sheet,
rewrites any line where someone mentions the uniform, and makes every prompt
compiled before the change stale. Stopping after the wardrobe file leaves a
character sheet and a set of prompts that still draw the uniform.

## Traceable adaptation edits

- Each issue records the passage it adapts in `source_span`, in both the
  series plan and `issue.yaml`.
- Compression, merged characters, cut scenes, and reordered events are
  adaptation decisions. Each is recorded where it happens, in the scene or
  page `notes`, with the source passage it departs from.
- Dialogue taken from the source keeps the author's wording as far as the
  balloon budget allows (`dialogue-economy.md`). A shortened line is still a
  `source` line. A new line is an `addition`.
- A cut MUST NOT remove the setup of something the adaptation keeps
  (`narrative-continuity.md`).
- Changes the adaptation makes for the medium (showing a handoff the prose
  only implies, splitting one sentence across three panels) are expected.
  They are recorded, and they do not contradict a `source` or `user_change`
  fact.

## Additions

- Additions are kept few. Before proposing one, check whether the source
  already answers the question.
- A story-critical addition is asked about before generation. A minor one is
  recorded and stays provisional (`common/ask-dont-assume.md`).
- When the user accepts an addition, it stays tagged `addition`. Acceptance
  makes it canon. It does not make it something the author wrote.

## Validation

- `story-bible.schema.json` requires `provenance` on every fact and restricts
  it to the three tags.
- `scripts/validate-workspace.js` schema-checks the bible and resolves the
  IDs it cites.
- Prompt packages record `source_hashes`, so a package compiled before a page
  or reference plan changed can be identified as stale.
- No script can tell whether a change reached every dependent artifact: the
  data model links a fact to entities, and has no link from a fact to each
  line of dialogue or each prompt. The script-editor checks propagation at
  the script gate, and the generating command's self-evaluation lists what it
  updated.
- On the rendered page, a design from before the change fails the `identity`
  or `wardrobe` check of the visual review.
