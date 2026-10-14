// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What browsers and password managers read off each account form: a real form posted as one, the
 * account's email as its username, and which password is the current one and which is new. The
 * names and ids are the ones they remember a site by, so changing one is a change for them too.
 */
import { describe, expect, test } from 'bun:test'
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ForgotPasswordForm } from './forgot-password/forgot-password-form'
import { ResetPasswordForm } from './reset-password/reset-password-form'
import { SignInForm } from './sign-in/sign-in-form'
import { SignUpForm } from './sign-up/sign-up-form'

const router: AppRouterInstance = {
  bfcacheId: '',
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
}

/** The form's own tag, then each input's attributes by name. */
function read(form: ReactElement) {
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, form))
  // Attribute names as the browser reads them: React writes some in camel case, HTML ignores case.
  const attributes = (tag: string) =>
    Object.fromEntries(
      [...tag.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)]
        .slice(1)
        .map(([, k, v]) => [k?.toLowerCase(), v ?? '']),
    )
  const tag = html.match(/<form[^>]*>/)?.[0] ?? ''
  const inputs = [...html.matchAll(/<input[^>]*>/g)].map(([input]) => attributes(input))
  return {
    form: attributes(tag),
    inputs: Object.fromEntries(inputs.map((input) => [input.name, input])),
    submits: html.match(/<button[^>]*type="submit"/g)?.length ?? 0,
  }
}

describe('the account forms, as password managers read them', () => {
  test('signing in names the account and its current password', () => {
    const { form, inputs, submits } = read(createElement(SignInForm, { next: '/servers' }))
    expect(form).toMatchObject({ id: 'sign-in', method: 'post' })
    expect(submits).toBe(1)
    expect(inputs.email).toMatchObject({ id: 'email', type: 'email', autocomplete: 'username' })
    expect(inputs.password).toMatchObject({
      id: 'current-password',
      type: 'password',
      autocomplete: 'current-password',
    })
  })

  test('signing up names the account and a new password', () => {
    const { form, inputs, submits } = read(
      createElement(SignUpForm, { next: '/servers', turnstileSiteKey: null }),
    )
    expect(form).toMatchObject({ id: 'sign-up', method: 'post' })
    expect(submits).toBe(1)
    expect(inputs.email).toMatchObject({ id: 'email', type: 'email', autocomplete: 'username' })
    expect(inputs['new-password']).toMatchObject({
      id: 'new-password',
      type: 'password',
      autocomplete: 'new-password',
    })
  })

  test('asking for a reset link fills in the saved account', () => {
    const { form, inputs, submits } = read(createElement(ForgotPasswordForm))
    expect(form).toMatchObject({ id: 'forgot-password', method: 'post' })
    expect(submits).toBe(1)
    expect(inputs.email).toMatchObject({ id: 'email', type: 'email', autocomplete: 'username' })
  })

  test('a new password is saved to the account the link was for', () => {
    const { form, inputs, submits } = read(
      createElement(ResetPasswordForm, { token: 't', email: 'player@example.test' }),
    )
    expect(form).toMatchObject({ id: 'reset-password', method: 'post' })
    expect(submits).toBe(1)
    expect(inputs.email).toMatchObject({
      id: 'email',
      type: 'email',
      autocomplete: 'username',
      value: 'player@example.test',
      readonly: '',
      hidden: '',
    })
    expect(inputs['new-password']).toMatchObject({ type: 'password', autocomplete: 'new-password' })
    expect(inputs['confirm-password']).toMatchObject({ type: 'password', autocomplete: 'new-password' })
  })

  test('a link from before the email came with it still sets a password', () => {
    const { inputs } = read(createElement(ResetPasswordForm, { token: 't', email: null }))
    expect(inputs.email).toBeUndefined()
    expect(inputs['new-password']).toMatchObject({ autocomplete: 'new-password' })
  })
})
