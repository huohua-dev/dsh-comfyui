/**
 * Turn-tail media wall (`conversation.chat.turnTail`, id `dsh-comfyui-media`).
 *
 * Renders the ComfyUI results of a completed Turn beneath its closing prose,
 * outside the folded process group, so a finished video plays in the main
 * conversation flow like an image does. Reuses the tool card's result and
 * background components: a background run keeps polling /comfyui/jobs/media
 * and swaps to the player when the job lands, with the local archive first.
 */
import { createElement as h } from 'react'
import { BackgroundCard, ResultCard, type ComfyUICardProps } from './card.tsx'
import { selectTurnMedia, type TurnTailOwner } from './turn-media.ts'

export interface TurnMediaTailProps extends TurnTailOwner {
  t: ComfyUICardProps['t']
}

export function TurnMediaTail(props: TurnMediaTailProps): ReturnType<typeof h> | null {
  const entries = selectTurnMedia(props)
  if (entries.length === 0) return null
  const { t } = props
  return h('div', { className: 'dsc-turn-media' }, entries.map((entry) => entry.kind === 'background'
    ? h(BackgroundCard, { key: entry.callId, label: entry.title, promptId: entry.promptId, t })
    : h(ResultCard, {
        key: entry.callId,
        title: entry.title,
        result: {
          kind: 'sync',
          promptId: entry.promptId,
          status: entry.status,
          elapsedMs: entry.elapsedMs,
          media: entry.media,
          summary: entry.summary,
        },
        t,
      })))
}
