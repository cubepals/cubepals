// The look of Blockly's architecture document: brand, colour, type, page, tables, status labels,
// callouts, and the drawing conventions every diagram shares. Parts import this file and nothing
// else; every colour, typeface and size they use is a token named here.

#import "@preview/fletcher:0.5.8" as fletcher: diagram, edge, node
#import "@preview/chronos:0.3.0"

// ─── brand ────────────────────────────────────────────────────────────────────────────────────
// From brand/README.md. The mark and the lockups are used as drawn: Ink on Paper, or Paper on Ink,
// the only approved colourways; never below the minimum sizes (the mark 20 px, 15 pt in print; the
// horizontal lockup 120 px wide, 90 pt); with clear space of a quarter of the mark's height on
// every side. Typst reads them from brand/ itself, so the document always shows the current files.

#let brand-ink = rgb("#0d0d0d")
#let brand-paper = rgb("#f8f7f5")
#let brand-mark = "/brand/mark.svg"
#let brand-lockup = "/brand/lockup-horizontal.svg"
#let brand-lockup-reversed = "/brand/lockup-horizontal-reversed.svg"
#let mark-min = 15pt
#let lockup-min-width = 90pt
/// The mark's share of the horizontal lockup's height (56 of 63.3 units in its SVG).
#let lockup-mark-share = 56 / 63.3
/// The clear space around a mark `height` tall: nothing else may enter it.
#let clear-space(height) = height / 4

// ─── type ─────────────────────────────────────────────────────────────────────────────────────
// The brand's typeface is Figtree, which the product's pages are set in and the wordmark is drawn
// from. This document keeps IBM Plex, vendored in fonts/ so every render matches: brand/README.md
// names Figtree for the product and the wordmark, which the lockups carry as outlines, and asks
// nothing of documents; and Plex has the monospace companion that code and citations need.

#let type-brand = "Figtree"
#let type-sans = "IBM Plex Sans"
#let type-mono = "IBM Plex Mono"

#let size-body = 9.2pt
#let size-small = 7.9pt
#let size-caption = 7.8pt
#let size-running = 7pt
#let size-label = 6.2pt

// ─── colour ───────────────────────────────────────────────────────────────────────────────────
// Pages are Paper and type is Ink, as the brand sets them. Each diagram layer differs in fill
// lightness and in outline or shape, so a grayscale print still tells them apart: control plane
// rounded and thin, runtime square and thick, storage a cylinder, external providers dashed.

#let ink = brand-ink
#let paper = brand-paper
/// Paper type on an Ink ground, a step quieter than Paper itself.
#let paper-quiet = color.mix((brand-paper, 68%), (brand-ink, 32%))
#let muted = rgb("#59636e")
#let hairline = rgb("#d1d9e0")
/// Callouts, code, and what a diagram shows as held back: a shade below Paper.
#let tint = rgb("#eeece8")
/// Boxes a diagram draws on the page: externals, labels, what is free.
#let surface = rgb("#ffffff")

#let control-fill = rgb("#e6eefa")
#let control-ink = rgb("#264a7a")
#let runtime-fill = rgb("#dcebd8")
#let runtime-ink = rgb("#2b5a2f")
#let storage-fill = rgb("#fbf0dc")
#let storage-ink = rgb("#7a5418")
#let external-ink = rgb("#6b6b6b")

#let control-stroke = 0.7pt + control-ink
#let runtime-stroke = 1.4pt + runtime-ink
#let storage-stroke = 0.8pt + storage-ink
#let external-stroke = (paint: external-ink, thickness: 0.8pt, dash: "dashed")

#let implemented-fill = rgb("#1a7f37")
#let canary-fill = rgb("#fff4c2")
#let canary-ink = rgb("#9a6700")
#let canary-text = rgb("#6c4400")
#let designed-ink = rgb("#0b5cad")
#let designed-text = rgb("#0b4a8f")
#let deferred-ink = rgb("#8c959f")
#let quiet-text = rgb("#4f5861")
#let research-ink = rgb("#7048b6")
#let research-text = rgb("#5a3696")
#let historical-fill = rgb("#eef1f4")

#let why-ink = control-ink
#let mismatch-ink = canary-ink
#let caveat-ink = rgb("#b42318")

// ─── diagram nodes ────────────────────────────────────────────────────────────────────────────

/// Control plane: the API, workers, the database's owner, FleetRuntime.
#let cp(pos, body, ..args) = node(
  pos, body, fill: control-fill, stroke: control-stroke, corner-radius: 4pt, inset: 5pt, ..args,
)
/// Runtime and infrastructure: machines, blocklyd, Docker, containers, the edge's hosts.
#let rt(pos, body, ..args) = node(
  pos, body, fill: runtime-fill, stroke: runtime-stroke, corner-radius: 0pt, inset: 5pt, ..args,
)
/// Storage: Postgres, object storage, a node's disk.
#let st(pos, body, ..args) = node(
  pos, body, fill: storage-fill, stroke: storage-stroke, shape: fletcher.shapes.cylinder,
  inset: 5pt, ..args,
)
/// External providers: Fly, Boat, Polar, hosting providers, S3 services.
#let ext(pos, body, ..args) = node(
  pos, body, fill: surface, stroke: external-stroke, corner-radius: 0pt, inset: 5pt, ..args,
)
/// People: players, operators, the server's owner.
#let who(pos, body, ..args) = node(pos, emph(body), stroke: none, inset: 3pt, ..args)
/// A labelled region that groups nodes (a host, a trust zone). Its label sits on the top border,
/// like a fieldset's legend, or on the bottom one (`side: "south"`) when edges arrive from above.
/// `name` is a string unique within the diagram.
#let zone(nodes, label, name: "zone", side: "north", ..args) = (
  node(
    enclose: nodes, name: std.label(name), fill: none, inset: 8pt, corner-radius: 3pt,
    stroke: (paint: hairline.darken(30%), thickness: 0.6pt, dash: "dotted"), ..args,
  ),
  node(std.label(name + "." + side), text(size: 6.4pt, fill: muted, label), fill: paper,
    stroke: none, inset: 1.6pt),
)

/// Small type for edge labels.
#let lbl(body) = text(size: 6.8pt, fill: ink, body)

/// Shrinks `body` to the width it is given when it is wider; never enlarges it.
#let fit(body) = layout(size => {
  let natural = measure(body)
  if natural.width <= size.width { align(center, body) } else {
    let factor = size.width / natural.width * 100%
    align(center, scale(factor, reflow: true, body))
  }
})

/// A diagram in the document's conventions. Arrows: solid for a call or a write, dashed for
/// something periodic or eventual (heartbeats, reconciliation), dotted for what is only designed.
#let draw(..args, size: 7.8pt) = {
  set text(size: size)
  fit(diagram(
    spacing: (9mm, 7mm),
    edge-stroke: 0.7pt + ink,
    mark-scale: 80%,
    label-size: 6.8pt,
    label-wrapper: e => box(inset: 1.4pt, radius: 1pt, fill: paper, e.label),
    ..args,
  ))
}

/// Sequence-diagram participants in the same conventions (chronos cannot dash an outline, so
/// externals are plain boxes and storage is a database shape).
#let par-control(name, shown) = chronos._par(
  name, display-name: shown, color: control-fill, show-bottom: false,
)
#let par-runtime(name, shown) = chronos._par(
  name, display-name: shown, color: runtime-fill, show-bottom: false,
)
#let par-storage(name, shown) = chronos._par(
  name, display-name: shown, color: storage-fill, shape: "database", show-bottom: false,
)
#let par-external(name, shown) = chronos._par(
  name, display-name: shown, color: surface, show-bottom: false,
)
#let par-person(name, shown) = chronos._par(
  name, display-name: shown, shape: "actor", color: surface, show-bottom: false,
)

#let sequence(body, size: 7.5pt) = {
  set text(size: size)
  fit(chronos.diagram(body))
}

/// A numbered figure; `name` makes it referable as @name.
/// A figure. `float: true` lets a large one move to the top or bottom of a page, so the text
/// after it fills what would otherwise be a gap; use it only where the text before doesn't lead
/// into the figure.
#let fig(body, caption: none, name: none, float: false) = {
  let f = figure(body, caption: caption, kind: image, supplement: [Figure],
    placement: if float { auto } else { none })
  if name == none { f } else { [#f#label(name)] }
}

// ─── status labels ────────────────────────────────────────────────────────────────────────────
// The words carry the meaning; colour and outline only help the eye.

#let badge(word, fill: none, stroke: none, color: ink) = box(
  inset: (x: 2.8pt, y: 1.4pt), outset: (y: 0.6pt), radius: 1.6pt, fill: fill, stroke: stroke,
  baseline: 0.8pt,
  text(size: size-label, weight: "semibold", tracking: 0.05em, fill: color, upper(word)),
)

#let implemented = badge("implemented", fill: implemented-fill, color: surface)
#let canary = badge("canary only", fill: canary-fill, stroke: 0.7pt + canary-ink, color: canary-text)
#let designed = badge("designed", stroke: (paint: designed-ink, thickness: 0.7pt, dash: "dashed"),
  color: designed-text)
#let deferred = badge("deferred", stroke: 0.7pt + deferred-ink, color: quiet-text)
#let research = badge("research only", stroke: (paint: research-ink, thickness: 0.7pt,
  dash: "dotted"), color: research-text)
#let historical = badge("historical", fill: historical-fill, color: quiet-text)

// ─── callouts ─────────────────────────────────────────────────────────────────────────────────

#let callout(title, accent, body) = block(
  width: 100%, breakable: false, fill: tint, inset: (left: 8pt, right: 7pt, y: 6pt),
  stroke: (left: 2pt + accent), above: 0.9em, below: 0.9em,
  {
    text(size: 6.8pt, weight: "semibold", tracking: 0.05em, fill: accent, upper(title))
    linebreak()
    body
  },
)
/// The reason behind a decision.
#let why(body) = callout("Why", why-ink, body)
/// Where the code and a document disagree; the code wins.
#let mismatch(body) = callout("Code vs. documents", mismatch-ink, body)
/// A limit or a risk the reader must not miss.
#let caveat(body) = callout("Caveat", caveat-ink, body)

/// A source location, `path:line`, in quiet monospace.
#let src(path) = text(font: type-mono, size: 0.84em, fill: muted, path)

// ─── document ─────────────────────────────────────────────────────────────────────────────────

#let part-marker = <part>
#let part-counter = counter("part")

/// What a part is called where it is listed: "Part I" for a numbered one.
#let part-label(number) = if number == none { none } else [Part #numbering("I", number)]

/// Starts a part: a new page, its number and title, and a line saying what it covers. The
/// appendices are a part without a number (`numbered: false`).
#let part(title, summary, numbered: true) = {
  place.flush()
  pagebreak(weak: true)
  if numbered { part-counter.step() }
  context {
    let number = if numbered { part-counter.get().first() } else { none }
    [#metadata((title: title, number: number))#part-marker]
    block(below: 1.4em, sticky: true, {
      if number != none {
        text(size: 7pt, weight: "semibold", tracking: 0.08em, fill: muted, upper(part-label(number)))
        linebreak()
      }
      text(size: 15pt, weight: "semibold", title)
      v(-0.3em)
      line(length: 100%, stroke: 0.6pt + hairline)
      text(size: 8.5pt, fill: muted, summary)
    })
  }
}

/// The table of contents: parts, then the numbered sections in them, with page numbers. Headings
/// made with `outlined: false` (the front matter before it) are left out.
#let contents() = context {
  let items = query(selector(part-marker).or(heading.where(level: 1, outlined: true)))
  set text(size: 8.6pt)
  for item in items {
    let at = item.location()
    let page = counter(page).at(at).first()
    let entry(number, body) = block(above: 0.28em, below: 0.28em, link(at, grid(
      columns: (2.4em, 1fr, auto), column-gutter: 0.4em,
      text(fill: muted, number),
      box(width: 100%, [#body #box(width: 1fr, repeat(text(fill: hairline.darken(20%), "."), gap: 2.5pt))]),
      str(page),
    )))
    if item.func() == metadata {
      let value = item.value
      block(above: 1.05em, below: 0.4em, sticky: true, link(at, text(weight: "semibold",
        upper(text(size: 7pt, tracking: 0.06em, if value.number == none { value.title } else [
          #part-label(value.number) · #value.title
        ])))))
    } else {
      let number = if item.numbering == none { none } else {
        numbering(item.numbering, ..counter(heading).at(at))
      }
      entry(number, item.body)
    }
  }
}

/// The level-1 heading a page belongs to: the first that starts on it, else the last before it.
#let current-heading() = {
  let here-page = here().page()
  let on-page = query(heading.where(level: 1)).filter(h => h.location().page() == here-page)
  let before = query(heading.where(level: 1).before(here()))
  if on-page.len() > 0 { on-page.first() } else if before.len() > 0 { before.last() }
}

/// The whole document's frame. `commit`, `branch` and `date` come from the render script, the rest
/// from control.typ; the footer carries them all, so a printed page says what it is.
#let frame(
  title: none, kind: none, revision: none, commit: none, branch: none, date: none, body,
) = {
  set document(title: title, author: "Blockly")
  set text(font: type-sans, size: size-body, fill: ink, lang: "en", hyphenate: false)
  set par(leading: 0.6em, spacing: 0.95em, justify: false)
  show raw: set text(font: type-mono, size: 0.9em)
  show raw.where(block: true): it => block(
    width: 100%, fill: tint, inset: (x: 7pt, y: 6pt), radius: 2pt, breakable: true,
    text(size: 7.6pt, it),
  )
  show link: it => it

  set page(
    paper: "a4",
    fill: paper,
    margin: (x: 19mm, top: 23mm, bottom: 21mm),
    header-ascent: 28%,
    footer-descent: 28%,
    // The section the page is in, and the mark, at its smallest size, with its clear space kept
    // above the rule.
    header: context {
      let current = current-heading()
      set block(spacing: 0pt)
      set text(size: size-running, fill: muted)
      grid(
        columns: (1fr, auto), align: (left + bottom, right + bottom),
        if current == none { title } else if current.numbering == none { current.body } else [
          #numbering(current.numbering, ..counter(heading).at(current.location()))#h(0.8em)#current.body
        ],
        image(brand-mark, height: mark-min),
      )
      v(clear-space(mark-min) + 1.5pt)
      line(length: 100%, stroke: 0.4pt + hairline)
    },
    footer: context {
      set block(spacing: 0pt)
      set text(size: size-running, fill: muted)
      line(length: 100%, stroke: 0.4pt + hairline)
      v(5pt)
      grid(
        columns: (1fr, auto), row-gutter: 4pt,
        [#title · #kind · revision #revision],
        [Page #counter(page).display() of #counter(page).final().first()],
        text(size: 6.4pt)[Rendered from #raw(commit) on #raw(branch), #date], [],
      )
    },
  )

  set heading(numbering: "1.1")
  // A reference to a section reads §12 (an appendix, §A), and links to it.
  show ref: it => {
    let el = it.element
    if el != none and el.func() == heading and el.numbering != none {
      link(el.location(), [§#numbering(el.numbering, ..counter(heading).at(el.location()))])
    } else { it }
  }
  show heading: set text(weight: "semibold")
  show heading.where(level: 1): it => block(above: 1.7em, below: 0.75em, sticky: true, {
    set text(size: 13pt)
    if it.numbering != none {
      box(width: 2.1em, text(fill: muted, counter(heading).display(it.numbering)))
    }
    it.body
  })
  show heading.where(level: 2): it => block(above: 1.25em, below: 0.6em, sticky: true, {
    set text(size: 10.4pt)
    if it.numbering != none {
      box(width: 2.6em, text(fill: muted, counter(heading).display(it.numbering)))
    }
    it.body
  })
  show heading.where(level: 3): it => block(above: 1em, below: 0.5em, sticky: true,
    text(size: 9.4pt, it.body))

  set table(
    stroke: (x, y) => (
      top: if y == 0 { 0.8pt + ink } else if y == 1 { 0.6pt + ink } else { none },
      bottom: 0.4pt + hairline,
    ),
    inset: (x: 4.5pt, y: 3.6pt),
    align: left + top,
  )
  // A row never splits across pages: a page ends between rows, and the header repeats.
  set table.cell(breakable: false)
  show table: set text(size: size-small)
  show table: set par(leading: 0.5em)
  show table.cell.where(y: 0): set text(weight: "semibold")
  show figure.where(kind: table): set figure.caption(position: top)
  // "Figure 12" and "Table 3" in the weight of a heading, then the caption.
  show figure.caption: it => text(size: size-caption, fill: muted, [
    #text(weight: "semibold", fill: ink)[#it.supplement #context it.counter.display(it.numbering)]#it.separator#it.body
  ])
  show figure: set block(breakable: false, above: 1.1em, below: 1.1em)
  // Tables may run onto the next page (their header repeats); diagrams never split. A table's
  // caption sticks to its first rows, so it is never left alone at the bottom of a page.
  show figure.where(kind: table): set block(breakable: true)
  show figure.where(kind: table): it => block(breakable: true, width: 100%, above: 1.1em,
    below: 1.1em, {
      if it.caption != none { block(sticky: true, below: it.gap, align(center, it.caption)) }
      block(breakable: true, above: it.gap, width: 100%, it.body)
    })
  set list(indent: 0.6em, spacing: 0.55em)
  set enum(indent: 0.6em, spacing: 0.55em)

  body
}
