import { describe, expect, it } from 'vitest'
import { entryFromMeta, selectTurnMedia, turnMediaDefinition, TURN_MEDIA_KIND } from '../src/client/turn-media.js'

type Event = Parameters<typeof turnMediaDefinition.match>[0]

const video = { filename: 'h3_00001_.mp4', subfolder: 'video', type: 'output', node: '14', index: 0, kind: 'video', url: '/comfyui/archive/p/14-0-h3_00001_.mp4', proxyUrl: '/comfyui/media?file=h3_00001_.mp4' }

/** Drive the Definition the way ui-conversation does: start, then updates. */
function replay(events: Event[]) {
  let state: ReturnType<typeof turnMediaDefinition.start> | undefined
  for (const event of events) {
    const match = turnMediaDefinition.match(event)
    if (match === null) continue
    state = match.role === 'start'
      ? turnMediaDefinition.start(undefined, { event })
      : turnMediaDefinition.update({ state: state! }, { event })
  }
  return turnMediaDefinition.buildLocationData({ state }, 'turn', null)
}

function call(seq: number, callId: string, name: string): Event {
  return { type: 'tool/call', seq, data: { turn: 3, callId, name } }
}

function result(seq: number, callId: string, meta: unknown, extra: Partial<Event> = {}): Event {
  return { type: 'tool/result', seq, surfaceOp: 'append', data: { turn: 3, message: { source: { callId } }, meta }, ...extra }
}

describe('turn-tail media projection', () => {
  it('collects background and sync generations of one Turn, in settlement order', () => {
    const data = replay([
      { type: 'turn/start', seq: 1, data: { turn: 3 } },
      call(2, 'a', 'comfyui_run'),
      result(3, 'a', { kind: 'background', jobId: 'j', promptId: 'p-bg', label: 'h3_t2v' }),
      call(4, 'b', 'comfyui_workflow'),
      result(5, 'b', { action: 'run', id: 'w', workflowName: '海边橘猫', result: { kind: 'sync', promptId: 'p-sync', status: 'completed', elapsedMs: 1, summary: 's', media: [video] } }),
      call(6, 'c', 'comfyui_workflow'),
      result(7, 'c', { action: 'list', workflows: [] }),
      call(8, 'd', 'paint_image'),
      result(9, 'd', { kind: 'background', promptId: 'not-ours' }),
    ])
    expect(data?.key).toBe(TURN_MEDIA_KIND)
    expect(data?.value.entries).toEqual([
      { kind: 'background', seq: 3, callId: 'a', title: 'h3_t2v', promptId: 'p-bg' },
      { kind: 'sync', seq: 5, callId: 'b', title: '海边橘猫', promptId: 'p-sync', status: 'completed', elapsedMs: 1, summary: 's', media: [video] },
    ])
  })

  it('skips failed calls, empty runs and compaction replacement copies', () => {
    const data = replay([
      { type: 'turn/start', seq: 1, data: { turn: 3 } },
      call(2, 'a', 'comfyui_run'),
      result(3, 'a', { kind: 'background', promptId: 'p' }, { data: { turn: 3, message: { source: { callId: 'a' }, isError: true } } }),
      call(4, 'b', 'comfyui_run'),
      result(5, 'b', { kind: 'sync', promptId: 'p2', status: 'completed', media: [] }),
      call(6, 'c', 'comfyui_run'),
      result(7, 'c', { kind: 'background', promptId: 'p3' }, { surfaceOp: 'replace' }),
    ])
    expect(data?.value.entries).toEqual([])
  })

  it('keeps the previous Location data when nothing changed (stable identity)', () => {
    const state = turnMediaDefinition.start(undefined, { event: { type: 'turn/start', seq: 1, data: { turn: 3 } } })
    const first = turnMediaDefinition.buildLocationData({ state }, 'turn', null)
    expect(turnMediaDefinition.buildLocationData({ state }, 'turn', first)).toBe(first)
    expect(turnMediaDefinition.buildLocationData({ state }, 'step', null)).toBeNull()
  })

  it('selects entries for the tail bounded by the Turn end', () => {
    const entries = [
      { kind: 'background' as const, seq: 3, callId: 'a', title: '', promptId: 'p1' },
      { kind: 'background' as const, seq: 9, callId: 'b', title: '', promptId: 'p2' },
    ]
    const data = new Map([[TURN_MEDIA_KIND, { entries }]])
    expect(selectTurnMedia({ turn: { data, end: { seq: 5 } } }).map((entry) => entry.promptId)).toEqual(['p1'])
    expect(selectTurnMedia({ turn: { data }, seq: 10 })).toHaveLength(2)
    expect(selectTurnMedia({ turn: { data: new Map() } })).toEqual([])
  })

  it('ignores meta shapes that are not generations', () => {
    expect(entryFromMeta(undefined, 1, 'x')).toBeUndefined()
    expect(entryFromMeta({ action: 'save', id: 'w' }, 1, 'x')).toBeUndefined()
    expect(entryFromMeta({ kind: 'background' }, 1, 'x')).toBeUndefined()
  })
})
