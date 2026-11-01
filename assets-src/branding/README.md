# assets-src/branding

Tooling for the mascot, logo and card art. It is its own npm package, like `tests/`, and is not part of the root install.

```
npm ci            # in this folder; .npmrc keeps ignore-scripts and min-release-age=7
npm test          # node --test, no network
```

Paths below are relative to this folder. Input files are looked up from the working directory first, then from this folder.

## Keys and endpoints

Only four names are read, from the environment or from `.env` (git-ignored; the environment wins). Nothing else in either place is read.

| Name | Use |
|---|---|
| `OPENAI_API_KEY` | OpenAI adapter |
| `GEMINI_API_KEY` | Gemini adapter |
| `OPENAI_BASE_URL` | default `https://api.linkapi.ai/v1` |
| `GEMINI_BASE_URL` | default `https://api.linkapi.ai` |

Base URLs must be https (plain http only for localhost). Keys never reach a log line, the console or an error message: headers named `Authorization` and `x-goog-api-key` and any `key=` query are redacted, every printed line and error is also scrubbed for the literal key values, and the `.jsonl` log stores references only as sha256. `test/redact.test.mjs` and `test/providers.test.mjs` cover this.

Official endpoints are a configuration change: set the two base URLs.

## Commands

```
node scripts/generate.mjs --template <name> [--vars k=v ...] [--characters reisen,tewi] [--refs a.png,b.png]
    [--model <id>] [--provider openai|gemini] [--size <size>] [--aspect <ratio>] [--n 1]
    --out raw/<stage>/ [--stage <name>] [--quality q] [--background transparent|opaque|auto]
    [--dry-run] [--yes] [--allow-stub] [--balance]

node scripts/edit.mjs --image <file> --instruction "<what to change>" [same options, no --template/--vars]
node scripts/contact-sheet.mjs [--out out/contact-sheet.png] [--cols 4] [--cell 384] [--cell-width N] [--cell-height N]
    [--labels a,b] [--nearest] <image>...
node scripts/key-bg.mjs [--out-dir out/keyed] [--key #00FF00] [--tolerance 80] [--softness 40] <image>...
node scripts/approve.mjs [--ref] [--dry-run] <file-or-sha256>...
node scripts/notice.mjs
```

- `--model` falls back to `lockedModel` in `config.json`; the provider is taken from the model's entry.
- `--size`: OpenAI takes `WIDTHxHEIGHT` (multiples of 16, edges up to 3840) and defaults to `1024x1024`. Gemini takes `512`, `1K`, `2K` or `4K` plus `--aspect` such as `2:3`, and defaults to `1K`.
- `--vars` repeats. Variables a template does not declare are an error. `name` is declared by the templates and stays empty unless a stage sets it.
- `--out` must resolve inside `raw/` or `out/`, which are git-ignored.
- Gemini returns JPEG. Files are saved with the extension of the bytes they hold (`.jpg`).
- Every real run prints `count x price`, refuses to start if the logged total plus the batch would pass `costCapUsd`, then asks `[y/N]`. `--yes` skips only the question; the cap check always runs. Without a terminal and without `--yes` the run stops.
- `--dry-run` prints the composed prompt, the references (name, size, sha256 prefix), the redacted request and the estimate. It sends, saves and logs nothing and needs no key.
- `--balance` reads the relay's `GET /api/usage/token/` before and after the run and prints `total_used` and the charge for the run from its change (500,000 quota units per dollar). The account balance in dollars is shown only when the token reports `data.user_quota`; the Gemini token does not. With `--balance`, the charge is also written to the log line as `chargedUsd`. It is the change in `total_used`, so it is only right when nothing else spends from the same token during the run; if either balance read fails, the field is left out.
- A template with `status: stub` is refused for real runs unless `--allow-stub` is passed.
- Both adapters make one image per request, one request at a time, because the relay has returned fewer images than `n` and still charged for `n`. The first failure stops the batch; images already made are saved, logged and charged, and the exit code is 1.
- A non-2xx reply whose body says `error.type: "upstream_error"` (a failed relay channel, not charged) is retried once after 3 seconds and the retry is printed. Nothing else is retried: not a 2xx reply, and not a request that threw, such as a timeout, because the relay may already be working on it.
- Edits put the edited image first among the references and use the `edit` template.

## Contact sheets, keying, approval

- `contact-sheet.mjs` scales each image to fit inside the cell box at its own aspect ratio, so mixed 3:2 and 2:3 images leave no grey bars. `--cell` sets a square box; `--cell-width` and `--cell-height` bound each side separately. Rows are as tall as their tallest image.
- `key-bg.mjs` reads PNG, JPEG or WebP and writes PNG. Pixels within `--tolerance` (RGB distance, default 80) of the key become transparent, the next `--softness` (default 40) are feathered, and the key's dominant channel is clamped on what remains to remove the green fringe. A test keys a blurred figure on a green field saved as JPEG at qualities 90, 75 and 50; the defaults hold at all three, so they were not changed. Every pixel near the key colour is keyed, so a figure must not contain it.
- `contact-sheet.mjs --scales 1,4` shows every image at each whole-number scale, at exactly width x scale, with nearest-neighbour resizing, one row per image. Use it for pixel art.
- `approve.mjs` takes log output files (path or sha256, full or a prefix of at least 8 digits), checks that each file's sha256 is the logged one, then sets `approved: true` on the output and its entry, copies the file to `approved/` and, with `--ref`, also to `refs/`. It checks everything before it writes anything and refuses a mismatching file or a different file already in the way. `approve.mjs --supersede <old> --by <new>` replaces an approved output with a newer approved one: the old output stays in the log with `superseded: <new sha256>`, its copies leave `approved/` and `refs/`, and it can no longer be approved. It refuses when the new output is not approved yet, when the old one is not approved, or when a copy in `approved/` or `refs/` is not the logged file. `NOTICE.md` lists only current approvals and gives superseded ones one history line.

## Local patches

Whole-image edits cannot fix details a few pixels wide. `patch.mjs` edits one crop at a time and puts only the chosen rects back, so nothing else in the picture changes.

```
patch.mjs --image <png> --spec <patches.json> [--instruction "..."] [--n 1] [--feather 6] --stage <s> --out raw/<stage>/ [--dry-run] [--yes] [--balance]
```

`patches.json` is a list of `{ "crop": [x, y, w, h], "composite": [[x, y, w, h], ...], "instruction": "optional" }`, all in the source image's pixels. A patch without `composite` composites its whole crop; composite rects must lie inside their crop.

- Each crop is magnified with Lanczos into whichever of 1024x1024, 1536x1024 or 1024x1536 magnifies it most, centred on a canvas padded with the median colour of the crop's border (never stretched), and sent to `/images/edits` with the `patch-edit` template. That template says the image is a close-up crop of a larger image and carries the `no-human-ears-edit` constraint.
- The result is scaled back to the crop's exact size, and only the composite rects are blended into the source, with a soft edge `--feather` pixels wide (default 6; 0 is a hard edge). Pixels outside the rects stay byte-identical to the source.
- Each call prints the mean colour difference inside and outside the composite rects. A large difference outside means the model redrew more than asked (warning above 10).
- Outputs in `--out`: the raw result of each call, the padded request image and prompt of each patch, the full-size picture (`...-patch-<variant>.png`) and a before and after sheet at 2x (`...-patch-<variant>-compare.png`). `--n` makes that many variants; variant k combines the k-th result of every patch.
- One log line per call (`template: patch-edit`, `refs` the source file's sha256, `vars` with `crop`, `composite`, `patch`, `variant`, `feather`, `chargedUsd` under `--balance`), plus one line per full-size picture (`template: patch-composite`, no cost) so `approve.mjs` can approve it. A failed call stops the run, keeps what was made and builds no picture for an incomplete variant.
- Only the OpenAI provider is supported.

`patch-overlay.mjs --image <png> --spec <patches.json> [--scale 2] [--cols 2] [--flags <flags.json>] [--out out/patches/<spec>-overlay.png]` writes a check sheet: every crop at 2x (nearest-neighbour) with its composite rects outlined in green, so the rects can be judged by eye before any call is paid for. It reads the spec with the same checks as `patch.mjs`. With `--flags` (the file `ear-remnants.mjs` writes) the flagged pixels are tinted under the outlines, red for skin and yellow for warm lines, so every flag can be seen to be covered or deliberately left out.

`ear-remnants.mjs --image <png> --heads <heads.json> [--name <sheet>] [--out-dir out/patches] [--scale 4] [--cols 2] [--threshold 0.2] [--open-radius 7] [--min-pixels 8]` looks for what is left of a human ear beside each face. `heads.json` is a list of `{ "name", "crop": [x, y, w, h], "skin": [x, y], "ignore": [[x, y, w, h], ...], "faceless": false }`: `skin` is a point on that face's cheek (a back view, with `"faceless": true`, can use a cheek from anywhere on the sheet), and `ignore` hides rects such as a rabbit ear that hangs beside the face. Skin-like pixels (OKLab distance from the cheek colour, lightness halved, with hue and chroma checks that keep the page and the sticker white out) outside the opened face and beside its rows are flagged red; thin orange or brown lines in the hair are flagged yellow. It writes `<name>-remnants.png` (each head at 4x with the flags tinted) and `<name>-flags.json` (`[x, y, kind]`, source pixels) to `--out-dir`. It is a hint, not a verdict: temple and blush skin beside the eyes, jaw and neck bits and rabbit-ear bases are flagged too, and a person decides which flags are real and sets the rects.

`grid-image.mjs --image <png> [--step 100] [--crop x,y,w,h] [--zoom 1]` writes a copy with a labelled coordinate grid to `out/grid/`, for picking rects. With `--crop` and `--zoom` the lines and labels stay in source pixels.

## Pixel tools (S3)

The grid detector is our own (`scripts/lib/pixel-grid.mjs`). The unfake.js project is private on GitHub and is not published to npm (`unfake.js` does not exist there; the npm package `unfake` is an unrelated one), and `.npmrc` forbids git dependencies. The only dependency stays `sharp`.

- `palette-extract.mjs --in <approved sheet.png> --name reisen [--colours 28]` proposes a DRAFT palette: the sheet's colour families (weighted k-means in OKLab, skipping the page colour and transparent pixels), each as a ramp with a shadow leaning towards violet and a highlight leaning towards warm yellow, a deeper shade for the biggest families, and white plus the soft rim of the sticker look. It writes `out/palettes/<name>-draft.hex`, `.gpl` (each colour named by its role) and a `.preview.png`. 24 to 32 colours; fewer than asked for, with a warning, when the sheet has few colour families. Lock a palette by copying the `.hex` to `palettes/<name>.hex`; `--palette reisen` then finds it.
- `pixelate.mjs --in <large.png> --grid 128x128 --palette reisen [--out out/pixel/<name>.png]`:
  1. The picture is assumed to span the whole native canvas, so the expected cell is source size / grid size (a source already near native size is read one cell per pixel). The detector searches 12% either side for the cell, which may be fractional (10.24 pixels per cell), and for where the grid starts. `--cell N` fixes the cell and still finds the offset. A weak detection (strength under 0.2) is a warning.
  2. Every cell becomes one pixel. `--sample mode` (default) lets the middle 60% of the cell vote for its nearest palette colour, `centre` takes the one centre pixel. Neither averages colours.
  3. Colours are the nearest palette entry in OKLab. The palette may hold at most 32 colours (a warning below 24).
  4. Alpha is binary: a cell is opaque when at least half its voting pixels have alpha of `--alpha-threshold` (default 128) or more.
  5. Orphans (an opaque pixel with no same-colour neighbour among its 8, and a transparent pixel with 8 opaque neighbours) are reported with a suggested colour, in the output and in `<out>.report.json`, and are NOT changed. `--orphans-patch <file>` writes the suggestions as a `pixel-fix` patch for review; `--fix-orphans` applies them (repeating until none are left, at most 10 passes). Real details such as a one-pixel eye highlight look like orphans, which is why nothing is removed silently.
  The sprite touching the canvas edge is a warning. `--indexed` writes a palette PNG.
- `pixel-fix.mjs --in <native.png> --patch <patch.json> [--palette reisen] [--allow-off-palette] [--out out/pixel-fixed/<name>.png]` applies `[{ "x": 3, "y": 4, "color": "#c82832" }, { "x": 10, "y": 2, "w": 4, "h": 1, "color": "transparent" }]` in order to a copy. With `--palette`, a colour outside it is an error. It never overwrites its input.
- `trim-align.mjs --canvas 128x128 [--pad N] [--baseline N] [--align-x bbox|centroid] [--lock each|first] [--scale none|fit] [--nearest] [--out-dir out/aligned] <images...>` trims each image to its opaque box and places it with its feet on one baseline and its box (or the weight of the sprite) on the centre line. Pixels are copied, not resampled, unless `--scale fit` applies one common magnification (a whole number with `--nearest`). `--lock first` keeps each frame's offset from the first one, so an ear that moves between frames still moves. An image that does not fit is an error.
- `contact-sheet.mjs --scales 1,4 <images...>` shows each native sprite at 1x and 4x with nearest-neighbour resizing.
- `design-sheet-pixel` (`--vars format=sprite-128` or `format=portrait-64`) and `pixel-still` ask for a transparent background. When the template's `background` variable says "transparent", OpenAI is sent `background: transparent`; `--vars background="flat pure green #00FF00"` is the fallback, which is then keyed out with `key-bg.mjs` (Gemini cannot make transparent pictures, so it needs the fallback). A relay that returns an opaque picture to a transparent request gets a warning. `--background transparent|opaque` must agree with the prompt.

## Master art export

The approved full-size picture is the master. A build step resizes it to the exact device pixels each placement needs; there is no pixel grid or palette lock for mascot art.

- `rim-recolour.mjs --in <picture.png> --out raw/<stage>/masters/<name>.png [--target #b99bf2] [--stage s3]` gives every character the same sticker rim. It finds the model's outer lavender ring (walking in from the transparent edge through pixels that are not white, no deeper than the white band starts) and moves each of its pixels by the difference between the target and the image's own median rim colour, scaled by how much of the way the pixel is from white to the rim. The move is made in OKLab, so hue and lightness change and the variation inside the rim stays, and antialiased pixels move less. Alpha, the white band and the character are never changed (a test checks they are byte for byte equal), and lavender hair behind the white band is not touched. A canvas border is a cut, not an edge. It writes the PNG, refuses to overwrite one, and logs a derived output (`template: rim-recolour`, `provider: local`, `estimatedUsd: 0`, the source's sha256 in `refs`) so `approve.mjs` can approve it. It fails when it finds no rim or no white band.
- `export-art.mjs --spec export-specs/trial.json [--out-dir out/export] [--only id,id] [--sheets]` writes `<id>@<css>x<density>.webp` for each asset and CSS size at 1x, 2x and 3x, and `manifest.json`. The spec is `{ "margin": 24, "assets": { "<id>": { "character", "master", "css": [128, 64], "fit": "contain|width|height", "square": false, "crop": [x, y, w, h], "margin", "webp", "focus": [x, y] } } }`.
  1. The frame is the subject's box (pixels with alpha of 16 or more, or `crop`) plus `margin` source pixels on every side, made square with `square`. It can reach past the canvas; the extra is transparent, so the sticker edge never touches the edge of the file.
  2. The frame is resized with Lanczos3 on premultiplied alpha (no fringe round the edge). `fit: contain` makes the longer side the CSS size times the density, which in a square box is the box; `width` and `height` measure that side. A size the frame cannot supply without enlarging it is an error.
  3. Each asset is stored as one of three WebP encodings: `lossless`; `near-lossless` (lossless WebP after rounding low bits, no chroma subsampling); or `lossy`. Each is compared with the Lanczos resize, both composited on grey, as an OKLab distance times 100 over the pixels that show: the mean must be at most 0.4 and the 99th percentile at most 1.5 (about 2 is the smallest step an eye can tell apart). `auto` takes, among the encodings that pass for every size of the asset, the one with the fewest bytes, trying near-lossless quality 40 to 90 and lossy 70 to 95 from the lowest. `webp` can force `"lossless"` or `{ "mode": "near-lossless" | "lossy", "quality": n }`.
  `crop: "canvas"` frames the whole picture (with `margin: 0` and `fit: "width"` that keeps the model's layout and a wide placement's aspect). `src` picks the fallback file for browsers without srcset: `{ "css": 128, "density": 2 }`, by default the 2x file of the widest CSS size. The manifest names it in `src` on the asset and flags it on its variant. `export-specs/shell.json` covers every mascot placement, with masters at `approved/<id>.png`; a slot whose master is not there yet is refused by name, so export the finished ones with `--only`.
  The manifest lists, for each asset, its master and its sha256, the frame, the encoding and, for each variant, file, css, density, width, height, bytes and the bytes and figures of all three encodings. `--sheets` also writes `<character>-sheet.png` into the output folder: each variant as the browser decodes it (1:1), a 4x zoom of a window round the asset's `focus`, and the real file size in the label. An asset's old files are replaced on a new run, and other assets in the manifest are kept.

## S5 masters

- `masters.mjs [--spec prompts/s5-masters.json] [--only id,id] [--n 1] [--dry-run] [--prompt id,id|all] [--yes]` builds one generation per slot from `prompts/s5-masters.json` (template `pixel-still` for one character, `pixel-scene` for two, the pose, expression, props, ears, facing and composition, the CSS sizes, the size sent, and the refs in the order each template's reference paragraph describes) and sends it through the usual run, so the cost cap, the confirmation and the log apply. `--dry-run` prints the table (id, size, aspect, refs, cost), the totals for one and two images per slot with the cap check, and the prompts named by `--prompt`; it sends, saves and logs nothing.
- Sizes are multiples of 16 at eight output pixels to the grid cell (the look of the approved masters): 1024x1024 for squares, 1536x1024 for 3:2 and 2048x1024 for 2:1, each at least 3x its biggest CSS size. Facing is `inline-end` (the right of the picture, mirrored by the front end in RTL), `inline-start` or `viewer`.
- The refs are the approved sheets, the line-up and the sprite masters in `refs/`. A finished master goes through `rim-recolour.mjs` into `raw/s5/masters/<id>.png` and is approved as `approved/<id>.png`, which is where `export-specs/shell.json` looks for it.
- `logo-concept` (S4) takes `--vars variation=asymmetric|symmetric` and `colour=#8b64aa`, and asks for a transparent background.

## Prompt kit

`prompts/` is composed in this order: style, character files, template, constraints. Template front matter holds `style`, `characters`, `constraints`, `require` and `var.<name>: <default>`. `lookup.<var>: <file>:<variable>` fills a variable from a `## key` table in `prompts/<file>.md`, keyed by another variable; `expression-face-edit` uses it to take its ear pose from `prompts/ear-poses.md` for each of the 28 expressions, and `--vars ears=...` overrides it. A line whose variable resolves to nothing is dropped. The `references`, `style-reference` and `sheet-order` constraints appear only when references are attached. Every template that draws a character carries the `no-human-ears` constraint (the `edit` and `patch-edit` templates carry `no-human-ears-edit`, which also asks to remove human ears that are already there unless the instruction says otherwise); `test/prompt-ears.test.mjs` fails for a new template that has neither, unless it is listed as drawing no character. Prompt files name no artist, studio, game or character; `test/prompt-kit.test.mjs` checks this.

## Log

`log/generations.jsonl` is committed. Each line is `{ time, stage, provider, model, template, vars, refs, size, n, outputs, estimatedUsd, [chargedUsd,] approved }`. `chargedUsd` is the relay's measured charge and is optional. The cost cap sums `chargedUsd` where a line has it and `estimatedUsd` otherwise; `notice.mjs` shows the two separately. `refs` and `outputs[].sha256` are hashes. For Gemini, `size` is `<size>/<aspect>` when an aspect is set. `n` and `estimatedUsd` count the images actually made. The composed prompt is written next to the outputs as `*.prompt.txt` (git-ignored).

## Request shapes and sources

Checked on 2026-11-01.

**OpenAI** (`openai` adapter)
- Text only: `POST {OPENAI_BASE_URL}/images/generations`, JSON `{ model, prompt, n, size }` plus `quality` and `background` when given, `Authorization: Bearer`. Response `data[].b64_json`; `usage` is printed.
- With references: `POST {OPENAI_BASE_URL}/images/edits`, multipart with `model`, `prompt`, `n`, `size` and one `image[]` file part per reference (up to 16).
- GPT Image models always return base64; the adapter also accepts a `url` item (https only, no credentials sent, size and time capped) and a `data:` URL, because a relay may differ.
- Sources: https://developers.openai.com/api/docs/guides/image-generation, https://developers.openai.com/api/reference/resources/images/methods/generate, https://developers.openai.com/api/reference/resources/images/methods/edit
- The edit reference also lists a JSON form (`images: [{ image_url }]`). The adapter uses the guide's multipart `image[]` form; the relay has not been tried with edits.

**Gemini** (`gemini` adapter)
- `POST {GEMINI_BASE_URL}/v1beta/models/{model}:generateContent`, header `x-goog-api-key`, JSON `{ contents: [{ role: 'user', parts: [{ text }, { inlineData: { mimeType, data } }, ...] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize, aspectRatio } } }`.
- Response `candidates[0].content.parts[]` with `inlineData` (also read as `inline_data`) or `fileData.fileUri`; `usageMetadata` is printed. A reply with no image is reported with its `finishReason`, `promptFeedback.blockReason` and any text.
- Up to 14 reference images (Nano Banana 2.1: 10 object and 4 character images).
- Output format: neither API documents a PNG option. In `generateContent`, `generationConfig.responseFormat.image.mimeType` has one value, `IMAGE_JPEG`; the Interactions API reference lists only `image/jpeg` for `response_format.mime_type`. There is no flag for it, and Gemini output is JPEG. Checked on 2026-11-01: https://ai.google.dev/api/generate-content (ImageResponseFormat), https://ai.google.dev/api/interactions.
- Sources: https://ai.google.dev/api/generate-content (`GenerationConfig.responseModalities`, `ImageConfig`), https://ai.google.dev/gemini-api/docs/image-generation (sizes, token counts, reference limits).
- Google's image guide now shows the Interactions API (`/v1beta/interactions`) as its main path. The relay lists `generateContent` as its Gemini endpoint, so that is what this adapter uses.

## Prices

From `GET https://api.linkapi.ai/api/pricing` (public, no key), pricing version `a42d372ccf0b5dd13ecf71203521f9d2`, retrieved 2026-11-01. Prices are after the group multiplier.

| Model | Group (multiplier) | Billing expression | Per image |
|---|---|---|---|
| `gpt-image-2.5-sunburst-h` | `all` or `once` (1) | `tier("image", fixed(0.2)) * image_count` | $0.20, confirmed by one run |
| `gpt-image-2.5-flare-h` | `all` or `once` (1) | same | $0.20, confirmed at the owner's instruction (the measured run was sunburst-h) |
| `gemini-3-pro-image-preview` | `gemini` (1.6) | `tier("request", fixed(0.21875))` | $0.35 (0.21875 x 1.6) |
| `gemini-nano-banana-2.1` | `gemini` (1.6; `geminipro` is 3) | `tier("base", p * 1.5 + c * 30)` per million tokens | measured, about $0.10 at 1K and $0.20 at 2K; 4K about $0.27, extrapolated |

The relay bills thinking tokens as output tokens, so the estimate uses candidate plus thought tokens per size, measured on 2026-11-01 (`usageMetadata.candidatesTokenCount` and `thoughtsTokenCount`):

| Size | Candidates | Thoughts | Measured charge |
|---|---|---|---|
| 1K | 1346 | 814 | 51,901 units = $0.1038 (one image) |
| 2K | about 2840 | 871 to 1711 (1291 used) | 200,324 units for two images = $0.2003 each |
| 4K | 4260 (2K scaled by Google's 4K to 2K ratio) | 1291 | not measured |

The 2K figure comes from a three-image run that cost 375,324 units, with the Pro preview image taken at its fixed $0.35 (175,000 units). Input tokens use 4 characters per text token and 1120 per reference image, which are assumptions. Thought counts vary by prompt, so a charge can differ by about 10 percent. Google's own table lists fewer candidate tokens (1120, 1680, 2520); the relay's numbers are the ones used.

The endpoint's older `model_price` field says $0.30 for the GPT Image models; it disagrees with the expression and the measured charge, and is not used.

`costCapUsd` was raised from 10 to 20 for S2 retries (the ear passes) plus the S3 concepts. The account had about $24 left at the time.

## Tests

`npm test` runs `node --test` with no network; every provider call is a stubbed `fetch`.
