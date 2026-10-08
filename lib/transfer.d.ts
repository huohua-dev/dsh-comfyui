import type { WorkflowParameter } from './params.js';
import { type StoredWorkflow } from './store.js';
import { type SkillPackResult, type WorkflowSkillPack } from './skillpack.js';
/** Marker plus layout version of the packages this module writes. */
export declare const PRESET_FORMAT = "dsh-comfyui-workflow-preset";
export declare const PRESET_VERSION = 1;
/** Hard cap on the uploaded archive (route-level check before parsing). */
export declare const MAX_IMPORT_BYTES: number;
/** One workflow record inside preset.json. */
export interface PresetWorkflow {
    /** Id in the EXPORTING library; import mints a fresh one. */
    id: string;
    name: string;
    description: string;
    tags?: string[];
    parameters?: WorkflowParameter[];
    requireSkill?: boolean;
    /** Skill-pack contents; null when the workflow has no pack (or it was unreadable). */
    skill: PresetSkillRef | null;
    workflow: Record<string, {
        class_type: string;
        inputs: Record<string, unknown>;
    }>;
}
/** What the panel and tools need to know about one archived pack. */
export interface PresetSkillRef {
    files: Array<{
        path: string;
        size: number;
    }>;
    /** Sub-directories, kept so empty ones survive the round trip. */
    dirs: string[];
}
/** The whole manifest. `count` mirrors `workflows.length` on export and is
 * recomputed (not trusted) on import. */
export interface PresetManifest {
    format: string;
    version: number;
    exportedAt: string;
    pluginVersion: string;
    count: number;
    workflows: PresetWorkflow[];
}
/** Structural slice of the runtime the transfer routes operate through. */
export interface TransferHost {
    listWorkflows(): Promise<StoredWorkflow[]>;
    getWorkflow(id: string): Promise<StoredWorkflow | undefined>;
    saveWorkflow(input: {
        name: string;
        description: string;
        workflow: unknown;
        parameters?: WorkflowParameter[];
        tags?: string[];
    }): Promise<{
        ok: true;
        workflow: StoredWorkflow;
    } | {
        ok: false;
        error: string;
    }>;
    skillPacks: {
        info(id: string): Promise<WorkflowSkillPack | undefined>;
        readRaw(id: string, path: string): Promise<SkillPackResult<{
            bytes: Buffer;
            contentType: string;
        }>>;
        enable(id: string): Promise<SkillPackResult<WorkflowSkillPack>>;
        disable(id: string): Promise<SkillPackResult<true>>;
        writeFile(id: string, path: string, content: string): Promise<SkillPackResult<WorkflowSkillPack>>;
        importFile(id: string, file: string, bytes: Buffer, bucket?: string): Promise<SkillPackResult<{
            path: string;
            pack: WorkflowSkillPack;
        }>>;
        importFiles(id: string, entries: ReadonlyArray<{
            path: string;
            bytes: Buffer;
        }>): Promise<SkillPackResult<WorkflowSkillPack>>;
        makeDir(id: string, name: string): Promise<SkillPackResult<WorkflowSkillPack>>;
        setRequired(id: string, required: boolean): Promise<SkillPackResult<WorkflowSkillPack>>;
    };
}
export type ExportResult = {
    ok: true;
    bytes: Uint8Array;
    filename: string;
    count: number;
    names: string[];
    warnings: string[];
} | {
    ok: false;
    error: string;
};
/** One listed workflow inside an analyzed package. */
export interface ImportCandidate {
    /** Position in the manifest; the apply call selects by this index, which
     * stays stable because the same bytes are parsed again. */
    index: number;
    id: string;
    name: string;
    description: string;
    tags: string[];
    paramCount: number;
    skill: {
        fileCount: number;
        totalBytes: number;
        required: boolean;
    } | null;
    /** Non-fatal problems already visible at analysis time. */
    warnings: string[];
}
export interface ImportAnalysis {
    version: number;
    exportedAt: string;
    pluginVersion: string;
    workflows: ImportCandidate[];
}
/** Per-workflow result of an import; `ok` entries carry their new identity. */
export interface ImportOutcome {
    index: number;
    name: string;
    ok: boolean;
    newName?: string;
    newId?: string;
    error?: string;
    warnings: string[];
}
/**
 * Build one preset package from the selected library workflows.
 * @param host - the runtime face (workflow store + skill packs).
 * @param ids - workflow ids to export; unknown ids are skipped with a warning.
 */
export declare function buildExportPackage(host: TransferHost, ids: unknown): Promise<ExportResult>;
/**
 * Analyze one uploaded package: list the workflows it offers, with per-item
 * warnings for anything that would fail at apply time. No disk writes.
 */
export declare function analyzeImportPackage(bytes: Buffer): {
    ok: true;
    analysis: ImportAnalysis;
} | {
    ok: false;
    error: string;
};
/**
 * Import the selected workflows from one uploaded package. Every workflow
 * becomes a NEW library record (fresh id, name suffixed on clash); skill
 * packs land in freshly slugged directories, so nothing on disk is reused
 * or overwritten.
 * @param selected - manifest indexes to import (as listed by analyze).
 */
export declare function applyImportPackage(host: TransferHost, bytes: Buffer, selected: unknown): Promise<{
    ok: true;
    results: ImportOutcome[];
    imported: number;
} | {
    ok: false;
    error: string;
}>;
