// Crash report 2026-11-25: opening gag_trophy1.scad (a detailed, module-heavy
// 3D-print model) took ScadStudio down. OpenSCAD ran synchronously in the
// main process, so the ~75 s, ~1.5 GB render froze every window until the
// OS offered to kill the app. Rendering now runs in its own process; these
// tests hold the app to "a heavy or bad file never takes it down".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, DESKTOP_DIR, type ScadApp } from './fixtures';

const FIXTURE = join(DESKTOP_DIR, 'test/fixtures/gag_trophy1.scad');

async function renderProcessPid(scad: ScadApp): Promise<number | null> {
  return scad.app.evaluate(({ app }) => {
    const m = app.getAppMetrics().find((p) => p.type === 'Utility' && /OpenSCAD/i.test(`${p.serviceName ?? ''} ${p.name ?? ''}`));
    return m ? m.pid : null;
  });
}

test.describe('crash safety (crash report 2026-11-25)', () => {
  test('opening the gag trophy at full detail keeps the app responsive and renders it', async ({ scad }) => {
    // Over a minute on a fast machine; leave room for slow CI runners.
    test.setTimeout(420_000);
    // At full detail: the long render is the point (M18's quick preview
    // would otherwise make it take seconds).
    await scad.setQuickPreview('off');
    await scad.stubDialogs({ open: FIXTURE });
    await scad.button('Open .scad file...').click();
    await expect.poll(() => scad.status()).toBe('Rendering...');
    await expect(scad.page.getByText('gag_trophy1.scad')).toBeVisible();

    // While the engine works, the window answers right away: script round
    // trips, real clicks and real typing. Before the fix all of these hung
    // until the render finished.
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      expect(await scad.status()).toBe('Rendering...');
      expect(Date.now() - t0).toBeLessThan(2000);
      await scad.page.waitForTimeout(500);
    }
    const t0 = Date.now();
    await scad.page.getByPlaceholder(/Filter \d+ modules/).click({ timeout: 5000 });
    await scad.page.keyboard.type('pillow');
    await expect(scad.button('pillow')).toBeVisible({ timeout: 5000 });
    await expect(scad.button('rrect')).toBeHidden({ timeout: 5000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    // ...and the main process is not the one holding the engine's memory.
    const mainMb = await scad.app.evaluate(({ app }) => app.getAppMetrics().find((m) => m.type === 'Browser')!.memory.workingSetSize / 1024);
    expect(mainMb).toBeLessThan(600);

    await expect.poll(() => scad.status(), { timeout: 400_000 }).toBe('Rendered');
    expect(scad.pageErrors).toEqual([]);
    const shot = await scad.viewportShot();
    expect(shot.byteLength).toBeGreaterThan(0);
  });

  test('if the render process dies mid-render, the app says so and the next render works', async ({ scad }) => {
    test.setTimeout(240_000);
    await scad.setQuickPreview('off');
    const heavy = readFileSync(FIXTURE, 'utf8');
    await scad.page.evaluate((s) => (window as unknown as { __testSetSource(v: string): void }).__testSetSource(s), heavy);
    await expect.poll(() => scad.status()).toBe('Rendering...');
    let pid: number | null = null;
    await expect.poll(async () => (pid = await renderProcessPid(scad)), { timeout: 30_000 }).not.toBeNull();
    await scad.page.waitForTimeout(1000);
    process.kill(pid!, 'SIGKILL');

    await expect.poll(() => scad.status(), { timeout: 30_000 }).toMatch(/^Rendered 0\/1 nodes — node 1 .*The OpenSCAD engine stopped unexpectedly/);
    expect(scad.pageErrors).toEqual([]);
    // Not retried as 2D (that would only redo the heavy work): one engine
    // call for the node, not two.
    const stats = await scad.page.evaluate(() => (window as unknown as { __scadstudioRenderStats: { engineCalls: number } }).__scadstudioRenderStats);
    const callsAfterCrash = stats.engineCalls;

    // A fresh engine picks up the next render.
    expect(await scad.load('cube(10);')).toBe('Rendered');
    const after = await scad.page.evaluate(() => (window as unknown as { __scadstudioRenderStats: { engineCalls: number } }).__scadstudioRenderStats);
    expect(after.engineCalls).toBe(callsAfterCrash + 1);
    expect(await renderProcessPid(scad)).not.toBe(pid);
  });

  test('if the window itself crashes, it says so and reloads instead of staying blank', async ({ scad }) => {
    await scad.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __crashDialogs: string[] };
      g.__crashDialogs = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args[args.length - 1] as { message: string; detail?: string };
        g.__crashDialogs.push(`${options.message} ${options.detail ?? ''}`);
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    await scad.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());

    await expect
      .poll(() => scad.app.evaluate(() => (globalThis as unknown as { __crashDialogs: string[] }).__crashDialogs), { timeout: 30_000 })
      .toEqual([expect.stringMatching(/stopped unexpectedly[\s\S]*reload the window/)]);
    // The reloaded window renders its starting document again. (Asked
    // through the main process: Playwright keeps treating a page whose
    // renderer crashed as dead, even after it reloads.)
    await expect
      .poll(
        () =>
          scad.app
            .evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
                `[...document.querySelectorAll('span')].some((s) => s.style.marginLeft === 'auto' && s.textContent === 'Rendered')`,
              ),
            )
            .catch(() => false),
        { timeout: 90_000 },
      )
      .toBe(true);
  });
});
