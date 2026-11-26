# providers/

Thin adapters for image generation backends. One file per backend, one common
interface, zero runtime dependencies (Node 18 global `fetch` for the live HTTP
call). The roster lives in `manifests/image-providers.json` and must deep-match
what each module exports.

```
providers/
├── image/   fal.js  replicate.js  comfyui.js  gemini.js  harness-native.js  manual.js
└── lib/     common.js    capability checks, records, env checks, polling
             handoff.js   shared by manual and harness-native
```

Every provider has `kind: 'image'`: a comic page is an image.

## The interface (from docs/conventions.md)

Every `providers/image/<id>.js` exports exactly:

```js
module.exports = {
  id: 'fal',                    // matches the manifest entry
  kind: 'image',
  label: 'fal.ai',
  env: ['FAL_KEY'],             // required env vars; [] for harness-native and manual
  capabilities: {               // hard limits; deep-equal to the manifest
    referenceImages: 4,         // max input images per request, 0 if unsupported
    aspectRatios: ['2:3', '3:4', '9:16', '1:1'],
    imageEditing: true,         // accepts an edit target (needed for /repair-page)
    textRendering: 'unreliable' // 'reliable' | 'unreliable' | 'none'
  },
  compile(promptPackage, options = {}) { ... },   // pure: no I/O, no env reads
  async generate(requestSpec, { dryRun = true, outDir, root } = {}) { ... },
};
```

## Capabilities

| Provider | referenceImages | imageEditing | textRendering | Notes |
|---|---|---|---|---|
| fal | 4 | true | unreliable | The default model is text-to-image and reads no input images. Pin a multi-image model for page work. |
| replicate | 1 | false | unreliable | flux-dev takes one image as an image-to-image source. A page with a look master and a character does not fit. |
| comfyui | 8 | false | none | The default graph is text-to-image. The budget describes your own graph with reference nodes. Use overlay lettering. |
| gemini | 3 | true | unreliable | Reads inline images and edits a given image. |
| harness-native | 4 | true | unreliable | Handoff to the harness's image tool. No network. |
| manual | 4 | true | unreliable | Handoff to a person. No network. |

What each key means for the pipeline:

- `referenceImages` is the budget `build-reference-plan.js` plans against. The
  edit target of a repair counts as one of the images.
- `aspectRatios` always includes the portrait page ratios 2:3, 3:4, 9:16 and
  the square 1:1. A package with any other ratio is rejected with the list of
  supported ones. fal and ComfyUI take pixel sizes, so their adapters map each
  ratio to a size.
- `imageEditing: false` means `compile()` rejects every repair package.
- `textRendering: 'none'` means `compile()` rejects a package that carries
  `lettering_text`. Switch the project to overlay lettering for that provider.
  With `'unreliable'`, `compile-prompts.js` warns that the review must check
  every string.

No provider is marked `reliable`. Lettering always goes through the review.

## `compile(promptPackage, options)`

- Input: a prompt package (`schemas/prompt-package.schema.json`).
- Output: a request spec in the provider's dialect:
  `{ provider, kind, model, endpoint, method, body, meta }`. Handoff providers
  add `handoff: true`.
- Pure: no filesystem, no network, no `process.env`. Credentials are attached
  inside `generate()` at call time, so a request spec is safe to write to disk.
- Throws when the package violates `capabilities`. Use `checkCapabilities()`
  from `lib/common.js`; it reports every violated limit in one message.
- Model precedence: `options.model`, then the package's own `model` field,
  then the adapter's default. The `'pending'` placeholder is ignored. Default
  model IDs are configuration and live only in the adapter file.
- `meta.warnings` lists what the request cannot honor, for example a
  text-to-image default model that ignores the attached images.
  `compile-prompts.js` and `generate-assets.js` print them.

Input images travel in attachment order: the edit target of a repair first,
then the package's `references`. `attachments()` in `lib/common.js` computes
that order for the adapters and for the prompt's reference legend, so "Image 2"
in the prompt is the second image in the request.

## `generate(requestSpec, { dryRun = true, outDir, root })`

- Dry-run is the default. It calls no network and returns a generation record
  (`schemas/generation-record.schema.json`) with `status: 'dry_run'`.
- Live mode calls `assertEnv(provider.env)` first and refuses to run when a
  variable is missing. Never log keys or auth headers.
- `root` is the workspace root. Live mode resolves the package's
  workspace-relative image paths against it. A missing input image is an
  error, because a request that drops an identity reference draws the wrong
  character.
- Providers return the record object. Writing records, request specs, and
  media to disk is the job of `scripts/generate-assets.js`. An API that
  returns raw bytes attaches them as base64 on the record's `_media` field;
  `generate-assets.js` writes the files, fills `media_files`, and removes
  `_media` before the record reaches disk.

## Records never invent metadata

`makeRecord()` builds the comics generation record with page or asset scope
and the planned `output_render`. It fills in only what is known:

- `model` is the model the request addresses. For a handoff it is
  `unreported`, because the person or the harness tool picks the model.
- `cost.amount` is `null` with `reported: false`. When `generate-assets.js`
  has a list price for the model it passes an estimate, recorded with
  `estimated: true`. `reported` turns true only when the tool returns billing
  data.
- `seed` is the seed the package pins, else `null`.
- `metadata_unavailable` lists which of `model`, `cost`, and `seed` the tool
  has not reported. `applyReported()` fills a value in and removes it from the
  list once a response carries it.

## Handoff providers

`harness-native` and `manual` have no API. `compile()` produces a handoff
package: the prompt, the input images in order with the single role of each,
the aspect ratio, instructions, and the target output. `generate()` returns a
`dry_run` record even when asked to run live, and its notes say where to save
the result. `generate-assets.js` writes the package next to the record as
`GEN_<scope>_<attempt>.request.json` and fills in the target render and path.

The target depends on the package's scope. A page package targets the next
free render, `<page dir>/renders/<PAGE_ID>_V##.png`. A sheet package compiled
with `compile-prompts.js --asset <ENTITY_ID> --sheet <kind>` targets the next
free candidate in the entity's `refs/` directory,
`<ENTITY_ID>_<TAG>_V##.png` (`references/style/<LOOK_ID>_V##.png` for a look),
and its record goes under `generations/<ENTITY_ID>/`. The tag names the kind
and its variant: `TURN`, `EXPR`, `WARD_<OUTFIT>`, `PLATE`, `SHEET` for a
prop, `DETAIL_<SUBJECT>`. A candidate never takes
the `_MASTER` name; approval promotes it.

Use `harness-native` when the coding assistant has its own image tool (Codex
with gpt-image, or an MCP image tool). Use `manual` when a person generates in
a web UI. In both cases the record is completed afterwards with the saved file
and whatever the tool reported.

## Env vars

`FAL_KEY`, `REPLICATE_API_TOKEN`, `COMFYUI_HOST`, `GOOGLE_API_KEY`.
`npm run doctor` reports which are set (names only, never values).

## Adding a provider

1. Create `providers/image/<id>.js` exporting the interface above. Start from
   an existing adapter: `gemini.js` for an API, `manual.js` for a handoff.
2. Add the matching entry (id, file, label, env, capabilities) to
   `manifests/image-providers.json`. `capabilities` must deep-equal the
   module's export.
3. Add the id to the Providers roster in `docs/conventions.md`.
4. Document any new env var in `docs/conventions.md` and the root README.
5. Run `npm test` (`tests/provider-interface.test.js` picks the provider up
   from the manifest) and `npm run validate`.

Keep `capabilities` honest. `compile()`, `scripts/validate.js`,
`scripts/build-reference-plan.js`, and `scripts/compile-prompts.js` all treat
them as hard limits. When a backend only supports something with a different
model or a custom graph, say so in the adapter's header comment and warn from
`compile()`.
