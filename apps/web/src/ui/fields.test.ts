// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fields side by side line up (components.css, "Fields side by side line up"): the design system
 * lays every field out as three rows, label, control and note, and lets a grid share them across
 * a row. That holds only while each field renders those three parts and nothing else, label
 * first, in a `.bk-field`. These hold every field the design system draws to it, in each shape it
 * takes: with help, with an error, with none, with something trailing its control. A field drawn
 * outside `ui/`, such as the settings page's slider, is held here too. And the grid has to be the
 * design system's: no page sets fields side by side in a flex row (`bk-row`) or a grid of its own,
 * where nothing lines them up.
 */

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Window } from 'happy-dom'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RangeField } from '../app/(app)/servers/[id]/settings/range-field'
import { Select, TextField } from './fields'

type Part = 'label' | 'control' | 'help' | 'error'

/**
 * The parts a field renders, as the grid sees them: each element child named by what it holds. A
 * label row may carry more beside its label (the slider's value), so it is a label by holding one.
 */
function fieldParts(element: ReactElement): Part[] {
  const { document } = new Window()
  document.body.innerHTML = renderToStaticMarkup(element)
  const field = document.body.firstElementChild
  expect(field?.classList.contains('bk-field')).toBe(true)
  return [...(field?.children ?? [])].map((part): Part => {
    if (part.classList.contains('bk-field__help')) return 'help'
    if (part.classList.contains('bk-field__error')) return 'error'
    if (part.classList.contains('bk-field__label') || part.querySelector(':scope > .bk-field__label'))
      return 'label'
    return 'control'
  })
}

/** The label, the control, and the note when there is one: nothing else, in that order. */
function expectLinesUp(parts: Part[]) {
  expect(parts.slice(0, 2)).toEqual(['label', 'control'])
  expect(parts.length).toBeLessThanOrEqual(3)
  const note = parts[2]
  if (note !== undefined) expect(['help', 'error']).toContain(note)
}

const options = [{ value: 'a', label: 'A' }]

test('a text field is a label, a control and a note, in every shape', () => {
  for (const props of [
    { label: 'Name' },
    { label: 'Name', help: 'What friends see.' },
    { label: 'Name', error: 'Choose a name.' },
    {
      label: 'Name',
      help: 'What friends see.',
      trailing: createElement('button', { type: 'button' }, 'Copy'),
    },
  ])
    expectLinesUp(fieldParts(createElement(TextField, { ...props, onChange: () => {} })))
})

test('a select is a label, a control and a note, in every shape', () => {
  for (const props of [
    { label: 'Difficulty', options },
    { label: 'Game mode', options, help: 'For players joining for the first time.' },
    { label: 'Region', options, trailing: createElement('span', null, 'ms') },
  ])
    expectLinesUp(fieldParts(createElement(Select, { ...props, onChange: () => {} })))
})

test('a slider is a label, a control and a note, in every shape', () => {
  const slider = { label: 'View distance', value: 10, min: 3, max: 32, said: String, onChange: () => {} }
  for (const props of [
    slider,
    { ...slider, help: 'How far players see.' },
    { ...slider, error: 'Choose 3 to 8.' },
  ]) {
    expectLinesUp(fieldParts(createElement(RangeField, props)))
  }
})

/** The design system's fields and the ones built on them, by the names pages write. */
const FIELD = /^<(TextField|Select|RangeField|SuggestField|ItemField)\b/
/** An element that sets its children side by side without the design system lining them up. */
const SIDE_BY_SIDE = /className="[^"]*\bbk-row\b|gridTemplateColumns/

const indent = (line: string) => line.length - line.trimStart().length

/** The opening tag starting at `at`, over however many lines its props take, and where it ends. */
function openingTag(lines: string[], at: number): { tag: string; end: number } {
  let end = at
  while (end < lines.length && !/>\s*$/.test(lines[end] ?? '')) end++
  return { tag: lines.slice(at, end + 1).join(' '), end }
}

/**
 * The lines of an element's direct children, as Biome formats them: two spaces in from its opening
 * tag, or four inside a `{condition && (` at two. They end where the indent comes back to the tag's.
 */
function directChildren(lines: string[], end: number, own: number): number[] {
  const children: number[] = []
  let inCondition = false
  for (let i = end + 1; i < lines.length; i++) {
    const text = (lines[i] ?? '').trim()
    if (text === '') continue
    const depth = indent(lines[i] ?? '')
    if (depth <= own) break
    if (depth === own + 2) inCondition = text.startsWith('{')
    if (depth === own + 2 || (inCondition && depth === own + 4)) children.push(i)
  }
  return children
}

/** The fields a page sets directly in a flex row or a grid of its own, as `file:line`. */
function fieldsOutsideGrids(source: string, name: string): string[] {
  const lines = source.split('\n')
  return lines.flatMap((line, at) => {
    const text = line.trimStart()
    if (!text.startsWith('<') || text.startsWith('</')) return []
    const { tag, end } = openingTag(lines, at)
    if (!SIDE_BY_SIDE.test(tag) || /\/>\s*$/.test(lines[end] ?? '')) return []
    return directChildren(lines, end, indent(line))
      .filter((i) => FIELD.test((lines[i] ?? '').trim()))
      .map((i) => `${name}:${i + 1}`)
  })
}

/** Every `.tsx` under `apps/web/src`, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') && !entry.name.includes('.test.') ? [path] : []
  })
}

test('no page sets fields side by side outside the design system’s grid', () => {
  const root = join(import.meta.dir, '..')
  const found = sources(root).flatMap((path) =>
    fieldsOutsideGrids(readFileSync(path, 'utf8'), relative(root, path)),
  )
  expect(found).toEqual([])
})

test('a flex row or a grid of a page’s own holding fields is found, a design-system grid is not', () => {
  const flexRow = [
    '<div className="bk-row" style={{ gap: 8 }}>',
    '  <ItemField value={item} />',
    '  <TextField label="How many" />',
    '</div>',
  ].join('\n')
  const ownGrid = [
    '<div',
    '  style={{',
    "    display: 'grid',",
    "    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',",
    '  }}',
    '>',
    '  <Select label="World" />',
    '  {kind !== "warn" && (',
    '    <TextField label="X" />',
    '  )}',
    '</div>',
  ].join('\n')
  const designGrid = ['<div className="bk-grid bk-grid--two">', '  <TextField label="X" />', '</div>'].join(
    '\n',
  )
  expect(fieldsOutsideGrids(flexRow, 'a')).toEqual(['a:2', 'a:3'])
  expect(fieldsOutsideGrids(ownGrid, 'b')).toEqual(['b:7', 'b:9'])
  expect(fieldsOutsideGrids(designGrid, 'c')).toEqual([])
})
