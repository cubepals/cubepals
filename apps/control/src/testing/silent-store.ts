// Run with Node, as the control plane runs: a store that accepts connections and never answers,
// and one call to it. Prints how the call ended, as JSON. Bun's node:http never fires socket
// timeouts, so this can't run inside `bun test` itself (see s3-archive-store.test.ts).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { S3ArchiveStore } from '../infra/s3/s3-archive-store.ts'

const silent = createServer(() => {})
await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
const { port } = silent.address() as AddressInfo
const store = new S3ArchiveStore({
  endpoint: `http://127.0.0.1:${port}`,
  bucket: 'silent',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  timeouts: { connectMs: 1_000, idleMs: 700 },
})
const started = Date.now()
try {
  await store.head('anything')
  process.stdout.write(`${JSON.stringify({ outcome: 'answered' })}\n`)
} catch (error) {
  const ended = { outcome: 'failed', name: (error as Error).name, ms: Date.now() - started }
  process.stdout.write(`${JSON.stringify(ended)}\n`)
} finally {
  silent.closeAllConnections()
  silent.close()
}
