import { openStore, closeStore } from "../src/store";
import { tryAcquireMemoryLease } from "../src/memory/ledger";

const [ref, bytesText] = process.argv.slice(2);
const store = openStore();
try {
  const result = tryAcquireMemoryLease(store, {
    id: `worker-${ref}`,
    kind: "gate",
    ref: ref!,
    bytes: Number(bytesText),
  });
  process.stdout.write(`${JSON.stringify({ acquired: result.acquired, free_bytes: result.freeBytes })}\n`);
} finally {
  closeStore(store);
}
