# TwoNote

A local-first, open source notebook app in the freeform style of OneNote:
notebooks, colour-coded sections, pages and subpages, and a canvas where you
click anywhere and start typing.

Built with a Rust core and a [Tauri](https://tauri.app) shell. Notes are plain
JSON files in a folder you own. The app makes no network requests.

![TwoNote](docs/screenshot.png)

## Status

Milestone 1: a usable notebook app with its own open format.

What works today:

- Notebooks, sections (colours, rename, drag to reorder) and pages (subpages
  to two levels, drag to reorder, drop onto a section to move)
- Freeform canvas: click empty space for a new note container, drag it by its
  top bar, resize it from its right edge
- Rich text: headings, bold, italic, underline, strikethrough, highlight,
  bullet and numbered lists, links, to-do tags with tick boxes
- Tables: press Tab after some text to start one, Tab through cells, Tab in
  the last cell for a new row, right-click for row and column operations
- Pictures: paste, drop, or pick a file; drag to move, corner handle to resize
- Search across every notebook (Ctrl+E)
- Autosave, light and dark themes
- Deleting is safe: pages, sections and notebooks move to `.trash` inside the
  library instead of being destroyed

- Import from OneNote: bring in `.one` section files or a whole notebook,
  keeping text, formatting, lists, to-dos, tables, links, pictures, subpages
  and original dates (see [Importing from OneNote](#importing-from-onenote))

Not yet built (see [Roadmap](#roadmap)): ink, attached files, undo for moving
containers, page history, sync.

## Where your notes live

`Documents/TwoNote` by default. The path is shown in the status bar; click it
to open the folder. Set `TWONOTE_LIBRARY=/some/path` to keep the library
somewhere else, such as a folder synced by Syncthing or an encrypted volume.

The layout is documented in [docs/FORMAT.md](docs/FORMAT.md). It is designed
to be readable without TwoNote.

## Building and running

You need Rust 1.90+, Node.js 20.19+ and Tauri's system libraries. Then:

```sh
git clone https://github.com/morningjon/twonote.git
cd twonote
npm install
npm run tauri dev      # run the desktop app with live reload
npm run tauri build    # produce an installable package
```

**Full instructions for Linux, macOS and Windows, including the exact
packages to install, packaging options and troubleshooting, are in
[docs/BUILDING.md](docs/BUILDING.md).**

Prefer not to build it yourself? Every push is built for macOS, Windows and
Linux; the apps are attached to each run under the
[Actions tab](https://github.com/morningjon/twonote/actions/workflows/build.yml)
(a free GitHub account is needed to download them).

So far TwoNote has been run by hand on Linux only. The macOS and Windows apps
build and package successfully but are untested in use; reports are welcome.

To try the interface in a browser without building any Rust, run
`npm run dev` and open http://localhost:1420. In that mode notes are kept in
the browser's local storage only.

## Importing from OneNote

Open the notebook menu at the top left and choose **Import from OneNote…**,
then pick one or more `.one` section files, or a notebook's `.onetoc2` index
to bring in every section at once. Each OneNote section becomes a new section
in the notebook you have open. Your OneNote files are only read, never
changed, and nothing already in the notebook is touched.

Where to find the files:

- **OneNote for Windows (desktop)**: File, Export, and export a section as
  "OneNote 2010-2016 Section (*.one)". Notebooks stored on the computer are
  already folders of `.one` files, usually under `Documents\OneNote Notebooks`.
- **OneDrive**: on onedrive.com, select the notebook's folder and choose
  Download. Unzip it and pick the `.onetoc2` file inside.

What comes across:

| Kept | Not yet |
| --- | --- |
| Pages, subpages, titles, created and modified dates | Ink and handwriting |
| Section names, colours and section groups | Attached files, audio and video (a note marks where each was) |
| Note containers in their original positions | Pictures stored as EMF, BMP or TIFF |
| Bold, italic, underline, strikethrough, highlight, super and subscript | Fonts, text sizes and text colours |
| Headings, bullet and numbered lists, indentation | Tags other than to-do tick boxes |
| To-do tick boxes, ticked or not | Equations (their text is kept, not the layout) |
| Tables, web and email links | Links to other OneNote pages (the text is kept) |
| PNG, JPEG, GIF and WebP pictures, inline or free-standing | Password-protected sections |

After an import, TwoNote tells you how many of each skipped item it found.
The first time you open an imported page, overlapping note containers are
moved apart once, since the same text takes up slightly different room here.

Importing has been checked against 32 real OneNote files, covering both the
desktop OneNote format and OneDrive downloads. The format is large and
old, so if a file of yours fails or comes out wrong, please open an issue.

There is also a command-line importer, useful for scripting or bulk moves:

```sh
cargo run -p twonote-onenote --example import -- \
  ~/Documents/TwoNote "From OneNote" path/to/Notebook/*.one
```

## Shortcuts

Shortcuts follow OneNote's where one exists.

| Action | Shortcut |
| --- | --- |
| Search all notebooks | Ctrl+E |
| New page / new section | Ctrl+N / Ctrl+T |
| Previous / next page | Ctrl+PageUp / Ctrl+PageDown |
| Make subpage / promote | Ctrl+Alt+] / Ctrl+Alt+[ |
| Bold, italic, underline | Ctrl+B, Ctrl+I, Ctrl+U |
| Strikethrough | Ctrl+- |
| Highlight | Ctrl+Alt+H |
| Bullet list / numbered list | Ctrl+. / Ctrl+/ |
| To-do tag | Ctrl+1 |
| Heading 1, 2, 3 / normal text | Ctrl+Alt+1, 2, 3 / Ctrl+Shift+N |
| Insert link | Ctrl+K |
| Start a table, next cell | Tab |
| Open a link | Ctrl+click |

On macOS use Cmd in place of Ctrl.

## Layout of this repository

| Path | What it is |
| --- | --- |
| `crates/twonote-core` | Model, on-disk format, HTML sanitising, search. No UI, no network. |
| `crates/twonote-onenote` | Imports OneNote `.one` and `.onetoc2` files into a library. |
| `src-tauri` | The desktop shell: a window and a thin command layer over the core. |
| `ui` | The interface, in plain TypeScript with no framework. |
| `tests/ui.mjs` | End-to-end test of the interface in headless Chromium. |
| `docs/BUILDING.md` | How to build, package and test TwoNote. |
| `docs/FORMAT.md` | The notebook file format. |

## Tests

```sh
cargo test -p twonote-core            # storage, sanitising, search
npm run build && npm run test:ui      # interface, in headless Chromium
```

## Security model

- The web view talks to Rust only through TwoNote's own commands. Those take
  ids, never file paths, and the core rejects any id that is not a plain
  identifier, so the interface cannot read or write outside the library.
- Note content is a fixed subset of HTML. It is sanitised in Rust (with
  [ammonia](https://crates.io/crates/ammonia)) when written and again when
  read, so a notebook copied in from elsewhere cannot carry script.
- A strict Content Security Policy blocks inline script and all remote
  content. Pasted web content has its images removed rather than fetched.
- Links open in your default browser, and only `http`, `https` and `mailto`
  links are kept.

## Roadmap

1. Undo and redo for canvas operations; page version history
2. Ink and drawing, including ink from imported OneNote pages
3. Attached files
4. Export to Markdown and HTML
5. Optional end-to-end encrypted sync

## How this was built

TwoNote is an independent, from-scratch implementation. It contains no
Microsoft code and was not derived from OneNote's binaries. Familiar
behaviour was reproduced from how the application visibly works. TwoNote is
not affiliated with or endorsed by Microsoft; OneNote is a trademark of
Microsoft Corporation.

OneNote files are read with [onenote_parser](https://github.com/msiemens/onenote.rs)
by Markus Siemens (MPL-2.0), itself an independent implementation of
Microsoft's published [MS-ONE] and [MS-ONESTORE] file format specifications.

## Licence

Copyright (C) 2026 morningjon and the TwoNote contributors.

TwoNote is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

TwoNote is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the GNU General Public License for more details.

The full text is in [LICENSE](LICENSE). In short: you are free to use, study,
change and share TwoNote, and anything you distribute that is built from it
must be offered under the same terms, with its source code.

[MS-ONE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-one/
[MS-ONESTORE]: https://learn.microsoft.com/openspecs/office_file_formats/ms-onestore/
