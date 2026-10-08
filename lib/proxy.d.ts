/**
 * Media proxy: serves generated ComfyUI files to the browser through the
 * same-origin route /comfyui/media?file=&subfolder=&type= (legacy:
 * ?prompt=&node=&index=), so the client never talks to the ComfyUI server
 * directly (no CORS, no mixed content, no key in the browser). A file that
 * was archived locally is served from disk without touching ComfyUI.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComfyUIMediaRef } from './comfyui.js';
import type { ComfyUIRuntime } from './tools.js';
import type { RouteGuard } from './route-guard.js';
/**
 * Validate a /view reference taken from the query string. ComfyUI joins
 * `subfolder` and `filename` onto its folder itself (and checks containment),
 * but this proxy must not depend on that: a bare file name, a relative
 * forward-slash subfolder without `..`/absolute/backslash/NUL segments, and a
 * known folder type are the only shapes passed on.
 */
export declare function checkViewRef(ref: ComfyUIMediaRef): string | undefined;
/**
 * Mount the media proxy route on the host web server. The local archive is
 * consulted first, so any media URL the plugin ever handed out keeps playing
 * after ComfyUI goes offline, as long as the run was archived.
 * @returns the disposer, or undefined when no web server is present.
 */
export declare function mountComfyUIProxy(ctx: Context, runtime: ComfyUIRuntime, guard?: RouteGuard): (() => void) | undefined;
