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

`reflow` is optional and normally absent. Importers set it to `true` on pages
whose block positions came from another application. The first time such a
page is opened, TwoNote moves overlapping blocks apart and saves the page
without the flag.

Blocks sit on a freeform canvas. `x`, `y`, `w` and `h` are CSS pixels from
the top-left corner of the canvas. A text block's height follows its content.

### Text block HTML

`html` is restricted to these elements, with every other element, attribute
and inline style removed on write and on read:

`p div br b strong i em u s strike mark sub sup h1 h2 h3 ul ol li blockquote
code pre table tbody tr td th a span img`

Allowed attributes:

- `a`: `href` (schemes `http`, `https`, `mailto` only), plus an automatic `rel`
- `td`, `th`: `colspan`, `rowspan`
- `div`, `p`, `li`: `class`, limited to `todo` and `done`
- `img`: `data-asset`, `width`, `height`, `alt`

A `blockquote` is plain indentation, not a quotation.

An inline picture is an `img` whose `data-asset` names a file in the
notebook's `assets/` folder, exactly as an image block's `asset` does. It
never has a `src`: nothing in a note can point outside the notebook, and an
`img` without a valid `data-asset` is removed. `width` and `height` are whole
numbers of CSS pixels.

A to-do item is a `div`, `p` or `li` with `class="todo"`, and
`class="todo done"` once ticked.

### Image blocks

`asset` names a file in the notebook's `assets/` folder. Asset names are the
lowercase hex SHA-256 of the file's bytes plus an extension chosen from the
file's actual content, so identical pictures are stored once and a file's
name always proves its integrity. Maximum size is 25 MB.

## .trash

Deleting a page, section or notebook moves it here with a timestamped name.
TwoNote never empties this folder; remove items yourself when you are sure.
To restore something, move it back and re-add its id to the parent's
`sections` or `pages` list.

## Writing safely

Files are written to a temporary name in the same directory and then renamed
into place, so a crash or power loss leaves either the old version or the new
one, never a partial file.
