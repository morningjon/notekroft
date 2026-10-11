# Changelog

What changed in each version of NoteKroft, newest first.

NoteKroft is alpha software. It has automated tests but has not yet had
real-world use, so expect rough edges and keep backups of anything that
matters. Version 1.0 is a long way off.

Versioning: each round of changes raises the last number only (0.4.1, 0.4.2,
0.4.3, and so on), whatever its size. The first two numbers stay as they are
until there is a deliberate decision to move them.

Version numbers live in two places that must agree: `Cargo.toml` (which the
app and its installers use) and `package.json` (which the interface shows in
Help, About). The build checks they match and that this file has an entry.

## 0.4.1 (2026-10-11)

- Choose where your notes are kept. File, Notes folder (or a click on the
  path at the bottom of the window) shows the current folder and offers to:
  - **Move** your notes to another folder. Everything is copied and checked
    before the old copy is removed, so the notes are never in neither place.
  - **Use a different folder**, opening the notes already there or starting
    fresh, and leaving the current folder untouched.
  - **Show** the folder in your file manager.
- Picking a folder that already has other files in it (Documents, a
  cloud-sync folder) puts the notes in a `NoteKroft` folder inside it.
- Only notebooks and the trash are moved. Other files you keep beside them
  are left where they are.
- If the chosen folder is missing at start-up, for example on an unplugged
  drive, NoteKroft says so and shows the standard folder until it returns.
  It does not create an empty library in the missing place.
- The choice is remembered in the app's own settings, outside the notes
  folder. The `NOTEKROFT_LIBRARY` environment variable still overrides it.

## 0.4.0 (2026-10-11)

- Renamed from TwoNote to NoteKroft.
- Purple is now the primary colour in both themes, with a new purple logo.
- Notes kept under the old name carry on working: an existing
  `Documents/TwoNote` folder is still used, and `TWONOTE_LIBRARY` is still
  honoured.
- The version is shown in Help, About.

## 0.3.0 (2026-10-11)

- A ribbon with Home, Insert, Draw and View tabs, plus File and Help menus.
- Text formatting: fonts, sizes, text and highlight colours, subscript,
  superscript, alignment, indent, clear formatting, format painter.
- Paragraph styles: Heading 1 to 6, Citation, Quote, Code.
- 16 note tags alongside To Do.
- Inserts: table by grid, date and time, horizontal line, symbols.
- Handwriting and drawing: pens, highlighter, eraser, shapes.
- One undo and redo history for everything on the page.
- Zoom, rule lines and grid, page colour, a theme switch.
- OneNote import keeps fonts, colours, alignment, tags and handwriting.
- File format: text styles, ink blocks, page colour and rule lines.

## 0.2.0 (2026-10-11)

- Import from OneNote: `.one` section files and `.onetoc2` notebooks, keeping
  pages, subpages, dates, layout, formatting, lists, to-dos, tables, links
  and pictures.
- Pictures can sit in line with text.
- A command-line importer.
- Automated builds for macOS, Windows and Linux.
- Licence changed from Apache-2.0 to GPL-3.0-or-later.

## 0.1.0 (2026-10-10)

- First version: notebooks, sections, pages and subpages; a freeform canvas
  of note containers; rich text, lists, to-dos, tables, links and pictures;
  search; autosave; light and dark themes; an open, plain-file format.
