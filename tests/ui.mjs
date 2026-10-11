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
    assert.equal(await page.inputValue('#title'), 'Welcome to TwoNote');
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
    assert.equal(await page.locator('#toolbar [data-cmd=bold]').getAttribute('aria-pressed'), 'true');
    await page.locator('#toolbar [data-act=highlight]').click();
    const html = await blocks('.text').nth(1).locator('.content').innerHTML();
    assert.match(html, /<b>/);
    assert.match(html, /<mark>/);
    assert.doesNotMatch(html, /style=/);
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
    assert.deepEqual(await page.locator('#pages li').allTextContents(), ['Welcome to TwoNote', 'Project plan']);
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
    await page.waitForFunction(() => document.getElementById('title').value === 'Welcome to TwoNote');
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
    await page.waitForFunction(() => document.getElementById('title').value === 'Welcome to TwoNote');
    assert.equal(await page.locator('#pages li').count(), 1);
  });

  await step('imported pages: inline pictures show, overlapping blocks are moved apart once', async () => {
    // Plant a page shaped like the OneNote importer's output.
    const pageId = await page.evaluate(() => {
      const data = JSON.parse(localStorage.getItem('twonote.demo.v1'));
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
      localStorage.setItem('twonote.demo.v1', JSON.stringify(data));
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

    const stored = await page.evaluate((id) => Object.values(JSON.parse(localStorage.getItem('twonote.demo.v1')).notebooks)[0].pages[id], pageId);
    assert.equal(stored.reflow, false, 'the reflow happens once');
    assert.equal(stored.blocks.find((x) => x.id === 'b').y, b.top);
    assert.match(stored.blocks[0].html, /<img data-asset="[0-9a-f]{64}\.png" width="120" height="80" alt="dot">/);
    assert.doesNotMatch(stored.blocks[0].html, /src=|draggable/);
    await page.screenshot({ path: `${OUT}06-imported.png` });
  });

  await step('dark theme renders', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${OUT}05-dark.png` });
  });

  assert.deepEqual(errors, [], 'no console or page errors');
  console.log('\nAll interface checks passed.');
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
