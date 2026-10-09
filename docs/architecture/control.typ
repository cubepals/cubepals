// Document control: what this document is, its status, and its revisions, oldest first. Add a
// revision whenever what the document says changes; the cover, the footer and the revision table
// all read it from here.

#let doc-title = "Blockly architecture"
#let doc-subtitle = [How Blockly runs Minecraft servers]
#let doc-kind = "Technical architecture"
#let doc-status = [Current]

#let revisions = (
  (
    number: "1", date: "2026-10-01", commits: "4b73704 to 3da68bb",
    change: [First complete version: every part, diagram and appendix.],
  ),
  (
    number: "2", date: "2026-10-02", commits: "d6a6e9f to 22c066b",
    change: [What the fixes before merge changed; the test counts on the final code.],
  ),
  (
    number: "3", date: "2026-10-02", commits: "09556cf to 4ebf721",
    change: [Archives larger than one PUT go to the store in parts.],
  ),
  (
    number: "4", date: "2026-10-02", commits: "f44172b",
    change: [Branded and formalized: a cover, document control, how to read it, and a running
      header and footer. What the document says is unchanged.],
  ),
  (
    number: "5", date: "2026-10-08", commits: none,
    change: [Everything described is on `main`, so the branch labels are gone. Choosing a runtime is
      explained by its technical reasons, and every citation points into the repository.],
  ),
  (
    number: "6", date: "2026-10-09", commits: none,
    change: [blocklyd moved to its own repository, `cubepals/blocklyd`, and the control plane pins
      a release of it. Its citations start `blocklyd/`.],
  ),
)
#let revision = revisions.last()
