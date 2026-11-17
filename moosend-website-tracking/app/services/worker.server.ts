import { config } from "../config.server";
import { logger } from "../lib/logger.server";
import { processOutbox } from "./outbox.server";
import { purgeExpiredData } from "./retention.server";

/**
 * In-process background worker: delivers the outbox on an interval and applies
 * the retention policy hourly. Multiple app instances are safe because outbox
 * rows are claimed atomically before delivery.
 */

declare global {
  // eslint-disable-next-line no-var
  var __moosendWorker: { timer: NodeJS.Timeout; running: boolean } | undefined;
}

let lastPurge = 0;
let kickPending = false;

async function tick() {
  const state = global.__moosendWorker;
  if (!state || state.running) return;
  state.running = true;
  try {
    // Drain in batches so a backlog doesn't wait for the next interval.
    for (let i = 0; i < 10; i += 1) {
      const stats = await processOutbox({ limit: 100 });
      const handled = stats.delivered + stats.failed + stats.retried + stats.cancelled;
      if (handled === 0) break;
    }
    if (Date.now() - lastPurge > 60 * 60 * 1000) {
      lastPurge = Date.now();
      const purged = await purgeExpiredData();
      logger.info("Retention purge completed", purged);
    }
  } catch (error) {
    logger.error("Background worker tick failed", { error });
  } finally {
    state.running = false;
  }
}

export function startBackgroundWorker() {
  if (process.env.NODE_ENV === "test" || !config.workerEnabled) return;
  if (global.__moosendWorker) return;
  const timer = setInterval(() => void tick(), config.workerIntervalMs);
  timer.unref();
  global.__moosendWorker = { timer, running: false };
  logger.info("Background delivery worker started", { intervalMs: config.workerIntervalMs });
}

/** Requests near-immediate delivery after new events are queued. */
export function kickWorker() {
  if (!global.__moosendWorker || kickPending) return;
  kickPending = true;
  setTimeout(() => {
    kickPending = false;
    void tick();
  }, 250).unref();
}
