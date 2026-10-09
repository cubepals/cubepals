'use client'

import type { AuthMethods } from '@blockly/contracts'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { AGREED } from '../../lib/agreement'
import { authClient } from '../../lib/auth'
import { Button, ICON, Note } from '../../ui'
import { AgreementNote } from './agreement'
import styles from './auth.module.css'
import { GitHubMark } from './github-mark'
import { GoogleMark } from './google-mark'

type Provider = keyof AuthMethods

/** The ways in besides email, in the order they're offered. */
const PROVIDERS: { id: Provider; name: string; mark: ReactNode }[] = [
  { id: 'google', name: 'Google', mark: <GoogleMark /> },
  { id: 'github', name: 'GitHub', mark: <GitHubMark /> },
]

/** What a round trip to `provider` that came back with `?error=` means, and what to do next. */
function failureCopy(code: string, provider: string): string {
  switch (code) {
    case 'access_denied':
      return `${provider} sign-in was cancelled. Try again when you are ready, or use your email.`
    case 'account_not_linked':
      return `This email already has a Cubepals account, which ${provider} can join only once both have confirmed the address. Sign in with your password, or confirm your email and then continue with ${provider}.`
    case 'unable_to_create_user':
      return `We couldn’t create your account with ${provider}. Start again from this page, or use your email.`
    case 'email_not_found':
      return `${provider} did not share an email address, and your Cubepals account needs one. Try another ${provider} account, or use your email.`
    case 'SIGNUPS_FULL':
      return `Cubepals is full for now, so ${provider} couldn't make you a new account. Leave your email on the sign-up page and we'll tell you when there's room.`
    case 'state_not_found':
    case 'state_mismatch':
    case 'please_restart_the_process':
    case 'invalid_code':
    case 'no_code':
      return 'That sign-in was interrupted before it finished. Start it again.'
    default:
      return `We could not sign you in with ${provider}. Try again, or use your email.`
  }
}

/** The error page a round trip to `provider` returns to, marked with the provider it came from. */
const markedWith = (url: string, provider: Provider) =>
  `${url}${url.includes('?') ? '&' : '?'}via=${provider}`

/**
 * The way into Blockly: the deployment's sign-in providers first, and email and password one step
 * behind them, revealed in place rather than on another page. Without a provider, email is
 * simply open. Under them all, the line that says continuing agrees to the Terms.
 */
export function AuthEntry({
  title,
  description,
  methods,
  redirects,
  failure,
  failedVia,
  notice,
  emailOpen = false,
  footer,
  children,
}: {
  title: string
  description?: string
  methods: AuthMethods
  /** Where a provider sends someone back to: signed in, newly signed up, or with an error. */
  redirects: { callbackURL: string; newUserCallbackURL: string; errorCallbackURL: string }
  /** The `?error=` code a failed round trip came back with. */
  failure: string | null
  /** The `?via=` provider that round trip went to. */
  failedVia: string | null
  /** Good news from the page before, such as a password that was just changed. */
  notice?: string
  /** Start with the email form showing, when email is the way forward. */
  emailOpen?: boolean
  footer: ReactNode
  /** The email form. */
  children: ReactNode
}) {
  const offered = PROVIDERS.filter((provider) => methods[provider.id])
  const social = offered.length > 0
  const failedWith = PROVIDERS.find((provider) => provider.id === failedVia) ?? offered[0]
  const regionId = useId()
  const region = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(!social || emailOpen)
  // Focus moves into the form only when someone opens it, never on the first render.
  const opening = useRef(false)
  const [redirecting, setRedirecting] = useState<Provider | null>(null)
  const [socialError, setSocialError] = useState<string | null>(null)

  useEffect(() => {
    if (open && opening.current) region.current?.querySelector('input')?.focus({ preventScroll: true })
    opening.current = false
  }, [open])

  // Back from a provider restores this page from the back/forward cache, still "opening" it.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setRedirecting(null)
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [])

  const continueWith = async (provider: (typeof PROVIDERS)[number]) => {
    setRedirecting(provider.id)
    setSocialError(null)
    // On success the browser is already on its way to the provider. It carries the Terms agreed
    // to, without which the control plane makes no new account.
    const { error } = await authClient.signIn.social({
      provider: provider.id,
      ...redirects,
      errorCallbackURL: markedWith(redirects.errorCallbackURL, provider.id),
      additionalData: { agreement: AGREED },
    })
    if (error) {
      setRedirecting(null)
      setSocialError(`We could not open ${provider.name} sign-in. Try again in a moment, or use your email.`)
    }
  }

  return (
    <div className={styles.entry}>
      <header className={styles.heading}>
        <h1 className="type-display-md" style={{ color: 'var(--ink)' }}>
          {title}
        </h1>
        {description && <p className={`type-body ${styles.muted}`}>{description}</p>}
      </header>

      {failure && (
        <div className={styles.failure}>
          <Note tone="danger">{failureCopy(failure, failedWith?.name ?? 'Google')}</Note>
        </div>
      )}
      {notice && !failure && (
        <div className={styles.failure}>
          <Note tone="success">{notice}</Note>
        </div>
      )}

      {social && (
        <div className={styles.methods}>
          {offered.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              size="lg"
              block
              icon={provider.mark}
              disabled={redirecting !== null}
              onClick={() => continueWith(provider)}
            >
              {redirecting === provider.id ? `Opening ${provider.name}…` : `Continue with ${provider.name}`}
            </Button>
          ))}
          {socialError && <Note tone="danger">{socialError}</Note>}
          <Button
            variant="ghost"
            block
            className="bk-reveal-toggle"
            aria-expanded={open}
            aria-controls={regionId}
            iconEnd={<ChevronDown {...ICON} aria-hidden />}
            onClick={() => {
              opening.current = !open
              setOpen(!open)
            }}
          >
            Use email
          </Button>
        </div>
      )}

      <div
        id={regionId}
        ref={region}
        className={['bk-reveal', !social && styles.alone].filter(Boolean).join(' ')}
        data-open={open}
        inert={!open}
      >
        <div className="bk-reveal__inner">{children}</div>
      </div>

      <AgreementNote />

      <p className={`type-body-sm ${styles.footer}`}>{footer}</p>
    </div>
  )
}
