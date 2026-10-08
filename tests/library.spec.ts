/** Saving, updating and deleting library workflows from chat (comfyui_workflow). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDefaults, draftForSave, draftForUpdate } from '../src/library.js'
import { findTemplate } from '../src/templates.js'
import { applyWorkflowParameters } from '../src/params.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

const h3 = findTemplate('h3_t2v')!

describe('draftForSave', () => {
  it('saves a template with new defaults and keeps the seconds parameter', () => {
    const draft = draftForSave({ template: 'h3_t2v', defaults: { prompt: '雨夜霓虹街道', seconds: 5 } })
    const seconds = draft.parameters.find((param) => param.name === 'seconds')!
    expect(seconds.default).toBe(5)
    expect(seconds.transform).toBe('h3_seconds_to_frames')
    const graph = applyWorkflowParameters(draft.workflow, draft.parameters, {})
    expect(graph['5']!.inputs).toMatchObject({ prompt: '雨夜霓虹街道', length: 124 })
  })

  it('saves a run: recorded parameters, used values as defaults, random seed stays random', () => {
    const run = {
      workflow: structuredClone(h3.workflow),
      parameters: structuredClone(h3.parameters!),
      values: { prompt: '猫', width: 864, height: 480, seconds: 3, seed: 1234, steps: 8 },
    }
    const draft = draftForSave({ run })
    const byName = Object.fromEntries(draft.parameters.map((param) => [param.name, param]))
    expect(byName.prompt!.default).toBe('猫')
    expect(byName.seconds!.default).toBe(3)
    expect(byName.seed!.random).toBe(true)
  })

  it('pins a seed when a default is given for it', () => {
    const parameters = applyDefaults(h3.parameters!, { seed: 7 })
    expect(parameters.find((param) => param.name === 'seed')).toMatchObject({ default: 7, random: false })
  })

  it('rejects ambiguous sources, unknown names and defaults that would fail at run time', () => {
    expect(() => draftForSave({ template: 'h3_t2v', workflow: h3.workflow })).toThrow(/其中之一/)
    expect(() => draftForSave({ template: 'h3_t2v', defaults: { fps: 30 } })).toThrow(/没有名为 fps/)
    expect(() => draftForSave({ template: 'h3_t2v', defaults: { width: 850 } })).toThrow(/32 的倍数/)
    expect(() => draftForSave({ workflow: { '1': { inputs: {} } } })).toThrow(/class_type/)
  })

  it('auto-detects parameters for raw H3 JSON (seconds, not frames)', () => {
    const draft = draftForSave({ workflow: h3.workflow })
    expect(draft.parameters.map((param) => param.name)).toContain('seconds')
  })
})

describe('draftForUpdate', () => {
  it('keeps parameters whose input survives a workflow replacement and adds new ones', () => {
    const current = draftForSave({ template: 'h3_t2v', defaults: { prompt: 'p', seconds: 5 } })
    const next = structuredClone(h3.workflow)
    delete (next['8']!.inputs as Record<string, unknown>).steps
    next['8']!.inputs.steps = ['99', 0] // now linked → steps parameter no longer applies
    next['7']!.inputs.sampler_name = 'euler'
    const draft = draftForUpdate(current, { workflow: next })
    const names = draft.parameters.map((param) => param.name)
    expect(names).not.toContain('steps')
    expect(draft.parameters.find((param) => param.name === 'seconds')!.default).toBe(5)
  })

  it('changes defaults by name', () => {
    const current = draftForSave({ template: 'h3_t2v', defaults: { prompt: 'p' } })
    const draft = draftForUpdate(current, { defaults: { width: 1344, height: 768 } })
    const graph = applyWorkflowParameters(draft.workflow, draft.parameters, {})
    expect(graph['5']!.inputs).toMatchObject({ width: 1344, height: 768 })
  })
})

describe('comfyui_workflow save → list → run → update → delete', () => {
  let comfy: FakeComfy
  let host: FakeHost
  beforeEach(async () => {
    comfy = await startFakeComfy()
    host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 50 })
  })
  afterEach(async () => {
    await host.dispose()
    await comfy.close()
  })

  async function runToCompletion(args: Record<string, unknown>): Promise<string> {
    const value = await host.call('comfyui_run', { ...args, mode: 'async' }) as { jobId: string; promptId: string }
    await delay(30)
    comfy.startNext()
    comfy.finishRunning()
    const outcome = await host.jobs.jobs.get(value.jobId)!.settled
    expect(outcome.status).toBe('completed')
    return value.promptId
  }

  it('saves the run just made, lists it, and reruns it with one parameter changed', async () => {
    const promptId = await runToCompletion({ template: 'h3_t2v', parameters: { prompt: '海边日落，海鸥叫声', seconds: 3 } })
    const saved = await host.call('comfyui_workflow', { action: 'save', prompt_id: promptId, name: '海边日落 H3' }) as { id: string; name: string }
    expect(saved.name).toBe('海边日落 H3')

    const listed = await host.call('comfyui_workflow', { action: 'list' }) as { workflows: Array<{ id: string; name: string; parameters: Array<{ name: string }> }> }
    const entry = listed.workflows.find((workflow) => workflow.id === saved.id)!
    expect(entry.parameters.map((param) => param.name)).toEqual(expect.arrayContaining(['prompt', 'seconds', 'seed']))
    const listText = host.tools.get('comfyui_workflow')!.output.render({}, listed)[0]!.text
    expect(listText).toContain('海边日落 H3')
    expect(listText).toContain('内置模板 h3_t2v')

    comfy.log.length = 0
    const rerun = await host.call('comfyui_workflow', { action: 'run', id: saved.id, parameters: { seconds: 5 }, mode: 'async' }) as { background: { jobId: string } }
    await delay(30)
    const submitted = comfy.log.find((entry) => entry.path === '/prompt')!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }
    expect(submitted.prompt['5']!.inputs).toMatchObject({ prompt: '海边日落，海鸥叫声', length: 124, width: 864 })
    await host.jobs.kill(rerun.background.jobId)

    const updated = await host.call('comfyui_workflow', { action: 'update', id: saved.id, parameters: { seconds: 5 }, description: '默认 5 秒' }) as { parameterSummary: string }
    expect(updated.parameterSummary).toContain('seconds=5')

    const deleted = await host.call('comfyui_workflow', { action: 'delete', id: saved.id }) as { action: string }
    expect(deleted.action).toBe('delete')
    const after = await host.call('comfyui_workflow', { action: 'list' }) as { workflows: unknown[] }
    expect(after.workflows).toHaveLength(0)
  })

  it('saves a built-in template directly', async () => {
    const saved = await host.call('comfyui_workflow', { action: 'save', template: 'h3_t2v', name: 'H3 竖屏', parameters: { width: 480, height: 864 } }) as { id: string; parameterSummary: string }
    expect(saved.parameterSummary).toContain('width=480')
    await expect(host.call('comfyui_workflow', { action: 'save', template: 'h3_t2v' })).rejects.toThrow(/needs a name/)
  })
})
