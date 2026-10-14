// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

import nodemailer, { type Transporter } from 'nodemailer'
import type { Mailer } from '../../app/ports/platform.ts'

/**
 * Mail through the deployment's SMTP server (`mail.smtpUrl`): Mailpit on a local stack and on
 * staging, the mail provider in production. With an HTML part, the email goes as
 * multipart/alternative, the text first, so a mail app that shows no HTML shows the text. No
 * email carries List-Unsubscribe or any other bulk-mail header: none of them is marketing.
 */
/**
 * How long a send waits on the SMTP server: to connect, for its greeting, and between any two
 * answers. Sign-up and password reset wait on their email, so a server that hangs fails them in
 * seconds instead of nodemailer's own minutes. A `?connectionTimeout=` (or the others) in
 * SMTP_URL wins over these.
 */
export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 }

export class SmtpMailer implements Mailer {
  readonly #transport: Transporter
  readonly #from: string
  readonly #replyTo: string | undefined
  readonly #subjectPrefix: string

  /** With `replyTo`, a reply goes there rather than to the sender. Tests pass shorter `timeouts`. */
  constructor(
    mail: { smtpUrl: string; from: string; replyTo?: string; subjectPrefix: string },
    timeouts: typeof SMTP_TIMEOUTS = SMTP_TIMEOUTS,
  ) {
    this.#transport = nodemailer.createTransport({ url: mail.smtpUrl, ...timeouts })
    this.#from = mail.from
    this.#replyTo = mail.replyTo
    this.#subjectPrefix = mail.subjectPrefix
  }

  async send(message: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      ...(this.#replyTo === undefined ? {} : { replyTo: this.#replyTo }),
      to: message.to,
      subject: `${this.#subjectPrefix}${message.subject}`,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
    })
  }
}
