// End-to-end check of the interface against the in-browser demo backend.
// Usage: npm run build && npm run test:ui
// Screenshots land in tests/out/.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { preview } from 'vite';

const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// 1x1 red PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const server = await preview({ preview: { port: 4317, strictPort: true } });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const step = async (name, fn) => {
  await fn();
  console.log(`ok  ${name}`);
};
const saved = () => page.waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved');
const blocks = (sel = '') => page.locator(`#canvas > .block${sel}`);
/** Click empty canvas space at an offset from its top-left corner. */
const clickCanvas = async (x, y) => {
  await page.evaluate(() => document.getElementById('editor').scrollTo(0, 0));
  const box = await page.locator('#canvas').boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
};

try {
  await page.goto('http://localhost:4317/');

  await step('first run creates a welcome notebook', async () => {
    await page.waitForSelector('#page:not([hidden])');
    assert.equal(await page.inputValue('#title'), 'Welcome to NoteKroft');
    assert.equal(await page.textContent('#nb-title'), 'My Notebook');
    assert.equal(await page.locator('#sections li').count(), 1);
    assert.equal(await blocks('.text').count(), 1);
    await page.screenshot({ path: `${OUT}01-welcome.png` });
  });

  await step('clicking empty space starts a note; formatting applies', async () => {
    await clickCanvas(620, 40);
    await page.keyboard.type('Hello world');
    assert.equal(await blocks('.text').count(), 2);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+b');
    await page.waitForSelector('#ribbon button[title^="Bold"][aria-pressed="true"]');
    await page.locator('#ribbon button[title^="Highlight"]').first().click();
    const html = await blocks('.text').nth(1).locator('.content').innerHTML();
    assert.match(html, /<b/);
    assert.match(html, /style="background-color: #ffff00"/);
    await saved();
  });

  await step('an abandoned empty container disappears', async () => {
    await clickCanvas(620, 420);
    assert.equal(await blocks('.text').count(), 3);
    await page.locator('#title').click();
    await page.waitForFunction(() => document.querySelectorAll('#canvas > .block.text').length === 2);
  });

  await step('Tab turns a line into a table and adds rows', async () => {
    await clickCanvas(620, 140);
    await page.keyboard.type('Name');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Value');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Rust');
    const table = blocks('.text').nth(2).locator('table');
    assert.equal(await table.locator('tr').count(), 2);
    assert.deepEqual(await table.locator('td').allTextContents(), ['Name', 'Value', 'Rust', '']);
  });

  await step('to-do tags toggle by shortcut and by clicking the box', async () => {
    await clickCanvas(620, 300);
    await page.keyboard.type('Buy oat milk');
    await page.keyboard.press('Control+1');
    const todo = blocks('.text').nth(3).locator('.todo');
    assert.equal(await todo.count(), 1);
    const box = await todo.boundingBox();
    await page.mouse.click(box.x + 8, box.y + box.height / 2);
    assert.equal(await blocks('.text').nth(3).locator('.todo.done').count(), 1);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second item');
    assert.equal(await blocks('.text').nth(3).locator('.todo').count(), 2);
    assert.equal(await blocks('.text').nth(3).locator('.todo.done').count(), 1);
    await saved();
  });

  await step('containers can be dragged by their grip', async () => {
    const block = blocks('.text').nth(1);
    await block.hover();
    const before = await block.boundingBox();
    const grip = await block.locator('.grip').boundingBox();
    await page.mouse.move(grip.x + 30, grip.y + 5);
    await page.mouse.down();
    await page.mouse.move(grip.x + 130, grip.y + 45, { steps: 4 });
    await page.mouse.up();
    const after = await block.boundingBox();
    assert.equal(Math.round(after.x - before.x), 100);
    assert.equal(Math.round(after.y - before.y), 40);
  });

  await step('pasted HTML is sanitised', async () => {
    await clickCanvas(60, 520);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/html', '<p style="color:red" onclick="window.pwned=1">safe <img src=x onerror="window.pwned=1"><script>window.pwned=1</script><a href="javascript:window.pwned=1">link</a></p>');
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const html = await page.evaluate(() => document.activeElement.innerHTML);
    assert.match(html, /safe/);
    assert.doesNotMatch(html, /script|onerror|onclick|javascript:|<img|style=/);
    assert.equal(await page.evaluate(() => window.pwned), undefined);
  });

  await step('pictures can be inserted and stay selected for deletion', async () => {
    await page.setInputFiles('#image-file', { name: 'dot.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#canvas > .block.image.selected img[src]');
    assert.equal(await blocks('.image').count(), 1);
    await saved();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1360, 'the app never scrolls sideways as a whole');
    await page.screenshot({ path: `${OUT}02-editing.png` });
  });

  await step('pages: add, title, subpage', async () => {
    await page.click('#add-page');
    await page.waitForFunction(() => document.activeElement?.id === 'title');
    await page.keyboard.type('Project plan');
    assert.deepEqual(await page.locator('#pages li').allTextContents(), ['Welcome to NoteKroft', 'Project plan']);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Body text about quarterly forecasts');
    await saved();
    await page.keyboard.press('Control+Alt+]');
    await page.waitForSelector('#pages li.level-1');
  });

  await step('sections: add through the dialog, then switch back', async () => {
    await page.click('#add-section');
    await page.fill('.dialog-input', 'Meetings');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('#sections li').length === 2);
    assert.equal(await page.locator('#sections li.active').textContent(), 'Meetings');
    await page.locator('#sections li').first().click();
    await page.waitForFunction(() => document.getElementById('title').value === 'Project plan');
  });

  await step('everything survives a reload', async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('title').value === 'Project plan');
    await page.locator('#pages li').first().click();
    await page.waitForFunction(() => document.getElementById('title').value === 'Welcome to NoteKroft');
    assert.equal(await blocks('.text').count(), 5);
    assert.equal(await blocks('.image').count(), 1);
    await page.waitForSelector('#canvas > .block.image img[src]');
    assert.equal(await page.locator('#canvas table tr').count(), 2);
    assert.equal(await page.locator('#canvas .todo.done').count(), 2);
  });

  await step('search finds text across pages and jumps to it', async () => {
    await page.keyboard.press('Control+e');
    await page.keyboard.type('forecasts');
    await page.waitForSelector('.hit');
    assert.equal(await page.locator('.hit').count(), 1);
    assert.match(await page.locator('.hit-path').textContent(), /My Notebook › Quick Notes/);
    await page.screenshot({ path: `${OUT}03-search.png` });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('title').value === 'Project plan');
  });

  await step('deleting a page opens its neighbour', async () => {
    await page.locator('#pages li.active').click({ button: 'right' });
    await page.screenshot({ path: `${OUT}04-menu.png` });
    await page.getByRole('menuitem', { name: 'Delete page' }).click();
    await page.waitForFunction(() => document.getElementById('title').value === 'Welcome to NoteKroft');
    assert.equal(await page.locator('#pages li').count(), 1);
  });

  await step('imported pages: inline pictures show, overlapping blocks are moved apart once', async () => {
    // Plant a page shaped like the OneNote importer's output.
    const pageId = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('notekroft.demo.v1'));
      const nb = Object.values(data.notebooks)[0];
      const asset = Object.keys(data.assets)[0];
      const id = crypto.randomUUID();
      const long = '<div>' + 'A long imported paragraph that wraps over several lines. '.repeat(6) + '</div>';
      nb.pages[id] = {
        id, title: 'Imported page', created: 1, modified: 1, reflow: true,
        blocks: [
          { kind: 'text', id: 'a', x: 0, y: 0, w: 300, html: long + `<div><img data-asset="${asset}" width="120" height="80" alt="dot"></div>` },
          { kind: 'text', id: 'b', x: 40, y: 30, w: 300, html: '<div>Second container</div><blockquote><div>indented</div></blockquote>' },
          { kind: 'text', id: 'c', x: 500, y: 10, w: 200, html: '<div>Beside, untouched</div>' },
        ],
      };
      nb.sections[0].pages.push({ id, title: 'Imported page', level: 0, modified: 1 });
      localStorage.setItem('notekroft.demo.v1', JSON.stringify(data));
      return id;
    });
    await page.reload();
    await page.waitForSelector('#page:not([hidden])');
    await page.locator('#pages li', { hasText: 'Imported page' }).click();
    await page.waitForSelector('#canvas img[data-asset][src]');
    await saved();

    const boxes = await blocks('.text').evaluateAll((els) => els.map((e) => ({ id: e.dataset.id, top: e.offsetTop, bottom: e.offsetTop + e.offsetHeight, left: e.offsetLeft })));
    const [a, b, c] = ['a', 'b', 'c'].map((id) => boxes.find((x) => x.id === id));
    assert.equal(a.top, 0);
    assert.ok(a.bottom > 150, 'first block is tall enough to have overlapped the second');
    assert.ok(b.top >= a.bottom, `second block moved below the first (${b.top} >= ${a.bottom})`);
    assert.equal(c.top, 10, 'a block alongside is left where it was');
    const img = page.locator('#canvas img[data-asset]');
    assert.equal(await img.evaluate((e) => e.offsetWidth), 120);

    const stored = await page.evaluate((id) => Object.values(JSON.parse(localStorage.getItem('notekroft.demo.v1')).notebooks)[0].pages[id], pageId);
    assert.equal(stored.reflow, false, 'the reflow happens once');
    assert.equal(stored.blocks.find((x) => x.id === 'b').y, b.top);
    assert.match(stored.blocks[0].html, /<img data-asset="[0-9a-f]{64}\.png" width="120" height="80" alt="dot">/);
    assert.doesNotMatch(stored.blocks[0].html, /src=|draggable/);
    await page.screenshot({ path: `${OUT}06-imported.png` });
  });

  // ---- ribbon ------------------------------------------------------------------

  const tab = (name) => page.locator(`#tabs button[data-tab="${name}"]`).click();
  const tool = (title) => page.locator(`#ribbon button[title^="${title}"]`).first();
  const pick = async (title, item) => {
    const exact = page.locator(`#ribbon button[title="${title}"]`);
    await ((await exact.count()) ? exact : tool(title)).click();
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.locator('.menu .menu-label', { hasText: new RegExp(`^${escaped}$`) }).click();
  };
  const storedPage = (title) => page.evaluate((t) => {
    const nb = Object.values(JSON.parse(localStorage.getItem('notekroft.demo.v1')).notebooks)[0];
    return Object.values(nb.pages).find((p) => p.title === t);
  }, title);
  const newPage = async (title) => {
    await page.click('#add-page');
    await page.waitForFunction(() => document.activeElement?.id === 'title');
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
  };

  await step('Home tab: font, size, colour, alignment, styles and tags', async () => {
    await newPage('Formatting');
    await page.keyboard.type('Styled text');
    await page.keyboard.press('Control+a');
    await pick('Font size', '20');
    await pick('Font', 'Georgia');
    await tool('Font colour').click();
    await pick('Paragraph alignment', 'Centre');
    assert.equal(await tool('Font size').textContent(), '20▾');
    assert.equal(await tool('Font').first().textContent(), 'Georgia▾');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await pick('Paragraph style', 'Heading 2');
    await page.keyboard.type('A heading');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Star this');
    await page.keyboard.press('Control+2');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Quoted');
    await pick('Paragraph style', 'Quote');
    await saved();

    const html = (await storedPage('Formatting')).blocks[0].html;
    assert.match(html, /font-family: Georgia/);
    assert.match(html, /font-size: 20pt/);
    assert.match(html, /color: #c00000/);
    assert.match(html, /text-align: center/);
    assert.match(html, /<h2[^>]*>(<span[^>]*>)?A heading/);
    assert.match(html, /<div class="tag-important">(<span[^>]*>)?Star this</);
    assert.match(html, /<div class="quote">(<span[^>]*>)?Quoted</, 'a tag does not follow onto the next line');
    assert.doesNotMatch(html, /<font|rgb\(/, 'stored formatting is in canonical form');
    const star = page.locator('#canvas .tag-important');
    assert.notEqual(await star.evaluate((e) => getComputedStyle(e, '::before').maskImage || getComputedStyle(e, '::before').webkitMaskImage), 'none');
    await page.screenshot({ path: `${OUT}07-formatting.png` });
  });

  await step('undo and redo cover typing and moving, in one history', async () => {
    await newPage('Undo');
    await page.keyboard.type('First');
    await page.waitForTimeout(700);
    await page.keyboard.type(' second');
    await page.waitForTimeout(700);
    const text = () => page.locator('#canvas .content').first().textContent();
    assert.equal(await text(), 'First second');
    await page.keyboard.press('Control+z');
    assert.equal(await text(), 'First');
    await page.keyboard.press('Control+y');
    assert.equal(await text(), 'First second');

    const block = blocks('.text').first();
    await block.hover();
    const grip = await block.locator('.grip').boundingBox();
    const before = await block.boundingBox();
    await page.mouse.move(grip.x + 30, grip.y + 5);
    await page.mouse.down();
    await page.mouse.move(grip.x + 230, grip.y + 105, { steps: 4 });
    await page.mouse.up();
    assert.equal(Math.round((await block.boundingBox()).x - before.x), 200);
    await tool('Undo').click();
    assert.equal(Math.round((await blocks('.text').first().boundingBox()).x - before.x), 0);
    await page.waitForSelector('#ribbon button[title^="Redo"]:not(:disabled)');
    await tool('Redo').click();
    assert.equal(Math.round((await blocks('.text').first().boundingBox()).x - before.x), 200);
    await page.waitForSelector('#ribbon button[title^="Redo"]:disabled');
  });

  await step('Insert tab: table by grid, date, line and symbol', async () => {
    await newPage('Inserts');
    await tab('insert');
    await tool('Insert a table').click();
    await page.getByRole('button', { name: '4 by 2 table' }).click();
    assert.equal(await page.locator('#canvas table tr').count(), 2);
    assert.equal(await page.locator('#canvas table td').count(), 8);
    await page.keyboard.type('in a cell');
    await clickCanvas(40, 260);
    await tool("Insert today's date").click();
    await tool('Insert a symbol').click();
    await page.getByRole('button', { name: '€', exact: true }).click();
    await tool('Insert a horizontal line').click();
    await saved();
    const stored = await storedPage('Inserts');
    assert.match(stored.blocks[0].html, /<td>in a cell<\/td>/);
    assert.match(stored.blocks[1].html, new RegExp(`${new Date().getFullYear()}.*€.*<hr>`, 's'));
  });

  await step('Draw tab: pens, grouping, shapes, eraser, selecting ink', async () => {
    await newPage('Drawing');
    await page.locator('#title').click();
    await tab('draw');
    await tool('Black pen').click();
    const canvas = await page.locator('#canvas').boundingBox();
    const stroke = async (points) => {
      await page.mouse.move(canvas.x + points[0][0], canvas.y + points[0][1]);
      await page.mouse.down();
      for (const [x, y] of points.slice(1)) await page.mouse.move(canvas.x + x, canvas.y + y, { steps: 6 });
      await page.mouse.up();
    };
    await stroke([[100, 100], [160, 60], [220, 110]]);
    await stroke([[100, 140], [220, 150]]);
    assert.equal(await blocks('.ink').count(), 1, 'strokes drawn in quick succession join one drawing');
    assert.equal(await blocks('.ink').locator('g').count(), 2);

    await page.waitForTimeout(1700);
    await tool('Yellow highlighter').click();
    await stroke([[300, 100], [460, 104]]);
    assert.equal(await blocks('.ink').count(), 2);
    const marker = blocks('.ink').nth(1).locator('path.line');
    assert.equal(await marker.getAttribute('stroke'), '#ffe600');
    assert.equal(await marker.getAttribute('stroke-opacity'), '0.4');

    await pick('Draw a shape', 'Rectangle');
    await stroke([[100, 220], [260, 300]]);
    assert.equal(await blocks('.ink').count(), 3);
    const rect = await blocks('.ink').nth(2).locator('path.line').getAttribute('d');
    assert.equal(rect.split('L').length, 5, 'a rectangle keeps its four straight sides');
    assert.equal(await blocks('.text').count(), 0, 'drawing never starts a note container');

    await tool('Erase strokes').click();
    await stroke([[160, 130], [160, 160]]);
    assert.equal(await blocks('.ink').first().locator('g').count(), 1, 'the eraser removes the stroke it crosses');

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#canvas').evaluate((e) => e.className), 'canvas');
    await saved();
    const stored = await storedPage('Drawing');
    assert.deepEqual(stored.blocks.map((b) => [b.kind, b.strokes.length]), [['ink', 1], ['ink', 1], ['ink', 1]]);
    assert.ok(stored.blocks[0].strokes[0].points.length > 5);
    await page.screenshot({ path: `${OUT}08-drawing.png` });

    // In typing mode a stroke can be clicked to select its drawing, then deleted.
    await page.mouse.click(canvas.x + 380, canvas.y + 102);
    await page.waitForSelector('#canvas .block.ink.selected');
    await page.keyboard.press('Delete');
    assert.equal(await blocks('.ink').count(), 2);
    await tool('Undo').click().catch(() => {});
    await tab('home');
    await tool('Undo').click();
    assert.equal(await blocks('.ink').count(), 3, 'deleting ink can be undone');
    // Empty space inside a drawing's bounds still starts a note.
    await clickCanvas(180, 260);
    await page.keyboard.type('inside the box');
    assert.equal(await blocks('.text').count(), 1);
    await saved();
  });

  await step('View tab: zoom, rule lines, page colour and theme', async () => {
    await tab('view');
    await pick('Zoom', '150%');
    assert.equal(await page.locator('#page').evaluate((e) => e.style.transform), 'scale(1.5)');
    // Clicks and drags still land where the pointer is.
    const canvas = await page.locator('#canvas').boundingBox();
    await page.mouse.click(canvas.x + 600, canvas.y + 90);
    await page.keyboard.type('zoomed');
    const placed = blocks('.text').last();
    assert.equal(await placed.evaluate((e) => e.style.left), '390px');
    assert.equal(await placed.evaluate((e) => e.style.top), '46px');
    await tool('Zoom to 100%').click();
    assert.equal(await page.locator('#page').evaluate((e) => e.style.transform), '');

    await pick('Show lines', 'Grid');
    assert.ok(await page.locator('#canvas').evaluate((e) => e.classList.contains('rules-grid')));
    await tool("Change this page's background").click();
    await page.locator('.menu .swatch').first().click();
    assert.equal(await page.locator('#editor').evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(255, 249, 219)');
    await saved();
    const stored = await storedPage('Drawing');
    assert.equal(stored.rules, 'grid');
    assert.equal(stored.color, '#fff9db');
    await page.screenshot({ path: `${OUT}09-view.png` });

    await pick('Light or dark', 'Dark');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.locator('.topbar').evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(31, 28, 38)');
    // A coloured page stays a light page with dark text.
    assert.equal(await page.locator('#canvas .content').first().evaluate((e) => getComputedStyle(e).color), 'rgb(33, 29, 41)');
    await page.reload();
    await page.waitForSelector('#page:not([hidden])');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'the theme is remembered');
    assert.ok(await page.locator('#canvas').evaluate((e) => e.classList.contains('rules-grid')));
    assert.equal(await blocks('.ink').count(), 3, 'ink survives a reload');
    await page.screenshot({ path: `${OUT}10-dark-ink.png` });
    await tab('view');
    await pick('Light or dark', 'Match the system');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
    await tab('home');
  });

  await step('File and Help menus', async () => {
    await page.locator('#tabs button[data-tab="file"]').click();
    assert.deepEqual(
      await page.locator('.menu .menu-label').allTextContents(),
      ['New notebook…', 'Import from OneNote…', 'Rename this notebook…', 'Delete this notebook…'],
    );
    await page.keyboard.press('Escape');
    await page.locator('#tabs button[data-tab="help"]').click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    assert.ok((await page.locator('.dialog-table tr').count()) > 15);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.overlay', { state: 'detached' });
  });

  await step('dark theme renders', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${OUT}05-dark.png` });
  });

  await step('phone layout: lists in a drawer, search inside it, notes fit the screen', async () => {
    const phoneContext = await browser.newContext({
      viewport: { width: 390, height: 780 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const phone = await phoneContext.newPage();
    phone.on('pageerror', (e) => errors.push(`phone: ${e}`));
    phone.on('console', (m) => m.type() === 'error' && errors.push(`phone: ${m.text()}`));
    await phone.goto('http://localhost:4317/');
    await phone.waitForSelector('#page:not([hidden])');
    const onScreen = async (sel) => {
      const box = await phone.locator(sel).boundingBox();
      return !!box && box.x >= 0 && box.x + box.width <= 390.5;
    };
    // Nothing spills sideways, and the lists start out of the way.
    assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth), 390);
    assert.ok(await phone.locator('#nav-toggle').isVisible());
    assert.ok(!(await phone.locator('#nav').isVisible()));
    assert.ok(await onScreen('#canvas > .block.text'), 'welcome note fits the screen');
    await phone.screenshot({ path: `${OUT}06-phone.png` });

    await phone.locator('#nav-toggle').tap();
    await phone.waitForSelector('#nav.open');
    await phone.waitForTimeout(250);
    assert.ok(await onScreen('#nav'));
    assert.ok(await phone.locator('#nav #search').isVisible(), 'search moves into the drawer');
    await phone.screenshot({ path: `${OUT}07-phone-drawer.png` });

    // Adding a page from the drawer, then picking one, closes it again.
    await phone.locator('#add-page').tap();
    await phone.waitForFunction(() => document.querySelectorAll('#pages li').length === 2);
    await phone.locator('#pages li').first().tap();
    await phone.waitForSelector('#nav:not(.open)', { state: 'attached' });
    assert.equal(await phone.inputValue('#title'), 'Welcome to NoteKroft');

    // Tapping the page starts a note that fits, and typing lands in it.
    const canvas = await phone.locator('#canvas').boundingBox();
    const last = await phone.locator('#canvas > .block.text').last().boundingBox();
    await phone.touchscreen.tap(canvas.x + 120, last.y + last.height + 60);
    await phone.keyboard.type('Typed on a phone');
    assert.equal(await phone.locator('#canvas > .block.text').count(), 2);
    assert.ok(await onScreen('#canvas > .block.text >> nth=1'), 'new note fits the screen');
    await phone.waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved');

    // The ribbon still works by touch.
    await phone.locator('#tabs button[data-tab="draw"]').tap();
    await phone.waitForSelector('#ribbon button[title^="Pen"], #ribbon button[title*="pen" i]');
    await phone.screenshot({ path: `${OUT}08-phone-draw.png` });

    // Search from the drawer jumps to the page and closes the drawer.
    await phone.locator('#nav-toggle').tap();
    await phone.waitForSelector('#nav.open');
    await phone.locator('#search').fill('Typed on a phone');
    await phone.locator('#search-results .hit').first().tap();
    await phone.waitForSelector('#nav:not(.open)', { state: 'attached' });
    await phoneContext.close();
  });

  assert.deepEqual(errors, [], 'no console or page errors');
  console.log('\nAll interface checks passed.');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
