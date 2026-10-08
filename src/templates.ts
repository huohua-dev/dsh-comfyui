/**
 * Built-in ComfyUI workflow templates in API format (node id → class_type +
 * inputs). `txt2img` and `img2img` use only core ComfyUI nodes; `video` is a
 * Wan 2.1 text-to-video skeleton that requires the ComfyUI-WanVideoWrapper
 * custom nodes and matching model files; `h3_t2v` is MiniMax H3 text-to-video
 * on core ComfyUI (≥ 0.39) nodes with the 10Eros TURBO checkpoint. The `guide`
 * field is shown to the model so it can override the right node inputs;
 * templates that declare `parameters` are driven by name instead (prompt,
 * width, seconds…), exactly like a saved library workflow.
 */
import type { WorkflowParameter } from './params.js'

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  guide: string
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  /** Named run parameters; when present, callers pass `parameters` by name. */
  parameters?: WorkflowParameter[]
}

/** Python's round(): half to even, so frame counts match the reference script bit for bit. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * MiniMax H3 frame count for a duration — the template's ComfyMathExpression
 * (and h3_t2v.py): `x = max(5, round(sec × 24))`, then up to the next value
 * ≡ 5 (mod 17). Python's `%` is non-negative for a positive modulus; JS's is
 * not, so `(5 − x % 17) % 17` is normalized explicitly (1 s → 39, not 22).
 * 3 s → 73, 5 s → 124.
 */
export function h3Frames(seconds: number): number {
  const x = Math.max(5, roundHalfEven(seconds * 24))
  return x + ((((5 - (x % 17)) % 17) + 17) % 17)
}

/** Seconds that map back onto an H3 frame count (two decimals, round-trips through h3Frames). */
export function h3SecondsOf(frames: number): number {
  return Math.round((frames / 24) * 100) / 100
}

/** H3 model files on the reference server (see the reference h3_t2v.py script). */
export const H3_MODELS = {
  unet: '10Eros_Max_h3_TURBO-hybrid_beta5_int8.safetensors',
  clip: 'qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors',
  videoVae: 'minimax_h3_video_vae_int8_convrot.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
} as const

/** Stable ids for the template parameters (the library keeps them on save). */
function h3Parameters(): WorkflowParameter[] {
  return [
    { id: 'h3-prompt', name: 'prompt', label: '提示词', type: 'string', nodeId: '5', inputKey: 'prompt', default: '', required: true,
      description: '画面与声音描述（H3 会同时生成音轨）' },
    { id: 'h3-width', name: 'width', label: '宽度', type: 'number', nodeId: '5', inputKey: 'width', default: 864,
      numberKind: 'int', min: 32, max: 16384, step: 32, multipleOf: 32, description: '32 的倍数；480p = 864×480，720p 级 = 1344×768' },
    { id: 'h3-height', name: 'height', label: '高度', type: 'number', nodeId: '5', inputKey: 'height', default: 480,
      numberKind: 'int', min: 32, max: 16384, step: 32, multipleOf: 32, description: '32 的倍数' },
    { id: 'h3-seconds', name: 'seconds', label: '时长（秒）', type: 'number', nodeId: '5', inputKey: 'length', default: 3,
      numberKind: 'float', min: 0.2, max: 149, transform: 'h3_seconds_to_frames',
      description: '按 24fps 换算帧数：x=max(5,round(秒×24))，再补到 ≡5 (mod 17)；3 秒 = 73 帧，5 秒 = 124 帧' },
    { id: 'h3-seed', name: 'seed', label: '随机种子', type: 'number', nodeId: '6', inputKey: 'noise_seed', default: 0, random: true,
      numberKind: 'int', min: 0, description: '不传则每次随机；实际用的值写进归档 meta.json' },
    { id: 'h3-steps', name: 'steps', label: '采样步数', type: 'number', nodeId: '8', inputKey: 'steps', default: 8,
      numberKind: 'int', min: 1, max: 10000, description: 'TURBO 模型 8 步即可' },
  ]
}

export const TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'txt2img',
    name: 'SDXL text-to-image',
    description: 'Generate an image from a text prompt using a standard SDXL checkpoint.',
    guide: 'Node ids: 4 checkpoint (ckpt_name), 5 EmptyLatentImage (width/height/batch_size), 6 positive CLIPTextEncode (text), 7 negative CLIPTextEncode (text), 3 KSampler (seed/steps/cfg/denoise), 9 SaveImage (filename_prefix). Override 6.text with the prompt and 7.text with negative prompt; set a random 3.seed for variety.',
    workflow: {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
      },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-comfyui', images: ['8', 0] } },
    },
  },
  {
    id: 'img2img',
    name: 'SDXL image-to-image',
    description: 'Edit or restyle an input image with a text prompt and denoise strength.',
    guide: 'Node ids: 4 checkpoint, 10 LoadImage (image), 11 VAEEncode, 6 positive text, 7 negative text, 3 KSampler (denoise controls how much the input changes, 0..1; seed/steps/cfg), 9 SaveImage. Put the input image filename in 10.image, the prompt in 6.text.',
    workflow: {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['11', 0] },
      },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-comfyui', images: ['8', 0] } },
      '10': { class_type: 'LoadImage', inputs: { image: 'example.png' } },
      '11': { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } },
    },
  },
  {
    id: 'video',
    name: 'Wan 2.1 text-to-video',
    description: 'Generate a short video from a text prompt (requires ComfyUI-WanVideoWrapper custom nodes and Wan 2.1 models).',
    guide: 'Node ids: 10 UNETLoader (unet_name), 11 CLIPLoader, 12 VAELoader, 13 WanTextEncode (prompt/negative_prompt), 14 WanImageToVideo (width/height/length frames/batch_size), 15 KSampler (seed/steps/cfg), 17 SaveVideo (filename_prefix). Requires the ComfyUI-WanVideoWrapper custom nodes and downloaded Wan 2.1 checkpoints; verify node names with comfyui_object_info if your install differs.',
    workflow: {
      '10': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors', weight_dtype: 'fp8_e4m3fn' } },
      '11': { class_type: 'CLIPLoader', inputs: { clip_name: 'wan2.1_t2v_14B_clip.safetensors', type: 'wan' } },
      '12': { class_type: 'VAELoader', inputs: { vae_name: 'wan_2.1_vae.safetensors' } },
      '13': { class_type: 'WanTextEncode', inputs: { prompt: '', negative_prompt: '', clip: ['11', 0] } },
      '14': { class_type: 'WanImageToVideo', inputs: { positive: ['13', 0], negative: ['13', 1], vae: ['12', 0], width: 832, height: 480, length: 81, batch_size: 1 } },
      '15': { class_type: 'KSampler', inputs: { seed: 0, steps: 20, cfg: 6, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['13', 0], negative: ['13', 1], latent_image: ['14', 0] } },
      '16': { class_type: 'WanVideoDecode', inputs: { samples: ['15', 0], vae: ['12', 0] } },
      '17': { class_type: 'SaveVideo', inputs: { filename_prefix: 'dsh-comfyui', video: ['16', 0] } },
    },
  },
  {
    id: 'h3_t2v',
    name: 'MiniMax H3 文生视频（10Eros TURBO）',
    description: 'Text-to-video with sound on MiniMax H3 (core ComfyUI ≥ 0.39 nodes, 10Eros TURBO int8 checkpoint with Turbo built in — no extra LoRA). 864×480 3 s ≈ 50 s, 1344×768 5 s ≈ 2 min on the reference GPU.',
    guide: 'Drive it by name with `parameters`: prompt (required), width/height (multiples of 32; 480p = 864×480, 768p = 1344×768), seconds (converted to frames: 3 s → 73, 5 s → 124), seed (random when omitted), steps (default 8). Always run with mode "async". Node ids: 1 UNETLoader, 2 CLIPLoader(type minimax), 3/4 VAELoader (video/audio), 5 MiniMaxH3ImageToVideo (prompt/width/height/length), 6 RandomNoise, 7 KSamplerSelect(res_multistep), 8 BasicScheduler(simple), 9 BasicGuider, 10 SamplerCustomAdvanced, 11 VAEDecode, 12 VAEDecodeAudio, 13 CreateVideo(fps 24), 14 SaveVideo.',
    workflow: {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: H3_MODELS.unet, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: H3_MODELS.clip, type: 'minimax', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.videoVae } },
      '4': { class_type: 'VAELoader', inputs: { vae_name: H3_MODELS.audioVae } },
      '5': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: '', width: 864, height: 480, length: 73 } },
      '6': { class_type: 'RandomNoise', inputs: { noise_seed: 0 } },
      '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
      '8': { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: 'simple', steps: 8, denoise: 1.0 } },
      '9': { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } },
      '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] } },
      '11': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
      '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } },
      '13': { class_type: 'CreateVideo', inputs: { images: ['11', 0], audio: ['12', 0], fps: 24.0 } },
      // SaveVideo's format/codec are DynamicCombo V3: flat keys in API form (CLAUDE.md contract 15).
      '14': { class_type: 'SaveVideo', inputs: { video: ['13', 0], filename_prefix: 'video/dsh-h3', format: 'auto', 'format.codec': 'auto' } },
    },
    parameters: h3Parameters(),
  },
]

/** Look up a template by id. */
export function findTemplate(id: string): WorkflowTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id)
}

/**
 * Merge per-node input overrides into a workflow copy. Each entry maps a node
 * id to a partial inputs object; later entries observe earlier merges.
 */
export function applyTemplateInputs(
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>,
  overrides: Record<string, Record<string, unknown>>,
): void {
  for (const [nodeId, partial] of Object.entries(overrides)) {
    const node = workflow[nodeId]
    if (node === undefined) continue
    if (typeof partial !== 'object' || partial === null) continue
    node.inputs = { ...node.inputs, ...partial }
  }
}

/** Deep-copy a template's parameter list (callers may edit defaults). */
export function cloneParameters(parameters: WorkflowParameter[] | undefined): WorkflowParameter[] | undefined {
  return parameters === undefined ? undefined : structuredClone(parameters)
}

/** Clone a template workflow so callers never mutate the shared constant. */
export function cloneWorkflow(workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return JSON.parse(JSON.stringify(workflow))
}
