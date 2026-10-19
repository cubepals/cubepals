# Limits

What caps or paces Blockly when many people use it at once, and where each limit is set. The
numbers are not written here: they live in configuration, in code as development defaults, or in
private configuration (`ABUSE_LIMITS`, `FREE_LINK_TUNING`) for anything that guards against abuse.
Paths are from the repository root; `control/` is `apps/control/src/`.

## Server operations

Starting, stopping, creating and restoring a server are operations a worker runs a few at a time
(`control/main.node.ts`). The rest wait their turn. Pack imports, world downloads and curation have
a queue of their own each (`control/infra/pg/jobs.ts`).

A wake from the edge waits for its server to run, up to a limit set in `control/main.node.ts`, and
the edge agent gives up a little later.

## Wakes

A connection to a sleeping server can wake it, but each server can be woken that way only so many
times an hour (`AbuseLimits.wakesPerHour`, private configuration), and a run started by a
connection stops again if nobody completes a login (`control/app/edge/service.ts`). A server list
pinging a sleeping server starts it only under the tighter rules in `control/app/edge/ping-wake.ts`.

## Creating and starting

Creates, starts and undeletes take turns for the platform's counts, room and caps under one lock
(`lockCapacity` in `control/app/accounts/persistence.ts`). Each person's own facts are read before
it, under a lock of their own (`lockOwnerCapacity`). The person's lock is always taken first.
`control/app/policy/access-policy.ts` (`requireThenAdmit`) shows the order, and
`capacity-lock.test.ts` checks that nothing passes a cap and nothing deadlocks.

A runtime is asked whether it has room before the lock, so a call to a provider is never waited on
under it.

## Where servers run

Each runtime has a ceiling on what it holds, read from configuration (`control/config/load.ts`).
Fly's is the machine limit of its organization, less the machines the platform itself uses
(`control/infra/fly/fly-runtime.ts`). A fleet node's is its memory, CPU and disk ledger
(`control/infra/fleet/placement.ts`, [fleet.md](fleet.md)). A new server goes where there is room.

## The edge

The edge limits connections per address and per server, and handshakes in progress
(`apps/edge/agent.ts`, `apps/edge/front.ts`), from environment variables with defaults in code.
Every player reaches a game server from the edge's address, so Paper's own per-address connection
throttle sees one address for everyone on a server. A connection to a game server has a connect
timeout and an idle timeout longer than Minecraft's keep-alive.

The edge's route list is built from the control plane once a second per edge, and only the routes
that changed are sent on to mc-router, one at a time through its API (`apps/edge/router.ts`).

## Database

Each process opens a query pool and a job-queue pool, sized by `DATABASE_POOL_MAX`
(`packages/db/src/index.ts`, `control/config/load.ts`). Hot queries have indexes
(`control/app/servers/hot-path-indexes.test.ts` plans the real ones).

## Sweeps

Per-minute sweeps (presence, idle stops, session caps, drift, disk growth) go through running
servers one at a time (`control/app/operations/schedules/`). A scheduled job that runs past its
expiry is cut off.

## Outbound calls and request size

Calls to Hangar and to the mail server have timeouts. The Fly API is called at a fixed pace per process
(`control/infra/fly/client.ts`). Page reads, invite reads and the waitlist are counted in each
machine's memory (`control/infra/limits/memory-limits.ts`).
