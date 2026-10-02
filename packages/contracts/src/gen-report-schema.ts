import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executorReportJsonSchema } from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../generated/report.schema.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(executorReportJsonSchema(), null, 2)}\n`, "utf8");
