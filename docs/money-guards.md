# Money guards

Fly has no spending cap and no billing alerts, so Cubepals bounds what it spends itself. This
lists every guard that limits what Cubepals can spend, its default, what fails if it breaks, and
what bounds the cost instead. The last section is the runbook for a spike.

The watchdog prices compute at Fly's list prices for the default region, per size
(`apps/control/src/domain/account/entitlements.ts`). A day is 24 running hours. Free runs only
3 GB. Plus can run 3, 4 or 8 GB.

## The bound that matters

With every guard working, the most Cubepals can spend on servers in a day is set by
**`maxRunningServers`**: that many servers, at the largest size their plans allow, for 24 hours.
Disks add the servers held × their sizes × the volume price, a small share of it.

The spend watchdog trips at **`dailySpendLimitCents`** and pauses starts and creation. A day can
still pass the limit, by what is already running and by up to ten minutes between passes.
Running servers stop as they idle out.

## Every guard

"Tested" names the tests that hold the guard at its trip point. "If it breaks" is the cost with
that one guard gone and every other guard working.

### Platform kill switches and caps

Set on `/admin/platform`, stored in `platform_controls`, read on every request
(`apps/control/src/app/platform/controls.ts`, `domain/policy/policy.ts`; the free-account cap is
`AccountService.admits` in `app/accounts/service.ts`, asked by Better Auth before it writes an
account). The defaults are the table's (`packages/db/src/schema/accounts.ts`); every change is
audited with what it was before.

| Guard | Default | What it stops | If it breaks | Tested |
|---|---|---|---|---|
| `provisioningEnabled` | on | Creating servers, and a worker continuing a create it accepted | The caps below still hold | `policy.test.ts` "every kill switch…", "the kill switch stops creation…"; `platform.test.ts`; `spend-watchdog.test.ts` |
| `startsEnabled` | on | Starts from the page, **wake-on-join through the edge**, restarts, restores, and a worker continuing a start | The caps below still hold | `policy.test.ts`; `spend-watchdog.test.ts` "paused by the watchdog, nothing starts…" (through the edge's HTTP protocol) |
| `publicListingEnabled` | on | The public directory | No spend of its own | `listings.test.ts`, `policy.test.ts` |
| `uploadsEnabled` | on | Mod and pack uploads (archive storage) | No compute; storage only | `policy.test.ts` "every kill switch…" (no test existed before) |
| `maxRunningServers` | **10** | The next start or create past it, platform-wide | Falls to the per-plan limits × accounts, then the provider ceiling | `policy.test.ts` "the platform runs ten at once…" |
| `maxServers` | **30** | The next server that holds compute past it | Falls to the provider ceiling | `policy.test.ts` "thirty servers in all…"; `platform.test.ts` |
| `dailySpendLimitCents` | **1000** | See the spend watchdog | — | `spend-watchdog.test.ts` |
| `maxFreeAccounts` | **30** | Sign-up past that many free accounts. The check and the take are one step (`lockFreePlaces`; a place is held in `signup_holds` until the account is written), so two at the last place get one. The sign-up page shows no form while it can't ask | Signups are free until they play; the caps above still hold | `signups-full.test.ts` "two sign-ups at once…"; web `auth-methods.test.ts` |

### The capacity lock and `SPENDS`

`apps/control/src/app/policy/access-policy.ts`. Every decision that spends money
(`create_server`, `start_server`, `resize_server`, `undelete_server`) takes a Postgres advisory
lock (`lockCapacity`) before it counts, inside the transaction that writes. Two starts at once
can't both see 9 running and both start.

- **If it breaks:** concurrent requests overshoot each cap by however many arrive at once.
- **Tested:** indirectly, by every service test that starts or creates. Nothing races two
  requests against it.

### Plans (`apps/control/src/domain/account/entitlements.ts`)

| Guard | Free | Plus | If it breaks | Tested |
|---|---|---|---|---|
| Hours a month (`includedUnits`) | **20** | **60** (an 8 GB hour counts as 2) | A server runs until it idles out, every day | `policy.test.ts` "Free's 20 hours and Plus's 60…"; `metered.test.ts`; `usage.test.ts` |
| Hours run out → running servers stop | `standing-sweep`, every minute | same | A run already going runs until it idles out | `metered.test.ts` |
| Idle shutdown (`idleShutdownAfterMinutes`) | **10 min** | **15 min** | An empty server runs until the month's hours are spent | `schedule-limits.test.ts`, `edge.test.ts` |
| Wake probation | 5 min | 5 min | A join nobody follows runs the whole idle window | `edge.test.ts` |
| Wakes an hour, per server | 12 | 12 | A forged join wakes it every time, bounded by the hours | `edge.test.ts` "woken over and over…" |
| AFK kick (`playerIdleKickMinutes`) | **15 min** | 15 min; the owner may change it | A standing player keeps the server up until the hours run out | `minecraft.test.ts`, `plan-caps.test.ts` |
| `createsPerHour` | **3** | **10** | Bounded by `maxServers` per plan anyway | `policy.test.ts` "a free account makes three servers an hour at most" (no test existed before) |
| `maxServers` | **1** | **3** | Falls to the platform caps | `policy.test.ts`, `accounts.test.ts`, `lifecycle.test.ts` |
| `maxRunning` | **1** | **2** | One account can fill the platform's running cap | `policy.test.ts`, `billing.test.ts` |
| Paid hours past the block (`mayBuyMore`) | no | yes, under the guards in [Extra play](#extra-play) | — | `extra-play.test.ts`, `extra-usage.test.ts` |

The AFK kick is vanilla's own (`player-idle-timeout`), and its timer starts again on anything the
player's client does, including what it didn't choose: being knocked back, or respawning. A
standing player that mobs reach at night is kicked that much later. A client that respawns by
itself, as a bot does, starts it again at each death. A real player who dies stays on the death screen, so
the delay is the time until the mobs got to them. The hours still bound it.

### Extra play

Plus players can play past their 60 hours, at 25¢ an hour (a large server two), billed after it
is played, on their next Plus payment. Money lost here is play Polar never collects, so every
guard is about who may run up hours they then don't pay for. Blockly is the only judge of hours:
it counts them, holds them to the owner's limit and stops servers; Polar only bills what Blockly
sends it, and never stops anything itself.

| Guard | Where | If it breaks | Tested |
|---|---|---|---|
| Only Plus with an `active` subscription (not trialing, past due or set to end), at least one paid Plus order, and nothing owed may allow extra | `domain/account/extra-play.ts` | Someone allows hours on a card that was never charged, or that they are leaving | `extra-play.test.ts` |
| A ceiling: **20** extra hours a month ($5) until a renewal (`order.paid`, `subscription_cycle`) is paid, then **100** ($25) | `EXTRA_CEILING`, `entitlements.ts` | A new card's first failure costs more | `extra-play.test.ts`, `extra-usage.test.ts` |
| The owner's own limit, from what fits under the ceiling; servers stop with `stopReason = hours` at it | `AccountService.enforceLimits`, `standing-sweep` | Play past what they said | `extra-usage.test.ts` |
| A cancel, a failed renewal or an ending stops extra play at once: servers sleep at the included block; what was played stays owed | `extraPlayNow` read by the policy, the sweep and the reporter | Play that the final invoice may not collect | `extra-usage.test.ts` |
| A charge carrying extra play that is owed blocks starts and new servers (`payment_due`, `stopReason = unpaid`) and a new checkout until it is paid; downloads stay. It is owed only once Polar, asked again (`BillingService.confirmOwed`), says it is still unpaid, and it is at least an hour old: a subscription's final charge once it was tried and declined (a `failed` payment) or voided, any other once 7 days have passed | `billing/persistence.ts` `owing`, `mayBeOwed`, `policy.ts` | Someone plays on after not paying; or, without the second read, a lost `order.paid` blocks someone who paid | `extra-usage.test.ts`, `policy.test.ts` |
| Polar's own backstop: the metered price's `cap_amount`, $50 a period (twice the top ceiling, since a calendar month's extra can straddle two billing periods) | Polar | Only a bug in all of the above | — |

**Counting.** Every minute (`extra-play-report`), for each account that played in the last
quarter of an hour, or has a month before this one that isn't final yet, Blockly takes each such
month's units past the included block, held to what it may use, in thousandths of an hour rounded
down, and raises the month's row in `extra_play_months` to it. The row only grows, so lowering a
limit never un-bills hours already played. While extra play is on, the count runs to now; once a
cancel, a failed renewal or an ending stops it, the count runs to that moment
(`billing_subscriptions.canceled_at`, Polar's own `canceled_at` where it says, or `past_due_at`)
and no further, so what was played before it is billed even when no count ran in between. The
month is the UTC calendar month ("resets on the 1st"). A month is counted until it is final
(`final_at`): over for an hour, past `usage-close`, with nothing of the account's that ran in it
still running. An account that may play extra and ran last month is counted then whether or not
it plays now.

**Reporting.** What was counted and not yet reported becomes an event in `extra_play_reports`
once a quarter of an hour waits, once anything has waited ten minutes, or once its month is over.
Each event is written before it is sent, with the id `extra:<account>:<YYYY-MM>:<n>`, which Polar
keeps for good: sent again it counts as a duplicate, never twice. Unsent events go oldest first,
25 to a request, at most four requests a pass; a batch Polar refuses is sent one at a time so one
bad event never holds back the rest. An event Polar refuses waits a minute before it is sent
again, then twice as long each time, up to six hours; after ten refusals (about eight and a half
hours) it is no longer sent (`failed_at`), it goes on the account's audit log as
`billing.extra_unsent` with its hours and cents, and the `extra_play_unsent` admin alert says how
many are set aside. Newer events go on meanwhile. Polar being down refuses nothing: the pass stops
and everything is sent again next minute. Events are dated a
minute behind the clock, because Polar refuses one from the future. Polar bills an event on the
payment after it *receives* it, so a late one lands on the next payment, never on none.

**Being paid.** A renewal's metered line is kept on its order (`billing_orders.extra_cents`). A
failed one is emailed once while Polar retries the card; once it is owed, once more, and servers
stop until it is paid. Before either email, and before an order is held to be owed
(`billing_orders.owed_at`), the order is read from Polar again with its payments, so one whose
`order.paid` was lost is kept as paid instead; Polar not answering leaves it for the next minute's
pass. A final charge made when a subscription ends is pending at first and tried later, so it is
owed only after an hour, and only once a payment for it failed or Polar voided it. While Polar still retries it, it is paid by fixing the card: the portal's
"Retry payment" charges the new card, and `order.paid` clears the block. Once its subscription has
ended, Polar won't retry it (`OrderNotEligibleForRetry`) and voids it, so the account page offers
"Pay $x" instead: a checkout for the one-time "balance" product (found by its metadata
`purpose: balance`), with the orders it settles in its metadata and no discount codes. It is priced
at what those orders came to before tax (`net`), as an ad-hoc price with `tax_behavior: exclusive`,
so the payer's tax goes on top once and they pay what they owed, never tax twice. Its `order.paid`
marks them `settledBy` that order, which clears the block, only when the order is for the balance
product and its own amount before tax covers theirs; anything else (another product carrying the
metadata, a short amount) clears nothing and is kept on the account's audit log
(`billing.balance_short`), and the debt stays. A charge still retried is never offered there, so
nothing is paid twice. "Pay $x" clicked again offers the checkout still open for the same orders
and amount (with 15 minutes left on it) rather than a second. A balance order that pays for orders
already paid (a second checkout, or the card fixed since) is refunded through Polar at once, before
tax, which Polar refunds with it (`billing.balance_overpaid_refunded`); `refund_asked_at` keeps a
webhook delivered twice from refunding twice. A balance order refunded, so that what is left of it
no longer covers what it paid, leaves those orders owed again (`billing.balance_refunded`).

**What Polar does, as seen in its sandbox (2026-10-10).**
- Checkout shows the plan's $15 and, under "Additional metered charges may apply", the line
  "Extra play $0.25 / hour". The portal shows "Metered Usage · Extra play $x" on the
  subscription, and, once it is set to end, a "Final Charge" card with the metered charges and
  "This will be the final charge before the subscription ends."
- A card can't be removed in the portal while a subscription still uses it, even once it is set to
  end: Polar answers `PaymentMethodInUseByActiveSubscription` ("Add another one or cancel the
  subscription first"). Replacing it with one that later declines is still possible, so a renewal
  that fails is what guards 3 and 4 are for.
- An event id sent twice is counted once (`inserted: 0, duplicates: 1`).
- Polar counts an event on the customer's meter within seconds, but bills it only once its own
  job has turned it into a billing entry, which took about ten minutes. An event that arrives
  later than that before a renewal is billed on the next one; 3.5 hours sent seven minutes before
  a renewal weren't on it, and were on the next period's meter at $0.88 (Polar rounds the half
  cent up). On a subscription that ends, the final invoice is the last one, so hours played in the
  last minutes before it ends may never be billed: bounded by the reporting delay, and the
  renewal check below says when it happened.
- Each paid renewal is checked against what Blockly sent since the order before it
  (`billing.extra_billed` on the account's audit log, with both amounts); a difference is kept for
  an admin, never acted on.

### Session cap (`apps/control/src/app/operations/schedules/session-cap.ts`)

No plan sets one (`maxSessionMinutes: null`). It is an admin's tool for one account, such as an
AFK farm that defeats the kick: warnings at 10 and 2 minutes, then an ordinary stop.

- **If it breaks:** that account runs until its hours are spent.
- **Tested:** `session-cap.test.ts`.

### Compute nobody accounts for

| Guard | When it runs | What it does | If it breaks | Tested |
|---|---|---|---|---|
| `reconcile` | every minute; a full pass hourly | Stops compute that starts running behind a stopped or failed server, and records crashes | Such a machine runs until the orphan sweep, at most an hour | `lifecycle.test.ts` "compute running behind a stopped server…" |
| `orphans` | hourly at :17, **and at once when the watchdog sees a stray** | **Stops** running compute that no running server accounts for: a stopped server's, one the database doesn't know, one left by a move. Destroys compute of purged servers and compute left by moves | A leaked machine runs at its size's price, and no cap counts it | `spend-watchdog.test.ts` "a machine Fly runs…"; `lifecycle.test.ts` |
| `usage-close` | every 10 min | Closes power intervals left open, so metering never counts time off | Over-counts hours; spends nothing | existing schedule tests |
| `store-sweep` | hourly | Rests worlds unplayed for 14 days (Free) or 30 (Plus), letting go of machine and disk | Idle disks stay, at the volume price | `storing.test.ts` |

Unknown compute used to be kept running "for an operator". It is now stopped, never destroyed,
so its world stays. The edge can't route to a server the database doesn't know, so nobody can
be playing on it.

### The spend watchdog (`apps/control/src/app/operations/schedules/spend.ts`)

Runs every 10 minutes (`spend-watchdog`). It works out the UTC day's spend from what the control
plane recorded (`domain/policy/spend.ts`):

- **compute:** every power interval that overlaps the day, by its size, at the prices above. A
  size it doesn't know is priced as 8 GB;
- **stray compute:** running machines that no running server accounts for, from when Fly last
  saw them change, at their server's size or 8 GB;
- **disks:** every disk held, at its plan's starting size or the size it grew to.

Each part rounds up to a whole cent. The figure goes to the log on every pass
(`spend-watchdog: <day> $<spent> of $<limit> (…)`), to the `spend_days` table, and to
`/admin/platform`.

Past the limit, once a day, it:

1. turns `startsEnabled` and `provisioningEnabled` off, audited as `system:spend`
   (`platform.controls_changed`, then `platform.spend_limit_reached` with the figure);
2. emails every admin (the `ADMIN_EMAILS` accounts) through the normal mail path, and tries
   again on later passes until every email goes out.

It never turns anything back on. An admin who turns the switches back on that day isn't
overruled until the next day. It doesn't stop running servers either: they stop as they idle
out, and the runbook says how to stop them sooner.

- **If it breaks:** the running cap still holds the day (see "The bound that matters").
- **What it can't see:** bandwidth (Fly charges for egress past its allowance), snapshots, the
  platform's own seven machines, and IPv4 addresses. Fly's bill is the truth. This is the early
  warning.
- **Tested:** `domain/policy/spend.test.ts` (prices, a full day, rounding, the limit at and one
  cent past), `app/operations/spend-watchdog.test.ts` (under the limit, at it, a cent past, once a day, an
  admin's override, the next day, a stray counted and stopped, the admin page).

### The provider ceiling (`fly_machine_limit`)

`fly_machine_limit`, in each environment's `config.auto.tfvars.json` (made from the committed
`config.auto.tfvars.example.json`), is the Fly org's machine limit, as Fly support set it. The
control plane reads it as `FLY_MACHINE_LIMIT`. It counts every machine, stopped ones too, and keeps 7 for the
platform and 2 a server (a restore, a move or an export briefly runs a second machine). So it
holds `maxServers` to `floor((limit − 7) / 2)` (`serverCeilingOf`). An admin can't set
`maxServers` above that.

**The variable doesn't change Fly's own limit.** Until Fly support sets the org's real limit to
match, Fly itself still allows what it allowed before, and with every guard in the app broken
that many machines can run. Ask Fly support to set the production org's machine limit to the
same number.

- **Tested:** `config/environments.test.ts` holds each environment's `maxServers` within its limit;
  `platform.test.ts` "the servers cap stays within what the provider's machine limit holds";
  `policy.test.ts` "thirty servers in all…".

## Raising the caps

Raise them in this order, each only after the one before is in place.

1. **Fly's limit:** ask Fly support to raise the production org's machine limit. Allow 2 machines per
   server plus 7: 100 servers is 207.
2. **`fly_machine_limit`** in `infra/terraform/environments/production/config.auto.tfvars.json`,
   to the same number. Apply Terraform (`docs/configuration.md`), which redeploys the control
   plane's `FLY_MACHINE_LIMIT`.
3. **`maxServers`** on `/admin/platform` → Caps → "Servers in all". It refuses a number above
   what the machine limit holds.
4. **`maxRunningServers`**: "Running at once". Each extra running server can add a day of its
   largest size.
5. **Daily spend limit**: "Daily spend limit, in dollars". Keep it below what the running cap
   allows on 3 GB (`maxRunningServers` × a 3 GB day), or it can never trip before the cap does.
6. **`maxFreeAccounts`**: "Free accounts". The waitlist count beside it says how many are
   waiting. Write to them yourself; nothing emails them on its own.

Lowering any of them works the same way, and takes effect at the next request. A server already
running isn't stopped by a lower cap. It just can't start again until there's room.

## If spending spikes

You notice it on Fly's bill, in a watchdog email ("Cubepals spent $X today…"), or on
`/admin/platform` → **Spend today**.

**1. Stop new spending (one minute).** Open `https://cubepals.com/admin/platform`. Under **Kill
switches**, turn off **Starting servers** and **Creating servers**. Nothing new starts: not
the Start button, not a player joining, not a restore. If the watchdog already did this, the
switches are already off, and the page says when.

**2. Stop what is running (a few minutes), if it can't wait for idle stops.** Running servers stop
on their own within 10 to 15 minutes of being empty. To stop them now:

- Find them in Fly: `fly machines list -a <app>` for each `bly-prod-*` app, or the
  Fly dashboard → `blockly-prod` → Machines, filtered to started ones.
- Stop one with `fly machine stop <id> -a <app>`. Stopping keeps the world. **Never `destroy`.**
- Reconcile records the stop as a crash on that server, which is harmless. Its owner can start
  it again once starts are back on.

**3. Look for machines nobody accounts for.** **Spend today** → "Machines nobody accounts for".
If it isn't 0, the watchdog runs the orphan sweep as soon as it sees them, so they stop within
ten minutes. Each stop is in the audit log as `server.stray_compute_stopped` by `system:orphans`.

**4. Check Fly's own figure.** The `blockly-prod` organization's billing page in the Fly
dashboard shows the month's usage so far, as Fly will invoice it. Compare its compute with the watchdog's days in
`spend_days`. If Fly is far above the watchdog's figure, look first at Fly's other charges:
bandwidth, IPv4, the platform's own machines, snapshots. Then look for machines in other orgs:
the watchdog only sees `blockly-prod`'s servers.

**5. Find out why.** The audit log (`/admin/audit`) has `platform.spend_limit_reached` with the
figure, and every start and wake with who asked. A server woken over and over shows `system:wake`
starts. One account with many servers shows in `/admin/accounts`. Restrict or suspend it there:
its servers stop within a minute.

**6. Turn things back on.** Once you know why and Fly's figure agrees, turn **Starting servers**
and **Creating servers** back on. If the day was busy rather than abused, raise the daily limit
instead (see "Raising the caps").

Staging runs in its own org (`blockly-staging`) with its own limit. Stop it with
`bun scripts/staging.ts stop` when nobody is testing (AGENTS.md).
