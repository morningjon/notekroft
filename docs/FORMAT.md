# TwoNote library format, version 1

A library is a directory. Everything in it is UTF-8 JSON or an image file, so
it can be read, backed up, diffed and synced with ordinary tools.

```
<library>/
  <notebook-id>/
    notebook.json
    assets/
      <sha256>.<png|jpg|gif|webp>
    sections/
      <section-id>/
        section.json
        pages/
          <page-id>.json
  .trash/
    <timestamp>-<kind>-<id>-<suffix>
```

Ids are UUIDs. TwoNote only accepts ids made of ASCII letters, digits and
hyphens, at most 64 characters. Timestamps are milliseconds since the Unix
epoch, UTC.

## notebook.json

```json
{
  "format": 1,
  "id": "42353866-387d-4127-9ed3-a51d6f684b4d",
  "title": "My Notebook",
  "color": "#2f7dd1",
  "created": 1791674888917,
  "modified": 1791674888922,
  "sections": ["c35d4294-d35b-4f40-9e8f-033f6aa641b6"]
}
```

`sections` gives the display order. A notebook whose `format` is higher than
the running version understands is left alone and not shown, so an older
TwoNote never rewrites data it cannot fully read.

## section.json

```json
{
  "id": "c35d4294-d35b-4f40-9e8f-033f6aa641b6",
  "title": "Quick Notes",
  "color": "#2f7dd1",
  "pages": [
    { "id": "655eacff-9032-414d-8690-dfb6bb9d2cb5", "title": "Welcome", "level": 0, "modified": 1791674888922 }
  ]
}
```

`pages` is the page index in display order. `level` is the subpage indent:
0, 1 or 2. A page is never more than one level deeper than the page above it,
and the first page is always level 0. Titles are repeated here so the
navigation can be drawn without opening every page; the page file is the
source of truth.

## pages/<page-id>.json

```json
{
  "id": "655eacff-9032-414d-8690-dfb6bb9d2cb5",
  "title": "Welcome",
  "created": 1791674888917,
  "modified": 1791674888922,
  "reflow": true,
  "blocks": [
    { "kind": "text", "id": "…", "x": 0, "y": 0, "w": 520, "html": "<div>Hello</div>" },
    { "kind": "image", "id": "…", "x": 40, "y": 300, "w": 320, "h": 200, "asset": "<sha256>.png", "alt": "" }
  ]
}
```

`rules` and `color` are optional. `rules` is `"ruled"` or `"grid"` and draws
lines behind the page. `color` is the page's background colour as `#rrggbb`.

`reflow` is optional and normally absent. Importers set it to `true` on pages
whose block positions came from another application. The first time such a
page is opened, TwoNote moves overlapping blocks apart and saves the page
without the flag.

Blocks sit on a freeform canvas. `x`, `y`, `w` and `h` are CSS pixels from
the top-left corner of the canvas. A text block's height follows its content.

### Text block HTML

`html` is restricted to these elements, with every other element and
attribute removed on write and on read:

`p div br hr b strong i em u s strike mark sub sup h1 h2 h3 h4 h5 h6 ul ol li
blockquote code pre table tbody tr td th a span img`

Allowed attributes:

- `a`: `href` (schemes `http`, `https`, `mailto` only), plus an automatic `rel`
- `td`, `th`: `colspan`, `rowspan`, `style`
- `div`, `p`, `li`, `h1` to `h6`: `class` and `style`
- `span`, `pre`, `blockquote`: `style`
- `img`: `data-asset`, `width`, `height`, `alt`

A `blockquote` is plain indentation, not a quotation.

#### Classes

Only these class names survive:

| Class | Meaning |
| --- | --- |
| `todo`, `todo done` | A to-do item with a tick box, unticked or ticked |
| `quote`, `cite` | The Quote and Citation paragraph styles |
| `tag-important`, `tag-question`, `tag-critical`, `tag-idea`, `tag-contact`, `tag-address`, `tag-phone`, `tag-website`, `tag-password`, `tag-movie`, `tag-book`, `tag-music`, `tag-source` | A note tag, shown as an icon before the paragraph |
| `tag-remember`, `tag-highlight`, `tag-definition` | A note tag shown as a background colour |

#### Styles

A `style` attribute may hold only the five properties below. Each value is
checked and rewritten in one canonical form; anything else is removed, so a
note can never position, hide or load anything.

| Property | Stored as | Example |
| --- | --- | --- |
| `font-family` | Font names, unquoted, comma separated | `font-family: Calibri Light` |
| `font-size` | A number with `pt` or `px`, 1 to 400 | `font-size: 20pt` |
| `color` | `#rrggbb` | `color: #c00000` |
| `background-color` | `#rrggbb` (text highlight) | `background-color: #ffff00` |
| `text-align` | `left`, `center`, `right` or `justify` | `text-align: center` |

Properties are always written in the order above, separated by `; `.

#### Inline pictures

An inline picture is an `img` whose `data-asset` names a file in the
notebook's `assets/` folder, exactly as an image block's `asset` does. It
never has a `src`: nothing in a note can point outside the notebook, and an
`img` without a valid `data-asset` is removed. `width` and `height` are whole
numbers of CSS pixels.

### Image blocks

`asset` names a file in the notebook's `assets/` folder. Asset names are the
lowercase hex SHA-256 of the file's bytes plus an extension chosen from the
file's actual content, so identical pictures are stored once and a file's
name always proves its integrity. Maximum size is 25 MB.

### Ink blocks

```json
{
  "kind": "ink", "id": "…", "x": 120, "y": 80, "w": 244, "h": 64,
  "strokes": [
    { "points": [[1, 3], [30.5, 62.1], [61, 3]], "color": "#1b1b1b", "width": 2 },
    { "points": [[4, 40], [240, 44]], "color": "#ffe600", "width": 16, "opacity": 0.4 }
  ]
}
```

An ink block is a drawing: one or more pen strokes. `x`, `y`, `w` and `h`
give its bounding box on the canvas. Each stroke's `points` are `[x, y]`
pairs in CSS pixels from the block's top-left corner, to one decimal place.
`width` is the line thickness in pixels (0.5 to 80) and `color` is
`#rrggbb`. `opacity` is left out for an ordinary pen and is below 1 for a
highlighter.

Strokes are drawn with round ends and joins. A stroke of eight or more
points is drawn as a smooth curve through them; a shorter one as straight
segments, which is how lines, arrows and rectangles keep their corners.

## .trash

Deleting a page, section or notebook moves it here with a timestamped name.
TwoNote never empties this folder; remove items yourself when you are sure.
To restore something, move it back and re-add its id to the parent's
`sections` or `pages` list.

## Writing safely

Files are written to a temporary name in the same directory and then renamed
into place, so a crash or power loss leaves either the old version or the new
one, never a partial file.
