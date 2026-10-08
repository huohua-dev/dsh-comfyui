/** comfyui_upload: path / extension / subfolder validation, header sizes, and the fake-comfy round trip. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_UPLOAD_BYTES, imageSizeOf, parseUploadSubfolder, resolveUploadPath, uploadKindOfFile, uploadLocalFile, type UploadDeps,
} from '../src/upload.js'
import type { Workflow } from '../src/params.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

/** A minimal PNG: signature + IHDR (CRC is not checked by the sniffer). */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13)
  bytes.write('GIF89a', 0, 'ascii')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return bytes
}

/** JPEG with an APP0 segment before the baseline SOF0 frame header. */
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, 2 payload bytes
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ])
}

function webpVp8x(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

describe('upload validation', () => {
  it('accepts one plain subfolder segment only', () => {
    expect(parseUploadSubfolder(undefined)).toBe('')
    expect(parseUploadSubfolder('')).toBe('')
    expect(parseUploadSubfolder('sparkle_refs-2')).toBe('sparkle_refs-2')
    for (const bad of ['../x', 'a/b', 'a\\b', '.', '..', 'a b', '中文', 'x'.repeat(65), 3, {}]) {
      expect(() => parseUploadSubfolder(bad)).toThrow(/subfolder/)
    }
  })

  it('resolves absolute paths as given and relative ones against the session cwd only', () => {
    expect(resolveUploadPath('/data/refs/a.png', undefined)).toBe('/data/refs/a.png')
    expect(resolveUploadPath('refs/../refs/a.png', '/work/session')).toBe('/work/session/refs/a.png')
    expect(() => resolveUploadPath('refs/a.png', undefined)).toThrow(/绝对路径/)
    expect(() => resolveUploadPath('', '/work')).toThrow(/path 必填/)
    expect(() => resolveUploadPath(42, '/work')).toThrow(/path 必填/)
    expect(() => resolveUploadPath('a\0.png', '/work')).toThrow(/非法字符/)
  })

  it('classifies the allow-listed extensions and nothing else', () => {
    expect(uploadKindOfFile('a.PNG')).toBe('image')
    expect(uploadKindOfFile('a.jpeg')).toBe('image')
    expect(uploadKindOfFile('v.m4a')).toBe('audio')
    expect(uploadKindOfFile('clip.mkv')).toBe('video')
    expect(uploadKindOfFile('clip.mov')).toBe('video')
    for (const bad of ['notes.txt', 'run.sh', 'a.svg', 'noext', 'archive.png.zip', '.env']) expect(uploadKindOfFile(bad)).toBeUndefined()
  })

  it('reads pixel sizes from PNG / GIF / JPEG / WebP headers', () => {
    expect(imageSizeOf(png(1024, 1536))).toEqual({ width: 1024, height: 1536 })
    expect(imageSizeOf(gif(320, 240))).toEqual({ width: 320, height: 240 })
    expect(imageSizeOf(jpeg(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageSizeOf(webpVp8x(4000, 3000))).toEqual({ width: 4000, height: 3000 })
    expect(imageSizeOf(Buffer.from('not an image at all, just text'))).toBeUndefined()
    expect(imageSizeOf(new Uint8Array(0))).toBeUndefined()
  })
})

describe('uploadLocalFile', () => {
  let dir: string
  const calls: Array<{ filename: string; opts: unknown; size: number }> = []
  const sizes = new Map<string, unknown>()
  const deps: UploadDeps = {
    async uploadInput(bytes, filename, opts) {
      calls.push({ filename, opts, size: bytes.length })
      return { name: filename, subfolder: opts.subfolder ?? '', type: 'input' }
    },
    async saveMediaSize(name, size) { sizes.set(name, size) },
  }
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-comfyui-upload-'))
    calls.length = 0
    sizes.clear()
  })

  it('uploads an image, returns subfolder/name and records its size', async () => {
    await writeFile(join(dir, 'turnaround.png'), png(1024, 1536))
    const result = await uploadLocalFile(deps, { path: 'turnaround.png', subfolder: 'sparkle', cwd: dir })
    expect(result).toMatchObject({ ref: 'sparkle/turnaround.png', kind: 'image', size: { width: 1024, height: 1536 } })
    expect(calls[0]).toMatchObject({ filename: 'turnaround.png', opts: { subfolder: 'sparkle', overwrite: false } })
    expect(sizes.get('sparkle/turnaround.png')).toEqual({ width: 1024, height: 1536 })
  })

  it('rejects disallowed types before touching the disk, then missing files, directories, empty and oversized files', async () => {
    await expect(uploadLocalFile(deps, { path: join(dir, 'secret.txt'), cwd: undefined })).rejects.toThrow(/不支持的文件类型/)
    await expect(uploadLocalFile(deps, { path: join(dir, 'missing.wav'), cwd: undefined })).rejects.toThrow(/找不到文件/)
    await mkdir(join(dir, 'folder.mp4'))
    await expect(uploadLocalFile(deps, { path: join(dir, 'folder.mp4'), cwd: undefined })).rejects.toThrow(/不是普通文件/)
    await writeFile(join(dir, 'empty.wav'), '')
    await expect(uploadLocalFile(deps, { path: join(dir, 'empty.wav'), cwd: undefined })).rejects.toThrow(/空文件/)
    const big = join(dir, 'huge.mp4')
    await writeFile(big, '')
    await truncate(big, MAX_UPLOAD_BYTES + 1) // sparse: no real 200 MB written
    await expect(uploadLocalFile(deps, { path: big, cwd: undefined })).rejects.toThrow(/超过上限/)
    await expect(uploadLocalFile(deps, { path: join(dir, 'a.png'), subfolder: '../input', cwd: undefined })).rejects.toThrow(/subfolder/)
    await expect(uploadLocalFile(deps, { path: join(dir, 'a.png'), overwrite: 'yes', cwd: undefined })).rejects.toThrow(/overwrite/)
    expect(calls).toEqual([])
  })
})

describe('comfyui_upload through the plugin', () => {
  let comfy: FakeComfy
  let host: FakeHost
  let cwd: string
  beforeEach(async () => {
    comfy = await startFakeComfy()
    host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 100 })
    cwd = await mkdtemp(join(tmpdir(), 'dsh-comfyui-session-'))
  })
  afterEach(async () => {
    await host.dispose()
    await comfy.close()
  })

  const session = () => ({ session: { header: { cwd } } })

  it('is registered next to the other tools', () => {
    expect([...host.tools.keys()]).toContain('comfyui_upload')
  })

  it('puts the bytes into input/<subfolder>/, records the size, and the ref runs h3_r2v', async () => {
    const bytes = png(768, 1344)
    await mkdir(join(cwd, 'refs'))
    await writeFile(join(cwd, 'refs', 'sheet.png'), bytes)
    const first = await host.call('comfyui_upload', { path: 'refs/sheet.png', subfolder: 'sparkle' }, undefined, session()) as { ref: string; size?: unknown }
    expect(first.ref).toBe('sparkle/sheet.png')
    expect(comfy.files.get('input/sparkle/sheet.png')?.equals(bytes)).toBe(true)
    expect(comfy.log.find((entry) => entry.path === '/upload/image')?.body).toMatchObject({ filename: 'sheet.png', subfolder: 'sparkle', overwrite: false })
    const recorded = JSON.parse(await readFile(join(host.dataDir, 'media-sizes.json'), 'utf8')) as Record<string, unknown>
    expect(JSON.stringify(recorded)).toContain('sparkle/sheet.png')
    expect(host.tools.get('comfyui_upload')!.output.render({}, first)[0]!.text).toContain('sparkle/sheet.png')

    // Same name again: the server renames unless overwrite is asked for.
    const second = await host.call('comfyui_upload', { path: join(cwd, 'refs', 'sheet.png'), subfolder: 'sparkle' }, undefined, session()) as { ref: string }
    expect(second.ref).toBe('sparkle/sheet (1).png')
    const third = await host.call('comfyui_upload', { path: 'refs/sheet.png', subfolder: 'sparkle', overwrite: true }, undefined, session()) as { ref: string }
    expect(third.ref).toBe('sparkle/sheet.png')

    const run = await host.call('comfyui_run', { template: 'h3_r2v', parameters: { prompt: 'p', ref_image_1: first.ref }, mode: 'async' }) as { jobId: string }
    await delay(50)
    const submitted = comfy.log.find((entry) => entry.path === '/prompt')!.body as { prompt: Workflow }
    expect(submitted.prompt['20']!.inputs.image).toBe('sparkle/sheet.png')
    // A reference image never resizes the canvas, even with a recorded size.
    expect(submitted.prompt['5']!.inputs).toMatchObject({ width: 480, height: 864 })
    await host.jobs.kill(run.jobId)
  })

  it('refuses a relative path when the session has no working directory', async () => {
    await expect(host.call('comfyui_upload', { path: 'refs/sheet.png' })).rejects.toThrow(/绝对路径/)
    expect(comfy.log.some((entry) => entry.path === '/upload/image')).toBe(false)
  })
})
