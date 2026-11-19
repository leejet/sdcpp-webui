# sdcpp-webui

A lightweight Vue + Vite web UI for `stable-diffusion.cpp` servers that expose the native `sdcpp` API.

It is designed for two use cases:

- run as a standalone frontend during local development
- build into a single HTML file that can be embedded into `sd-server`

## What It Does

`sdcpp-webui` talks directly to the native server endpoints:

- `GET /sdcpp/v1/capabilities`
- `POST /sdcpp/v1/img_gen`
- `POST /sdcpp/v1/vid_gen`
- `GET /sdcpp/v1/jobs/:id`
- `POST /sdcpp/v1/jobs/:id/cancel`

The current UI supports:

- automatic image/video generation mode selection from the selected recipe
- prompt and negative prompt editing
- streaming prompt enhancement through a configurable OpenAI-compatible API, with system prompt presets, retry, and restore
- width, height, seed, batch count, video frames, and fps
- sampler and scheduler selection
- guidance controls, including the video high-noise stage
- conditioning controls such as `clip_skip`, `strength`, `control_strength`, `moe_boundary`, and `vace_strength`
- a dedicated LoRA button with a selection count; selections, multipliers, and high-noise targets are saved locally per server and recipe, and unavailable entries are retained but excluded from generation
- init image, end image, mask image, control image, control frames, and reference images
- original reference video and audio file inputs, with browser-side decoding and optional video soundtrack conditioning
- VAE tiling controls
- cache controls
- job polling, cancellation, image preview, and video or animated WebP preview
- live preview mode and step interval always available in Settings, even before selecting a recipe, and saved locally; unsupported modes temporarily fall back to disabled without overwriting the saved preference
- light and dark themes with a header icon shortcut and a Device (follow system) option in Settings; the choice is saved locally and system theme changes apply immediately

## Creation Workspace

The workspace uses a central output stage and a bottom prompt composer.
Selecting a recipe determines whether to generate images or video; command-line
models use the server's reported mode. Buttons below the prompt open model selection, LoRAs, a combined
aspect-ratio and resolution panel, output options, reference inputs, a dedicated
Sample & Guidance panel, and advanced settings. The sample panel also contains
high-noise sampling and guidance when supported. The LoRA button sits beside the model button.
Settings contains output format, output compression, VAE tiling, connection,
theme, polling, and live-preview preferences.
On desktop, the preview fits the space above the composer within the viewport.
Generation status and result actions share a compact row; Details opens a dialog,
and batch thumbnails scroll horizontally. Small or short windows allow page
scrolling so the preview and composer remain accessible.
Negative Prompt sits below Prompt and can be collapsed even when filled. Its
collapsed row shows a single-line text preview; collapsing preserves the prompt
used for generation. The expanded state is saved locally, and Clear removes the
text. The editor grows from two to four lines before scrolling internally.
When CFG Scale equals 1, the Negative Prompt section is hidden without clearing
its text or saved expansion state.

- **Aspect Ratio** offers common ratio presets. Changing the
  ratio preserves the image pixel budget or the video's short-edge resolution.
- **Resolution** offers model defaults, image pixel-budget tiers, and video
  short-edge tiers (480p, 720p, 1080p), plus direct width/height entry, a ratio
  lock, and width/height swapping. Use **Exact dimensions** with the ratio
  unlocked for custom proportions. Exact entry switches to Custom. The UI
  rounds presets up to the recipe's `size_multiple` (default `8`, including when
  no recipe is selected). Manual dimensions must satisfy this increment and
  server limits; a correction button offers the next valid aligned size.
- Image and video drafts, including prompts, sizes, and image inputs, remain
  separate for the current page session and restore when a recipe changes the
  generation mode. Selecting a recipe still applies its
  defaults when **Apply recipe defaults** is enabled.
- Use **Ctrl+Enter** or **Cmd+Enter** from the prompt to generate. Configuration
  panels support Escape, focus return, and keyboard navigation. On small screens
  they open as bottom sheets.

## Prompt Enhancement

In **Settings → Prompt Enhancement**, enter an OpenAI-compatible API base URL
(including its version path, such as `https://your-api.example/v1`), API key,
and model ID. A full `/chat/completions` URL also works. The key is optional for
local services that do not require authentication. Settings, including the key,
are saved in this browser's local storage. Requests go directly to the provider,
which must allow browser requests through CORS; an HTTPS UI needs an HTTPS API.

Edit **System Prompt** directly; it is saved automatically and used for requests
without requiring a preset. Choosing a **Preset** copies its text into this
field. Further edits change only the current system prompt, not the saved preset.
Preset controls sit below the System Prompt editor. To keep a reusable template,
click **Save as new preset**, enter a name, and confirm with **Save preset**, or
explicitly **Update selected preset**. Cancel closes the name field without
creating a preset. Deleting a preset keeps the current system
prompt. Ask the model to return only the resulting prompt text. The built-in
General preset provides a starting point.

Click **Enhance** below the prompt to stream the result into the editor. **Cancel**
keeps the text received so far. **Restore original** returns to the exact original
text; **Try again** generates another version from that original, using the
current system prompt. Failed or incomplete requests restore the text from
before that request. Editing the prompt manually or switching image/video modes
cancels any pending enhancement and starts a new editing session without the old
restore history. Image/video generation is disabled while enhancement is running.

## Requirements

- Node.js `>= 20`
- `pnpm` `>= 10`
- a running `stable-diffusion.cpp` server with the `sdcpp` API enabled

## Development

Install dependencies:

```bash
pnpm install
```

Start the dev server:

```bash
pnpm dev
```

Then open the Vite URL shown in the terminal.

The UI lets you set the backend base URL in the Settings tab.  
If left empty, requests go to the current origin.

## Production Build

Build a production bundle:

```bash
pnpm build
```

This project uses `vite-plugin-singlefile`, so the output is emitted as a self-contained `dist/index.html`.

Preview the production build locally:

```bash
pnpm preview
```

## Embedding Into `sd-server`

If you want to ship the UI inside `stable-diffusion.cpp`, first build the frontend:

```bash
pnpm build
```

Then generate the C header:

```bash
pnpm build:header
```

That produces:

```text
dist/gen_index_html.h
```

The generated header contains the built HTML as a byte array, which can be compiled into the server binary.

## Type Checking

Run:

```bash
pnpm type-check
```

## Project Layout

```text
src/
  components/   reusable UI pieces
  lib/          API, form mapping, image helpers, settings helpers
  App.vue       main application shell
  main.ts       app entry
  styles.css    global styles
scripts/
  build_gen_index_html.js
```

## Notes

- This UI is intentionally thin. Most selectable options come from the server's `capabilities` response.
- It assumes the backend handles CORS correctly if the frontend is served from a different origin.
- Image/video generation uses the native `sdcpp` API, not the OpenAI-compatible or A1111-compatible server routes. Prompt enhancement uses the separately configured chat completions API.

## License

MIT License
