import { afterEach, describe, expect, test } from 'bun:test'
import { clientAddressHeaders } from './client-address'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
const incoming = new Headers({ 'fly-client-ip': '198.51.100.1', 'x-real-ip': '203.0.113.7' })
const configured = (header: string | undefined, secret: string | null = 'a-proxy-secret-long-enough') => {
  process.env = { ...saved }
  if (header === undefined) delete process.env.WEB_CLIENT_ADDRESS_HEADER
  else process.env.WEB_CLIENT_ADDRESS_HEADER = header
  if (secret === null) delete process.env.WEB_PROXY_SECRET
  else process.env.WEB_PROXY_SECRET = secret
}

describe('what the web tier tells the control plane about a browser', () => {
  test('the address from the header its host sets, with the secret', () => {
    configured('fly-client-ip')
    expect(clientAddressHeaders(incoming)).toEqual({
      'x-blockly-client': '198.51.100.1',
      'x-blockly-proxy': 'a-proxy-secret-long-enough',
    })
    configured('x-real-ip')
    expect(clientAddressHeaders(incoming)['x-blockly-client']).toBe('203.0.113.7')
  })

  test('nothing without the secret, without a named header, or when the header is missing', () => {
    configured('fly-client-ip', null)
    expect(clientAddressHeaders(incoming)).toEqual({})
    configured(undefined)
    expect(clientAddressHeaders(incoming)).toEqual({})
    configured('fly-client-ip')
    expect(clientAddressHeaders(new Headers())).toEqual({})
  })
})
