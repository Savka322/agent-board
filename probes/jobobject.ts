import { dlopen, FFIType, ptr } from "bun:ffi";
import { bunCommand, report, runCaptured } from "./common.ts";

const scriptPath = import.meta.path;
const memoryLimit = 256n * 1024n * 1024n;
const megabyte = 1024n * 1024n;
const JOB_OBJECT_ALL_ACCESS = 0x1f001f;
const JobObjectExtendedLimitInformation = 9;
const JobObjectAssociateCompletionPortInformation = 7;
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
const JOB_OBJECT_MSG_JOB_MEMORY_LIMIT = 10;

function u64(value: unknown): bigint {
  if (typeof value === "bigint") return BigInt.asUintN(64, value);
  if (typeof value === "number") return BigInt.asUintN(64, BigInt(value));
  if (value === null || value === undefined) return 0n;
  return BigInt.asUintN(64, BigInt(String(value)));
}

function asHandle(value: unknown): bigint {
  return u64(value);
}

function wideString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf16le");
}

function winErrorCode(kernel: Record<string, (...args: never[]) => unknown>): number {
  try {
    return Number(kernel.GetLastError!());
  } catch {
    return -1;
  }
}

function createKernel() {
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenJobObjectW: { args: [FFIType.u32, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    QueryInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
    CreateIoCompletionPort: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
    GetQueuedCompletionStatus: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  return { library, kernel: library.symbols as unknown as Record<string, (...args: never[]) => unknown> };
}

function createLimitedJob(kernel: Record<string, (...args: never[]) => unknown>, name: string): bigint {
  const nameBuffer = wideString(name);
  const job = asHandle(kernel.CreateJobObjectW!(0n, ptr(nameBuffer)));
  if (job === 0n) throw new Error(`CreateJobObjectW failed with Win32 error ${winErrorCode(kernel)}`);

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION x64 layout, 144 bytes total:
  // JOBOBJECT_BASIC_LIMIT_INFORMATION occupies bytes 0..63:
  // PerProcessUserTimeLimit offset 0 size 8; PerJobUserTimeLimit offset 8 size 8;
  // LimitFlags offset 16 size 4; padding offset 20 size 4;
  // MinimumWorkingSetSize offset 24 size 8; MaximumWorkingSetSize offset 32 size 8;
  // ActiveProcessLimit offset 40 size 4; padding offset 44 size 4;
  // Affinity offset 48 size 8; PriorityClass offset 56 size 4; SchedulingClass offset 60 size 4.
  // IO_COUNTERS occupies bytes 64..111: ReadOperationCount offset 64 size 8;
  // WriteOperationCount offset 72 size 8; OtherOperationCount offset 80 size 8;
  // ReadTransferCount offset 88 size 8; WriteTransferCount offset 96 size 8;
  // OtherTransferCount offset 104 size 8.
  // ProcessMemoryLimit offset 112 size 8; JobMemoryLimit offset 120 size 8;
  // PeakProcessMemoryUsed offset 128 size 8; PeakJobMemoryUsed offset 136 size 8.
  const information = new Uint8Array(144);
  const view = new DataView(information.buffer);
  view.setUint32(16, JOB_OBJECT_LIMIT_JOB_MEMORY, true);
  view.setBigUint64(120, memoryLimit, true);
  const configured = Number(kernel.SetInformationJobObject!(job, JobObjectExtendedLimitInformation, ptr(information), information.byteLength));
  if (configured === 0) {
    const error = winErrorCode(kernel);
    kernel.CloseHandle!(job);
    throw new Error(`SetInformationJobObject failed with Win32 error ${error}`);
  }
  return job;
}

async function allocatorMode(): Promise<void> {
  const allocations: Uint8Array[] = [];
  for (let step = 1; step <= 32; step += 1) {
    try {
      const block = new Uint8Array(32 * 1024 * 1024);
      for (let offset = 0; offset < block.byteLength; offset += 4096) block[offset] = 1;
      allocations.push(block);
      process.stdout.write(`allocated_mb=${step * 32}\n`);
      await Bun.sleep(10);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 2;
      return;
    }
  }
  process.stdout.write("allocation_completed=1024\n");
}

async function launcherMode(jobName: string): Promise<void> {
  const { library, kernel } = createKernel();
  let outerJob = 0n;
  let nestedJob = 0n;
  try {
    const jobNameBuffer = wideString(jobName);
    outerJob = asHandle(kernel.OpenJobObjectW!(JOB_OBJECT_ALL_ACCESS, 0, ptr(jobNameBuffer)));
    if (outerJob === 0n) {
      console.log(JSON.stringify({ outerAssignment: false, openError: winErrorCode(kernel) }));
      return;
    }
    const currentProcess = asHandle(kernel.GetCurrentProcess!());
    const outerAssignment = Number(kernel.AssignProcessToJobObject!(outerJob, currentProcess)) !== 0;
    const outerError = outerAssignment ? 0 : winErrorCode(kernel);
    if (!outerAssignment) {
      console.log(JSON.stringify({ outerAssignment, outerError }));
      return;
    }

    const nestedName = `Local\\agent-board-probe-nested-${crypto.randomUUID()}`;
    const nestedNameBuffer = wideString(nestedName);
    nestedJob = asHandle(kernel.CreateJobObjectW!(0n, ptr(nestedNameBuffer)));
    const nestedAssignment = nestedJob !== 0n && Number(kernel.AssignProcessToJobObject!(nestedJob, currentProcess)) !== 0;
    const nestedError = nestedAssignment ? 0 : winErrorCode(kernel);
    const allocator = Bun.spawn(bunCommand(scriptPath, "__allocator"), {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    } as Bun.SpawnOptions);
    const [stdout, stderr, allocationExitCode] = await Promise.all([
      new Response(allocator.stdout).text(),
      new Response(allocator.stderr).text(),
      allocator.exited,
    ]);
    console.log(JSON.stringify({
      outerAssignment,
      outerError,
      nestedAssignment,
      nestedError,
      allocationExitCode,
      allocationStdout: stdout,
      allocationStderr: stderr,
    }));
  } catch (error) {
    console.log(JSON.stringify({ launcherError: error instanceof Error ? error.message : String(error) }));
  } finally {
    if (nestedJob !== 0n) kernel.CloseHandle!(nestedJob);
    if (outerJob !== 0n) kernel.CloseHandle!(outerJob);
    library.close();
  }
}

function queryPeakMemory(kernel: Record<string, (...args: never[]) => unknown>, job: bigint): bigint | null {
  // PeakJobMemoryUsed is the final SIZE_T in the 144-byte x64 extended structure, at offset 136.
  const information = new Uint8Array(144);
  const returned = new Uint32Array(1);
  const success = Number(kernel.QueryInformationJobObject!(job, JobObjectExtendedLimitInformation, ptr(information), information.byteLength, ptr(returned)));
  return success === 0 ? null : new DataView(information.buffer).getBigUint64(136, true);
}

async function inspectNotifications(
  kernel: Record<string, (...args: never[]) => unknown>,
  port: bigint,
): Promise<number[]> {
  const messages: number[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bytes = new Uint32Array(1);
    const key = new BigUint64Array(1);
    const overlapped = new BigUint64Array(1);
    const succeeded = Number(kernel.GetQueuedCompletionStatus!(port, ptr(bytes), ptr(key), ptr(overlapped), 250));
    if (succeeded !== 0) messages.push(bytes[0]!);
  }
  return messages;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "__allocator") {
    await allocatorMode();
    return;
  }
  if (args[0] === "__launcher") {
    await launcherMode(args[1]!);
    return;
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    report("jobobject", false, { error: "This probe requires Windows x64" });
    return;
  }

  let library: ReturnType<typeof dlopen> | undefined;
  let job = 0n;
  let port = 0n;
  try {
    const opened = createKernel();
    library = opened.library;
    const kernel = opened.kernel;
    const jobName = `Local\\agent-board-probe-${crypto.randomUUID()}`;
    job = createLimitedJob(kernel, jobName);

    const invalidHandle = BigInt.asUintN(64, -1n);
    port = asHandle(kernel.CreateIoCompletionPort!(invalidHandle, 0n, 0n, 1));
    let notificationSetup = port !== 0n;
    let notificationReason: string | undefined;
    if (notificationSetup) {
      // JOBOBJECT_ASSOCIATE_COMPLETION_PORT x64 layout is 16 bytes:
      // CompletionKey offset 0 size 8; CompletionPort offset 8 size 8.
      const association = new Uint8Array(16);
      const associationView = new DataView(association.buffer);
      associationView.setBigUint64(0, 1n, true);
      associationView.setBigUint64(8, port, true);
      const associated = Number(kernel.SetInformationJobObject!(job, JobObjectAssociateCompletionPortInformation, ptr(association), association.byteLength)) !== 0;
      if (!associated) notificationReason = `SetInformationJobObject association failed with Win32 error ${winErrorCode(kernel)}`;
      notificationSetup = associated;
    } else {
      notificationReason = `CreateIoCompletionPort failed with Win32 error ${winErrorCode(kernel)}`;
    }

    const launcher = await runCaptured(bunCommand(scriptPath, "__launcher", jobName), 35000);
    let launcherResult: Record<string, unknown> = {};
    try {
      launcherResult = JSON.parse(launcher.stdout.trim()) as Record<string, unknown>;
    } catch {
      launcherResult = { output: launcher.stdout.trim() };
    }
    const peak = queryPeakMemory(kernel, job);
    const notificationIds = notificationSetup ? await inspectNotifications(kernel, port) : [];
    const allocationExitCode = Number(launcherResult.allocationExitCode ?? launcher.code);
    const allocatedMegabytes = [...String(launcherResult.allocationStdout ?? "").matchAll(/allocated_mb=(\d+)/g)].map((match) => Number(match[1]));
    const highestProgressMb = Math.max(0, ...allocatedMegabytes);
    const allocatorFailedBeforeOneGb = launcherResult.allocationExitCode !== undefined && allocationExitCode !== 0 && highestProgressMb < 1024;
    const assignmentsSucceeded = launcherResult.outerAssignment === true && launcherResult.nestedAssignment === true;
    const peakWithinSingleAllocatorStep = peak !== null && peak <= memoryLimit + 32n * megabyte;
    const peakReachedLimitRange = peak !== null && peak >= memoryLimit - 32n * megabyte;
    const outerLimitApplied = peakWithinSingleAllocatorStep && peakReachedLimitRange && allocatorFailedBeforeOneGb;
    const notificationObserved = notificationIds.includes(JOB_OBJECT_MSG_JOB_MEMORY_LIMIT);
    report("jobobject", assignmentsSucceeded && outerLimitApplied && notificationObserved, {
      jobName,
      jobMemoryLimitBytes: Number(memoryLimit),
      launcherExitCode: launcher.code,
      launcherTimedOut: launcher.timedOut,
      launcherStderr: launcher.stderr,
      launcher: launcherResult,
      allocatorExitCode: allocationExitCode,
      allocatorStderr: String(launcherResult.allocationStderr ?? ""),
      highestAllocatorProgressMb: highestProgressMb,
      allocatorFailedBeforeOneGb,
      peakJobMemoryUsedBytes: peak === null ? null : Number(peak),
      peakExceededLimitBytes: peak === null ? null : Number(peak - memoryLimit),
      peakWithinSingleAllocatorStep,
      outerLimitApplied,
      nestedAssignmentSucceeded: launcherResult.nestedAssignment === true,
      completionPortMessages: notificationIds,
      notification: notificationObserved ? "received" : "not_received",
      notificationSetup,
      ...(notificationReason ? { notificationReason } : {}),
    });
  } catch (error) {
    report("jobobject", false, { error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (library && job !== 0n) {
      try {
        library.symbols.CloseHandle!(job);
      } catch {
        // Handle cleanup is best effort if initialization failed partway through.
      }
    }
    if (library && port !== 0n) {
      try {
        library.symbols.CloseHandle!(port);
      } catch {
        // Handle cleanup is best effort if initialization failed partway through.
      }
    }
    library?.close();
  }
}

main().catch((error: unknown) => {
  report("jobobject", false, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 0;
});
