#!/bin/sh
# A sizing edge's entrypoint (size.ts): the test relay and sampler beside the edge agent.
bun /size/probe.ts &
exec /edge-agent
