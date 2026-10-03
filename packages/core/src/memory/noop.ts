import type { ResourceLimiter, ResourceLimitSession } from "./resource-limiter";

const session: ResourceLimitSession = {
  peakMemoryBytes: () => null,
  pollMemoryLimit: () => false,
  pollMessages: () => [],
  dispose: () => {},
};

/** Keeps ledger admission consistent on systems without Windows Job Objects. */
export const noopResourceLimiter: ResourceLimiter = {
  create(memoryLimitBytes) {
    if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
      throw new TypeError("memoryLimitBytes must be a positive safe integer");
    }
    return { ...session };
  },
};
