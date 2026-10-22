#!/bin/sh
# A sizing edge's start (size.ts): this checkout's edge, run from source on the load image, because
# a test edge has no image of its own to build. Fetches the pushed commit, mc-router and the pinned
# Geyser, then runs the test relay and sampler beside the agent as the edge image does.
set -eu
cd /edge
pin=$(grep -E '^ARG GEYSER_(VERSION|BUILD|SHA256)=' repo/apps/edge/Dockerfile | cut -d= -f2)
set -- $pin
version=$1 build=$2 sha=$3
bun repo/tools/bedrock-join/size/edge/fetch.ts "https://download.geysermc.org/v2/projects/geyser/versions/$version/builds/$build/downloads/standalone" geyser.jar
echo "$sha  geyser.jar" | sha256sum -c -
bun repo/tools/bedrock-join/size/edge/fetch.ts "https://github.com/itzg/mc-router/releases/download/v$MC_ROUTER_VERSION/mc-router_${MC_ROUTER_VERSION}_linux_amd64.tar.gz" mc-router.tgz
tar xzf mc-router.tgz -C /edge mc-router
export GEYSER_JAR=/edge/geyser.jar ROUTER_BIN=/edge/mc-router
bun repo/tools/bedrock-join/size/edge/probe.ts &
exec bun repo/apps/edge/agent.ts
