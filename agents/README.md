# Agents

Specialized roles, one per file. An agent is the answer to "who owns this?":
each one owns a slice of the pipeline, reads the bibles as the source of
truth, and writes or reviews artifacts inside a `production/` workspace.
Agents do not freehand prompts, and they do not edit an approved master. A
change to approved work is a new version.

## Roster

| Agent | Role |
|---|---|
| [editor-in-chief](editor-in-chief.md) | Canon, phase order, approvals, rulings between departments |
| [comic-writer](comic-writer.md) | Panel script: moments, dialogue, captions, sound effects |
| [script-editor](script-editor.md) | Coverage, source fidelity, causality, dialogue economy |
| [art-director](art-director.md) | The look, the frozen style block, the style fidelity gate |
| [character-designer](character-designer.md) | Identity, distinguishing features, wardrobe states, sheets |
| [environment-designer](environment-designer.md) | Locations, maps with levels and landmarks, props |
| [layout-artist](layout-artist.md) | Pages, grids, panel sizes, reading order, page turns, thumbnails |
| [penciller](penciller.md) | Framing, staging, and acting inside each panel |
| [colorist](colorist.md) | Color mode, spot colors, color script, tone continuity |
| [letterer](letterer.md) | Exact text, reading order, balloon tails, lettering checks |
| [continuity-editor](continuity-editor.md) | Panel ledger: position, custody, state tags, hands, wardrobe |
| [prompt-director](prompt-director.md) | Reference plans and compiled prompt packages |
| [image-generation-specialist](image-generation-specialist.md) | Generation runs, versioned renders, generation records |
| [visual-reviewer](visual-reviewer.md) | Pixel review, findings with evidence, verdicts |
| [prepress-specialist](prepress-specialist.md) | Editions and exports |
| [production-qa](production-qa.md) | Mechanical gates: schemas, provenance, approval, cost |

The art-director, penciller, colorist, and production-qa are read-only. They
decide and review, and the agents that own the files write the result. That
keeps one writer per artifact.

Two separations run through the roster. The agent that generates an image
does not review it: the image-generation-specialist files the render and the
visual-reviewer judges it. And production-qa reports what scripts can check,
which never includes whether a drawing is correct.

## How agents relate to commands and skills

A command in `commands/` is an entry point. It lists the agents it invokes
and the skills it requires, and the authoritative map is the command table in
[docs/conventions.md](../docs/conventions.md). A skill in `skills/` is a
procedure. Each agent file lists the skills it uses under `Uses These
Skills`, drawn from the commands that invoke it.

When a command runs, its agents work in the order the command's process
gives, each applies its skills, and the output lands in the workspace layout.
`/smart-page` is the widest example: layout, script, composition, lettering
text, ledger, reference plan, and prompts for one scene, each stage owned by
a different agent. `/full-production` gives the editor-in-chief the whole map
and puts production-qa on every phase gate.

## File format

Frontmatter carries `name`, `description`, `tools`, and `model`. The body has
these sections, in order: Role, Responsibilities, Uses These Skills,
Collaborates With, Deliverables, Activation Guidance. Bullets under `Uses These Skills` and
`Collaborates With` are bare roster names with nothing after them, because
`npm run validate` matches them exactly. The `description` is the sentence
from the Agents table in the conventions, word for word.

## Adding or renaming an agent

A roster change touches three places:

1. `agents/<name>.md`, in the format above.
2. `manifests/agents.json`, with the same name, file path, and description.
3. `docs/conventions.md`: the roster list, the Agents table, and any row of
   the command map that should invoke the agent.

Then run `npm run sync:harnesses` to regenerate the harness wrappers and
`npm run validate` to confirm the three agree. Do not edit the generated
harness directories by hand.
