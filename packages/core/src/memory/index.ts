import { noopResourceLimiter } from "./noop";
import { win32ResourceLimiter } from "./win32";
import type { ResourceLimiter } from "./resource-limiter";

export * from "./ledger";
export type { ResourceLimiter, ResourceLimitSession } from "./resource-limiter";

export const resourceLimiter: ResourceLimiter = process.platform === "win32"
  ? win32ResourceLimiter
  : noopResourceLimiter;
