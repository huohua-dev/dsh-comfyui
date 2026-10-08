import { describe, expect, it } from 'vitest'
import { findTemplate } from '../src/templates.js'

describe('harness', () => {
  it('imports host sources through .js specifiers', () => {
    expect(findTemplate('txt2img')?.id).toBe('txt2img')
  })
})
