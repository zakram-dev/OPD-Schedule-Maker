# Design system: OPD Schedule Maker

## Who it's for
Team leads planning the day at shift start, often on a phone in the backroom and sometimes on a back-office PC.
The result gets printed and posted. They need to be fast, read it at a glance, and trust it.
This is a working tool, not a marketing site: no hero sections, no decoration that slows the job down.

## Identity: "dispatch board"
- **Ink-black chrome, warm paper surface** with a faint 32px grid, like a schedule board.
- **Signage type:** Barlow Condensed for titles, labels and every number; Barlow for reading text.
- **One signal color, lunch yellow `#FFC933`.** Lunches are what the app produces, so yellow marks lunch
  and the few brand moments (logo, eyebrow tick, upload button). Nothing else uses it.
- **Job colors carry the data.** The chrome stays neutral so Picker, Dispenser, Backroom, Prep, SM/EXP and
  Team lead colors stand out. Color always comes with a text label.
- **Logo:** a yellow tile holding a mini Gantt chart with a gap in the middle bar, the lunch slot.

## Tokens (in `css/styles.css` under `:root`)
| Group | Values |
|---|---|
| Type scale | 12 · 14 · 16 (base) · 18 · 22 · 28 · 30–44 fluid display |
| Spacing | 4px grid: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48; gutters 16 / 24 / 32 |
| Radius | 6 · 10 · 14 · pill |
| Motion | 120ms (hover), 200ms (state), 360ms (enter); ease-out `cubic-bezier(.2,.8,.2,1)`, spring for pop-ins |
| Surfaces | `--bg` paper, `--surface`, `--surface-2/3`, `--line`, `--line-strong` |
| Text | `--ink` (16:1), `--ink-2` (7:1), `--ink-3` (4.9:1) |
| Jobs | `--pick/-ink/-soft`, `--disp…`, `--br…`, `--prep…`, `--sm…`, `--tl…`; components use `.r-ROLE` scopes for `--c` (base), `--ci` (text), `--cs` (tint) |
| Status | `--ok`, `--warn-ink`, `--bad` with `-soft` tints |

Every text/background pair meets WCAG AA (4.5:1) in light and dark mode. Light is the default; each person can pick
Light, Dark or Match device under Settings → Preferences (saved on that device). Print always uses the light palette.

## Layout
- Mobile first. Breakpoints: 480 (tab labels), 640 (tablet spacing), 720 (tables become cards below it),
  900 (desktop header and two-column import), 1100 (mini timelines in the edit table).
- Phones: header on two rows (brand + icon buttons, then the day picker); the KPI board scrolls sideways;
  the review and edit tables become cards; the review action bar sticks to the bottom; dialogs open as bottom sheets.
- Touch targets are at least 44px on phones.

## Motion
Only two things animate on purpose: the screen content rising in when the screen changes, and the chart bars
sweeping in. In-place edits never re-animate. Everything respects `prefers-reduced-motion`.

## Icons
Inline SVG sprite in `index.html` (stroke icons on a 24px grid), used through `icon(name)` in `app.js`. No emoji as icons.
