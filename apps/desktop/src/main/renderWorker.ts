import { renderScadToStl, ScadRenderError, type RenderOptions } from './scadRender';

// The OpenSCAD render process (an Electron utilityProcess started by
// renderHost.ts). OpenSCAD's WASM build runs synchronously, so a render used
// to block Electron's main process, which is also the browser UI thread: a
// heavy model (the gag-trophy crash report, 2026-11-25: about 75 s and
// 1.5 GB) froze every window until the OS offered to kill the app, and an
// engine abort or out-of-memory took the whole app down. Here it can only
// take this process down, which the host notices and replaces.

export interface RenderRequest {
  id: number;
  source: string;
  options: RenderOptions;
}

export type RenderReply =
  | { id: number; ok: true; bytes: Uint8Array; rss: number }
  | { id: number; ok: false; message: string; log: string[]; rss: number };

export async function handleRenderRequest(request: RenderRequest): Promise<RenderReply> {
  try {
    const bytes = await renderScadToStl(request.source, request.options);
    return { id: request.id, ok: true, bytes, rss: process.memoryUsage().rss };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const log = err instanceof ScadRenderError ? err.log : [];
    return { id: request.id, ok: false, message, log, rss: process.memoryUsage().rss };
  }
}

// Wiring, only when started as a utility process (tests import the handler).
interface ParentPort {
  on(event: 'message', listener: (event: { data: RenderRequest }) => void): void;
  postMessage(message: RenderReply): void;
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort) {
  parentPort.on('message', (event) => {
    void handleRenderRequest(event.data).then((reply) => parentPort.postMessage(reply));
  });
}
