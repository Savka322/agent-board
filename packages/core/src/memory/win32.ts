import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ResourceLimiter, ResourceLimitSession } from "./resource-limiter";

const JOB_OBJECT_ALL_ACCESS = 0x1f001f;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;
const JobObjectAssociateCompletionPortInformation = 7;
const JobObjectExtendedLimitInformation = 9;
const INVALID_HANDLE_VALUE = BigInt.asUintN(64, -1n);

type Kernel = Record<string, (...args: unknown[]) => unknown>;

function asHandle(value: unknown): bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  if (typeof value === "number") return BigInt.asUintN(64, BigInt(value));
  return value === null || value === undefined ? 0n : BigInt.asUintN(64, BigInt(String(value)));
}

function winError(kernel: Kernel): number {
  try { return Number(kernel.GetLastError!()); } catch { return -1; }
}

function createKernel(): { library: ReturnType<typeof dlopen>; kernel: Kernel } {
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    CreateIoCompletionPort: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    GetQueuedCompletionStatus: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  return { library, kernel: library.symbols as unknown as Kernel };
}

function createWindowsJob(memoryLimitBytes: number): ResourceLimitSession {
  if (process.arch !== "x64") throw new Error("Windows Job Object memory limits require x64");
  if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
    throw new TypeError("memoryLimitBytes must be a positive safe integer");
  }

  const { library, kernel } = createKernel();
  let job = 0n;
  let port = 0n;
  try {
    job = asHandle(kernel.CreateJobObjectW!(0n, 0n));
    if (job === 0n) throw new Error(`CreateJobObjectW failed with Win32 error ${winError(kernel)}`);

    // Verified x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes. The
    // JobMemoryLimit SIZE_T is at offset 120; PeakJobMemoryUsed is at 136.
    const information = new Uint8Array(144);
    const view = new DataView(information.buffer);
    view.setUint32(16, JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    view.setBigUint64(120, BigInt(memoryLimitBytes), true);
    if (Number(kernel.SetInformationJobObject!(job, JobObjectExtendedLimitInformation, ptr(information), information.byteLength)) === 0) {
      throw new Error(`SetInformationJobObject(limit) failed with Win32 error ${winError(kernel)}`);
    }

    port = asHandle(kernel.CreateIoCompletionPort!(INVALID_HANDLE_VALUE, 0n, 0n, 1));
    if (port === 0n) throw new Error(`CreateIoCompletionPort failed with Win32 error ${winError(kernel)}`);

    // Verified x64 JOBOBJECT_ASSOCIATE_COMPLETION_PORT is 16 bytes:
    // CompletionKey at offset 0, CompletionPort at offset 8.
    const association = new Uint8Array(16);
    const associationView = new DataView(association.buffer);
    associationView.setBigUint64(0, 1n, true);
    associationView.setBigUint64(8, port, true);
    if (Number(kernel.SetInformationJobObject!(job, JobObjectAssociateCompletionPortInformation, ptr(association), association.byteLength)) === 0) {
      throw new Error(`SetInformationJobObject(completion port) failed with Win32 error ${winError(kernel)}`);
    }

    if (Number(kernel.AssignProcessToJobObject!(job, kernel.GetCurrentProcess!())) === 0) {
      throw new Error(`AssignProcessToJobObject failed with Win32 error ${winError(kernel)}`);
    }

    const completionBytes = new Uint32Array(1);
    const completionKey = new BigUint64Array(1);
    const completionOverlapped = new BigUint64Array(1);
    const drainMessages = (): number[] => {
      const messages: number[] = [];
      // The same port carries process create/exit messages. Drain all queued
      // notifications so a burst cannot leave message 10 behind old entries.
      for (let attempt = 0; attempt < 1024; attempt += 1) {
        const succeeded = Number(kernel.GetQueuedCompletionStatus!(port, ptr(completionBytes), ptr(completionKey), ptr(completionOverlapped), 0));
        if (succeeded === 0) return messages;
        messages.push(completionBytes[0]!);
      }
      return messages;
    };
    let disposed = false;
    return {
      peakMemoryBytes() {
        const peakInfo = new Uint8Array(144);
        const returned = new Uint32Array(1);
        const success = Number(kernel.QueryInformationJobObject!(job, JobObjectExtendedLimitInformation, ptr(peakInfo), peakInfo.byteLength, ptr(returned)));
        return success === 0 ? null : Number(new DataView(peakInfo.buffer).getBigUint64(136, true));
      },
      pollMemoryLimit() {
        return drainMessages().includes(JOB_OBJECT_MSG_JOB_MEMORY_LIMIT);
      },
      pollMessages: drainMessages,
      dispose() {
        if (disposed) return;
        disposed = true;
        kernel.CloseHandle!(port);
        kernel.CloseHandle!(job);
        library.close();
      },
    };
  } catch (error) {
    if (port !== 0n) kernel.CloseHandle!(port);
    if (job !== 0n) kernel.CloseHandle!(job);
    library.close();
    throw error;
  }
}

export const win32ResourceLimiter: ResourceLimiter = { create: createWindowsJob };
