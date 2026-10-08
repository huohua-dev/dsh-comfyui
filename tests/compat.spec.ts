/**
 * DSH 0.2.0-rc.2 compatibility of the package manifest and the client bundle.
 * The peer check mirrors dsh-app-boot's evaluatePluginCompatibility: every
 * `@deepseek-ai/dsh*` peer must accept the running version with
 * `includePrerelease`, otherwise install/boot refuses the plugin unless an
 * allow-version exemption exists (which we must not need).
 */
import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import semver from 'semver'
import { Config, resolveConfig } from '../src/config.js'
// @ts-expect-error -- plain .mjs config module without types
import { PLATFORM_EXTERNALS } from '../tsdown.config.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  peerDependencies: Record<string, string>
  dsh: { client: { platform: string; inject: string[] } }
}

/** Same rule as dsh-app-boot evaluatePluginCompatibility (0.2.0-rc.2). */
function incompatiblePeers(peers: Record<string, string>, runtime: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (range.trim() === '' || !semver.satisfies(runtime, range, { includePrerelease: true })) out[name] = range
  }
  return out
}

describe('package manifest', () => {
  it('passes the host peer check on 0.2.0-rc.2 without an exemption', () => {
    expect(incompatiblePeers(pkg.peerDependencies, '0.2.0-rc.2')).toEqual({})
  })

  it('pins dsh peers to the 0.2 line (0.1 hosts are rejected loudly, not half-working)', () => {
    expect(Object.keys(incompatiblePeers(pkg.peerDependencies, '0.1.7-alpha.1'))).toContain('@deepseek-ai/dsh-settings')
  })

  it('keeps cordis on the 4.x host line', () => {
    expect(semver.satisfies('4.0.4', pkg.peerDependencies['@deepseek-ai/cordis']!)).toBe(true)
  })

  it('declares only client inject packages that exist in 0.2 and own the slots we use', () => {
    const inject = pkg.dsh.client.inject
    expect(inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    // Slot owners in 0.2.0-rc.2: tool.call.toolview → ui-tool, settings.section →
    // ui-settings-general, shell.overlay → ui-layout, session header actions → ui-conversation.
    expect(new Set(inject)).toEqual(new Set([
      '@deepseek-ai/dsh-client-ui-tool',
      '@deepseek-ai/dsh-client-ui-settings-general',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-conversation',
    ]))
    expect(pkg.dsh.client.platform).toBe('web')
  })
})

describe('client bundle', () => {
  const bundlePath = new URL('../client/client.js', import.meta.url)
  it.skipIf(!existsSync(bundlePath))('only requires modules from the 0.2 shell static table', () => {
    const code = readFileSync(bundlePath, 'utf8')
    expect(code).toMatch(/^window\.__ModuleLoader__\.load\(\{\s*id: "dsh-comfyui"/)
    const required = new Set([...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]))
    for (const name of required) expect(PLATFORM_EXTERNALS).toContain(name)
    expect(required.has('react')).toBe(true)
  })
})

describe('settings schema', () => {
  it('exposes the ComfyUI address as a described volatile field for the plugin page form', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean; description?: unknown } }> }).dict
    expect(dict.baseUrl!.meta.volatile).toBe(true)
    expect(dict.baseUrl!.meta.description).toBeTruthy()
    expect(dict.archiveDir!.meta.volatile).toBe(true)
    expect(dict.unreachableHint!.meta.volatile).toBe(true)
    // dataDir stays ordinary: the store is built from it at startup.
    expect(dict.dataDir!.meta.volatile).toBeFalsy()
  })

  it('parses an empty entry config to defaults', () => {
    // Volatile fields arrive as references; resolveConfig reads them back.
    const parsed = (Config as unknown as (value: unknown) => Record<string, unknown>)({})
    const resolved = resolveConfig(parsed, '/data')
    expect(resolved.baseUrl).toBe('http://127.0.0.1:8188')
    expect(resolved.archiveDir).toBe('')
    expect(resolved.unreachableHint).toContain('winmode.sh video')
  })
})
