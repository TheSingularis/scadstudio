// Playwright fixtures for driving the built Electron app headlessly.
//
// Every test gets a fresh app (`scad`), launched with software GL so it runs
// under Xvfb on CI. All interaction is real input through Chromium's input
// pipeline (page.mouse / page.keyboard / locator.click), and assertions read
// what a user would see: editor text, the status line, toolbar state.
//
// The only app hooks used are the two that already exist for manual
// verification: window.__testSetSource (App.tsx) to load a document without
// typing it, and window.__testEditor (Editor.tsx) to read the editor text.
import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from './png';

export const DESKTOP_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
export const SPIKE_FIXTURES_DIR = resolve(DESKTOP_DIR, '../../spikes/fixtures');
export const FONT_FIXTURES_DIR = resolve(DESKTOP_DIR, 'test/fixtures/fonts');

const LAUNCH_ARGS = ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class ScadApp {
  readonly consoleLines: string[] = [];
  readonly pageErrors: string[] = [];

  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
  ) {
    page.on('console', (m) => this.consoleLines.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => this.pageErrors.push(String(e)));
  }

  button(name: string | RegExp) {
    return this.page.getByRole('button', { name, exact: typeof name === 'string' });
  }

  /** The status text at the right of the top bar ("Rendered", "Rendering...", ...). */
  async status(): Promise<string> {
    return this.page.evaluate(
      () => [...document.querySelectorAll('span')].find((s) => (s as HTMLElement).style.marginLeft === 'auto')?.textContent ?? '',
    );
  }

  async source(): Promise<string> {
    return this.page.evaluate(() => (window as unknown as { __testEditor: { getValue(): string } }).__testEditor.getValue());
  }

  /**
   * Run `action`, then wait for the render it triggers to finish. Watches the
   * status line for "Rendering" so an earlier "Rendered" can't satisfy the wait.
   */
  async rendersAfter(action: () => Promise<unknown>, timeout = 60_000): Promise<string> {
    await this.page.evaluate(() => {
      const w = window as unknown as { __e2eSawRendering: boolean; __e2eObserver?: MutationObserver };
      w.__e2eSawRendering = false;
      w.__e2eObserver?.disconnect();
      const el = [...document.querySelectorAll('span')].find((s) => (s as HTMLElement).style.marginLeft === 'auto');
      if (!el) return;
      w.__e2eObserver = new MutationObserver(() => {
        if (el.textContent?.includes('Rendering')) w.__e2eSawRendering = true;
      });
      w.__e2eObserver.observe(el, { childList: true, characterData: true, subtree: true });
    });
    await action();
    // Every document the tests load has nodes, so a render always passes
    // through "Rendering..."; the 3 s fallback only covers a missed frame.
    const started = Date.now();
    await this.page.waitForFunction(
      (t0) => (window as unknown as { __e2eSawRendering: boolean }).__e2eSawRendering || Date.now() - t0 > 3000,
      started,
      { timeout },
    );
    await expect.poll(() => this.status(), { timeout }).toMatch(/Rendered|Render failed/);
    return this.status();
  }

  /** Load a whole document (no typing), wait for it to render, and re-fit the camera. */
  async load(source: string, { fit = true } = {}): Promise<string> {
    const status = await this.rendersAfter(() =>
      this.page.evaluate((s) => (window as unknown as { __testSetSource(v: string): void }).__testSetSource(s), source),
    );
    if (fit) await this.resetView();
    return status;
  }

  async resetView(): Promise<void> {
    await this.button('Reset View').click();
    await this.page.waitForTimeout(1200); // camera fit animation
  }

  /** The 3D viewport's canvas (the largest canvas on the page). */
  async viewport(): Promise<Box> {
    const boxes = await this.page.locator('canvas').evaluateAll((cs) =>
      cs.map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
    return boxes.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  }

  async viewportCenter(): Promise<{ x: number; y: number }> {
    const v = await this.viewport();
    return { x: v.x + v.width / 2, y: v.y + v.height / 2 };
  }

  /** Click a point in the viewport, as an offset in px from its centre. */
  async clickViewport(dx = 0, dy = 0, modifiers: ('Shift' | 'Control' | 'Alt')[] = []): Promise<void> {
    const c = await this.viewportCenter();
    for (const m of modifiers) await this.page.keyboard.down(m);
    await this.page.mouse.click(c.x + dx, c.y + dy);
    for (const m of modifiers) await this.page.keyboard.up(m);
    await this.page.waitForTimeout(400);
  }

  /** A real press-move-release drag in viewport-centre-relative px. */
  async dragViewport(from: { dx: number; dy: number }, to: { dx: number; dy: number }, steps = 12): Promise<void> {
    const c = await this.viewportCenter();
    await this.page.mouse.move(c.x + from.dx, c.y + from.dy);
    await this.page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await this.page.mouse.move(c.x + from.dx + ((to.dx - from.dx) * i) / steps, c.y + from.dy + ((to.dy - from.dy) * i) / steps);
      await this.page.waitForTimeout(25);
    }
    await this.page.mouse.up();
  }

  /** Name of the selected node's call in the parameter panel, or null when nothing is selected. */
  async selectedCall(): Promise<string | null> {
    if (!(await this.button('Mirror X').isVisible())) return null;
    return this.page.evaluate(() => {
      const label = [...document.querySelectorAll('span')].find((s) => /^[a-z_]+:$/.test(s.textContent ?? '') && (s as HTMLElement).style.opacity === '0.7');
      return label ? label.textContent!.slice(0, -1) : '';
    });
  }

  /** The toolbar's Position X/Y/Z fields for the selected node. */
  positionInputs() {
    return this.page.locator('input[type=number]');
  }

  /** Click on a line of the editor (1-based), which selects the node there. */
  async clickEditorLine(line: number): Promise<void> {
    await this.page.locator('.monaco-editor .view-line').nth(line - 1).click({ position: { x: 4, y: 5 } });
    await this.page.waitForTimeout(200);
  }

  /** Put the caret at the very end of the editor and type with real key presses. */
  async typeAtEnd(text: string): Promise<void> {
    await this.page.locator('.monaco-editor .view-lines').click();
    await this.page.keyboard.press('Control+End');
    await this.page.keyboard.type(text, { delay: 5 });
  }

  /** Make Electron's native open/save dialogs return `filePath` without showing UI. */
  async stubDialogs(paths: { open?: string; save?: string }): Promise<void> {
    await this.app.evaluate(({ dialog }, p) => {
      if (p.open) {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p.open!] })) as typeof dialog.showOpenDialog;
        dialog.showOpenDialogSync = (() => [p.open!]) as typeof dialog.showOpenDialogSync;
      }
      if (p.save) {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p.save })) as typeof dialog.showSaveDialog;
        dialog.showSaveDialogSync = (() => p.save) as typeof dialog.showSaveDialogSync;
      }
    }, paths);
  }

  /**
   * Centroid (viewport-centre-relative px) of the pixels in the viewport that
   * are a pure gizmo axis colour: TransformControls draws X red, Y green,
   * Z blue. Used to find a gizmo handle without hard-coding screen positions.
   */
  async axisHandle(axis: 'x' | 'y' | 'z'): Promise<{ dx: number; dy: number; count: number }> {
    const v = await this.viewport();
    const img = decodePng(await this.page.screenshot({ clip: v }));
    const ch = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        const others = [0, 1, 2].filter((k) => k !== ch).map((k) => img.data[i + k]);
        if (img.data[i + ch] > 180 && others.every((o) => o < 70)) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    // Screenshot pixels may be scaled relative to CSS px.
    const kx = v.width / img.width;
    const ky = v.height / img.height;
    return n === 0 ? { dx: NaN, dy: NaN, count: 0 } : { dx: (sx / n) * kx - v.width / 2, dy: (sy / n) * ky - v.height / 2, count: n };
  }

  /** PNG of the viewport only, for before/after comparisons. */
  async viewportShot(): Promise<Buffer> {
    return this.page.screenshot({ clip: await this.viewport() });
  }
}

export const test = base.extend<{ scad: ScadApp; tmpDir: string }>({
  scad: async ({}, use, testInfo) => {
    const app = await electron.launch({
      args: [join(DESKTOP_DIR, 'out/main/index.js'), ...LAUNCH_ARGS],
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        // A fresh settings folder per launch, and a known set of
        // "installed" fonts (M15).
        SCADSTUDIO_USER_DATA: mkdtempSync(join(tmpdir(), 'scadstudio-userdata-')),
        SCADSTUDIO_SYSTEM_FONT_DIRS: process.env['SCADSTUDIO_SYSTEM_FONT_DIRS'] ?? FONT_FIXTURES_DIR,
      },
    });
    const page = await app.firstWindow();
    const scad = new ScadApp(app, page);
    await expect.poll(() => scad.status(), { timeout: 90_000 }).toMatch(/^Rendered/);
    await use(scad);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' }).catch(() => {});
      await testInfo.attach('console', { body: scad.consoleLines.join('\n'), contentType: 'text/plain' });
    }
    // Force-quit: once the document is edited, a normal close may stop at
    // an "unsaved changes?" prompt and never finish.
    await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
    await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  },
  tmpDir: async ({}, use) => {
    await use(mkdtempSync(join(tmpdir(), 'scadstudio-e2e-')));
  },
});

export { expect };

/** `[audit H3] title`, matching the Vitest suites' naming. */
export function audit(id: string, title: string): string {
  return `[audit ${id}] ${title}`;
}
