/**
 * Turn-level projection of ComfyUI generation results.
 *
 * DSH 0.2 folds every tool call of a completed Turn into the collapsible
 * process group, so the comfyui_run / comfyui_workflow card (tool.call.toolview)
 * is only visible after the user expands "the thinking process". Images from
 * other plugins reach the main flow because the reply embeds them as Markdown;
 * there is no Markdown form for a video. ui-chat's `conversation.chat.turnTail`
 * list seat renders beneath the closing prose, outside the group — the same
 * route the built-in schedule_create card takes.
 *
 * This module is the React-free half: a ui-conversation event Definition that
 * accumulates, per Turn, the settled generation results (tool/result `meta`,
 * the presentation metadata the host writes into the session log). Everything
 * is read from persisted events, so session replay reproduces the cards with
 * no host change.
 */

export const TURN_MEDIA_KIND = 'dsh-comfyui-media'

const TOOL_NAMES = new Set(['comfyui_run', 'comfyui_workflow'])

/** One media file of a finished run (mirrors the host's presentation meta). */
export interface TurnMediaItem {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
  proxyUrl?: string
  localPath?: string
}

/** A generation result the Turn tail shows. */
export type TurnMediaEntry = {
  kind: 'sync'
  seq: number
  callId: string
  title: string
  promptId: string
  status: 'completed' | 'interrupted'
  elapsedMs: number
  summary: string
  media: TurnMediaItem[]
} | {
  kind: 'background'
  seq: number
  callId: string
  title: string
  promptId: string
}

interface CallHead {
  name: string
}

interface TurnMediaState {
  turn: number
  calls: Map<string, CallHead>
  entries: TurnMediaEntry[]
}

/** Structural slice of the ui-conversation event the Definition reads. */
interface EventLike {
  type: string
  seq: number
  surfaceOp?: string
  data: {
    turn: number
    callId?: unknown
    name?: string
    message?: { source?: { callId?: unknown }; isError?: boolean }
    meta?: unknown
  }
}

interface MatchLike {
  event: EventLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function mediaList(value: unknown): TurnMediaItem[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is TurnMediaItem => isRecord(item) && typeof item.url === 'string' && typeof item.filename === 'string')
}

function syncEntry(meta: Record<string, unknown>, base: { seq: number; callId: string; title: string }): TurnMediaEntry | undefined {
  const promptId = asString(meta.promptId)
  const media = mediaList(meta.media)
  if (promptId === '' || media.length === 0) return undefined
  return {
    kind: 'sync',
    ...base,
    promptId,
    status: meta.status === 'interrupted' ? 'interrupted' : 'completed',
    elapsedMs: typeof meta.elapsedMs === 'number' ? meta.elapsedMs : 0,
    summary: asString(meta.summary),
    media,
  }
}

function backgroundEntry(meta: Record<string, unknown>, base: { seq: number; callId: string; title: string }): TurnMediaEntry | undefined {
  const promptId = asString(meta.promptId)
  return promptId === '' ? undefined : { kind: 'background', ...base, promptId }
}

/**
 * Narrow one settled call's presentation meta to a Turn entry, or undefined
 * for results that carry no generation (list/save/get, errors, empty runs).
 */
export function entryFromMeta(meta: unknown, seq: number, callId: string): TurnMediaEntry | undefined {
  if (!isRecord(meta)) return undefined
  if (meta.action !== undefined) {
    // comfyui_workflow: only `run` produces media.
    if (meta.action !== 'run') return undefined
    const base = { seq, callId, title: asString(meta.workflowName) }
    if (isRecord(meta.background)) return backgroundEntry(meta.background, base)
    if (isRecord(meta.result)) return syncEntry(meta.result, base)
    return undefined
  }
  const base = { seq, callId, title: '' }
  if (meta.kind === 'background') return backgroundEntry(meta, { ...base, title: asString(meta.label) })
  if (meta.kind === 'sync') return syncEntry(meta, base)
  return undefined
}

/** Turn-local accumulator; it publishes Turn data only, no view Node. */
export const turnMediaDefinition = {
  kind: TURN_MEDIA_KIND,
  match: (event: EventLike): { id: string; role: 'start' | 'update' } | null => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    // Append-origin results only: replacement copies (compaction) are
    // model-only and must not duplicate cards the user already saw.
    if (event.type === 'tool/result' && event.surfaceOp === 'append') return { id: String(event.data.turn), role: 'update' }
    return null
  },
  start: (_context: unknown, match: MatchLike): TurnMediaState => {
    if (match.event.type !== 'turn/start') throw new Error(`${TURN_MEDIA_KIND} start requires turn/start`)
    return { turn: match.event.data.turn, calls: new Map(), entries: [] }
  },
  update: (context: { state: TurnMediaState }, match: MatchLike): TurnMediaState => {
    const event = match.event
    if (event.type === 'tool/call') {
      const name = asString(event.data.name)
      if (!TOOL_NAMES.has(name)) return context.state
      const calls = new Map(context.state.calls)
      calls.set(String(event.data.callId), { name })
      return { ...context.state, calls }
    }
    if (event.type !== 'tool/result') return context.state
    const message = event.data.message
    if (message === undefined || message.isError === true) return context.state
    const callId = String(message.source?.callId)
    if (!context.state.calls.has(callId)) return context.state
    const entry = entryFromMeta(event.data.meta, event.seq, callId)
    return entry === undefined ? context.state : { ...context.state, entries: [...context.state.entries, entry] }
  },
  buildLocationData: (
    context: { state?: TurnMediaState },
    scope: string,
    previous?: { kind: string; turn: number; key: string; value: { entries: TurnMediaEntry[] } } | null,
  ): { kind: 'turn'; turn: number; key: string; value: { entries: TurnMediaEntry[] } } | null => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (
      previous?.kind === 'turn' &&
      previous.turn === context.state.turn &&
      previous.key === TURN_MEDIA_KIND &&
      previous.value.entries === context.state.entries
    ) {
      return previous as { kind: 'turn'; turn: number; key: string; value: { entries: TurnMediaEntry[] } }
    }
    return { kind: 'turn', turn: context.state.turn, key: TURN_MEDIA_KIND, value: { entries: context.state.entries } }
  },
}

/** Owner props of the `conversation.chat.turnTail` seat (structural slice). */
export interface TurnTailOwner {
  turn?: { data?: { get(key: string): unknown }; end?: { seq?: number } }
  seq?: number
}

/** Entries of the owner's Turn up to its end, or [] when it generated nothing. */
export function selectTurnMedia(owner: TurnTailOwner): TurnMediaEntry[] {
  const data = owner.turn?.data?.get(TURN_MEDIA_KIND)
  if (!isRecord(data) || !Array.isArray(data.entries)) return []
  const bound = owner.turn?.end?.seq ?? owner.seq ?? Number.POSITIVE_INFINITY
  return (data.entries as TurnMediaEntry[]).filter((entry) => entry.seq <= bound)
}
