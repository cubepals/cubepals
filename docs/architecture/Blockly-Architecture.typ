// Blockly's architecture: the canonical technical description of how Blockly runs Minecraft
// servers. Render it with `bun scripts/architecture.ts`; see README.md here for how to keep it
// true. The commit, branch and date on the cover and in the footer come from that script; its
// title, status and revisions from control.typ.

#import "style.typ": *
#import "control.typ": doc-kind, doc-title, revision

#let commit = sys.inputs.at("commit", default: "unknown commit")
#let branch = sys.inputs.at("branch", default: "unknown branch")
#let date = sys.inputs.at("date", default: "undated")

#show: frame.with(
  title: doc-title, kind: doc-kind, revision: revision.number, commit: commit, branch: branch,
  date: date,
)

#include "parts/00-front.typ"
#include "parts/01-orientation.typ"
#include "parts/02-runtimes.typ"
#include "parts/03-fleet-state.typ"
#include "parts/04-data.typ"
#include "parts/05-network-providers.typ"
#include "parts/06-security-operations.typ"
#include "parts/07-status.typ"
#include "parts/08-appendices.typ"
