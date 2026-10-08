/**
 * Library edits the agent performs from chat (`comfyui_workflow` save /
 * update / delete), so a user never has to open the panel or ComfyUI to keep
 * a workflow: "把这个存成模板" saves the run just made, "以后默认 5 秒" updates
 * a default, "删掉那个" removes it.
 *
 * Saving from a finished run (`prompt_id`) reuses the run's own record: the
 * exact API prompt that was submitted plus the parameter definitions it ran
 * with (so H3's seconds→frames parameter survives instead of degrading to a
 * raw frame count), with the values actually used as the new defaults. A
 * randomized seed stays random unless the caller pins one.
 */
import { analyzeWorkflowParameters, applyWorkflowParameters, type Workflow, type WorkflowParameter } from './params.js'
import { cloneParameters, cloneWorkflow, findTemplate, TEMPLATES } from './templates.js'
import { validateWorkflow } from './store.js'

/** What a finished (or submitted) run left behind that a save can reuse. */
export interface RunRecord {
  workflow: Workflow
  parameters?: WorkflowParameter[]
  values?: Record<string, unknown>
  workflowName?: string | null
}

/** A workflow + parameter set ready for `store.saveWorkflow`. */
export interface LibraryDraft {
  workflow: Workflow
  parameters: WorkflowParameter[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Coerce one default to the parameter's type, or explain why it cannot be. */
function coerceDefault(param: WorkflowParameter, value: unknown): string | number | boolean {
  if (param.type === 'number') {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`参数 ${param.name} 需要数字，收到 ${JSON.stringify(value)}`)
    return number
  }
  if (param.type === 'boolean') {
    if (typeof value === 'boolean') return value
    if (value === 'true' || value === 1) return true
    if (value === 'false' || value === 0) return false
    throw new Error(`参数 ${param.name} 需要 true/false，收到 ${JSON.stringify(value)}`)
  }
  if (typeof value !== 'string') throw new Error(`参数 ${param.name} 需要字符串，收到 ${JSON.stringify(value)}`)
  return value
}

/**
 * Apply `{ name: value }` as new defaults. Unknown names are an error (a typo
 * must not silently save the old value). Giving a random seed a default pins
 * it: the caller asked for that seed.
 */
export function applyDefaults(parameters: WorkflowParameter[], defaults: Record<string, unknown>): WorkflowParameter[] {
  const next = structuredClone(parameters)
  for (const [name, value] of Object.entries(defaults)) {
    const param = next.find((entry) => entry.name === name)
    if (param === undefined) {
      throw new Error(`没有名为 ${name} 的参数 — 可用：${next.map((entry) => entry.name).join(', ') || '（无）'}`)
    }
    param.default = coerceDefault(param, value)
    if (param.random === true) param.random = false
  }
  return next
}

/** Dry-run the parameters against the workflow so a bad default fails at save time, not at run time. */
function checkRunnable(draft: LibraryDraft): void {
  // A required parameter without a default (the prompt of a fresh template)
  // is the caller's job at run time; stand in a placeholder for the check.
  const placeholders: Record<string, unknown> = {}
  for (const param of draft.parameters) {
    if (param.required === true && (param.default === '' || param.default === undefined)) placeholders[param.name] = param.type === 'number' ? 1 : 'x'
  }
  applyWorkflowParameters(draft.workflow, draft.parameters, placeholders)
}

/** Defaults from a run's recorded values, keeping random seeds random. */
function defaultsFromRun(parameters: WorkflowParameter[], values: Record<string, unknown>): WorkflowParameter[] {
  return parameters.map((param) => {
    if (param.random === true) return { ...param }
    const value = values[param.name]
    if (value === undefined) return { ...param }
    try {
      return { ...param, default: coerceDefault(param, value) }
    } catch {
      return { ...param }
    }
  })
}

/**
 * Build the workflow + parameters to save from exactly one source:
 * `workflow` (raw API JSON, parameters auto-detected), `template` (built-in
 * id), or `run` (a finished prompt's record). `defaults` then overrides
 * parameter defaults by name.
 */
export function draftForSave(source: {
  workflow?: unknown
  template?: unknown
  run?: RunRecord
  defaults?: unknown
  objectInfo?: Record<string, unknown>
}): LibraryDraft {
  const given = [source.workflow !== undefined, source.template !== undefined, source.run !== undefined].filter(Boolean).length
  if (given !== 1) throw new Error('save 需要且只能给出 workflow、template、prompt_id 其中之一')
  if (source.defaults !== undefined && !isRecord(source.defaults)) throw new Error('parameters 必须是 { 参数名: 默认值 } 对象')
  let draft: LibraryDraft
  if (source.template !== undefined) {
    const template = typeof source.template === 'string' ? findTemplate(source.template) : undefined
    if (template === undefined) throw new Error(`未知模板 ${String(source.template)} — 可用：${TEMPLATES.map((entry) => entry.id).join(', ')}`)
    draft = {
      workflow: cloneWorkflow(template.workflow),
      parameters: cloneParameters(template.parameters) ?? analyzeWorkflowParameters(template.workflow, source.objectInfo),
    }
  } else if (source.run !== undefined) {
    const workflow = cloneWorkflow(source.run.workflow)
    const recorded = source.run.parameters
    draft = {
      workflow,
      parameters: recorded !== undefined && recorded.length > 0
        ? defaultsFromRun(recorded, source.run.values ?? {})
        : analyzeWorkflowParameters(workflow, source.objectInfo),
    }
  } else {
    const problem = validateWorkflow(source.workflow)
    if (problem !== undefined) throw new Error(problem)
    const workflow = cloneWorkflow(source.workflow as Workflow)
    draft = { workflow, parameters: analyzeWorkflowParameters(workflow, source.objectInfo) }
  }
  if (isRecord(source.defaults)) draft.parameters = applyDefaults(draft.parameters, source.defaults)
  checkRunnable(draft)
  return draft
}

/**
 * Replace a saved workflow's JSON while keeping its parameter set where it
 * still applies: a parameter survives when its node still exists with a
 * literal (non-linked) value under that input; inputs the new graph exposes
 * that no surviving parameter covers are added from auto-detection.
 */
export function draftForUpdate(current: LibraryDraft, change: {
  workflow?: unknown
  defaults?: unknown
  objectInfo?: Record<string, unknown>
}): LibraryDraft {
  if (change.defaults !== undefined && !isRecord(change.defaults)) throw new Error('parameters 必须是 { 参数名: 默认值 } 对象')
  let draft: LibraryDraft = { workflow: cloneWorkflow(current.workflow), parameters: structuredClone(current.parameters) }
  if (change.workflow !== undefined) {
    const problem = validateWorkflow(change.workflow)
    if (problem !== undefined) throw new Error(problem)
    const workflow = cloneWorkflow(change.workflow as Workflow)
    const literal = (nodeId: string, key: string): boolean => {
      const value = workflow[nodeId]?.inputs[key]
      return value !== undefined && !Array.isArray(value)
    }
    const kept = draft.parameters.filter((param) => literal(param.nodeId, param.inputKey))
    const covered = new Set(kept.map((param) => `${param.nodeId}:${param.inputKey}`))
    const names = new Set(kept.map((param) => param.name))
    const added = analyzeWorkflowParameters(workflow, change.objectInfo)
      .filter((param) => !covered.has(`${param.nodeId}:${param.inputKey}`) && !names.has(param.name))
    draft = { workflow, parameters: [...kept, ...added] }
  }
  if (isRecord(change.defaults)) draft.parameters = applyDefaults(draft.parameters, change.defaults)
  checkRunnable(draft)
  return draft
}

/** One-line parameter summary for tool output: `seconds=3, width=864, seed=随机`. */
export function describeParameters(parameters: WorkflowParameter[]): string {
  return parameters
    .map((param) => `${param.name}=${param.random === true ? '随机' : typeof param.default === 'string' ? JSON.stringify(param.default.length > 40 ? `${param.default.slice(0, 40)}…` : param.default) : String(param.default)}`)
    .join(', ')
}
