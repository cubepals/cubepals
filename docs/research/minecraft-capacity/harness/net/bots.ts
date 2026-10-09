// biome-ignore-all lint/suspicious/noConsole: a benchmark script whose output is its log
// Real protocol clients for the network benchmark: joins N offline-mode bots and keeps them online
// until killed. Movement is driven server-side over RCON so every bot moves identically.
import mineflayer from 'mineflayer'

const [port, count, version, staggerMs] = [
  Number(process.argv[2]),
  Number(process.argv[3]),
  process.argv[4],
  Number(process.argv[5] ?? 3000),
]

for (let i = 0; i < count; i++) {
  const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port,
    username: `net${i}`,
    version,
    auth: 'offline',
    viewDistance: 32 as never,
  })
  bot.once('spawn', () => console.log(`spawned net${i} ${Date.now()}`))
  bot.on('kicked', (r) => console.log(`kicked net${i} ${JSON.stringify(r)}`))
  bot.on('error', (e) => console.log(`error net${i} ${e.message}`))
  await new Promise((r) => setTimeout(r, staggerMs))
}
