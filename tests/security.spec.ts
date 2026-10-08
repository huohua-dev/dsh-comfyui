/**
 * Route protection (dsh-image-gen / DSH isTrustedApiRequest rules) and media
 * path-traversal defenses, exercised over real HTTP against the plugin.
 */
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkViewRef } from '../src/proxy.js'
import { isLoopbackHostname, rejectUntrusted } from '../src/route-guard.js'
import type { RunMeta } from '../src/archive.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { AUTH_COOKIE, bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

/** Raw request so Host / Origin / Sec-Fetch-Site can be set freely. */
function raw(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, setHost: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('rejectUntrusted', () => {
  const req = (headers: Record<string, string>) => ({ headers } as never)
  it('accepts loopback hosts with no or matching Origin', () => {
    expect(rejectUntrusted(req({ host: '127.0.0.1:19387' }))).toBeUndefined()
    expect(rejectUntrusted(req({ host: 'localhost:19387', origin: 'http://localhost:19387', 'sec-fetch-site': 'same-origin' }))).toBeUndefined()
    expect(rejectUntrusted(req({ host: '[::1]:8080' }))).toBeUndefined()
  })
  it('refuses rebinding hosts, cross-site fetches, foreign origins and odd hosts', () => {
    expect(rejectUntrusted(req({ host: 'evil.example:19387' }))?.reason).toBe('host-rejected')
    expect(rejectUntrusted(req({ host: '192.0.2.10:19387' }))?.reason).toBe('host-rejected')
    expect(rejectUntrusted(req({}))?.reason).toBe('host-rejected')
    expect(rejectUntrusted(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' }))?.reason).toBe('cross-site')
    expect(rejectUntrusted(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:9999' }))?.reason).toBe('origin-rejected')
    expect(rejectUntrusted(req({ host: '127.0.0.1:19387', origin: 'null' }))?.reason).toBe('origin-rejected')
    expect(rejectUntrusted(req({ host: 'user@127.0.0.1' }))?.reason).toBe('host-rejected')
  })
  it('knows the loopback set', () => {
    expect(isLoopbackHostname('127.10.0.1')).toBe(true)
    expect(isLoopbackHostname('127.0.0.256')).toBe(false)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
  })
})

describe('checkViewRef', () => {
  it('passes plain output references', () => {
    expect(checkViewRef({ filename: 'a.mp4', subfolder: 'video', type: 'output' })).toBeUndefined()
    expect(checkViewRef({ filename: 'a.png', subfolder: '', type: 'temp' })).toBeUndefined()
    expect(checkViewRef({ filename: 'a.png', subfolder: 'minimax_h3/ref', type: 'input' })).toBeUndefined()
  })
  it.each([
    [{ filename: 'a.mp4', subfolder: '', type: 'models' }],
    [{ filename: 'a.mp4', subfolder: '../..', type: 'output' }],
    [{ filename: 'a.mp4', subfolder: 'video/../../x', type: 'output' }],
    [{ filename: 'a.mp4', subfolder: '/etc', type: 'output' }],
    [{ filename: 'a.mp4', subfolder: 'C:/Windows', type: 'output' }],
    [{ filename: 'a.mp4', subfolder: '..\\\\..', type: 'output' }],
    [{ filename: '../secret.txt', subfolder: '', type: 'output' }],
    [{ filename: 'x/../../y', subfolder: '', type: 'output' }],
    [{ filename: 'a\\\\b.mp4', subfolder: '', type: 'output' }],
    [{ filename: '.env', subfolder: '', type: 'output' }],
    [{ filename: 'a\u0000.mp4', subfolder: '', type: 'output' }],
    [{ filename: '', subfolder: '', type: 'output' }],
  ])('refuses %j', (ref) => {
    expect(checkViewRef(ref)).toBeDefined()
  })
})

describe('guarded routes over HTTP', () => {
  let comfy: FakeComfy
  let host: FakeHost
  let archiveDir: string
  let promptId: string

  beforeEach(async () => {
    comfy = await startFakeComfy()
    archiveDir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-sec-'))
    host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 50, archiveDir })
    const value = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'x' }, mode: 'async' }) as { jobId: string; promptId: string }
    await delay(20)
    comfy.startNext()
    comfy.finishRunning(Buffer.from('VIDEO'))
    await host.jobs.jobs.get(value.jobId)!.settled
    promptId = value.promptId
  })
  afterEach(async () => {
    await host.dispose()
    await comfy.close()
  })

  const ok = () => ({ host: `127.0.0.1:${host.port}`, cookie: AUTH_COOKIE })
  const archivePath = () => `/comfyui/archive/${promptId}/14-0-dsh_00001_.mp4`

  it('serves the page itself (loopback host, session cookie, same-origin)', async () => {
    expect((await raw(host.port, archivePath(), { ...ok(), 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await raw(host.port, '/comfyui/workflows', { ...ok(), origin: `http://127.0.0.1:${host.port}` })).status).toBe(200)
  })

  it.each([
    ['/comfyui/workflows'],
    ['/comfyui/config'],
    ['/comfyui/assets'],
    ['/comfyui/jobs/media?promptId=x'],
    ['/comfyui/media?file=a.mp4&subfolder=video&type=output'],
    ['/comfyui/ping'],
  ])('protects %s: rebinding host, cross-site, foreign origin, missing session', async (path) => {
    expect((await raw(host.port, path, { ...ok(), host: `evil.example:${host.port}` })).status).toBe(403)
    expect((await raw(host.port, path, { ...ok(), 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await raw(host.port, path, { ...ok(), origin: 'https://evil.example' })).status).toBe(403)
    expect((await raw(host.port, path, { host: `127.0.0.1:${host.port}` })).status).toBe(401)
  })

  it('protects writes the same way (no Origin is no longer a free pass from a foreign host)', async () => {
    const res = await raw(host.port, '/comfyui/jobs/actions', { host: `attacker.test:${host.port}`, cookie: AUTH_COOKIE, 'content-type': 'application/json' }, 'POST')
    expect(res.status).toBe(403)
  })

  it.each([
    ['%2e%2e/meta.json'],
    ['..%2f..%2fetc%2fpasswd'],
    ['meta.json'],
    ['14-0-dsh_00001_.mp4%2f..%2f..%2fmeta.json'],
    ['..%5c..%5cmeta.json'],
    ['.%2e'],
  ])('archive route refuses traversal name %s', async (name) => {
    const res = await raw(host.port, `/comfyui/archive/${promptId}/${name}`, ok())
    expect([400, 404]).toContain(res.status)
    expect(res.body).not.toContain('"promptId"')
  })

  it('archive route refuses non-UUID run ids and extra path segments', async () => {
    for (const path of [
      '/comfyui/archive/../../etc/passwd',
      `/comfyui/archive/%2e%2e/${promptId}/14-0-dsh_00001_.mp4`,
      '/comfyui/archive/not-a-uuid/14-0-dsh_00001_.mp4',
      `/comfyui/archive/${promptId}/video/14-0-dsh_00001_.mp4`,
      `/comfyui/archive/${promptId}`,
    ]) {
      expect((await raw(host.port, path, ok())).status).toBe(404)
    }
  })

  it('does not follow a symlink planted in a run directory, even if meta.json lists it', async () => {
    const dir = join(archiveDir, promptId)
    const secret = join(archiveDir, 'secret.txt')
    await writeFile(secret, 'TOP SECRET')
    await symlink(secret, join(dir, '14-1-link.mp4'))
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RunMeta
    meta.files.push({ ...meta.files[0]!, name: '14-1-link.mp4', index: 1 })
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
    const res = await raw(host.port, `/comfyui/archive/${promptId}/14-1-link.mp4`, ok())
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('TOP SECRET')
  })

  it('media proxy refuses traversal before anything reaches ComfyUI', async () => {
    comfy.log.length = 0
    for (const query of [
      'file=a.mp4&subfolder=..%2F..&type=output',
      'file=..%2F..%2Fcomfy.settings.json&subfolder=&type=output',
      'file=a.mp4&subfolder=%2Fetc&type=output',
      'file=a.mp4&subfolder=..%5C..&type=output',
      'file=extra_model_paths.yaml&subfolder=&type=..',
      'file=x.safetensors&subfolder=&type=models',
    ]) {
      expect((await raw(host.port, `/comfyui/media?${query}`, ok())).status).toBe(400)
    }
    expect(comfy.log.filter((entry) => entry.path.startsWith('/view'))).toEqual([])
  })
})

describe('without the host Connection service', () => {
  it('falls back to the loopback/origin fence alone', async () => {
    const comfy = await startFakeComfy()
    const host = await bootPlugin({ baseUrl: comfy.url }, { connection: false })
    try {
      expect((await raw(host.port, '/comfyui/workflows', { host: `127.0.0.1:${host.port}` })).status).toBe(200)
      expect((await raw(host.port, '/comfyui/workflows', { host: `evil.example:${host.port}` })).status).toBe(403)
    } finally {
      await host.dispose()
      await comfy.close()
    }
  })
})
