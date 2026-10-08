/** MiniMax H3 reference-to-video template: optional branches pruned when empty, mirrors, plugin round trip. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { H3_CONTINUE_FRAMES, H3_MODELS, findTemplate, h3Frames } from '../src/templates.js'
import { applyWorkflowParameters, danglingReferences, pruneWorkflowNodes, type Workflow } from '../src/params.js'
import { buildWorkflow } from '../src/tools.js'
import { draftForSave } from '../src/library.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

function render(
  values: Record<string, unknown>,
  extra: {
    effective?: Record<string, unknown>
    sizes?: Record<string, { width: number; height: number }>
    loadArea?: Array<{ name: string; kind: 'image' | 'video' | 'audio' }>
  } = {},
): Workflow {
  const built = buildWorkflow({ template: 'h3_r2v', parameters: values })
  return applyWorkflowParameters(built.workflow, built.parameters!, built.values!, undefined, extra.sizes, extra.loadArea, extra.effective)
}

const OPTIONAL_BRANCH_NODES = ['15', '21', '22', '23', '30', '31', '32', '33', '34', '35', '40', '41', '42', '50', '51', '52']

/** work/h3run.py build() for one ref image, no audio, no guides, hybrid model (ids renamed to the template's). */
function referenceGraph(a: { prompt: string; ref: string; w: number; h: number; sec: number; seed: number; steps: number }): Workflow {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: H3_MODELS.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: H3_MODELS.clip, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.audioVae } },
    '20': { class_type: 'LoadImage', inputs: { image: a.ref } },
    '5': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: { clip: ['2', 0], vae: ['3', 0], audio_vae: ['4', 0], prompt: a.prompt, width: a.w, height: a.h, length: h3Frames(a.sec), ref_image_size: 'match', 'ref_images.ref_image_0': ['20', 0] },
    },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: a.seed } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '8': { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: 'simple', steps: a.steps, denoise: 1.0 } },
    '9': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
    '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] } },
    '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } },
    '13': { class_type: 'CreateVideo', inputs: { images: ['11', 0], audio: ['12', 0], fps: 24.0 } },
    '14': { class_type: 'SaveVideo', inputs: { video: ['13', 0], filename_prefix: 'PREFIX', format: 'auto', 'format.codec': 'auto' } },
  }
}

describe('h3_r2v template', () => {
  it('the authored template is closed (every reference resolves)', () => {
    expect(danglingReferences(findTemplate('h3_r2v')!.workflow)).toEqual([])
  })

  it('with only the required inputs equals the reference script graph (every optional branch pruned)', () => {
    const graph = render({ prompt: 'p', ref_image_1: 'sparkle/turnaround.png', seed: 7 })
    graph['14']!.inputs.filename_prefix = 'PREFIX'
    expect(graph).toEqual(referenceGraph({ prompt: 'p', ref: 'sparkle/turnaround.png', w: 480, h: 864, sec: 5, seed: 7, steps: 8 }))
    for (const id of OPTIONAL_BRANCH_NODES) expect(graph[id]).toBeUndefined()
    expect(Object.values(graph).some((node) => node.class_type === 'LoadImage' && node.inputs.image === '')).toBe(false)
  })

  it('wires every branch when all media are given, mirroring width/height into the scalers', () => {
    const graph = render({
      prompt: 'p', ref_image_1: 'a.png', ref_image_2: 'b.png', ref_image_3: 'c.png', ref_audio_1: 'voice.wav',
      first_frame: 'first.png', last_frame: 'last.png', continue_from: 'prev.mp4',
      width: 768, height: 1344, seconds: 15, lora: H3_MODELS.ref2vaTurboLora, unet: H3_MODELS.ref2va, steps: 4, ref_image_size: 'max',
    })
    expect(danglingReferences(graph)).toEqual([])
    expect(graph['5']!.inputs).toMatchObject({
      width: 768, height: 1344, length: 362, ref_image_size: 'max',
      'ref_images.ref_image_0': ['20', 0], 'ref_images.ref_image_1': ['21', 0], 'ref_images.ref_image_2': ['22', 0], 'ref_audios.ref_audio_0': ['23', 0],
    })
    for (const id of ['33', '41', '51']) expect(graph[id]!.inputs).toMatchObject({ width: 768, height: 1344, upscale_method: 'lanczos', crop: 'center' })
    expect(graph['30']!.inputs.file).toBe('prev.mp4')
    expect(graph['32']!.inputs).toMatchObject({ batch_index: -H3_CONTINUE_FRAMES, length: H3_CONTINUE_FRAMES })
    expect(graph['35']!.inputs).toMatchObject({ positive: ['5', 0], frame_idx: 0, audio: ['34', 0], image: ['33', 0] })
    expect(graph['42']!.inputs).toMatchObject({ positive: ['35', 0], frame_idx: 0 })
    expect(graph['52']!.inputs).toMatchObject({ positive: ['42', 0], frame_idx: -1 })
    expect(graph['9']!.inputs).toEqual({ model: ['15', 0], conditioning: ['52', 0] })
    expect(graph['15']!.inputs).toMatchObject({ model: ['1', 0], lora_name: H3_MODELS.ref2vaTurboLora })
    expect(graph['1']!.inputs.unet_name).toBe(H3_MODELS.ref2va)
    expect(graph['8']!.inputs).toMatchObject({ model: ['15', 0], steps: 4 })
  })

  it('closes the conditioning chain around a missing guide', () => {
    const lastOnly = render({ prompt: 'p', ref_image_1: 'a.png', last_frame: 'end.png' })
    expect(lastOnly['52']!.inputs.positive).toEqual(['5', 0])
    expect(lastOnly['9']!.inputs.conditioning).toEqual(['52', 0])
    expect(lastOnly['42']).toBeUndefined()
    const firstOnly = render({ prompt: 'p', ref_image_1: 'a.png', first_frame: 'start.png' })
    expect(firstOnly['42']!.inputs.positive).toEqual(['5', 0])
    expect(firstOnly['9']!.inputs.conditioning).toEqual(['42', 0])
    expect(firstOnly['41']!.inputs).toMatchObject({ image: ['40', 0], width: 480, height: 864 })
    expect(danglingReferences(lastOnly)).toEqual([])
    expect(danglingReferences(firstOnly)).toEqual([])
  })

  it('renumbers autogrow keys so <Picture N> follows the filled references', () => {
    const graph = render({ prompt: 'p', ref_image_1: 'a.png', ref_image_3: 'c.png' })
    const refs = Object.entries(graph['5']!.inputs).filter(([key]) => key.startsWith('ref_images.'))
    expect(Object.fromEntries(refs)).toEqual({ 'ref_images.ref_image_0': ['20', 0], 'ref_images.ref_image_1': ['22', 0] })
    expect(graph['21']).toBeUndefined()
  })

  it('treats explicit empty and whitespace values as "leave this slot out"', () => {
    const effective: Record<string, unknown> = {}
    const graph = render({ prompt: 'p', ref_image_1: 'a.png', ref_audio_1: '', first_frame: '   ' }, { effective })
    expect(graph['23']).toBeUndefined()
    expect(graph['40']).toBeUndefined()
    expect(graph['5']!.inputs['ref_audios.ref_audio_0']).toBeUndefined()
    expect(effective).toMatchObject({ ref_audio_1: '', first_frame: '', ref_image_1: 'a.png', seconds: 5 })
  })

  it('refuses a missing first reference image', () => {
    expect(() => render({ prompt: 'p' })).toThrow(/缺少参数 ref_image_1/)
    expect(() => render({ prompt: 'p', ref_image_1: '' })).toThrow(/缺少参数 ref_image_1/)
    expect(() => render({ ref_image_1: 'a.png' })).toThrow(/缺少参数 prompt/)
    expect(() => render({ prompt: 'p', ref_image_1: 'a.png', ref_image_size: 'huge' })).toThrow(/allowed options/)
  })

  it('takes only ref_image_1 from the load area and never sizes the canvas after a reference', () => {
    const graph = render({ prompt: 'p' }, {
      loadArea: [{ name: 'one.png', kind: 'image' }, { name: 'two.png', kind: 'image' }, { name: 'clip.mp4', kind: 'video' }],
      sizes: { 'one.png': { width: 1024, height: 1536 } },
    })
    expect(graph['20']!.inputs.image).toBe('one.png')
    expect(graph['21']).toBeUndefined()
    expect(graph['30']).toBeUndefined()
    expect(graph['5']!.inputs).toMatchObject({ width: 480, height: 864 })
  })

  it('saves into the library like the other templates', () => {
    const draft = draftForSave({ template: 'h3_r2v', defaults: { seconds: 10 } })
    expect(draft.parameters.find((param) => param.name === 'seconds')?.default).toBe(10)
    expect(draft.parameters.find((param) => param.name === 'first_frame')?.prune?.nodes).toEqual(['40', '41', '42'])
  })
})

describe('pruneWorkflowNodes', () => {
  const chain = (): Workflow => ({
    src: { class_type: 'Source', inputs: {} },
    a: { class_type: 'Filter', inputs: { positive: ['src', 0], strength: 1 } },
    b: { class_type: 'Filter', inputs: { positive: ['a', 0] } },
    sink: { class_type: 'Sink', inputs: { conditioning: ['b', 0], extra: ['a', 0], 'items.item_0': ['src', 0], 'items.item_1': ['a', 0], 'items.item_2': ['b', 0] } },
  })

  it('follows pass-through transitively and does not mutate its input', () => {
    const before = chain()
    const after = pruneWorkflowNodes(before, new Map([['a', 'positive'], ['b', 'positive']]))
    expect(after.sink!.inputs.conditioning).toEqual(['src', 0])
    expect(after.a).toBeUndefined()
    expect(before.a).toBeDefined()
    expect(before.sink!.inputs.conditioning).toEqual(['b', 0])
  })

  it('drops consumer keys of nodes without pass-through and compacts autogrow groups', () => {
    const after = pruneWorkflowNodes(chain(), new Map([['a', undefined], ['b', 'positive']]))
    expect(after.sink!.inputs).toEqual({ 'items.item_0': ['src', 0] })
    const keep = pruneWorkflowNodes(chain(), new Map([['a', undefined]]))
    expect(keep.sink!.inputs).toEqual({ conditioning: ['b', 0], 'items.item_0': ['src', 0], 'items.item_1': ['b', 0] })
    // b lost its only input: a template bug the integrity rule does not see,
    // but the reference graph stays closed.
    expect(danglingReferences(keep)).toEqual([])
  })

  it('refuses a result that still references a missing node, and pass-through cycles', () => {
    const broken = { ...chain(), orphan: { class_type: 'X', inputs: { in: ['ghost', 0] } } }
    expect(() => pruneWorkflowNodes(broken, new Map([['a', 'positive']]))).toThrow(/ghost/)
    const loop: Workflow = {
      x: { class_type: 'F', inputs: { in: ['y', 0] } },
      y: { class_type: 'F', inputs: { in: ['x', 0] } },
      z: { class_type: 'Sink', inputs: { in: ['x', 0] } },
    }
    expect(() => pruneWorkflowNodes(loop, new Map([['x', 'in'], ['y', 'in']]))).toThrow(/直通环/)
  })
})

describe('comfyui_run template h3_r2v through the plugin', () => {
  let comfy: FakeComfy
  let host: FakeHost
  beforeEach(async () => {
    comfy = await startFakeComfy()
    host = await bootPlugin({ baseUrl: comfy.url, pollIntervalMs: 100 })
  })
  afterEach(async () => {
    await host.dispose()
    await comfy.close()
  })

  it('submits a closed prompt without the empty branches', async () => {
    const value = await host.call('comfyui_run', {
      template: 'h3_r2v',
      parameters: { prompt: 'subject_definitions: <Subject 1> is <Picture 1>.', ref_image_1: 'refs/a.png', ref_audio_1: 'refs/voice.wav', seconds: 5 },
      mode: 'async',
    }) as { jobId: string; label: string }
    await delay(50)
    const submitted = comfy.log.find((entry) => entry.path === '/prompt')!.body as { prompt: Workflow }
    expect(danglingReferences(submitted.prompt)).toEqual([])
    expect(submitted.prompt['5']!.inputs).toMatchObject({ length: 124, 'ref_images.ref_image_0': ['20', 0], 'ref_audios.ref_audio_0': ['23', 0] })
    expect(submitted.prompt['23']!.inputs.audio).toBe('refs/voice.wav')
    for (const id of ['21', '22', '30', '40', '50', '15']) expect(submitted.prompt[id]).toBeUndefined()
    expect(value.label).toContain('h3_r2v')
    await host.jobs.kill(value.jobId)
  })
})
