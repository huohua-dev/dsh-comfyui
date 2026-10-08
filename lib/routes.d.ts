/**
 * Browser-facing HTTP routes for dsh-comfyui: configuration (read/redacted,
 * persist through the settings service), a connection probe, the workflow
 * library (list/save/delete/run), the asset index, and the live ComfyUI
 * queue view. Writes are same-origin-only.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ComfyUIRuntime } from './tools.js';
import type { RouteGuard } from './route-guard.js';
/**
 * Mount every dsh-comfyui route on the host web server.
 * @returns the disposer, or undefined when no web server is present.
 */
export declare function mountComfyUIRoutes(ctx: Context, runtime: ComfyUIRuntime, guard?: RouteGuard): (() => void) | undefined;
