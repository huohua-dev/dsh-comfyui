/** File types a loader node can consume (lower-case, without the dot). */
export declare const UPLOAD_EXTENSIONS: ReadonlySet<string>;
/** Largest file the tool uploads (videos for continuation are the big case). */
export declare const MAX_UPLOAD_BYTES: number;
export type UploadKind = 'image' | 'audio' | 'video';
/** What the server answered for one upload, plus what the tool derived. */
export interface UploadResult {
    /** Server-side reference to put into a loader input: `subfolder/name` or `name`. */
    ref: string;
    name: string;
    subfolder: string;
    type: string;
    kind: UploadKind;
    bytes: number;
    /** Pixel size for images whose header could be read (recorded for size matching). */
    size?: {
        width: number;
        height: number;
    };
}
/** What the upload needs from the runtime (the tool passes the runtime itself). */
export interface UploadDeps {
    uploadInput(bytes: Uint8Array, filename: string, opts: {
        subfolder?: string;
        overwrite?: boolean;
    }): Promise<{
        name: string;
        subfolder: string;
        type: string;
    }>;
    saveMediaSize(name: string, size: {
        width: number;
        height: number;
    }): Promise<void>;
}
/** Validate an optional subfolder: '' for none, else one safe segment. */
export declare function parseUploadSubfolder(raw: unknown): string;
/**
 * Resolve the caller's path: absolute as given, relative against the session
 * working directory. A relative path without a session cwd is refused rather
 * than resolved against the DSH process directory, which the model cannot see.
 */
export declare function resolveUploadPath(raw: unknown, cwd: string | undefined): string;
/** Media kind from the file extension; undefined when the type is not allowed. */
export declare function uploadKindOfFile(name: string): UploadKind | undefined;
/** Content type for the multipart part (ComfyUI only looks at the name). */
export declare function uploadContentType(name: string): string;
/**
 * Pixel size from an image header (PNG, GIF, WebP, JPEG), without decoding.
 * The panel measures in the browser; the tool has no browser, and pulling in
 * an image library for four fixed header layouts is not worth it. JPEG EXIF
 * rotation is ignored (the stored size is the encoded one, as ComfyUI's
 * LoadImage before its own exif transpose). Undefined when unreadable.
 */
export declare function imageSizeOf(bytes: Uint8Array): {
    width: number;
    height: number;
} | undefined;
/**
 * Validate, read and upload one local file. Images additionally get their
 * pixel size recorded under the returned reference (the same store the panel
 * fills, so saved img2img-style workflows size-match on it).
 */
export declare function uploadLocalFile(deps: UploadDeps, input: {
    path: unknown;
    subfolder?: unknown;
    overwrite?: unknown;
    cwd: string | undefined;
}): Promise<UploadResult>;
