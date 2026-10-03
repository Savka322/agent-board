import { describe, expect, test } from "bun:test";
import en from "../src/i18n/en.json";
import ru from "../src/i18n/ru.json";

function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("translation resources", () => {
  test("English and Russian have exactly the same keys", () => {
    expect(leafKeys(en).sort()).toEqual(leafKeys(ru).sort());
  });

  test("keeps the requested Russian board labels", () => {
    expect(ru.next).toBe("Next");
    expect(ru.status.next).toBe("Next");
    expect(ru.review).toBe("\u0420\u0435\u0432\u044c\u044e");
    expect(ru.status.review).toBe("\u0420\u0435\u0432\u044c\u044e");
    expect(ru.round).toContain("\u041a\u0440\u0443\u0433");
    expect(ru.roundLabel).toContain("\u041a\u0440\u0443\u0433");
    expect(JSON.stringify(ru)).not.toContain("\u0420\u0430\u0443\u043d\u0434");
  });
});
