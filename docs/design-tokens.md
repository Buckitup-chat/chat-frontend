# Design tokens and building blocks

The values live in `src/scss/tokens.css` as CSS variables; the blocks built
from them in `src/scss/ui.scss` (global `ui-` classes) and
`src/components/ui/` (blocks that need markup). New and redesigned screens use
only these. Sizes, radii and colours outside them are a defect.

## Font

The platform's system font (`system-ui`): San Francisco on Apple, Segoe UI on
Windows, Roboto on Android. All three cover Cyrillic, and no font file is
loaded.

## Text scale

| Step | Size / line height | Weight | Where | Class |
|---|---|---|---|---|
| caption | 12 / 16 | 400, 500 | message time, badges, hints under fields, counters | `ui-caption` |
| small | 14 / 20 | 400, 500 | explanation under a menu item, second line in lists, notices, meta | `ui-small` |
| body | 16 / 24 | 400; buttons 500 | messages, menu items, fields, buttons, body text | `ui-body` |
| title-sm | 18 / 26 | 600 | card title, group title on a desktop | `ui-title-sm` |
| title | 20 / 28 | 600 | screen title in the phone header | `ui-title` |
| title-lg | 24 / 32 | 600 | screen title on a desktop, large figures ("3 of 5") | `ui-title-lg` |
| display | 30 / 38 | 700 | sign-in, final states ("Contact confirmed") | `ui-display` |

- There are no other sizes: 13, 15 and 17 px go to the nearest step.
- Group labels in a menu (You, Security…) are caption 500, upper case,
  letter spacing 0.06em (`ui-group-label`).
- Text that has to be read is at least 14 px; 12 px is for meta only.
- Text colours: main `--color-text` #1c1720, secondary
  `--color-text-secondary` #5c5563, muted `--color-text-muted` #736b79. All
  three pass WCAG AA on white (17.6 / 7.2 / 5.1) and on the surface #f6f4f7
  (muted: 4.7).

## Spacing, radii, shadows

- Spacing in steps of 4: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. Inside a row
  8–12, between blocks 16–24, screen padding 16 on a phone and 32 on a
  desktop.
- Radii: fields and buttons 12, cards 16, sheets and modals 24, a message
  bubble 18 with a 6 px tail corner, badges 6, avatars and toggles round.
- Shadows: `--shadow-sm` cards, `--shadow-md` menus, `--shadow-lg` modals.

## Buttons

`ui-btn` with a variant: none (primary, dark), `_outline` (icon right of the
text), `_text`, `_danger` (outline), `_danger_solid`. Sizes: 44 px, `_lg` 52 px,
`_sm` 36 px for dense rows; `_block` fills the width. Disabled is 40 %
opacity, and the reason is written under the button. Keyboard focus is a
2 px accent ring at a 2 px offset.

## Icons

24×24 grid, 2 px padding, 1.5 px line, one colour (`currentColor`), drawn as
CSS masks: `<i class="_icon_<name>">`, coloured with `background-color`.
The filled variant of a tab icon (`<name>_filled`) marks the selected tab.
The set and its masks are listed in `src/scss/icons.scss`; `tests/iconSet.test.js`
checks that every class used exists.

## Blocks

- `UiRow` — a menu item: icon tile, title, second line, chevron. `tone`
  colours the tile and the second line by status; `dot` puts a status dot on
  the right (`success`, `warning`, `danger`, or `accent` for "changed since
  you looked"); the `meta` slot adds a third line in caption size; `selected`
  marks the desktop's current item.
- `ui-card`, `ui-group-label`, `ui-field` (label, input, `_hint` or `_error`),
  `ui-badge` (`_success`, `_warning`, `_danger`, `_accent`), `ui-notice`,
  `ui-skeleton` (loading keeps the screen's shape; no spinners).
