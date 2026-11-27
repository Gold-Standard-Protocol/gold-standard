# DESIGN
status: approved

## Identity and audience
Gold Standard Protocol issues GSUSD, the Gold Standard Dollar, a dollar over-collateralised by tokenised gold. The audience is gold
holders and crypto-native borrowers who read a balance sheet before they trust a logo. The
look is a private mint's paperwork: warm paper, engraved detail, serif display type, one
gold accent. It must read as careful and verifiable, never as a trading terminal or a
growth-stage SaaS page.

## Personality and mood
Calm, exact, slightly formal. Numbers are the hero on app screens; typography is the hero
on the landing. Nothing pulses, floats or glows for attention. The page should hold up
printed.

## Palette (hex and role)
- Paper `#fcfaf8` (background) and white `#ffffff` (card): the two grounds.
- Ink `#23201a` (foreground) with muted ink `#736e64` for secondary text (4.87:1 on paper).
- Antique gold `#87651d` (primary): the single accent. Button text on it is 5.16:1.
- Control boundary `hsl(40 10% 54%)` (input): 3:1 against white and paper, for inputs and
  tooltip triggers only. Cards keep the soft hairline `#e8e5de`, which is decorative.
- Status: success `#29704f`, warning `#915812` (5.2:1 on its soft fill), danger `#c72929`,
  each with a soft fill. Status is always paired with text, never colour alone.

## Typography (faces, roles, reason)
- Fraunces (variable, optical sizing) for display and headings: an old-style serif with
  ink traps that reads as struck type, not as a tech brand.
- Hanken Grotesk for body and interface text: neutral, open and legible at 14 to 16px.
- IBM Plex Mono for figures and short labels only (`label-mono`), at 12px minimum, with
  tabular and slashed-zero figures so columns of numbers align. Not for body text.
All three are self-hosted (`apps/dapp/public/fonts`), latin and latin-ext subsets, OFL.

## Touch targets
Every control is at least 44 by 44px on every width: `min-h-11` on links, tabs, pills and
inputs, and the `tap-target` utility (a 44px pseudo-element hit area) on inline text controls
such as the Max links, where the visual must stay small. Tooltip triggers stay 16px visually
with the same hit area.

## Shape and elevation (radius scale, shadow use)
Radius scale from `--radius: 0.625rem`: sm, md, lg, xl, 2xl by role (inputs md, cards xl,
the hero stat panel 2xl). Pills only for round things: avatars, status dots. Shadows mark
real elevation only: `shadow-card` on the proof panel and hero stats, `shadow-lift` on
dialogs and the open tooltip, `shadow-gold` on the one primary call to action. Everything
else sits flat on a hairline.

## Motion
MOTION 2. One hero entrance on load (lines rise, the gold line inks its optical size once,
one sheen pass), then rest. Each later section fades and rises once when it first enters
the viewport, driven by an IntersectionObserver so content is never gated on a scroll
timeline. The live price tape is the one continuous movement; it pauses on hover and
focus. No per-item staggers, no card lift, no magnetic buttons, no parallax, no progress
rule. `prefers-reduced-motion` disables all of it; the settled state is the default.

## Voice
British or American English (never convert one to the other), no contractions, no Oxford comma, no dashes of any kind. Specific and
unhurried: name the mechanism, the number and the source. Never a claim the contracts do
not make (see the accuracy rule at the top of `apps/dapp/src/app/content/site.ts`). Calls to
action name the action ("Open a vault", "View reserves"). An empty or failed value says
why ("Price feed unavailable, retrying"), never a dash.

## Dials: ENERGY 2 / RHYTHM 2 / MOTION 2

## Recorded overrides
- Warm paper ground with a high-contrast serif display face: kept. It is the mint identity,
  recorded here so it is a decision and not the default.
- One headline phrase set in gold ("back on the gold standard"): kept, hero only, as the
  identity motif together with the gold hairline rules, the guilloche watermark, paper
  grain and corner registration ticks.
- Tracked uppercase monospace labels: kept for figures and short data labels at 12px and
  above; removed as eyebrows that repeat a heading.
- Light theme only, `color-scheme: light`: the product is paperwork, and a dark theme would
  need its own engraved palette. Revisit if users ask.
- The empty-value glyph is "n/a", not a dash.
- Section folio numerals ("01", "02") were removed on 2026-10-18; the step numbers inside
  "Three steps" stay because those are a sequence.
