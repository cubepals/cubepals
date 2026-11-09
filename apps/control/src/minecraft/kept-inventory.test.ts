// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The commands that keep an inventory and put it back, as they were run on a 26.1 server with a
 * player on, where every item came back whole: a sword with its name and enchantment, a shulker
 * box with what it held, a helmet and a shield. And what the game's answers to them mean.
 */
import { expect, test } from 'bun:test'
import { forgetKept, keepSteps, keptAnswer, putBackItem, putBackStart } from './kept-inventory.ts'

const ID = 'k000000000002'
/** How vanilla knows them: by the short name, the second way of each. */
const short = (step: readonly string[]) => step[1]

test('keeps the inventory and what is worn, under the id', () => {
  expect(keepSteps('Kai', ID).map(short)).toEqual([
    `data modify storage blockly:kept ${ID}.Inventory set from entity Kai Inventory`,
    `data modify storage blockly:kept ${ID}.equipment set from entity Kai equipment`,
  ])
})

test('puts each item back through a placeholder filled whole, and only then forgets it', () => {
  expect(putBackStart('Kai', ID).map(short)).toEqual([
    `kill @e[type=minecraft:item,tag=blockly.kept.${ID}]`,
    `data modify storage blockly:kept ${ID}.next set value {PickupDelay:0s,Tags:[]}`,
    `data modify storage blockly:kept ${ID}.next.Owner set from entity Kai UUID`,
  ])
  const { copy, drop, fill, forget } = putBackItem('Kai', ID, 'Inventory[0]')
  expect([copy, drop, fill, forget].map(short)).toEqual([
    `data modify storage blockly:kept ${ID}.next.Item set from storage blockly:kept ${ID}.Inventory[0]`,
    `execute at Kai run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:barrier",count:1},Tags:["blockly.kept.${ID}"],PickupDelay:32767s}`,
    `data modify entity @e[type=minecraft:item,tag=blockly.kept.${ID},limit=1] {} merge from storage blockly:kept ${ID}.next`,
    `data remove storage blockly:kept ${ID}.Inventory[0]`,
  ])
  expect(short(forgetKept(ID))).toBe(`data remove storage blockly:kept ${ID}`)
})

test('an empty path is gone, so putting back stops before handing over a placeholder', () => {
  // As 26.1 answered them.
  expect(keptAnswer(`Found no elements matching ${ID}.Inventory[0]`)).toBe('gone')
  expect(keptAnswer('Modified storage blockly:kept')).toBe('done')
  expect(keptAnswer('Nothing changed. The specified properties already have these values')).toBe('done')
  expect(keptAnswer('No entity was found')).toBe('not_on')
  expect(keptAnswer('Unknown or incomplete command. See below for error')).toBe('unknown')
})
