// Electron wraps an error thrown by an ipcMain handler as "Error invoking
// remote method 'scad:render': ScadRenderError: <message>"; keep the message.
export function renderErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}

// Start of the message the main process rejects a render with when the
// OpenSCAD render process itself died (src/main/renderHost.ts keeps the
// same text; a unit test holds the two in step).
export const ENGINE_CRASH_PREFIX = 'The OpenSCAD engine stopped';

/** Whether a render failed because the engine process died, not because of the model's own errors. */
export function isEngineCrash(err: unknown): boolean {
  return renderErrorMessage(err).includes(ENGINE_CRASH_PREFIX);
}
