# A held join, told how long

How the edge tells a player waiting on a booting server how long is left, and why it works the
way it does. The wake itself is [waking.md](waking.md); the edge's side of a join is §12 of
[architecture.md](architecture.md).

## Before

A join to a sleeping server waits in the edge's waiting room while the server wakes
(`apps/edge/hold.ts`). The client is in Minecraft's login state, and every 10 s it gets a login
query, which it answers, so it doesn't give up on a silent server. The login state can show no
words, so the player sees only "Logging in…": nothing says the world is waking, or for how long.
A resume is over in about 2 s and nobody notices. A boot takes 35 s or more, and production's
held joins from Oct 28 to 31 show players cancelling after 1 to 41 s.

## The hold, from here

1. **A few seconds as before.** The join is held in the login state, with its queries. A wake
   that is done in 4 s (`DIALOG_AFTER_MS`, `apps/edge/held-words.ts`) was a resume, and the join
   goes on to the server as it always has: no reconnect, nothing new to see.
2. **Then a dialog, for a client that takes one.** Past 4 s, a client from 1.21.6 on has its
   login finished by the edge: Login Success with the name and uuid the client sent, with no
   encryption and no account check, as an offline server does. The client acknowledges it and
   enters configuration, the state a server uses before the world loads. There the edge shows a
   notice dialog (Show Dialog, 1.21.6+) titled with the address the player dialled, saying the
   waking line from `waking-line.ts`: "Waking your world · about N seconds", counting down from the median
   the control plane measured, or only "Waking your world" without one. The edge looks at the
   line every second and shows the dialog again when its words change; between, a
   configuration keep-alive every 10 s keeps the client waiting. Escape closes the dialog, back
   to the joining screen, whose Cancel leaves.
3. **A transfer once the server is up.** The client is sent a Transfer (1.20.5+) to the address
   and port it dialled, as its handshake gave them. It connects again, and joins the server with
   a whole login of the server's own, online mode and account check included.
4. **Turned away in the words of the state.** A join that can't go on hears why, as today, by a
   configuration Disconnect with the same words.

Every other client keeps today's hold: one before 1.21.6, one whose protocol no report covers
yet (below), a Forge client (its marker after the hostname) and a Bedrock player through Geyser
(Floodgate's data after the hostname, `dialogFor` in `apps/edge/dialog-hold.ts`).

## Packet ids, from the game itself

Packet ids differ by version, and AGENTS.md has them taken from a maintained source. They are
taken from each release's own server: `java -DbundlerMainClass=net.minecraft.data.Main -jar
server.jar --reports` writes `reports/packets.json`, the id of every packet in every state.
`bun scripts/hold-packets.ts bump` runs the newest release of each protocol from 1.21.6 on, from
the jar Mojang's manifest names and by its SHA-1, and writes the ids the hold uses to
`apps/edge/hold-packets.json` with the jar each came from; `check` holds the copy to the manifest
and to the edge's protocol table. A protocol with no entry keeps the login hold.

They do move. 26.3 put a packet (`post_effects`) before Show Dialog and Transfer, so its Show
Dialog is 19 where 1.21.6 to 26.2 have 18, and its Transfer 12 where they have 11.
minecraft-data, which `scripts/protocols.ts` copies the protocol numbers from, has no packet data
past 26.1, so it can't be the source for the releases most players run.

A new release is a bump of `scripts/protocols.ts`, then of this. The report needs the Java the
release runs on (25 for 26.x: `JAVA=/path/to/java bun scripts/hold-packets.ts bump`).

## Transfers, without changing any server

A server refuses a transfer unless its `server.properties` says `accepts-transfers=true`. Setting
it for every server was the first plan. It isn't needed, and it costs:

- **Every spec changes**, so every running server nobody is on is restarted by drift, a few at a
  time, and every sleeping one boots on its next wake instead of resuming from memory.
- **The edge can't know which run took it.** A resume runs on the spec it slept with, and on
  Cubepals' own machines a change only a start reads waits for the next boot (`deferred`,
  [waking.md](waking.md#on-the-fleet)). A transfer to a server that resumed without it is refused
  with Minecraft's own "transfers disabled", so the control plane would have to tell the edge, per
  run, whether its server takes transfers.
- **Servers from before 1.20.5 don't know transfers at all**, though newer clients join them
  through their Via plugins.

Instead, the edge's front door makes every transfer a plain join (`withoutForwarding`,
`apps/edge/forwarding.ts`): it rewrites the handshake's intent from 3 to 2, as it already takes
forwarded identity out of every public handshake. The server sees a player joining the address
they chose, and logs them in as it would anyone. This is wherever the reconnect lands, on any
edge machine.

What it gives up: a server can't tell that another server sent a player. Vanilla only uses that
to decide whether to trust cookies another server stored, and Cubepals' servers set none. A
plugin that reads cookies on a transfer won't be asked to. Who can reach a server doesn't
change: anyone who knows the address could already join it, and the whitelist, bans and the
account check all apply to a transferred join as to any other.

## Security

- The edge never authenticates during the hold. It finishes a login nobody checked, and the
  only thing it does with the claimed name and uuid is send them back to the same client. It
  hands nothing to a server.
- The server does its own whole login after the transfer, online mode included. A player who
  claimed a name that isn't theirs sees a dialog, then the server refuses them, as it would have.
- Nothing about the wake changes: what wakes a server, and who may, is the control plane's, as
  before.
- A configuring client that sends far more than a waiting one does (256 KiB) is cut off.

## Bedrock players

Geyser speaks Java to the edge, on the newest protocol, so it would qualify by number. It keeps
the login hold: its joins carry Floodgate's data after the hostname, which `dialogFor` turns
down. What Geyser would do with a Java dialog in configuration and a Java transfer isn't known
well enough to put Bedrock players through it: a transfer translated to Bedrock's own would
send the client to the Java address. Bedrock's hold is a change of its own, through Geyser's
forms, if it is wanted.

## What it costs a player

- A join that waits past 4 s reconnects once, after the server is up: a new connection and a
  whole login, about what a join to a running server takes. A join that would have waited 35 s
  saying nothing now waits 35 s and a moment, told how long.
- The dialog shows again when its words change, so one closed with Escape comes back within
  5 s, with the new count.

## In the agent

`apps/edge/agent.ts` runs the waiting room. The quality gate measures it at zero coverage: its
tests start it as a child process, which the coverage preload doesn't reach, and a change to a
file must bring it to 80% branches, 90% functions and lines, and 80% of its mutants killed. So
every piece of logic here lives in its own tested module:

| Module | What it does |
|---|---|
| `held-words.ts` | Speaks to a held client until its wait is over: the queries, the switch, the dialog and its keep-alives |
| `dialog-hold.ts` | The dialog hold's packets: finishing the login, the dialog, keep-alive, transfer, disconnect; who gets one |
| `hold-packet-ids.ts`, `hold-packets.json` | The ids, by protocol, from each release's own report |
| `nbt.ts` | The NBT the dialog and the disconnect are written in |
| `forwarding.ts` | The front door's rewrite of a transfer into a join |

The front door's rewrite runs as soon as this ships: `front.ts` already calls
`withoutForwarding` on every public handshake.

What is left is the wiring in the agent's `hold`: `speakWhile` in place of its own query
interval, and at the end a transfer or a configuration disconnect where `speakWhile` handed back
a dialog, with the waking line read through `WakingLine.waking`. It is written and works: run as
a child process against a stand-in control plane, a join to a booting server has its login
finished at 4 s, hears the dialog and is transferred to the address it dialled, and one to a
server that resumes in half a second is passed on as before (`held-dialog.test.ts`). It can't
merge as it is, for two reasons:

- **The coverage gate refuses any change to `agent.ts`** until the whole file is measured.
- **`agent.ts` is at 796 of its 800 lines**, and the wiring takes it to 812, so something has
  to move out of it first, in a `Move:` change of its own, which meets the same gate.

The ways through, in order:

1. **Measure the agent where its tests already run it.** Four test files start it as a child
   process and drive real joins through it (`concurrent-joins`, `held-wake-line`,
   `hold-frames`, `visits`). Its coverage is zero only because the child isn't instrumented.
   Running the child under the same preload and merging its counters is a change to the quality
   infrastructure, which only a reviewed policy update can make (`scripts/quality/README.md`).
2. **Move the waiting room out of the agent, into a module tested in-process.** The move itself
   changes `agent.ts`, so it meets the same gate: `agent.ts` must first be imported in-process
   by tests that bring the whole file to the floors.
3. **A maintainer merges the wiring over the gate's refusal for `agent.ts`,** once the staging
   proof below has passed.

## Proving it

On staging, with `bun scripts/join-times.ts`, from a cold state (`--states cold`), the real
Java client:

- hears the dialog with its line within about 5 s of the join, and the line goes down;
- is transferred once the server is up, and is in the world by the server's own login;
- from a sleep that resumes (`--states sleep`), is let in with no dialog and no transfer.

`join-times.ts`'s Java client is mineflayer at 1.21.11. It has to follow the transfer and record
the dialog's words for the run to say so. 26.3's ids differ from 1.21.11's, and its layouts
can't be read from the report, so a vanilla 26.3 client joins a cold staging server by hand
before production.
