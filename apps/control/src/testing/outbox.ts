import * as accountEmails from '../app/emails/account.ts'
import type { Mailer } from '../app/ports/platform.ts'

type Sent = { to: string; subject: string; text: string; html?: string }

/** Every email the application sends, in order, instead of an SMTP server. */
export class Outbox implements Mailer {
  readonly sent: Sent[] = []

  async send(message: Sent): Promise<void> {
    this.sent.push(message)
  }

  to(email: string) {
    return this.sent.filter((m) => m.to === email)
  }

  /** The first link in the text of the last email to this address. */
  link(email: string): string {
    const text = this.to(email).at(-1)?.text ?? ''
    const url = text.match(/https?:\/\/\S+/)?.[0]
    if (!url) throw new Error(`No link in the last email to ${email}`)
    return url
  }
}

/** Sign-in's mail for a test: the application's own emails, kept in `outbox`, or sent nowhere. */
export const authMail = (outbox?: Outbox) => ({
  mailer: outbox ?? { send: async () => {} },
  emails: accountEmails,
})
