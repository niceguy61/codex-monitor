# codex-monitor Design System

## Design Intent

`codex-monitor` is an observability dashboard for Codex sessions.
It should feel:
- operational, not decorative
- calm, not flashy
- trustworthy, not playful
- dense enough for monitoring, but still easy to scan

This is not a marketing page.
This is not a clone of the Codex CLI footer.
This is a lightweight control surface for:
- plan and quota visibility
- token usage analysis
- execution flow visibility
- file activity awareness

## Reference Direction

Primary inspiration:
- `Vercel`

Secondary inspiration:
- `Linear`

Use Vercel for:
- overall layout discipline
- monochrome structure
- clean card containment
- restrained shadows
- high-trust developer-tool atmosphere

Use Linear for:
- compact operational pills
- status badge behavior
- dense-but-readable monitoring controls
- subtle hierarchy inside cards

Do not drift into:
- Stripe-style premium fintech theatrics
- PostHog-style playful editorial energy
- dark-mode-first branding as the default identity

## Core Principles

1. The most important information must appear first.
2. Every card must have a clear operational purpose.
3. Color is for meaning, not decoration.
4. Charts should summarize, not overwhelm.
5. A user should understand the dashboard in under 3 seconds.

## Layout System

Use a single dashboard grid.

Target structure:
- row 1: `Now` full width
- row 2: `Plan`, `Tokens`
- row 3: `Recent Events`, `File Activity`

Rules:
- `Now` spans both columns
- all other cards live on the same 2-column grid
- do not create nested ad-hoc layout rows unless a card needs internal sub-layout
- preserve consistent outer card gaps

Recommended grid:
- `grid-template-columns: repeat(2, minmax(0, 1fr))`
- gap: `16px`

## Card Hierarchy

### 1. Now

Purpose:
- current state
- current tool
- repo context
- plan badge
- quota snapshot
- reset countdown

Rules:
- the only full-width card
- must be visually dominant but not oversized
- should feel like the dashboard header, not a hero section

### 2. Plan

Purpose:
- quota management
- plan awareness
- limit risk visibility

Rules:
- plan badge is small and secondary to actual usage data
- usage badges must encode status with color
- reset countdown must read like an operational timer

### 3. Tokens

Purpose:
- show where cost and context are going

Rules:
- token metrics are primary analytics
- last turn, session total, and context ratio should be readable in one glance
- token chart should emphasize trend and composition, not decoration

### 4. Recent Events

Purpose:
- summarize runtime behavior

Rules:
- prefer a compact chart over verbose text
- center value inside doughnut can represent total event count
- labels should remain short

### 5. File Activity

Purpose:
- summarize file activity at a glance

Rules:
- same card shape and chart pattern as Recent Events
- center value inside doughnut can represent total file count
- emphasize edit/write/delete relevance in future iterations

## Visual Language

### Background

Default mode: light

Base direction:
- page background: soft off-white, not pure white
- cards: white or near-white
- borders: faint gray
- shadows: subtle, border-like, low blur

Preferred palette:
- page: `#f7f8f8` to `#fafafa`
- card: `#ffffff`
- primary text: `#171717` to `#1a1a1e`
- secondary text: `#5f665f` to `#666666`
- border: `#e5e7eb` to `rgba(0,0,0,0.08)`

Avoid:
- saturated page backgrounds
- gradients that dominate the interface
- decorative blobs becoming stronger than the data

## Typography

Primary direction:
- use a disciplined grotesk sans aesthetic
- keep typography developer-tool friendly

Preferred type behavior:
- headings: compact and slightly tightened
- body: neutral, readable, not oversized
- metadata: mono

Reference hierarchy:
- card titles: `14px` to `16px`, semibold
- main values: `16px` to `18px`
- metadata: `12px` to `13px`, mono
- dashboard heading: strong, but not huge

Tone:
- precise
- structured
- low-emotion

## Color Semantics

Color should map to state.

### State badges
- idle: muted gray
- working: green
- tool running: amber/orange
- wait: amber
- error: red

### Quota usage
- `0-50%`: green
- `51-80%`: orange
- `81-100%`: red

### Plan badge
- neutral branded accent
- small, compact, not a dominant object

## Charts

Library:
- `Chart.js`

Rules:
- doughnut charts may show total count in the center
- borders should be white or near-white for clean separation
- chart colors should stay restrained and semantic
- avoid rainbow palettes

### Token chart
- stacked bars are acceptable
- encode `input`, `output`, and `reasoning`
- use consistent colors across all views

Suggested mapping:
- input: charcoal / near-black
- output: orange
- reasoning: green

### Mix charts
- Recent Events and File Activity should be sibling cards
- same visual system
- same center-value treatment
- same legend placement

## Component Rules

### Pills

Use pills for:
- plan
- usage
- state

Rules:
- compact
- fully rounded
- color meaning only
- no heavy shadows

### Cards

Rules:
- same radius across dashboard cards
- same padding rhythm
- same border treatment
- no card should invent a new visual style

Recommended:
- radius: `16px` to `24px`
- padding: `18px` to `20px`
- border: `1px solid rgba(0,0,0,0.08)`
- shadow: subtle, border-like

### Monospace

Use mono for:
- timestamps
- token values when compact
- quota and reset info
- file or tool identifiers where useful

Do not overuse mono for general text.

## What To Avoid

Do not:
- mix multiple design languages card-to-card
- use one-off accent colors without semantic meaning
- create oversized hero-like dashboard cards
- add decorative gradients behind charts
- add marketing-copy style paragraphs into operational cards
- add duplicated information across cards

Specific anti-patterns:
- plan shown both as a large card and repeated as a large label elsewhere
- event/file totals duplicated in both cards and charts when one placement is enough
- card layout drifting from the core `1 / 2 / 2` rhythm

## Implementation Guardrails

Before editing UI:
1. Check whether the change strengthens or weakens the `Now / Plan / Tokens / Events / Files` hierarchy.
2. Reuse existing spacing and card rules before introducing new ones.
3. Keep all dashboard cards visually related.
4. If a new widget does not improve monitoring, do not add it.

When uncertain:
- choose the simpler option
- prefer consistency over novelty
- prefer legibility over cleverness

## Future Extensions

When the dashboard grows, add:
- session insight card
- approaching-limit alert
- heavy-turn detection
- edit/write/delete-focused file breakdown

But keep the same visual language:
- Vercel structure
- Linear operational detail
- no drift
