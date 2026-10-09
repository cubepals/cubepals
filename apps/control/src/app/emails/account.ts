/**
 * The emails about a person's account: the welcome once it is ready, the link that confirms its
 * email, a reset link, and the notice that its password changed. Sign-in sends them
 * (infra/auth/better-auth.ts, given these by main.node.ts).
 */
import { ACCOUNT, type Email, layout, p, small } from '../emails.ts'

/** Once, when an account is ready: its email confirmed, or made through Google or GitHub. */
export function welcome(origin: string): Email {
  const url = `${origin}/servers/new`
  const preheader = 'Make a server, then send your friends its address.'
  const lines = [
    'Your account is ready. Make a server, choose what to play, and send your friends its address.',
    'It sleeps when nobody’s on and wakes when someone joins, so your hours only go to playing.',
  ]
  return {
    subject: 'Welcome to Cubepals',
    preheader,
    text: [...lines, `Make a server: ${url}`].join('\n\n'),
    html: layout({
      origin,
      preheader,
      figure: { name: 'moss-waving' },
      heading: 'Welcome to Cubepals',
      body: lines.map(p).join(''),
      action: { label: 'Make a server', url },
      why: ACCOUNT,
    }),
  }
}

export function verifyEmail(url: string, origin: string): Email {
  return {
    subject: 'Confirm your email for Cubepals',
    preheader: 'One click and you can start creating servers.',
    text: `Confirm your email to start creating servers:\n\n${url}\n\nIf you did not sign up, ignore this email.`,
    html: layout({
      origin,
      preheader: 'One click and you can start creating servers.',
      figure: { name: 'worker-clipboard' },
      heading: 'Confirm your email',
      body: p('Confirm your email to start creating servers.'),
      action: { label: 'Confirm email', url },
      after: small('If you did not sign up, ignore this email.'),
      why: 'You get this because someone signed up to Cubepals with this address.',
    }),
  }
}

export function resetPassword(url: string, origin: string): Email {
  return {
    subject: 'Reset your Cubepals password',
    preheader: 'The link works for an hour, once.',
    text: `Someone asked to reset the password for your Cubepals account. Choose a new one here:\n\n${url}\n\nThe link works for an hour, once. If it was not you, ignore this email: your password stays as it is.`,
    html: layout({
      origin,
      preheader: 'The link works for an hour, once.',
      heading: 'Reset your password',
      body: p('Someone asked to reset the password for your Cubepals account.'),
      action: { label: 'Choose a new password', url },
      after: small(
        'The link works for an hour, once. If it was not you, ignore this email: your password stays as it is.',
      ),
      why: ACCOUNT,
    }),
  }
}

export function passwordChanged(origin: string): Email {
  const url = `${origin}/forgot-password`
  return {
    subject: 'Your Cubepals password was changed',
    preheader: 'Every device was signed out.',
    text: `The password for your Cubepals account was just changed, and every device was signed out.\n\nIf that was not you, reset it again now:\n\n${url}`,
    html: layout({
      origin,
      preheader: 'Every device was signed out.',
      heading: 'Your password was changed',
      body:
        p('The password for your Cubepals account was just changed, and every device was signed out.') +
        p('If that was not you, reset it again now.'),
      action: { label: 'Reset password', url },
      why: ACCOUNT,
    }),
  }
}
