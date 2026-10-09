import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloudPrice, NODE_NAME, nextName, nodeTarget, readNodes, writeNodes } from './fleet-hetzner.ts'

describe('cloudPrice', () => {
  test("a catalog type is its EUR list price in US cents, at the catalog's rate", () => {
    expect(cloudPrice('ccx13')?.cents).toBe(5030)
    expect(cloudPrice('CCX33')?.cents).toBe(16203)
    expect(cloudPrice('ccx33')?.said).toBe('€138.49 a month in scripts/economics/catalog, at €1 = $1.17')
  })

  test('a type the catalog lacks, or a dedicated server, has no price', () => {
    expect(cloudPrice('cpx41')).toBeNull()
    expect(cloudPrice('ax42-1')).toBeNull()
  })
})

describe('the nodes file', () => {
  test('keeps its nodes sorted, so a change is one entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-nodes-'))
    writeFileSync(join(dir, 'fleet-nodes.auto.tfvars.json'), '{\n  "fleet_nodes": {}\n}\n')
    writeNodes(dir, { b: { location: 'fsn1', type: 'ccx33' }, a: { location: 'hel1', type: 'ccx13' } })
    expect(Object.keys(readNodes(dir))).toEqual(['a', 'b'])
    expect(readFileSync(join(dir, 'fleet-nodes.auto.tfvars.json'), 'utf8')).toEndWith('}\n')
  })

  test('names a new node by where and what it is, with the first number free', () => {
    const taken = { 'fsn1-ccx33-1': { location: 'fsn1', type: 'ccx33' } }
    expect(nextName(taken, 'fsn1', 'ccx33')).toBe('fsn1-ccx33-2')
    expect(nextName(taken, 'hel1', 'ccx33')).toBe('hel1-ccx33-1')
    expect(NODE_NAME.test('fsn1-ccx33-2')).toBe(true)
    expect(NODE_NAME.test('Box_1')).toBe(false)
  })

  test("targets the node's module in an environment", () => {
    expect(nodeTarget('fsn1-ccx33-1')).toBe('module.environment.module.fleet_node["fsn1-ccx33-1"]')
  })
})
