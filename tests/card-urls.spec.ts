import { describe, expect, it } from 'vitest'
import { mediaSources, sameOriginPath } from '../src/client/media-url.js'

describe('card media URLs', () => {
  it('turns pre-0.6 absolute URLs (LAN IP, old port) into same-origin paths', () => {
    expect(sameOriginPath('http://192.0.2.10:3080/comfyui/media?file=a.mp4&subfolder=video&type=output'))
      .toBe('/comfyui/media?file=a.mp4&subfolder=video&type=output')
    expect(sameOriginPath('/comfyui/archive/x/y.mp4')).toBe('/comfyui/archive/x/y.mp4')
    expect(sameOriginPath('https://evil.example/steal')).toBe('https://evil.example/steal')
  })

  it('tries the local archive first, then the ComfyUI proxy', () => {
    expect(mediaSources({ url: '/comfyui/archive/p/14-0-a.mp4', proxyUrl: '/comfyui/media?file=a.mp4' }))
      .toEqual(['/comfyui/archive/p/14-0-a.mp4', '/comfyui/media?file=a.mp4'])
    expect(mediaSources({ url: '/comfyui/media?file=a.mp4', proxyUrl: '/comfyui/media?file=a.mp4' })).toEqual(['/comfyui/media?file=a.mp4'])
  })
})
