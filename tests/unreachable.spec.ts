/** "ComfyUI is down" errors name the server and say how to bring it up. */
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { ComfyUIClient, ComfyUIError } from '../src/comfyui.js'
import { DEFAULT_UNREACHABLE_HINT } from '../src/config.js'
import { bootPlugin } from './fake-host.js'

/** A port nobody listens on (bind, read the port, close). */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('unreachable ComfyUI', () => {
  it('says the win box may be in LLM mode and how to switch it', async () => {
    const port = await closedPort()
    const client = new ComfyUIClient(`http://127.0.0.1:${port}`, undefined, 2_000, 1_000, DEFAULT_UNREACHABLE_HINT)
    const error = await client.systemStats().then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ComfyUIError)
    expect((error as ComfyUIError).code).toBe('unreachable')
    expect((error as Error).message).toBe(`无法连接 ComfyUI（http://127.0.0.1:${port}）：连接被拒绝（ECONNREFUSED）。win 可能在 LLM 模式，需要先运行 winmode.sh video`)
  })

  it('reports a silent server as a timeout with the same hint', async () => {
    const server: Server = createServer(() => { /* never answers */ })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const client = new ComfyUIClient(`http://127.0.0.1:${port}`, undefined, 1_000, 1_000, DEFAULT_UNREACHABLE_HINT)
      await expect(client.getQueue()).rejects.toThrow(/1000 ms 内没有响应。win 可能在 LLM 模式，需要先运行 winmode\.sh video/)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it('leaves real HTTP errors alone (the server did answer)', async () => {
    const server: Server = createServer((_req, res) => { res.writeHead(500); res.end('boom') })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const client = new ComfyUIClient(`http://127.0.0.1:${port}`, undefined, 2_000, 1_000, DEFAULT_UNREACHABLE_HINT)
      await expect(client.getQueue()).rejects.toThrow(/HTTP 500 — boom/)
    } finally {
      server.close()
    }
  })

  it('surfaces the hint from the tools and the connection test route; the hint is configurable', async () => {
    const port = await closedPort()
    const host = await bootPlugin({ baseUrl: `http://127.0.0.1:${port}` })
    try {
      await expect(host.call('comfyui_run', { template: 'h3_t2v', parameters: { prompt: 'x' }, mode: 'async' }))
        .rejects.toThrow(/无法连接 ComfyUI.*winmode\.sh video/)
      const test = await (await host.fetch('/comfyui/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { ok: boolean; error: string }
      expect(test.ok).toBe(false)
      expect(test.error).toContain('winmode.sh video')
    } finally {
      await host.dispose()
    }
    const custom = await bootPlugin({ baseUrl: `http://127.0.0.1:${port}`, unreachableHint: '请先启动 ComfyUI 桌面版' })
    try {
      await expect(custom.call('comfyui_object_info', {})).rejects.toThrow(/请先启动 ComfyUI 桌面版/)
    } finally {
      await custom.dispose()
    }
  })
})
