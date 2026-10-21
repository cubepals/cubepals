// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SmtpMailer through the real nodemailer transport, against a stand-in SMTP server that answers
 * every command and keeps each message's DATA: what goes on the wire is what is checked.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { SmtpMailer } from './smtp.ts'

const received: string[] = []

/** One SMTP conversation: a reply to each command, and the message between DATA and its dot. */
function converse(socket: Socket) {
  let data: string | null = null
  let buffer = ''
  const line = (text: string) => {
    if (data === null) return command(text)
    if (text !== '.') data += `${text}\n`
    else {
      received.push(data)
      data = null
      socket.write('250 kept\r\n')
    }
  }
  const command = (text: string) => {
    const verb = text.slice(0, 4).toUpperCase()
    if (verb === 'DATA') data = ''
    if (verb === 'QUIT') socket.end('221 bye\r\n')
    else socket.write(verb === 'DATA' ? '354 go on\r\n' : '250 ok\r\n')
  }
  socket.write('220 stand-in ESMTP\r\n')
  socket.on('data', (chunk) => {
    const lines = (buffer + chunk.toString('utf8')).split('\r\n')
    buffer = lines.pop() ?? ''
    for (const text of lines) line(text)
  })
}

let server: Server
let port = 0

beforeAll(async () => {
  server = createServer(converse)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  port = typeof address === 'object' && address !== null ? address.port : 0
})

afterAll(() => {
  server.close()
})

const mailer = (subjectPrefix: string, replyTo?: string) =>
  new SmtpMailer({
    smtpUrl: `smtp://127.0.0.1:${port}`,
    from: 'Cubepals <hello@blockly.test>',
    ...(replyTo === undefined ? {} : { replyTo }),
    subjectPrefix,
  })

test('an email with HTML goes as both parts, text first, its subject after the prefix', async () => {
  await mailer('[Staging] ').send({
    to: 'player@example.test',
    subject: 'Welcome to Cubepals',
    text: 'Your account is ready.',
    html: '<p>Your account is <b>ready</b>.</p>',
  })
  const message = received.at(-1) ?? ''
  expect(message).toContain('Subject: [Staging] Welcome to Cubepals')
  expect(message).toContain('multipart/alternative')
  const text = message.indexOf('Content-Type: text/plain')
  expect(text).toBeGreaterThan(-1)
  expect(message.indexOf('Content-Type: text/html')).toBeGreaterThan(text)
  expect(message).toContain('Your account is ready.')
  expect(message).toContain('<b>ready</b>')
})

test('without HTML, and without a prefix, it is the text alone under its own subject', async () => {
  await mailer('').send({ to: 'player@example.test', subject: 'Plain', text: 'Only words.' })
  const message = received.at(-1) ?? ''
  expect(message).toContain('Subject: Plain\n')
  expect(message).not.toContain('multipart')
  expect(message).not.toContain('text/html')
  expect(message).toContain('Only words.')
})

test('no email carries a bulk-mail header, and a reply goes where it is told', async () => {
  await mailer('').send({
    to: 'player@example.test',
    subject: 'Reset',
    text: 'A link.',
    html: '<p>A link.</p>',
  })
  const everyday = received.at(-1) ?? ''
  expect(everyday).not.toMatch(/^Reply-To:/im)
  await mailer('', 'Cubepals <hello@blockly.test>').send({
    to: 'player@example.test',
    subject: 'Reset',
    text: 'A link.',
    html: '<p>A link.</p>',
  })
  const account = received.at(-1) ?? ''
  expect(account).toMatch(/^Reply-To: Cubepals <hello@blockly\.test>$/m)
  for (const message of [everyday, account])
    expect(message).not.toMatch(
      /^(List-Unsubscribe|List-Unsubscribe-Post|List-Id|Precedence|Auto-Submitted):/im,
    )
})

test('a notice comes from the notices’ sender, with no Reply-To, and nothing else does', async () => {
  const both = new SmtpMailer({
    smtpUrl: `smtp://127.0.0.1:${port}`,
    from: 'Cubepals <account@blockly.test>',
    noticeFrom: 'Cubepals <noreply@blockly.test>',
    replyTo: 'Cubepals <hello@blockly.test>',
    subjectPrefix: '',
  })
  await both.send({
    to: 'player@example.test',
    subject: 'Moved',
    text: 'A notice.',
    html: '<p>A notice.</p>',
    notice: true,
  })
  const notice = received.at(-1) ?? ''
  expect(notice).toMatch(/^From: Cubepals <noreply@blockly\.test>$/m)
  expect(notice).not.toMatch(/^Reply-To:/im)
  await both.send({ to: 'player@example.test', subject: 'Reset', text: 'A link.' })
  const account = received.at(-1) ?? ''
  expect(account).toMatch(/^From: Cubepals <account@blockly\.test>$/m)
  expect(account).toMatch(/^Reply-To: Cubepals <hello@blockly\.test>$/m)
  // Without a sender of its own, a notice comes from the everyday one.
  await mailer('').send({ to: 'player@example.test', subject: 'Moved', text: 'A notice.', notice: true })
  expect(received.at(-1) ?? '').toMatch(/^From: Cubepals <hello@blockly\.test>$/m)
})

test('a server that never greets fails the send instead of holding it', async () => {
  const silent = createServer(() => undefined)
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const address = silent.address()
  const silentPort = typeof address === 'object' && address !== null ? address.port : 0
  const mailer = new SmtpMailer(
    { smtpUrl: `smtp://127.0.0.1:${silentPort}`, from: 'Cubepals <hello@blockly.test>', subjectPrefix: '' },
    { connectionTimeout: 200, greetingTimeout: 200, socketTimeout: 200 },
  )
  const started = Date.now()
  try {
    // Nodemailer reports the silent server as "Greeting never received" or as a timeout,
    // depending on which of its timers fires first on a busy runner.
    await expect(mailer.send({ to: 'player@example.test', subject: 'Hi', text: 'Hi.' })).rejects.toThrow(
      /timeout|greeting never received/i,
    )
    expect(Date.now() - started).toBeLessThan(5_000)
  } finally {
    silent.close()
  }
})
