import type { Mailer } from '../app/ports/platform.ts'

/** Every email the application sends, in order, instead of an SMTP server. */
export class Outbox implements Mailer {
  readonly sent: Array<{ to: string; subject: string; text: string }> = []

  async send(message: { to: string; subject: string; text: string }): Promise<void> {
    this.sent.push(message)
  }

  to(email: string) {
    return this.sent.filter((m) => m.to === email)
  }

  /** The first link in the last email to this address. */
  link(email: string): string {
    const text = this.to(email).at(-1)?.text ?? ''
    const url = text.match(/https?:\/\/\S+/)?.[0]
    if (!url) throw new Error(`No link in the last email to ${email}`)
    return url
  }
}
