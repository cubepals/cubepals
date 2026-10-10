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

const mailer = (subjectPrefix: string) =>
  new SmtpMailer({
    smtpUrl: `smtp://127.0.0.1:${port}`,
    from: 'Cubepals <hello@blockly.test>',
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
