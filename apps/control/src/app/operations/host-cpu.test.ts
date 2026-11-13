// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The marks a boot keeps of its host (`host-cpu.ts`): how they read, and that noting them never
 * fails a start or waits on a runtime that doesn't answer.
 */
import { describe, expect, test } from 'bun:test'
import type { HostCpu, RuntimeHandle } from '../ports/runtime.ts'
import { hostMarks, hostOf, isHostMark, noteHostCpu } from './host-cpu.ts'

const handle = 'machine-1' as RuntimeHandle
const fra = { region: 'fra', id: 'a1b2' }

/** What `noteHostCpu` marks and keeps for a runtime whose `hostCpu` goes as `read` does. */
async function noted(read: () => Promise<HostCpu | null>, withinMs?: number) {
  const marks: string[] = []
  const kept: { provider: string; cpu: HostCpu }[] = []
  const runtime = { hostCpu: read, providerOf: () => 'fly' }
  const seen = async (provider: string, cpu: HostCpu) => void kept.push({ provider, cpu })
  await noteHostCpu({ runtime, seen }, { mark: async (made) => void marks.push(made) }, handle, withinMs)
  return { marks, kept }
}

describe('the marks a boot keeps of its host', () => {
  test('say the model, the clock in whole MHz, and which host it is', () => {
    expect(hostMarks({ model: 'AMD EPYC', mhz: 2999.6, host: fra })).toEqual([
      'host_cpu:AMD EPYC@3000',
      'host:fra/a1b2',
    ])
  })

  test('say ? for whichever the host doesn’t say, and nothing of what it says nothing of', () => {
    expect(hostMarks({ model: null, mhz: 2500, host: null })).toEqual(['host_cpu:?@2500'])
    expect(hostMarks({ model: 'Neoverse-N1', mhz: null, host: null })).toEqual(['host_cpu:Neoverse-N1@?'])
    expect(hostMarks({ model: null, mhz: null, host: fra })).toEqual(['host:fra/a1b2'])
    expect(hostMarks({ model: null, mhz: null, host: null })).toEqual([])
  })

  test('hold no comma, which would split them in a list of marks, and no long name', () => {
    const model = `Some CPU,  with\ta comma ${'x'.repeat(200)}`
    const [cpu, host] = hostMarks({ model, mhz: 3000, host: { region: 'fra', id: 'a,b' } })
    expect(cpu).toStartWith('host_cpu:Some CPU with a comma xxx')
    expect(`${cpu}${host}`).not.toContain(',')
    expect(cpu?.length).toBeLessThan(80)
  })

  test('are read back from an operation’s steps: its last boot’s', () => {
    const steps = ['booting', 'host_cpu:AMD EPYC@2000', 'host:fra/a1b2', 'booting', 'host_cpu:AMD EPYC@3000']
    expect(hostOf(steps)).toEqual({ cpu: 'AMD EPYC@3000', host: 'fra/a1b2' })
    expect(hostOf(['booting', 'host_refused', 'let_in'])).toEqual({ cpu: '', host: '' })
    expect(steps.filter(isHostMark)).toHaveLength(3)
  })
})

describe('noting a boot’s host', () => {
  test('marks what the runtime read, and keeps the reading under the runtime that read it', async () => {
    const cpu = { model: 'AMD EPYC', mhz: 3000, host: fra }
    expect(await noted(async () => cpu)).toEqual({
      marks: ['host_cpu:AMD EPYC@3000', 'host:fra/a1b2'],
      kept: [{ provider: 'fly', cpu }],
    })
  })

  test('marks and keeps nothing where the runtime reads none, or the read fails', async () => {
    const nothing = { marks: [], kept: [] }
    expect(await noted(async () => null)).toEqual(nothing)
    expect(await noted(async () => Promise.reject(new Error('the provider is down')))).toEqual(nothing)
  })

  test('gives up on a read that doesn’t come back, and marks nothing for it', async () => {
    const asked = Date.now()
    expect((await noted(() => new Promise(() => {}), 50)).marks).toEqual([])
    expect(Date.now() - asked).toBeLessThan(1_000)
  })

  test('gives up on a mark, or a reading, that won’t write, as on a read that won’t come', async () => {
    const cpu = { model: 'AMD EPYC', mhz: 3000, host: fra }
    const runtime = { hostCpu: async () => cpu, providerOf: () => 'fly' }
    const never = () => new Promise<void>(() => {})
    const asked = Date.now()
    await noteHostCpu({ runtime }, { mark: never }, handle, 50)
    await noteHostCpu({ runtime, seen: never }, { mark: async () => {} }, handle, 50)
    expect(Date.now() - asked).toBeLessThan(1_000)
  })

  test('never fails for a mark, or a reading, that can’t be kept', async () => {
    const cpu = { model: 'AMD EPYC', mhz: 3000, host: fra }
    const runtime = { hostCpu: async () => cpu, providerOf: () => 'fly' }
    const failing = async () => Promise.reject(new Error('the database went away'))
    await noteHostCpu({ runtime }, { mark: failing }, handle)
    await noteHostCpu({ runtime, seen: failing }, { mark: async () => {} }, handle)
  })
})
