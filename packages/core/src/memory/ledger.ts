import { eq } from "drizzle-orm";
import type { BoardStore } from "../store";
import { getSetting } from "../store";
import { memoryLeases } from "../schema";

export const BYTES_PER_GB = 1024 ** 3;
export const BYTES_PER_MB = 1024 ** 2;

export type MemoryLeaseKind = "gate" | "executor";
export interface MemoryLease {
  id: string;
  kind: MemoryLeaseKind;
  ref: string;
  bytes: number;
  pid: number | null;
  createdAt: string;
}

export interface AcquireMemoryLeaseInput {
  id?: string;
  kind: MemoryLeaseKind;
  ref: string;
  bytes: number;
  pid?: number | null;
}

export type MemoryLeaseAcquisition =
  | { acquired: true; lease: MemoryLease; requestedBytes: number; freeBytes: number }
  | { acquired: false; lease: null; requestedBytes: number; freeBytes: number };

export class MemoryLeaseUnavailableError extends Error {
  constructor(readonly requestedBytes: number, readonly freeBytes: number) {
    super(`Memory lease does not fit: requested ${requestedBytes} bytes, ${freeBytes} bytes free`);
    this.name = "MemoryLeaseUnavailableError";
  }
}

export function memoryLimitBytes(store: BoardStore): number {
  return Math.floor(getSetting(store, "memory_limit_gb") * BYTES_PER_GB);
}

export function executorMemoryBytes(store: BoardStore): number {
  return Math.floor(getSetting(store, "executor_memory_gb") * BYTES_PER_GB);
}

export function memoryLeasedBytes(store: BoardStore): number {
  const row = store.sqlite.query("SELECT COALESCE(SUM(bytes), 0) AS total FROM memory_leases").get() as { total: number } | null;
  return Number(row?.total ?? 0);
}

export function freeMemoryBytes(store: BoardStore): number {
  return Math.max(0, memoryLimitBytes(store) - memoryLeasedBytes(store));
}

function validateRequest(input: AcquireMemoryLeaseInput): void {
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new TypeError("lease bytes must be a positive safe integer");
  if (input.pid !== undefined && input.pid !== null && (!Number.isInteger(input.pid) || input.pid <= 0)) {
    throw new TypeError("lease pid must be a positive integer or null");
  }
  if (input.kind !== "gate" && input.kind !== "executor") throw new TypeError("lease kind must be gate or executor");
}

/** Must be called while the caller holds BEGIN IMMEDIATE. */
export function acquireMemoryLeaseInTransaction(store: BoardStore, input: AcquireMemoryLeaseInput): MemoryLeaseAcquisition {
  validateRequest(input);
  const limit = memoryLimitBytes(store);
  const leased = memoryLeasedBytes(store);
  const freeBytes = Math.max(0, limit - leased);
  if (input.bytes > freeBytes) return { acquired: false, lease: null, requestedBytes: input.bytes, freeBytes };
  const values = {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    ref: input.ref,
    bytes: input.bytes,
    pid: input.pid ?? null,
    createdAt: new Date().toISOString(),
  };
  store.db.insert(memoryLeases).values(values).run();
  return { acquired: true, lease: values, requestedBytes: input.bytes, freeBytes };
}

export function tryAcquireMemoryLease(store: BoardStore, input: AcquireMemoryLeaseInput): MemoryLeaseAcquisition {
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = acquireMemoryLeaseInTransaction(store, input);
    store.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

export function acquireMemoryLease(store: BoardStore, input: AcquireMemoryLeaseInput): MemoryLease {
  const result = tryAcquireMemoryLease(store, input);
  if (!result.acquired) throw new MemoryLeaseUnavailableError(result.requestedBytes, result.freeBytes);
  return result.lease;
}

export function releaseMemoryLease(store: BoardStore, id: string): boolean {
  const exists = store.db.select({ id: memoryLeases.id }).from(memoryLeases).where(eq(memoryLeases.id, id)).get() !== undefined;
  if (exists) store.db.delete(memoryLeases).where(eq(memoryLeases.id, id)).run();
  return exists;
}

export function setMemoryLeasePid(store: BoardStore, id: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError("pid must be a positive integer");
  store.db.update(memoryLeases).set({ pid }).where(eq(memoryLeases.id, id)).run();
}

export function listMemoryLeases(store: BoardStore): MemoryLease[] {
  return store.db.select().from(memoryLeases).all() as MemoryLease[];
}

export function getMemoryLease(store: BoardStore, id: string): MemoryLease | null {
  return (store.db.select().from(memoryLeases).where(eq(memoryLeases.id, id)).get() as MemoryLease | undefined) ?? null;
}

export function getMemoryLeaseByRef(store: BoardStore, kind: MemoryLeaseKind, ref: string): MemoryLease | null {
  const row = store.sqlite.query("SELECT id, kind, ref, bytes, pid, created_at AS createdAt FROM memory_leases WHERE kind = ? AND ref = ? LIMIT 1")
    .get(kind, ref) as MemoryLease | null;
  return row;
}

export function cleanupDeadMemoryLeases(store: BoardStore, isAlive: (pid: number) => boolean): MemoryLease[] {
  store.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const dead = listMemoryLeases(store).filter((lease) => lease.pid !== null && !isAlive(lease.pid));
    for (const lease of dead) releaseMemoryLease(store, lease.id);
    store.sqlite.exec("COMMIT");
    return dead;
  } catch (error) {
    try { store.sqlite.exec("ROLLBACK"); } catch { /* Preserve the original error. */ }
    throw error;
  }
}
