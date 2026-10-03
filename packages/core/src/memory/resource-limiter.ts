/** A per-run operating-system memory boundary, when the platform supports one. */
export interface ResourceLimitSession {
  /** Return the run's final commit peak, or null when the platform cannot report it. */
  peakMemoryBytes(): number | null;
  /** Non-blocking check for the job memory-limit completion-port notification. */
  pollMemoryLimit(): boolean;
  /** Drain all currently queued job completion-port message identifiers. */
  pollMessages(): number[];
  dispose(): void;
}

export interface ResourceLimiter {
  create(memoryLimitBytes: number): ResourceLimitSession;
}
