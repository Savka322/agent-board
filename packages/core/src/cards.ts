import { TaskCardSchema, type TaskCard } from "@agent-board/contracts";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Parse a Markdown task card whose TOML front matter is delimited by +++ lines. */
export function parseCardFile(text: string): TaskCard {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "+++") throw new Error("Task card must start with a +++ TOML front matter line");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "+++");
  if (end < 0) throw new Error("Task card is missing its closing +++ front matter line");

  const frontMatter = lines.slice(1, end).join("\n");
  const fields = Bun.TOML.parse(frontMatter) as Record<string, unknown>;
  const goal = lines.slice(end + 1).join("\n");
  return TaskCardSchema.parse({ ...fields, goal });
}

/** Render a canonical, parseable task card without changing its validated content. */
export function renderCardFile(card: TaskCard): string {
  const parsed = TaskCardSchema.parse(card);
  const fields = [
    `id = ${tomlString(parsed.id)}`,
    `title = ${tomlString(parsed.title)}`,
    `epic = ${tomlString(parsed.epic)}`,
    `allowed_files = [${parsed.allowed_files.map(tomlString).join(", ")}]`,
    `deps = [${parsed.deps.map(tomlString).join(", ")}]`,
    `decisions = [${parsed.decisions.map(tomlString).join(", ")}]`,
    `light_tests = [${parsed.light_tests.map(tomlString).join(", ")}]`,
    `gates = [${parsed.gates.map((gate) => {
      const values = [`cmd = ${tomlString(gate.cmd)}`];
      if (gate.ram_est_gb !== undefined) values.push(`ram_est_gb = ${gate.ram_est_gb}`);
      return `{ ${values.join(", ")} }`;
    }).join(", ")}]`,
    `acceptance = [${parsed.acceptance.map(tomlString).join(", ")}]`,
  ];
  if (parsed.notes !== undefined) fields.push(`notes = ${tomlString(parsed.notes)}`);
  return ["+++", ...fields, "+++", parsed.goal].join("\n");
}
