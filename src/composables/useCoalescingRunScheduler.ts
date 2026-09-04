export interface CoalescingRunScheduler {
  schedule(): void;
  isRunning(): boolean;
}

export interface CoalescingRunSchedulerOptions {
  delayMs?: number;
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
}

export function createCoalescingRunScheduler(
  runOnce: () => void | Promise<void>,
  { delayMs = 200, setTimer = setTimeout }: CoalescingRunSchedulerOptions = {}
): CoalescingRunScheduler {
  let running = false;
  let scheduled = false;
  let rerunRequested = false;

  function armTimer(): void {
    if (scheduled) return;
    scheduled = true;
    setTimer(runNow, delayMs);
  }

  async function runNow(): Promise<void> {
    scheduled = false;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        armTimer();
      }
    }
  }

  return {
    schedule() {
      if (running) {
        rerunRequested = true;
        return;
      }
      armTimer();
    },
    isRunning: () => running,
  };
}
