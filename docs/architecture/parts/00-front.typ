// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

#import "../style.typ": *
#import "../control.typ": *

#let commit = sys.inputs.at("commit", default: "unknown commit")
#let branch = sys.inputs.at("branch", default: "unknown branch")
#let date = sys.inputs.at("date", default: "undated")

/// A render date as the cover writes it: 2026-10-02 becomes 2 October 2026.
#let long-date(iso) = {
  let parts = iso.split("-")
  if parts.len() != 3 { return iso }
  datetime(year: int(parts.at(0)), month: int(parts.at(1)), day: int(parts.at(2)))
    .display("[day padding:none] [month repr:long] [year]")
}

// ─── cover ────────────────────────────────────────────────────────────────────────────────────
// The reversed lockup on an Ink ground (Paper on Ink), well above its minimum width and clear of
// everything by more than a quarter of its mark's height.

#page(margin: 0pt, header: none, footer: none, {
  block(width: 100%, height: 64%, fill: brand-ink, inset: (x: 19mm, top: 22mm, bottom: 20mm), {
    set block(spacing: 0pt)
    image(brand-lockup-reversed, width: 54mm)
    v(1fr)
    text(size: 8.5pt, weight: "semibold", tracking: 0.16em, fill: paper-quiet, upper(doc-kind))
    v(6mm)
    text(size: 34pt, weight: "semibold", fill: paper, doc-title)
    v(5mm)
    text(size: 13pt, fill: paper-quiet, doc-subtitle)
  })
  block(width: 100%, inset: (x: 19mm, top: 16mm), {
    set text(size: 9pt)
    grid(
      columns: (34mm, 1fr), row-gutter: 3.6mm,
      text(fill: muted)[Document], doc-kind,
      text(fill: muted)[Revision], revision.number,
      text(fill: muted)[Date], long-date(date),
      text(fill: muted)[Status], doc-status,
      text(fill: muted)[Rendered from], [#raw(commit) on #raw(branch)],
    )
  })
})

// ─── document control ─────────────────────────────────────────────────────────────────────────

#heading(numbering: none, outlined: false)[Document control]

#block(below: 1.3em, text(size: 9.6pt, fill: muted)[
  How Blockly runs Minecraft servers: the control plane, its runtimes, the fleet and its node
  daemon, storage, the edge, money, and how all of it is operated. This is the canonical technical
  description. Where it and the code disagree, the code is right and this document has a bug.
])

#grid(
  columns: (30mm, 1fr), inset: (y: 4.2pt), stroke: (bottom: 0.4pt + hairline),
  grid.hline(stroke: 0.8pt + ink),
  text(fill: muted)[Title], doc-title,
  text(fill: muted)[Document type], doc-kind,
  text(fill: muted)[Revision], [#revision.number, #long-date(revision.date)],
  text(fill: muted)[Status], doc-status,
  text(fill: muted)[Source], [#raw(commit) on #raw(branch), rendered #date],
  text(fill: muted)[Scope], [
    The code on `main`: the control plane, the web app and the edge; the Fly, Boat, fleet and
    Docker runtimes; blocklyd; several runtimes in one deployment, the fleet canary and running
    admission.
  ],
  text(fill: muted)[Readers], [
    A maintainer returning to the code, a new engineer, someone judging the infrastructure, an
    operator on call, and anyone asking why it is built this way.
  ],
)

#heading(level: 2, numbering: none, outlined: false)[Revisions]

#table(
  columns: (auto, auto, 34mm, 1fr),
  table.header[Revision][Date][Commits][Changes],
  ..revisions
    .map(r => (
      r.number,
      r.date,
      if r.commits == none [this revision: #raw(commit)] else { raw(r.commits) },
      r.change,
    ))
    .flatten(),
)

// ─── contents ─────────────────────────────────────────────────────────────────────────────────

#pagebreak()
#heading(numbering: none, outlined: false)[Contents]
#contents()

// ─── how to read it ───────────────────────────────────────────────────────────────────────────

#pagebreak(weak: true)
#heading(numbering: none)[How to read this document]

Every capability this document describes carries a status label where it is described: how far it
exists, not whether it is deployed.
Sections are numbered and appendices lettered; a reference such as §12 links to its section, and
figures and tables in the body are numbered and captioned. Claims a reader might doubt cite the
code as `path:line`, at the commit on the cover.

#v(0.6em)
#grid(
  columns: (1fr, 1fr), column-gutter: 1.6em,
  [
    #text(weight: "semibold")[Status labels.] Every capability carries one.
    #v(0.2em)
    #table(
      columns: (auto, 1fr),
      table.header[Label][Meaning],
      implemented, [In the code, on the product's own paths. Whether it is deployed is said separately.],
      canary, [In the code, reached only by servers an operator sends to the fleet.],
      designed, [Written down, not built.],
      deferred, [Left out on purpose, for now; the reason is given.],
      research, [Measured or studied; nothing in the product depends on it.],
      historical, [True once; kept so old documents make sense.],
    )
  ],
  [
    #text(weight: "semibold")[Drawing conventions.] They hold in grayscale.
    #v(0.2em)
    #draw(
      spacing: (5mm, 4.2mm),
      cp((0, 0), [Control plane]),
      rt((1, 0), [Runtime, host]),
      st((0, 1), [Storage]),
      ext((1, 1), [External provider]),
      who((0, 2), [Person]),
      node((1, 2), align(left, text(size: 6.5pt)[
        #box(line(length: 6mm, stroke: 0.7pt + ink)) call, write \
        #box(line(length: 6mm, stroke: (paint: ink, thickness: 0.7pt, dash: "dashed"))) periodic, eventual \
        #box(line(length: 6mm, stroke: (paint: ink, thickness: 0.7pt, dash: "dotted"))) designed only
      ]), stroke: none),
      size: 7.2pt,
    )
  ],
)

#v(1.2em)
#text(weight: "semibold", size: 10.4pt)[Where to start]
#v(0.2em)
#table(
  columns: (auto, 1fr),
  table.header[If you are][Read first],
  [A maintainer returning to the code], [@s-overview, @s-status, @s-limits, @s-roadmap; then any part you are changing.],
  [A new engineer], [@s-overview to @s-runtime-port, @s-lifecycle and @s-startup, then the part you will work on, with @a-interfaces at hand.],
  [Judging the infrastructure], [@s-overview, @s-fleet-runtime, @s-capacity, @s-runtime-choice, @s-security, @s-status, @s-limits.],
  [An operator on call], [@s-health, @s-node-loss, @s-split-brain, @s-operators, @s-failures, and @a-config.],
  [Asking why], [The "Why" boxes: every major decision has one, next to what it explains.],
)
