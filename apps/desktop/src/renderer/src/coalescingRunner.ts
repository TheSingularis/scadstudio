// At most one `run` in flight; if new work arrives while one is running, only
// the latest value survives — never queue every call. See PLAN.md's render
// latency benchmark for why this matters (a naive per-keystroke render queue
// piles up ~1.2s full-document renders faster than they can complete).
export function createCoalescingRunner<T>(run: (value: T) => Promise<void>): (value: T) => void {
  let running = false;
  let pending: T | undefined;
  let hasPending = false;

  async function pump(): Promise<void> {
    running = true;
    while (hasPending) {
      const value = pending as T;
      hasPending = false;
      pending = undefined;
      await run(value);
    }
    running = false;
  }

  return (value: T) => {
    pending = value;
    hasPending = true;
    if (!running) void pump();
  };
}
