# The control plane: one image for the api, worker and realtime roles; ROLES picks which a
# machine runs. Build from the repository root:
#   docker build -f apps/control/Dockerfile -t blockly-control .
# Node runs the TypeScript sources directly (type stripping, Node >= 22.18), as in development.
# Debian trixie, not bookworm: the WebTransport module's prebuilt binary needs glibc 2.38.
# No base image comes from Docker Hub, whose outages and rate limits failed builds: Node and Bun
# come from Google's mirror of it (mirror.gcr.io), pinned by digest, the same digest Docker Hub
# serves for the tag. Not ECR's copy (public.ecr.aws): it refuses anonymous pulls past a data limit
# per address, which a shared address reaches. A version bump moves the tag and the digest together.

# blocklyd, which the node endpoint hands to hosts as they join (FLEET_BLOCKLYD_BIN): one release
# of cubepals/blocklyd, static (musl), pinned by digest. `bun scripts/blocklyd.ts bump <version>`
# moves this line and the copies of the release's files beside the fleet adapter together.
FROM ghcr.io/cubepals/blocklyd:0.3.2@sha256:acd8883aeb6bfb6625468183620d99beaff8dadaaafcb7356fbbe815f48edaac AS blocklyd

FROM mirror.gcr.io/library/node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS deps
COPY --from=mirror.gcr.io/oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Only the manifests first, so a source change doesn't reinstall anything.
COPY package.json bun.lock bunfig.toml ./
COPY apps/control/package.json apps/control/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
# Just the control plane's workspaces, at the versions bun.lock pins: the web app's packages would
# be installed otherwise, --filter notwithstanding. Peers are left out too: Better Auth's optional
# peers (next, drizzle-kit) and tRPC's typescript are for other setups and add 500 MB.
RUN bun -e 'const p = await Bun.file("package.json").json(); p.workspaces = ["apps/control", "packages/*"]; delete p.devDependencies; await Bun.write("package.json", JSON.stringify(p))' \
 && bun install --lockfile-only \
 && bun install --production --frozen-lockfile --omit peer
# The WebTransport module's install script (trusted in package.json) fetches its prebuilt native
# binary for this platform.

FROM mirror.gcr.io/library/node:22.23.2-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6
ENV NODE_ENV=production
WORKDIR /app
# Hoisted (bunfig.toml): every dependency lives in the root node_modules, and the workspace
# packages are links into packages/ and apps/, copied next to it.
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY apps/control/package.json apps/control/
COPY apps/control/src apps/control/src
# The server icons game runtimes download as they start: without them every server fails to boot.
COPY apps/control/assets apps/control/assets
# Cubepals' lockup, which every shared link's picture carries (src/interfaces/http/card.ts).
COPY brand/png/lockup-horizontal.png brand/png/lockup-horizontal.png
# What the node endpoint serves joining hosts: join.sh and daemon.json are in src/infra/fleet, and
# blocklyd itself is the pinned release's. Its licence (FSL-1.1-ALv2) goes with it.
COPY --from=blocklyd /blocklyd /usr/local/lib/blocklyd/blocklyd
COPY --from=blocklyd /LICENSE.md /usr/local/lib/blocklyd/LICENSE.md
USER node
WORKDIR /app/apps/control
# The api listener; the internal (edge) and realtime listeners are configured per deployment.
EXPOSE 8080
CMD ["node", "src/main.node.ts"]
