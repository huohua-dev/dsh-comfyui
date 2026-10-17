/**
 * DSH 0.2 compatibility of the package manifest and the client bundle.
 * The peer check mirrors dsh-app-boot's evaluatePluginCompatibility: every
 * `@deepseek-ai/dsh*` peer must accept the running version with
 * `includePrerelease`, otherwise install/boot refuses the plugin unless an
 * allow-version exemption exists (which we must not need).
 *
 * Host releases we build and boot against. A hard pin here is what made
 * 0.6.2 uninstallable on DSH 0.2.1-rc.1, so the dsh peers carry a range and
 * every host release we test is listed below.
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
  devDependencies: Record<string, string>
  dsh: { client: { platform: string; inject: string[] } }
}

/** DSH host releases this plugin is verified against. */
const SUPPORTED_HOSTS = ['0.2.0-rc.2', '0.2.1-rc.1']

/** Same rule as dsh-app-boot evaluatePluginCompatibility (0.2 line). */
function incompatiblePeers(peers: Record<string, string>, runtime: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (range.trim() === '' || !semver.satisfies(runtime, range, { includePrerelease: true })) out[name] = range
  }
  return out
}

describe('package manifest', () => {
  it.each(SUPPORTED_HOSTS)('passes the host peer check on %s without an exemption', (host) => {
    expect(incompatiblePeers(pkg.peerDependencies, host)).toEqual({})
  })

  it('declares dsh peers as a range, never a single-version pin', () => {
    // A pin turns every host patch release into a hard install refusal on a
    // plugin whose API surface did not change (that is exactly how 0.6.2 was
    // rejected by DSH 0.2.1-rc.1).
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      expect(semver.validRange(range), `${name} peer range`).not.toBeNull()
      expect(range, `${name} peer range`).toMatch(/[\^~><=| ]|\|\|/)
    }
  })

  it('builds and tests against the newest host it accepts', () => {
    const tested = pkg.devDependencies['@deepseek-ai/dsh-settings']!
    expect(Object.keys(incompatiblePeers(pkg.peerDependencies, tested))).toEqual([])
  })

  it('pins dsh peers to the 0.2 line (0.1 hosts are rejected loudly, not half-working)', () => {
    for (const host of ['0.1.7-alpha.1', '0.1.7-rc.2', '0.1.6-alpha.2']) {
      expect(Object.keys(incompatiblePeers(pkg.peerDependencies, host))).toContain('@deepseek-ai/dsh-settings')
    }
  })

  it('stops at the 0.2 line (an unvetted 0.3 host is refused, not guessed at)', () => {
    expect(Object.keys(incompatiblePeers(pkg.peerDependencies, '0.3.0-alpha.1'))).toContain('@deepseek-ai/dsh-settings')
  })

  it('keeps cordis on the 4.x host line', () => {
    const range = pkg.peerDependencies['@deepseek-ai/cordis']!
    for (const version of ['4.0.1', '4.0.4', '4.0.5']) {
      expect(semver.satisfies(version, range), version).toBe(true)
    }
    expect(semver.satisfies('5.0.0', range)).toBe(false)
  })

  it('declares only client inject packages that exist in 0.2 and own the slots we use', () => {
    const inject = pkg.dsh.client.inject
    expect(inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    // Slot owners in 0.2.0-rc.2: tool.call.toolview → ui-tool, settings.section →
    // ui-settings-general, shell.overlay → ui-layout, session header actions → ui-conversation,
    // conversation.chat.turnTail → ui-chat (the Turn-tail media wall).
    expect(new Set(inject)).toEqual(new Set([
      '@deepseek-ai/dsh-client-ui-tool',
      '@deepseek-ai/dsh-client-ui-settings-general',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-chat',
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
