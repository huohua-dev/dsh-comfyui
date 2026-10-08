# dsh-comfyui

**English** | [中文](README.md)

<p align="center">
  <img src="logo.png" width="480" alt="dsh-comfyui logo" />
</p>

<h1 align="center">dsh-comfyui</h1>

<p align="center">Let the DeepSeek Harness agent smartly drive a local or remote ComfyUI to generate anything — with workflow and asset management panels, per-workflow skill packs, a companion skill and a same-origin media proxy.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-comfyui"><img src="https://img.shields.io/npm/v/dsh-comfyui" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-comfyui"><img src="https://img.shields.io/npm/dm/dsh-comfyui" alt="npm downloads" /></a>
  <img src="https://img.shields.io/npm/l/dsh-comfyui" alt="license" />
</p>

> **This repository is a fork (huohua-dev) of [fandc520/dsh-comfyui](https://github.com/fandc520/dsh-comfyui) 0.5.4; from 0.6.0 it targets DeepSeek Harness 0.2.0-rc.2 only.**
>
> | dsh-comfyui | Paired DeepSeek Harness |
> | --- | --- |
> | **0.6.x (this fork, `dist` branch)** | **0.2.0-rc.2** (peer pinned; no allow-version exemption needed) |
> | 0.5.x (upstream npm) | 0.1.2 – 0.1.7 |
>
> Install (desktop profile, restart DSH afterwards):
> `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:huohua-dev/dsh-comfyui#dist`

### What 0.6.0 changes over upstream 0.5.4

- **Video from chat**: built-in `h3_t2v` template (MiniMax H3 text-to-video, 10Eros TURBO) driven by named `prompt / width / height / seconds / seed / steps`; seconds become frames (3 s = 73, 5 s = 124).
- **Manage workflows from chat**: `comfyui_workflow` gains `save` (from a run's `prompt_id`, a built-in template, or API JSON), `update` and `delete`.
- **Results land on this machine**: each run keeps its media plus `meta.json` (full workflow, seeds, parameters, sha256) under `archiveDir/<prompt_id>/`; chat cards play the local copy first, so history keeps playing (and seeking) with ComfyUI offline.
- **Videos show up in the conversation**: results render below that turn's reply in the main flow (like images), no need to expand the folded process; a background job shows its progress there and turns into a player when it lands.
- **0.2 background jobs**: owned by the session, live "queued / sampling x/8" progress in the DSH jobs panel, `job_kill` settles immediately.
- **Cancel only your own prompt**: pending → dequeued, running → interrupted by id (v0.39 `/api/jobs/{id}/cancel`); no global interrupt anywhere.
- **Route protection**: every `/comfyui/*` route requires a loopback Host, refuses cross-site requests and foreign Origins, and checks the DSH browser session; media routes only read the plugin's own archive and validated ComfyUI `/view` references. **Plugin routes are therefore no longer reachable from other LAN devices.**
- **Unreachable ComfyUI** errors name the server and a configurable hint.
- Settings carry descriptions and appear on this plugin's entry in the DSH Plugins page.

## Features

### Agent tools

The agent drives ComfyUI directly, no canvas work needed:

- `comfyui_run` — submit an API-format workflow or a built-in template (`txt2img` / `img2img` / `video` (Wan 2.1) / **`h3_t2v`** / **`h3_r2v`**) and get media back; `mode: "sync"` waits for the result, `mode: "async"` runs a background job (always for video). The H3 templates take named `parameters`; the trained duration range is 5–15 s (15 s = 362 frames).
  - **`h3_r2v` reference-to-video**: character reference images `ref_image_1..3` (the first is required), a voice-timbre reference `ref_audio_1`, first/last keyframes `first_frame` / `last_frame`, and continuation from a previous clip `continue_from` (its last 22 frames and audio pinned at frame 0); 480×864 portrait, 5 s by default. An empty optional slot removes its whole branch from the workflow. Prompts use the official six-section format with dialogue as `<d>[Chinese] …</d>`.
- `comfyui_upload` — upload a local media file (png/jpg/webp/gif/wav/mp3/flac/ogg/m4a/mp4/webm/mov/mkv, ≤200 MB) into ComfyUI's input directory, with an optional single-level `subfolder` and `overwrite`; returns the `subfolder/name` reference to put into LoadImage / LoadAudio / LoadVideo or template parameters, and records image pixel sizes.
- `comfyui_object_info` — list the node definitions your ComfyUI server supports, so the agent can build valid workflows on the fly.
- `comfyui_workflow` — manage the plugin's runnable-workflow library: `list` (server address, local ComfyUI dirs, load-area media, per-workflow parameter lists), `run` (by id + parameter overrides), **`save` / `update` / `delete`** (keep, change and remove workflows from chat), `skill` (on-demand read of a workflow's skill pack), `refresh` (re-derive a parameter snapshot).
- `comfyui_skill` — read and write workflow skill packs (`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`); the agent can write its lessons back into a pack and reuse them across sessions.

### UI panel

A right-docked panel with three tabs:

- **Workflows** — the runnable workflow library (create / edit / run / delete / import `.json`, tag classification with a dropdown filter); **preset export / import**: bundle selected workflows (all pre-selected; pack-bearing rows are annotated) with their parameters and skill packs into one `.zip` preset package — the completion notice reports what was actually packaged: workflow names, file name, size, and warnings; drag a preset package **onto the dialog** (or pick a file) to analyze it and import the selection, with skill packs restored byte-for-byte (thousand-file template packs included). Imports always create new workflows — nothing in the library is overwritten; auto-detects graphs saved on the ComfyUI server and can **extract** them into runnable workflows (whole / per component / main flow only when a canvas holds several independent flows).
- **Assets** — every generated result with preview, download, and hover-to-delete (also removes the file from the ComfyUI output directory).
- **Queue** — live queue plus full history in five states, with delete / interrupt / rerun / clear / free-memory actions; plugin-submitted jobs show a progress bar and preview.

Clicking the "ComfyUI Panel" button in the session header probes the backend's connection to ComfyUI: when it cannot connect, the panel closes again (the button does not stay highlighted) and a toast at the top of the page explains why (with the concrete reason), asking you to start the local ComfyUI (so the backend can see its port) or check the remote server URL in settings; a healthy connection stays silent, with a brief "Connected" note only when it recovers from a failure.

<p align="center"><img src="images/panel.png" width="70%" alt="Main panel: workflows / assets / queue" title="Main panel: workflows / assets / queue" /></p>

### Load area (media loader)

A media loader at the top of the Workflows tab, in the style of ComfyUI's LoadImage node: visual picking (with in-place playback for video/audio), paste/upload, and multiple slots. Filled slots fill the workflow's unset loader parameters in order — **the agent doesn't need to guess file names**; unset `width`/`height` auto-match the source image's size. Uploads are renamed by content hash (dedup).

The `loadArea` field of `comfyui_workflow list` exposes the slots and their contents to the agent.

### Workflow skill packs (a manual for the agent)

A parameter list tells the agent which knobs exist, not what the workflow is *for* or which step goes wrong. A complex workflow can carry a **skill pack** (enable it from the "Skill pack" button on the workflow card):

```
<data dir>/skills/<workflow>/
  SKILL.md          # main doc: when to use / key parameters / gotchas
  references/       # reference docs: style catalogs, troubleshooting
  assets/           # reference images etc (previewable in the panel)
```

- **Progressive disclosure, no resident context cost**: `comfyui_workflow list` shows one summary line → `action: skill` fetches the SKILL.md body once the workflow is chosen → a referenced document is read only when the body points at it. Dozens of workflows can carry full packs, and the daily context cost stays one line each.
- **Edited in the panel**: file list + editor, import (auto-bucketed by extension), custom subdirectories, image preview, and the whole pack root can be moved to another drive / a synced folder (the `技能包目录` setting).
- **The agent can write it too**: the `comfyui_skill` tool lets the agent read and author a pack — `append` a pitfall to SKILL.md and the next session (even another one) reuses that experience.
- **Read-before-run**: a "required" flag makes `run` refuse until the skill pack has been read in this session, with an error pointing to `action: skill`.

### Local archive, media proxy & settings

When a run finishes, its media is downloaded to `archiveDir/<prompt_id>/` (default `<dataDir>/archive`) next to a `meta.json` with the prompt id, the full workflow submitted to ComfyUI, parameter definitions and the values actually used (randomized seeds included), every seed input, and each file's sha256. `meta.json` is written at submit time, so a DSH restart mid-run can still archive later.

Chat cards play `/comfyui/archive/<prompt_id>/<file>` (local, Range-seekable) first and fall back to the same-origin proxy `/comfyui/media` (ComfyUI `/view`), which also checks the archive first. The browser never touches ComfyUI directly: no CORS, no mixed content, and the API key never leaves the host. The archive has no size cap, and deleting an asset in the panel does not touch it.

The DH settings page gets a "ComfyUI" section: server address, API key env var name, local ComfyUI directories, media host, connection test and a zh/en UI language switch — applied immediately, no `cordis.yml` edits needed.

## Install

```sh
# web profile
dsh plugin --profile web add dsh-comfyui
# desktop profile
dsh plugin --profile desktop add dsh-comfyui
```

After restarting the app: a panel entry appears in the sidebar, a "ComfyUI" section in settings, and the agent gets all tools plus the companion skill right away.

## Usage

Just tell the agent, e.g.:

- "Draw a red cat with ComfyUI"
- "Turn this image into cyberpunk style"
- "Turn the anime image in the load area into a photorealistic portrait, same resolution"
- "Make a 480p 3-second video: a ginger cat watching waves at dusk, with surf sounds" (H3, background job, plays in the card)
- "Save this as a template called beach cat" → "Run beach cat again, but 5 seconds"
- "Cancel that job" (only that prompt is cancelled)
- "Run my Krea-Afterlight saved in ComfyUI" (if the graph isn't extracted yet, the agent will ask you to **extract** it in the panel first)

For a remote ComfyUI behind an authenticated proxy, provide the key via credential storage or the `apiKeyEnv` env var (default `COMFYUI_API_KEY`) — it is resolved on the host and never sent to the browser.

## Configuration

`comfyui` section of `cordis.yml` (most is editable in the settings page):

| Key | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI server address |
| `apiKeyEnv` | `COMFYUI_API_KEY` | Optional API key env var / credential name |
| `dataDir` | *(DSH data dir)* | Where the workflow library and asset index live |
| `comfyuiDirs` | `[]` | Local ComfyUI install dirs (multiple allowed); the agent locates models, custom nodes, TTS voice libraries through these |
| `outputDir` | `''` (inferred) | ComfyUI output dir (used to locate files when deleting assets) |
| `archiveDir` | `''` (default `dataDir/archive`) | Local archive of finished runs (absolute path) |
| `unreachableHint` | `win 可能在 LLM 模式，需要先运行 winmode.sh video` | Appended to "cannot reach ComfyUI" errors |
| `maxMediaBytes` | `536870912` (512 MB) | Per-file cap for the proxy and the archive |
| `mediaHost` | `''` | Unused since 0.6.0 (media URLs are same-origin relative paths) |
| `skillsDir` | `''` (default `dataDir/skills`) | Skill pack root (absolute path; a synced folder or VCS works) |

## Requirements

- DeepSeek Harness (`web` / `desktop` profile)
- A running [ComfyUI](https://github.com/comfystack/ComfyUI) server (default `http://127.0.0.1:8188`)
- The `h3_r2v` template additionally uses the core nodes `MiniMaxH3ReferenceToVideo` / `MiniMaxH3AddGuide` (same models; optionally the official `minimax_h3_ref2va_pruned_int8_convrot.safetensors` + LoRA `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors`, 4 steps)
- The `h3_t2v` template needs ComfyUI ≥ 0.39 (core node `MiniMaxH3ImageToVideo`) with `10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors` (diffusion_models), `qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors` (text_encoders, type minimax), `minimax_h3_video_vae_int8_convrot.safetensors` and `minimax_h3_audio_vae_fp32.safetensors` (vae)
- The `video` template needs [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) and Wan 2.1 models

## License

MIT