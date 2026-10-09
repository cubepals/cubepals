# The control plane: one image for the api, worker and realtime roles; ROLES picks which a
# machine runs. Build from the repository root:
#   docker build -f apps/control/Dockerfile -t blockly-control .
# Node runs the TypeScript sources directly (type stripping, Node >= 22.18), as in development.
# Debian trixie, not bookworm: the WebTransport module's prebuilt binary needs glibc 2.38.

# blocklyd, which the node endpoint hands to hosts as they join (FLEET_BLOCKLYD_BIN): one release
# of cubepals/blocklyd, static (musl), pinned by digest. `bun scripts/blocklyd.ts bump <version>`
# moves this line and the copies of the release's files beside the fleet adapter together.
FROM ghcr.io/cubepals/blocklyd:0.3.0@sha256:3bb63d8aa7f7d56d0d7b99d3821c78a15ff4f265554fd1375c9635243e6ec326 AS blocklyd

FROM node:22.23.2-trixie-slim AS deps
COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun
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

FROM node:22.23.2-trixie-slim
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
# What the node endpoint serves joining hosts: join.sh and daemon.json are in src/infra/fleet, and
# blocklyd itself is the pinned release's. Its licence (FSL-1.1-ALv2) goes with it.
COPY --from=blocklyd /blocklyd /usr/local/lib/blocklyd/blocklyd
COPY --from=blocklyd /LICENSE.md /usr/local/lib/blocklyd/LICENSE.md
USER node
WORKDIR /app/apps/control
# The api listener; the internal (edge) and realtime listeners are configured per deployment.
EXPOSE 8080
CMD ["node", "src/main.node.ts"]
