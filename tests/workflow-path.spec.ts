/** Offline regressions for #29: identity must retain subdirectories end to end. */
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeWorkflowPath, workflowEntryPath } from '../src/workflow-path.js'
import { ComfyUIStore } from '../src/store.js'
import { bootPlugin, type FakeHost } from './fake-host.js'

const unsafe = ['../x.json', 'a/../x.json', './x.json', '/x.json', '\\x.json', 'C:\\x.json',
  'C:x.json', '\\\\server\\x.json', 'a//x.json', 'a/./x.json', 'a/.. /x.json', 'x\0.json',
  'workflows/../../x.json', 'a/%2e%2e/x.json', '%252e%252e/x.json', 'a%2fx.json',
  '.index.json', 'a/.index.json', '.hidden/x.json', '', 'a/', 'x.txt']

describe('workflow path identity', () => {
  it.each([
    ['x.json', 'x.json'], ['a/x.json', 'a/x.json'], ['workflows/a/x.json', 'workflows/a/x.json'],
    ['a\\x.json', 'a/x.json'], ['workflows\\a\\x.json', 'workflows/a/x.json'], ['中文/a b.json', '中文/a b.json'],
  ])('normalizes %s', (input, expected) => expect(normalizeWorkflowPath(input)).toBe(expected))
  it.each(unsafe)('rejects %s', (input) => expect(normalizeWorkflowPath(input)).toBeUndefined())
  it('prefers v2 path and falls back only for absent legacy path', () => {
    expect(workflowEntryPath({ name: 'x.json', path: 'workflows/a/x.json' })).toBe('a/x.json')
    expect(workflowEntryPath({ name: 'a\\x.json' })).toBe('a/x.json')
    expect(workflowEntryPath({ name: 'safe.json', path: '../x.json' })).toBeUndefined()
  })
})

const graph = {
  nodes: [
    { id: 1, type: 'Source', inputs: [], outputs: [{ name: 'value', type: 'STRING', links: [1] }], widgets_values: [] },
    { id: 2, type: 'Sink', inputs: [{ name: 'value', type: 'STRING', link: 1 }], outputs: [], widgets_values: [] },
  ], links: [[1, 1, 0, 2, 0, 'STRING']],
}
const objectInfo = {
  Source: { input: { required: {} }, output: ['STRING'] },
  Sink: { input: { required: { value: ['STRING'] } }, output: [], output_node: true },
}
type Listed = { name: string; extracted: boolean; derived: Array<{ libraryId: string }> }

describe('workflow list → get/analyze/extract over HTTP', () => {
  let server: Server
  let host: FakeHost
  let listing: unknown[]
  let legacy: boolean
  let reads: string[]
  beforeEach(async () => {
    listing = [
      { name: 'same.json', path: 'workflows/a/same.json', type: 'file' },
      { name: 'same.json', path: 'workflows\\b\\same.json', type: 'file' },
      { name: 'top.json', path: 'workflows/top.json', type: 'file' },
      { name: 'old\\same.json', type: 'file' },
      { name: 'same.json', path: 'workflows/workflows/same.json', type: 'file' },
      ...unsafe.map((path) => ({ name: 'safe.json', path, type: 'file' })),
      { name: 'directory.json', path: 'workflows/directory.json', type: 'directory' },
    ]
    legacy = false
    reads = []
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      res.setHeader('content-type', 'application/json')
      if (url.pathname.endsWith('/v2/userdata')) {
        if (legacy) { res.writeHead(404); res.end('{}'); return }
        res.end(JSON.stringify(listing)); return
      }
      if (url.pathname === '/userdata') { res.end(JSON.stringify(listing)); return }
      if (url.pathname === '/object_info') { res.end(JSON.stringify(objectInfo)); return }
      if (url.pathname.startsWith('/userdata/')) {
        const path = decodeURIComponent(url.pathname.slice('/userdata/'.length))
        reads.push(path)
        if (['a/same.json', 'b/same.json', 'top.json', 'old/same.json', 'workflows/same.json'].some((file) => path === `workflows/${file}`)) {
          res.end(JSON.stringify({ ...graph, file: path })); return
        }
      }
      res.writeHead(404); res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    host = await bootPlugin({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  })
  afterEach(async () => {
    await host?.dispose()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const list = async (): Promise<Listed[]> => ((await (await host.fetch('/comfyui/comfy-workflows')).json()) as { workflows: Listed[] }).workflows
  const extract = async (file: string) => host.fetch('/comfyui/comfy-workflows/extract', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: host.origin }, body: JSON.stringify({ file, mode: 'all' }),
  })

  it('keeps identical basenames distinct and normalizes existing provenance without rewriting it', async () => {
    const store = new ComfyUIStore(host.dataDir, 100)
    for (const file of ['a\\same.json', 'b/same.json', 'top.json', '../same.json']) {
      await store.saveWorkflow({ name: file, description: '', workflow: { '1': { class_type: 'Source', inputs: {} } }, source: 'comfyui', comfyuiFile: file })
    }
    const before = await readFile(join(host.dataDir, 'workflows.json'), 'utf8')
    const files = await list()
    expect(files.map((f) => f.name)).toEqual(['a/same.json', 'b/same.json', 'top.json', 'old/same.json', 'workflows/same.json'])
    expect(files.map((f) => f.derived.length)).toEqual([1, 1, 1, 0, 0])
    expect(files[0]!.derived[0]!.libraryId).not.toBe(files[1]!.derived[0]!.libraryId)
    expect(await readFile(join(host.dataDir, 'workflows.json'), 'utf8')).toBe(before)
    const tool = await host.call('comfyui_workflow', { action: 'list' }) as { comfyuiWorkflows: Listed[] }
    expect(tool.comfyuiWorkflows.map((f) => f.name)).toEqual(files.map((f) => f.name))
  })

  it.each(['a/same.json', 'b/same.json', 'b\\same.json', 'top.json', 'workflows/same.json'])('reads, analyzes and extracts %s', async (file) => {
    const relative = normalizeWorkflowPath(file)!
    const view = await (await host.fetch(`/comfyui/comfy-workflows?file=${encodeURIComponent(file)}`)).json() as { ok: boolean; workflow: { file: string } }
    expect(view.workflow.file).toBe(`workflows/${relative}`)
    const analysis = await (await host.fetch(`/comfyui/comfy-workflows/analyze?file=${encodeURIComponent(file)}`)).json() as { analysis: { ok: boolean } }
    expect(analysis.analysis.ok).toBe(true)
    const response = await extract(file)
    expect(response.status).toBe(200)
    const result = await response.json() as { saved: Array<{ comfyuiFile: string }> }
    expect(result.saved[0]!.comfyuiFile).toBe(relative)
    expect((await list()).find((f) => f.name === relative)?.extracted).toBe(true)
    expect(reads).toEqual(Array(3).fill(`workflows/${relative}`))
  })

  it('rejects malicious and bookkeeping paths on every read surface before remote requests', async () => {
    for (const file of unsafe) {
      const view = await (await host.fetch(`/comfyui/comfy-workflows?file=${encodeURIComponent(file)}`)).json() as { ok: boolean; workflow: { file: string } }
      expect(view.ok).toBe(false)
      const analyze = await host.fetch(`/comfyui/comfy-workflows/analyze?file=${encodeURIComponent(file)}`)
      expect(((await analyze.json()) as { ok?: boolean }).ok).not.toBe(true)
      expect((await extract(file)).status).toBeGreaterThanOrEqual(400)
    }
    expect(reads).toEqual([])
  })

  it.each([false, true])('supports old string listings (v1 fallback: %s)', async (fallback) => {
    legacy = fallback
    listing = ['a\\same.json', 'b/same.json', 'top.json', '../bad.json', '/bad.json']
    expect((await list()).map((f) => f.name)).toEqual(['a/same.json', 'b/same.json', 'top.json'])
  })
  it('never aliases provenance in a real workflows subdirectory to a top-level file', async () => {
    listing = [
      { name: 'same.json', path: 'workflows/same.json', type: 'file' },
      { name: 'same.json', path: 'workflows/workflows/same.json', type: 'file' },
    ]
    const store = new ComfyUIStore(host.dataDir, 100)
    await store.saveWorkflow({ name: 'nested', description: '', workflow: { '1': { class_type: 'Source', inputs: {} } }, source: 'comfyui', comfyuiFile: 'workflows\\same.json' })
    expect((await list()).map((f) => f.extracted)).toEqual([false, true])
    listing.pop() // A deleted/hidden nested file is not evidence for a legacy alias.
    expect((await list()).map((f) => f.extracted)).toEqual([false])
  })

  it('supports legacy full_info relative paths', async () => {
    legacy = true
    listing = [{ path: 'a/same.json', size: 12 }, { path: 'b/same.json' }, { path: '../bad.json' }]
    expect((await list()).map((f) => f.name)).toEqual(['a/same.json', 'b/same.json'])
  })
})
