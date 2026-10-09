# The edge: mc-router, supervised by the edge agent. Build from the repository root:
#   docker build -f apps/edge/Dockerfile .
FROM itzg/mc-router:1.47.1 AS router

FROM oven/bun:1.3.11 AS agent
WORKDIR /build
# The agent imports only types from the contracts, so it compiles without installing anything.
COPY apps/edge/agent.ts apps/edge/hold.ts apps/edge/mappings.ts apps/edge/notice.ts apps/edge/
RUN bun build apps/edge/agent.ts --compile --outfile /build/edge-agent

FROM debian:trixie-slim
COPY --from=router /mc-router /mc-router
COPY --from=agent /build/edge-agent /edge-agent
USER 65532
EXPOSE 25565
ENTRYPOINT ["/edge-agent"]
