# experimental/

Experiments that are **not part of Blockly**. Nothing here is on the production runtime path,
nothing here is built or deployed by Blockly's CI or Terraform, and nothing here has
compatibility guarantees. Code can change shape or disappear in any commit.

An experiment lives here to answer a question with working software. It graduates only by an
explicit decision to adopt it: then it moves into `apps/` or `packages/`, gets the repo's
checks, and `docs/architecture.md` changes to say so. Until then, `docs/architecture.md`
describes Blockly, and experiments describe themselves.

No experiment is running now.

## Graduated

| Experiment | Question | Now |
|---|---|---|
| blocklyd | Blockly's node daemon: can Blockly run Minecraft servers on its own Linux hosts, first one node and then a fleet of them? | [`apps/blocklyd`](../apps/blocklyd/) and the `fleet` runtime in [`apps/control/src/infra/fleet`](../apps/control/src/infra/fleet/) ([docs/fleet.md](../docs/fleet.md)). The experiment's reports are kept in [docs/history/blocklyd](../docs/history/blocklyd/). |
