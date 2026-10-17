# When a resume hangs

How Blockly wakes a server that Fly suspended, and the fallbacks it takes in turn when the resume
doesn't come back. The table's last column says what happens on the fleet, where blocklyd suspends
([waking.md](waking.md#on-the-fleet)). The code is in `apps/control/src/app/`: `operations/resume.ts` (the resume and
its bounds), `operations/handlers/host-refused.ts` (the rebuild elsewhere) and the edge's wake in
`edge/service.ts`.

## What Fly promises, and what it doesn't

- **No guarantee to resume.** "We do not guarantee that a suspended Machine will ever resume from its
  snapshot." A deploy, a new image, a host migration, maintenance, or a lost snapshot drops the
  snapshot, and the machine cold boots from its image instead, with its volume as it was
  ([suspend-resume](https://docs.fly.io/reference/suspend-resume)).
- **Stopping a suspended machine discards its snapshot**, and its next start is a cold boot
  ([Machines resource](https://docs.fly.io/machines/api/machines-resource/)).
- **Nothing watches a resume.** In the 15-hour case of 2026-10-06, Fly staff said: "There's nothing
  supervising the machine comes up: it's a 'try to resume' fire and forget kind of thing." The
  host had run out of capacity, and a migration raced with the volume's move. Stop, start and a
  forced restart all failed, and only destroying the machine got the app back
  ([topic 28766](https://community.fly.io/t/machine-stuck-in-starting-for-15h-after-resume-from-suspend/28766)).
- **Fly sets no time for any state.** It counts a machine as wedged after 5 minutes in `starting`
  ([machine states](https://docs.fly.io/machines/machine-states)). The `wait` endpoint takes a
  `timeout` that defaults to 60 s, and nothing else bounds a wait.
- **Volumes are tied to their host.** A host without room refuses "to create new machine with
  existing volume". The way out is a new volume from a snapshot or a fork, somewhere else
  ([21378](https://community.fly.io/t/insufficient-resources-to-create-new-machine-with-existing-volume/21378)).
  Regional shortages come in runs: DFW and ORD in March 2026
  ([rollup](https://community.fly.io/t/psa-postmortem-s-rollup/27367)).

Blockly's own numbers, from staging on 2026-10-15:
- At 3, 4 and 8 GB (60 wakes), every resume reached a player within 3.2 s, and p95 was 2.3 s.
- At 16 GB (5 wakes, `bun scripts/suspend-bench.ts flow paper 16g 5`), every resume was `started`
  within 0.95 s and answered within 1 s, every block built before the sleep was there, and the
  suspend itself took 12 to 28 s. A resume doesn't get slower with more memory, so one bound
  serves every size.
- A cold boot answers in 35 to 45 s. At 16 GB, with the snapshot dropped, it was `started` after
  3.3 s and answered after 23 s.

## Where the 11.5 minutes went

A resume that didn't answer within 10 s was taken for a boot from disk, the one fallback Fly
documents. The boot was then given its full waits before anything else happened:

- **The machine reached `started` but never answered.** That meant 10 s, plus the 10-minute
  ready wait, plus a graceful stop of the frozen process (up to the 90 s grace), and only then a
  cold start: about 11.5 minutes.
- **The machine never reached `started`.** Each attempt waited 2 minutes for it. Three attempts,
  then the start failed, with no cold start at all, and the next join hit the same machine.

## The ladder

Each rung has a bound. The player is never left in silence: the edge's waiting room holds the join
for up to 3 minutes and asks again every few seconds, the server list says "Starting up · try again
in a moment", and a plain message ends the hold.

1. **Resume.** The machine has 30 s to reach `started` (nine times the slowest resume measured,
   and still short of a cold boot's answer). Once it runs, it has 10 s to answer a ping. The wait
   ends at the bound, not when Fly's long poll next returns.
2. **Snapshot dropped, so Fly cold boots.** It runs and prints its boot, but doesn't answer yet.
   This start goes on as a boot from its disk, as before.
3. **Hung resume.** It isn't running by 30 s, or it runs but neither answers nor prints anything
   by 30 s, and in no case sooner than 10 s after it got running.
   Blockly gives up on the snapshot: it kills the machine, which discards the snapshot, and cold
   starts it on its own volume. Nothing is lost. A server sleeps only once its world is saved
   (`save-all flush`) and written through to disk (`sync`), and nobody plays while it sleeps. The
   operation keeps a `resume_hung` mark, and the `resumes_hung` alert counts the servers it
   happened to, not the times.
4. **The host can't run it.** This covers two cases: the kill or the fresh start fails (a wedged
   machine), or Fly refuses the start for want of room on the host.
   - **A rebuild, when nothing can be lost.** It happens only from the snapshot a sleep took after
     the server's last run ended, which holds everything played. A schedule's or an owner's
     snapshot may have been taken while people played, so it never counts.
   - **How it rebuilds.** Blockly rebuilds the server elsewhere in its region from exactly that
     snapshot (the host-lost rebuild, `relocate` with `hostLost`) and starts it there. The old
     machine is destroyed, but the old volume is kept beside the new one: the leftovers sweep
     leaves it for 7 days (`servers/kept-storage.ts`), and the `storage_kept` alert lists it until
     it goes.
   - **Otherwise, a failed start.** It fails for good, with the `hosts_refused` alert, so an admin
     decides, for example by forking the volume. It doesn't go back to sleep, where a waiting join
     would only ask again every few seconds.
5. **Host unreachable.** Fly reports `host_status: unreachable`. The relocation sweep rebuilds the
   server from its newest snapshot after 10 minutes, as before.
6. **The end.**
   - **A start that failed in waking.** That is a resume given up on, or a host that couldn't run
     it. A joining player is told "Couldn't start this server just now · try again in a minute",
     and their next join tries the start again. Two joins at once start it once.
   - **A start that failed over what the server runs**, such as a crash or a broken mod. It would
     only fail again, so a join is told "This server can't start right now · its owner can see
     why on Cubepals", and nothing starts it.
   - **The hourly wake cap** counts every start a join asked for, whether it came up or not, but
     not one its runtime had no room for (a Boat plan's starts spent), which a waiting join asks
     again every few seconds at no cost.
   - **Rollout.** An edge names the newer answers it can word. Control deploys before the edges,
     so until an edge names them it hears what it did before: "starting" for the first case, and
     the suspended wording for the second.

| Failure | How it shows | Response | Bound | On the fleet |
| --- | --- | --- | --- | --- |
| Normal resume | `started`, answers a ping | Lets players in | 30 s to run, 10 s to answer | blocklyd resumes the frozen container; the start answers `resumed: true` |
| Snapshot dropped (deploy, migration, maintenance) | Runs, prints a boot, doesn't answer yet | Goes on as a boot | Boot's waits (2 min to run, 10 min to answer) | A host restart drops the frozen process: the copy reads `stopped` and boots on its data |
| Resume stuck in `starting` | Not `started` by 30 s | Kill, cold start on the same volume | 30 s, then the kill's 60 s at most | blocklyd kills it after `resume_timeout_seconds` (10 s) and starts it afresh; the start answers `resumed: false` and goes on as a boot |
| Resume `started` but frozen | No answer and no output by 30 s, and 10 s after running | Kill, cold start on the same volume | 30 s, or running + 10 s | Ladder as on Fly, after blocklyd's own 10 s |
| Wedged machine (won't stop or start) | The kill or the fresh start fails | Rebuild elsewhere from the sleep's snapshot after the last run, keeping the old volume; otherwise fail for good and alert | Kill's 60 s, then a rebuild | Ladder as on Fly |
| No room on the host | Fly refuses the start (`insufficient resources`) | The same | At once | The node refuses the start (`insufficient_capacity`): the server moves to a node with room |
| Host unreachable | `host_status: unreachable` | Rebuild from the newest snapshot (existing sweep) | 10 min grace | The node is suspect, then lost; an operator confirms the loss, and the server is rebuilt |
| API 429, 502–504 | Non-OK answers | Client paces requests and retries a 429, and a 502–504 on a repeatable call, waiting out `Retry-After`; an attempt that fails anyway is retried twice, backing off from 5 s | 5 tries a request, 3 attempts | None |
| Lease held | "lease currently held" | Blockly's own lease lives 120 s; the attempt retries | 3 attempts | None |
| Volume still claimed | 412 on create | Waits for the claim, clearing leftover helpers (existing) | 3 min | None |
| Slow image pull on a new host (rebuild only) | Machine stays `created` | Waits for it to settle (existing) | 10 min | A wake's PUT waits its grace plus 2 min; the node finishes the pull, and the retry finds it done |

## What is left open

- A wake whose log can't be read can't be told apart from a frozen one, so it is left to boot as
  before. A boot that is running but whose output takes more than 10 s to show up is killed and
  started once more. That is harmless, because nothing has loaded the world yet.
- Recovering a world whose snapshot is older than the last play needs a fork of the volume off the
  wedged host. That is the operators' call today, raised by the alert.
- A rebuild's kept volume can't be renamed or marked on Fly, so Fly can't tell it apart by
  itself. A start takes the volume the server's machine mounts, then the one its handle names,
  and never one recorded as kept. With only kept storage left it boots nothing and makes nothing,
  for an admin to decide. The inventory names no world volume when an app holds two.
