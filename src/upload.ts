/**
 * `comfyui_upload` support: put a file from the DSH machine into ComfyUI's
 * input directory so loader nodes (LoadImage / LoadAudio / LoadVideo) and
 * template parameters such as h3_r2v's `ref_image_1` can name it.
 *
 * Why a tool and not just the panel: reference-to-video runs are driven from
 * chat (character sheets, voice clips, the previous segment of a continuation
 * all live on disk), and ComfyUI may be on another machine, so a server-side
 * file name has to be produced without the user opening the panel.
 *
 * The path comes from the model and is therefore checked the same way any
 * untrusted input is: an extension allow-list (media only — this is not a
 * generic file exfiltration channel), a regular-file check, a size cap read
 * from `stat` before any bytes are loaded, and a single-segment subfolder
 * grammar so the server-side location cannot climb out of `input/`.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'

/** File types a loader node can consume (lower-case, without the dot). */
export const UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'wav', 'mp3', 'flac', 'ogg', 'm4a',
  'mp4', 'webm', 'mov', 'mkv',
])

/** Largest file the tool uploads (videos for continuation are the big case). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/** One subfolder segment under ComfyUI's input directory. */
const SUBFOLDER = /^[A-Za-z0-9_-]{1,64}$/

export type UploadKind = 'image' | 'audio' | 'video'

/** What the server answered for one upload, plus what the tool derived. */
export interface UploadResult {
  /** Server-side reference to put into a loader input: `subfolder/name` or `name`. */
  ref: string
  name: string
  subfolder: string
  type: string
  kind: UploadKind
  bytes: number
  /** Pixel size for images whose header could be read (recorded for size matching). */
  size?: { width: number; height: number }
}

/** What the upload needs from the runtime (the tool passes the runtime itself). */
export interface UploadDeps {
  uploadInput(bytes: Uint8Array, filename: string, opts: { subfolder?: string; overwrite?: boolean }): Promise<{ name: string; subfolder: string; type: string }>
  saveMediaSize(name: string, size: { width: number; height: number }): Promise<void>
}

/** Validate an optional subfolder: '' for none, else one safe segment. */
export function parseUploadSubfolder(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string' || !SUBFOLDER.test(raw)) {
    throw new Error('comfyui_upload: subfolder 只能是一层目录名（字母、数字、下划线、连字符，最长 64 字符）')
  }
  return raw
}

/**
 * Resolve the caller's path: absolute as given, relative against the session
 * working directory. A relative path without a session cwd is refused rather
 * than resolved against the DSH process directory, which the model cannot see.
 */
export function resolveUploadPath(raw: unknown, cwd: string | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('comfyui_upload: path 必填')
  if (raw.includes('\0')) throw new Error('comfyui_upload: path 含非法字符')
  if (isAbsolute(raw)) return resolve(raw)
  if (cwd === undefined || cwd === '') throw new Error('comfyui_upload: 当前会话没有工作目录，请传绝对路径')
  return resolve(cwd, raw)
}

/** Media kind from the file extension; undefined when the type is not allowed. */
export function uploadKindOfFile(name: string): UploadKind | undefined {
  const ext = extname(name).slice(1).toLowerCase()
  if (!UPLOAD_EXTENSIONS.has(ext)) return undefined
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image'
  if (['wav', 'mp3', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio'
  return 'video'
}

/** Content type for the multipart part (ComfyUI only looks at the name). */
export function uploadContentType(name: string): string {
  const ext = extname(name).slice(1).toLowerCase()
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  }
  return types[ext] ?? 'application/octet-stream'
}

/**
 * Pixel size from an image header (PNG, GIF, WebP, JPEG), without decoding.
 * The panel measures in the browser; the tool has no browser, and pulling in
 * an image library for four fixed header layouts is not worth it. JPEG EXIF
 * rotation is ignored (the stored size is the encoded one, as ComfyUI's
 * LoadImage before its own exif transpose). Undefined when unreadable.
 */
export function imageSizeOf(bytes: Uint8Array): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, length: number): string =>
    offset + length <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : ''
  const ok = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined
  // PNG: signature, then the IHDR chunk with big-endian width/height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && ascii(12, 4) === 'IHDR') {
    return ok(view.getUint32(16), view.getUint32(20))
  }
  // GIF: logical screen size, little-endian.
  if (bytes.length >= 10 && ascii(0, 4) === 'GIF8') {
    return ok(view.getUint16(6, true), view.getUint16(8, true))
  }
  // WebP: RIFF container, first chunk decides the layout.
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4)
    if (chunk === 'VP8 ') return ok(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff)
    if (chunk === 'VP8L') {
      const b0 = bytes[21]!
      const b1 = bytes[22]!
      const b2 = bytes[23]!
      const b3 = bytes[24]!
      return ok(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)))
    }
    if (chunk === 'VP8X') {
      const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
      return ok(1 + u24(24), 1 + u24(27))
    }
    return undefined
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker === 0xff) { offset += 1; continue } // fill byte
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isFrame) return ok(view.getUint16(offset + 7), view.getUint16(offset + 5))
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  return undefined
}

/**
 * Validate, read and upload one local file. Images additionally get their
 * pixel size recorded under the returned reference (the same store the panel
 * fills, so saved img2img-style workflows size-match on it).
 */
export async function uploadLocalFile(deps: UploadDeps, input: {
  path: unknown
  subfolder?: unknown
  overwrite?: unknown
  cwd: string | undefined
}): Promise<UploadResult> {
  const subfolder = parseUploadSubfolder(input.subfolder)
  if (input.overwrite !== undefined && typeof input.overwrite !== 'boolean') {
    throw new Error('comfyui_upload: overwrite 必须是 true / false')
  }
  const path = resolveUploadPath(input.path, input.cwd)
  const name = basename(path)
  const kind = uploadKindOfFile(name)
  if (kind === undefined) {
    throw new Error(`comfyui_upload: 不支持的文件类型 ${extname(name) || '（无扩展名）'}，只接受 ${[...UPLOAD_EXTENSIONS].join(' / ')}`)
  }
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) throw new Error(`comfyui_upload: 找不到文件 ${path}`)
  if (!info.isFile()) throw new Error(`comfyui_upload: ${path} 不是普通文件`)
  if (info.size === 0) throw new Error(`comfyui_upload: ${path} 是空文件`)
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`comfyui_upload: 文件 ${Math.round(info.size / 1024 / 1024)}MB，超过上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`)
  }
  const bytes = new Uint8Array(await readFile(path))
  const uploaded = await deps.uploadInput(bytes, name, {
    ...(subfolder !== '' ? { subfolder } : {}),
    overwrite: input.overwrite === true,
  })
  const serverName = uploaded.name !== '' ? uploaded.name : name
  const serverSubfolder = uploaded.subfolder
  const ref = serverSubfolder !== '' ? `${serverSubfolder}/${serverName}` : serverName
  const size = kind === 'image' ? imageSizeOf(bytes) : undefined
  if (size !== undefined) await deps.saveMediaSize(ref, size).catch(() => undefined)
  return {
    ref,
    name: serverName,
    subfolder: serverSubfolder,
    type: uploaded.type !== '' ? uploaded.type : 'input',
    kind,
    bytes: bytes.length,
    ...(size !== undefined ? { size } : {}),
  }
}
