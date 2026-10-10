# Local development

The whole stack on one machine, from a fresh clone, with no outside account: no Polar, Google,
GitHub, Fly, Cloudflare or SMTP provider. Docker has to be running.

```sh
bun run dev    # dependencies, containers, migrations, then the control plane and the web app
```

`bun run dev` (`scripts/dev.ts`) copies `.env.example` to `.env` itself if there is none, runs
`bun install` (every time, so a pull that adds a package just works), starts
the containers with `docker compose up -d` (Postgres, Mailpit, the object store, the
edge), waits for Postgres, applies the database's migrations, then runs the control plane and the web app until
Ctrl-C. The site is at http://localhost:3000, mail at http://localhost:8025.

`.env` reads the same in node's `--env-file`, docker compose and a shell's `source .env`
(`scripts/env-example.test.ts` holds them to it). Its secrets start with `local-only-`: anyone can
read them, so a deployment refuses to start with one. `bun run scripts/dev-env.ts` writes `.env`
with fresh ones instead.

## Test accounts

```sh
bun run dev:accounts    # with `bun run dev` running
```

makes one account per plan, `<plan>@blockly.localhost` (today `free@` and `plus@`), each signed
up with the Terms agreed and confirmed through Mailpit, and each paid one put on its plan through
the local checkout below. With `LOCAL_BILLING=polar`, paid accounts stay on Free and it says so:
Polar's checkout is a person's to go through. Run again, it resets them: the same passwords,
confirmed, back on their plans. Passwords go to `local/dev/accounts.json` (git ignores
`local/`); the terminal shows only where.

## What stands in for what

A deployment is local when its web origin is on this machine or its local network
(`apps/control/src/config/local.ts`); `bun run dev` and `bun run dev:lan` are. The control plane
then logs one `local:` line for each of these as it starts. Staging and production get none of
it: `config/environments.test.ts` and `config/local.test.ts` hold them to that.

| Outside service | Locally |
|---|---|
| Polar (payments) | The local checkout (`apps/control/src/infra/local-billing/`). Upgrade opens its page; its button sends a signed delivery to `/api/billing/webhook`, the route Polar's webhooks take, and the account is on the plan. Manage billing opens its other page, which cancels it. Nothing is charged; a plan bought there runs a year. Polar's values in `.env` change nothing: its webhooks never reach this machine, so its checkout would upgrade nobody here. `LOCAL_BILLING=polar` asks for Polar's sandbox; then, with every `POLAR_*` value set, it is used, and with only some, the log says which is missing and the local checkout stands in. |
| The free-account cap | Off: sign-up is always open. `platform_controls.max_free_accounts` still shows on the platform page. |
| Google and GitHub sign-in | Hidden while their client ids are empty. Email sign-in works. |
| Email | Mailpit catches every message (`SMTP_URL`), at http://localhost:8025. |
| Fly, Boat, a fleet | Servers run in Docker on this machine (`RUNTIME_PROVIDER=docker`), joined at `<slug>.play.localhost:25565`. |
| Regions | One, "This computer" (`REGIONS="local:This computer"`), because that is where servers run; the create page shows no picker and Settings → Location just names it. To try the picker and the move, set `REGIONS="eu:Europe,us:North America"`: both run on this machine, and a move here changes only the region. `RUNTIME_REGION_MAP=local:local,eu:local,us:local` keeps servers made under any of the three starting. Docker allows more than one region only locally. |
| Cloudflare's country header | `DEV_COUNTRY` (`US`, `DE`, …) stands in for `cf-ipcountry`, which picks the region a new server starts in. Empty, it starts in the first. |
| Object storage (R2) | RustFS in docker compose. Empty `ARCHIVE_S3_ENDPOINT` turns archives off instead. |
| Let's Encrypt, Cloudflare | Live updates use a self-signed certificate the browser pins (`REALTIME_TLS_MODE=pinned`). |

`bun run dev:lan` serves the same stack to other devices on the network; see `scripts/dev-lan.ts`.
