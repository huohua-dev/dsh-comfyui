/**
 * dsh-comfyui host entry: wires the tools, HTTP routes, and media proxy, and
 * registers the `comfyui:` settings section so the browser settings page can
 * persist config without editing cordis.yml. Everything unmounts with the
 * plugin fiber.
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as ConfigType } from './config.js';
export declare const name = "dsh-comfyui";
export { Config };
/**
 * Required services. `tools` is the model-facing registry the plugin writes
 * into, so the fiber must wait for it: reading `ctx.tools` without declaring
 * it here is what cordis rejects with `cannot get property "tools" without
 * inject`. `webServer`, `settings`, and `credentials` stay OUT of this list —
 * they are optional, and the plugin degrades gracefully without them (see
 * apply).
 */
export declare const inject: string[];
/**
 * The plugin body. The loader validates the entry config against `Config`
 * (defaults applied), then hands the resolved object to apply.
 */
export declare function apply(ctx: Context, entryConfig: Partial<Record<keyof ConfigType, unknown>>): Promise<void>;
