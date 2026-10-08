/** MiniMax H3 text-to-video template: frame rule, graph fidelity, parameters. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { H3_MAX_SECONDS, H3_MODELS, findTemplate, h3Frames, h3SecondsOf } from '../src/templates.js'
import { analyzeWorkflowParameters, applyWorkflowParameters, refreshParameterMetadata } from '../src/params.js'
import { buildWorkflow } from '../src/tools.js'
import { startFakeComfy, type FakeComfy } from './fake-comfy.js'
import { bootPlugin, type FakeHost } from './fake-host.js'
import { delay } from './helpers.js'

/** Reference values computed with h3_t2v.py's frames_for() (Python 3). */
const PYTHON_FRAMES: Record<number, number> = {
  0: 5, 0.1: 5, 0.2: 5, 0.5: 22, 1: 39, 1.5: 39, 2: 56, 2.5: 73, 3: 73, 3.04: 73, 4: 107, 5: 124, 5.17: 124,
  6: 158, 7.5: 192, 10: 243, 0.1875: 5, 0.0625: 5, 12.3: 311, 20: 481, 149: 3592,
  // 22.5 frames: Python rounds half to even (22 → 22 frames), JS Math.round would give 23 → 39.
  0.9375: 22,
}

/** h3_t2v.py build() for the same arguments (filename_prefix aside). */
function referenceGraph(a: { prompt: string; w: number; h: number; sec: number; seed: number; steps: number }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: H3_MODELS.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: H3_MODELS.clip, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.audioVae } },
    '5': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: a.prompt, width: a.w, height: a.h, length: h3Frames(a.sec) } },
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

function render(values: Record<string, unknown>, effective?: Record<string, unknown>) {
  const built = buildWorkflow({ template: 'h3_t2v', parameters: values })
  return applyWorkflowParameters(built.workflow, built.parameters!, built.values!, undefined, undefined, undefined, effective)
}

describe('h3Frames', () => {
  it.each(Object.entries(PYTHON_FRAMES))('%s s → %s frames (same as frames_for in h3_t2v.py)', (sec, frames) => {
    expect(h3Frames(Number(sec))).toBe(frames)
  })

  it('always lands on the ≡5 (mod 17) grid', () => {
    for (let tenth = 1; tenth < 300; tenth += 1) expect(h3Frames(tenth / 10) % 17).toBe(5)
  })

  it('h3SecondsOf round-trips every grid frame count', () => {
    for (let frames = 5; frames <= 3600; frames += 17) expect(h3Frames(h3SecondsOf(frames))).toBe(frames)
  })
})

describe('h3_t2v template', () => {
  it('matches the reference script graph node for node', () => {
    const graph = render({ prompt: 'a cat', width: 864, height: 480, seconds: 3, seed: 42, steps: 8 })
    const expected = referenceGraph({ prompt: 'a cat', w: 864, h: 480, sec: 3, seed: 42, steps: 8 })
    graph['14']!.inputs.filename_prefix = 'PREFIX'
    expect(graph).toEqual(expected)
    expect(graph['5']!.inputs.length).toBe(73)
  })

  it('has no LoRA node (Turbo is baked into 10Eros)', () => {
    const template = findTemplate('h3_t2v')!
    expect(Object.values(template.workflow).some((node) => /lora/i.test(node.class_type))).toBe(false)
  })

  it('converts 5 s at 1344×768 to 124 frames', () => {
    const graph = render({ prompt: 'x', width: 1344, height: 768, seconds: 5 })
    expect(graph['5']!.inputs).toMatchObject({ width: 1344, height: 768, length: 124 })
  })

  it('records the effective values, including a randomized seed in seconds units', () => {
    const effective: Record<string, unknown> = {}
    const graph = render({ prompt: 'x' }, effective)
    expect(effective).toMatchObject({ prompt: 'x', width: 864, height: 480, seconds: 3, steps: 8 })
    expect(typeof effective.seed).toBe('number')
    expect(graph['6']!.inputs.noise_seed).toBe(effective.seed)
  })

  it('refuses a missing prompt, non-multiple-of-32 sizes and unknown parameter names', () => {
    expect(() => render({})).toThrow(/缺少参数 prompt/)
    expect(() => render({ prompt: 'x', width: 854 })).toThrow(/32 的倍数.*864/)
    expect(() => render({ prompt: 'x', seconds: 0 })).toThrow(/大于 0/)
    expect(() => buildWorkflow({ template: 'h3_t2v', parameters: { prompt: 'x', fps: 30 } })).toThrow(/no parameter fps/)
  })

  it('lets a raw inputs override win over the named parameter', () => {
    const built = buildWorkflow({ template: 'h3_t2v', parameters: { prompt: 'x' }, inputs: { '5': { length: 39 } } })
    const graph = applyWorkflowParameters(built.workflow, built.parameters!, built.values!)
    expect(graph['5']!.inputs.length).toBe(39)
  })

  it('advertises the 5–15 s training range: seconds max 15.1 = 362 frames', () => {
    const seconds = findTemplate('h3_t2v')!.parameters!.find((param) => param.name === 'seconds')!
    expect(seconds.max).toBe(15.1)
    expect(h3Frames(seconds.max!)).toBe(362)
    expect(h3Frames(15)).toBe(362)
    expect(seconds.description).toContain('5–15 秒')
    expect(render({ prompt: 'x', seconds: 15 })['5']!.inputs.length).toBe(362)
  })

  it('keeps the Wan 2.1 video template', () => {
    expect(findTemplate('video')?.workflow['14']?.class_type).toBe('WanImageToVideo')
  })
})

describe('auto-detected parameters on an H3 graph', () => {
  it('exposes seconds (not frames) plus width/height multiples of 32, seed and steps', () => {
    const params = analyzeWorkflowParameters(findTemplate('h3_t2v')!.workflow)
    expect(params.map((param) => param.name).sort()).toEqual(['height', 'prompt', 'seconds', 'seed', 'steps', 'width'])
    const seconds = params.find((param) => param.name === 'seconds')!
    expect(seconds).toMatchObject({ inputKey: 'length', transform: 'h3_seconds_to_frames', numberKind: 'float', default: 3.04 })
    expect(params.find((param) => param.name === 'width')!.multipleOf).toBe(32)
    expect(params.find((param) => param.name === 'seed')!.random).toBe(true)
  })

  it('refresh leaves the unit-converted parameter alone', () => {
    const params = analyzeWorkflowParameters(findTemplate('h3_t2v')!.workflow)
    const objectInfo = { MiniMaxH3ImageToVideo: { input: { required: { length: ['INT', { min: 5, max: 3600, step: 17 }] } } } }
    const { parameters } = refreshParameterMetadata(params, objectInfo, findTemplate('h3_t2v')!.workflow)
    expect(parameters.find((param) => param.name === 'seconds')).toMatchObject({ numberKind: 'float', max: H3_MAX_SECONDS })
  })
})

describe('comfyui_run template h3_t2v through the plugin', () => {
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

  it('submits the converted graph and names the job after the prompt', async () => {
    const value = await host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: '海边的猫，浪花声', seconds: 3 }, mode: 'async' }) as { jobId: string; label: string }
    await delay(50)
    const submitted = comfy.log.find((entry) => entry.path === '/prompt')!.body as { prompt: Record<string, { inputs: Record<string, unknown> }> }
    expect(submitted.prompt['5']!.inputs).toMatchObject({ prompt: '海边的猫，浪花声', width: 864, height: 480, length: 73 })
    expect(typeof submitted.prompt['6']!.inputs.noise_seed).toBe('number')
    expect(value.label).toContain('海边的猫')
    await host.jobs.kill(value.jobId)
  })
})
