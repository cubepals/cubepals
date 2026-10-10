# The web app, for self-hosting; staging and production run it as a Cloudflare Worker
# (wrangler.jsonc). This image doesn't tell the control plane each browser's address, which only
# the Worker's entry does (src/lib/before-next.ts), so sign-in's limits count every browser behind
# it as one. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg API_UPSTREAM=https://control.example.com -t blockly-web .
# Next writes the /api rewrite when it builds, so API_UPSTREAM is a build argument: the control
# plane this image fronts is fixed at build time.

FROM node:22.23.2-trixie-slim AS build
COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/control/package.json apps/control/
COPY apps/edge/package.json apps/edge/
# Every workspace's manifest, or bun.lock reads as changed and the frozen install stops.
COPY apps/devtools/package.json apps/devtools/
COPY packages/db/package.json packages/db/
COPY packages/contracts/package.json packages/contracts/
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/web apps/web
ARG API_UPSTREAM
RUN test -n "$API_UPSTREAM" || (echo "Pass --build-arg API_UPSTREAM=<the control plane's origin>" && exit 1)
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && ../../node_modules/.bin/next build

FROM node:22.23.2-trixie-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
# The standalone server mirrors the repository layout from its tracing root.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/web/public apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
