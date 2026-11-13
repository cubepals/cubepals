// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fields side by side line up (components.css, "Fields side by side line up"): the design system
 * lays every field out as three rows, label, control and note, and lets a grid share them across
 * a row. That holds only while each field renders those three parts and nothing else, label
 * first, in a `.bk-field`. These hold every field the design system draws to it, in each shape it
 * takes: with help, with an error, with none, with something trailing its control. A field drawn
 * outside `ui/`, such as the settings page's slider, is held here too.
 */

import { expect, test } from 'bun:test'
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
