/**
 * dsh-comfyui client half: registers the comfyui_run tool card, the Turn-tail
 * media wall and the ComfyUI settings page. Registered through slots.inject so contributions
 * wait on the real slot declarations and unwind with this plugin's fiber.
 */
import { createElement as h } from 'react'
import { makeT, getLang } from './i18n.ts'
import { ComfyUICard, type ComfyUICardProps } from './card.tsx'
import { ComfyUISettings, type ComfyUISettingsProps } from './settings.tsx'
import { ComfyUIPanel, type ComfyUIPanelProps } from './panel.tsx'
import { ComfyUITrigger, type ComfyUITriggerProps } from './trigger.tsx'
import { injectStyles } from './styles.ts'
import { TurnMediaTail, type TurnMediaTailProps } from './turn-tail.tsx'
import { turnMediaDefinition, TURN_MEDIA_KIND } from './turn-media.ts'

export const name = 'dsh-comfyui'
export const inject = ['slots']

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: unknown): unknown
}

interface UiConversationService {
  events: { register(definition: unknown): unknown }
}

interface ComfyUIClientContext {
  effect(callback: () => unknown, label?: string): void
  inject(deps: string[], callback: (ctx: ComfyUIClientContext) => void): void
  slots: SlotsService
  uiConversation?: UiConversationService
}

export function apply(ctx: ComfyUIClientContext): void {
  // Plugin-local i18n: language comes from localStorage (settings page), not
  // the host locale, so zh/en switching works without a host change.
  const t = makeT(getLang())
  ctx.effect(() => injectStyles(), 'dsh-comfyui: styles')

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_run' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_workflow' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  // Finished media also renders beneath the Turn's closing prose: DSH folds
  // every tool card of a completed Turn into the process group, so without this
  // a finished video is only visible after expanding the "thinking" section.
  // uiConversation is optional so a host without the chat target still loads.
  ctx.inject(['uiConversation'], (sub) => {
    sub.uiConversation?.events.register(turnMediaDefinition)
    sub.slots.inject('conversation.chat.turnTail', () => sub.slots.register(
      { name: 'conversation.chat.turnTail', id: TURN_MEDIA_KIND, order: 30 },
      (props: unknown) => h(TurnMediaTail, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as TurnMediaTailProps),
    ))
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'comfyui', order: 30, label: () => t('settingsTitle') },
    (props: unknown) => h(ComfyUISettings, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUISettingsProps),
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'comfyui.panel', order: 20, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUIPanel, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUIPanelProps),
  ))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'comfyui', order: 100, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUITrigger, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUITriggerProps),
  ))
}
