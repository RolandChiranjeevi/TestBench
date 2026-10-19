import { XMLParser } from "fast-xml-parser";

export type Framework = "playwright" | "testcafe" | "selenium" | "junit";
export type TestStatus = "passed" | "failed" | "skipped";

export interface ParsedTest {
  file: string;
  suitePath: string;
  title: string;
  fullName: string;
  status: TestStatus;
  flaky: boolean;
  durationMs: number | null;
  error: string;
  tags: string[];
}

export interface ParsedReport {
  framework: Framework;
  format: "junit" | "playwright-json";
  startedAt: string | null;
  tests: ParsedTest[];
}

const ANSI = /\u001b\[[0-9;]*m/g;
const clean = (s: unknown) => (typeof s === "string" ? s.replace(ANSI, "").trim() : "");
const arr = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Case IDs referenced in a title or tag list, e.g. "@TC-42 login works" -> ["TC-42"]. */
export function extractCaseRefs(...sources: string[]): string[] {
  const refs = new Set<string>();
  for (const s of sources) {
    for (const m of s.matchAll(/(?:^|[\s\[(])@?([A-Za-z][A-Za-z0-9]*-\d+)(?=$|[\s\]),])/g)) {
      refs.add(m[1].toUpperCase());
    }
  }
  return [...refs];
}

export function parseReport(content: string, frameworkHint?: Framework): ParsedReport {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("{")) return parsePlaywrightJson(JSON.parse(trimmed));
  if (trimmed.startsWith("<")) return parseJUnit(trimmed, frameworkHint);
  throw new Error("Unrecognised report: expected JUnit XML or Playwright JSON");
}

export function isPlaywrightJson(v: unknown): boolean {
  return !!v && typeof v === "object" && "suites" in v && "config" in v;
}

// ---------- Playwright JSON reporter ----------

interface PwResult { status: string; duration: number; retry: number; error?: { message?: string }; errors?: { message?: string }[] }
interface PwTest { projectName?: string; status: string; results: PwResult[] }
interface PwSpec { title: string; file: string; tags?: string[]; tests: PwTest[] }
interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }

function parsePlaywrightJson(json: { suites?: PwSuite[]; stats?: { startTime?: string } }): ParsedReport {
  if (!isPlaywrightJson(json)) throw new Error("JSON file is not a Playwright JSON report");
  const tests: ParsedTest[] = [];

  const walk = (suite: PwSuite, path: string[], file: string) => {
    const f = suite.file ?? file;
    // The top-level suite title is the file name; don't repeat it in the path.
    const nextPath = suite.title && suite.title !== f ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        const failing = [...t.results].reverse().find((r) => r.status !== "passed" && r.status !== "skipped");
        const status: TestStatus =
          t.status === "skipped" ? "skipped" : t.status === "expected" || t.status === "flaky" ? "passed" : "failed";
        const project = t.projectName ? ` [${t.projectName}]` : "";
        const suitePath = nextPath.join(" › ");
        const total = t.results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
        tests.push({
          file: spec.file ?? f,
          suitePath,
          title: spec.title + project,
          fullName: [spec.file ?? f, suitePath, spec.title].filter(Boolean).join(" › ") + project,
          status,
          flaky: t.status === "flaky",
          durationMs: t.results.length ? total : null,
          error: status === "failed" ? clean(failing?.error?.message ?? failing?.errors?.[0]?.message) : "",
          tags: spec.tags ?? [],
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, nextPath, f);
  };
  for (const s of json.suites ?? []) walk(s, [], s.file ?? s.title);

  return { framework: "playwright", format: "playwright-json", startedAt: json.stats?.startTime ?? null, tests };
}

// ---------- JUnit / xUnit XML (Playwright junit, TestCafe xunit, Selenium via pytest/Surefire/TestNG) ----------

type XmlNode = Record<string, any>;

function parseJUnit(xml: string, frameworkHint?: Framework): ParsedReport {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    textNodeName: "#text",
    isArray: (name) => ["testsuite", "testcase", "failure", "error"].includes(name),
  });
  const doc = parser.parse(xml) as XmlNode;
  const root = doc.testsuites ?? doc;
  const suites: XmlNode[] = [];
  const collect = (node: XmlNode) => {
    for (const s of arr<XmlNode>(node.testsuite)) {
      suites.push(s);
      collect(s);
    }
  };
  collect(root);
  if (!suites.length) throw new Error("No <testsuite> elements found in XML");

  const framework = frameworkHint ?? guessFramework(suites);
  const tests: ParsedTest[] = [];
  let startedAt: string | null = root.timestamp ?? null;

  for (const suite of suites) {
    startedAt ??= suite.timestamp ?? null;
    for (const tc of arr<XmlNode>(suite.testcase)) {
      const name = String(tc.name ?? "");
      const classname = String(tc.classname ?? "");
      const failure = arr<XmlNode | string>(tc.failure)[0] ?? arr<XmlNode | string>(tc.error)[0];
      const status: TestStatus = failure !== undefined ? "failed" : tc.skipped !== undefined ? "skipped" : "passed";
      const error =
        failure === undefined
          ? ""
          : typeof failure === "string"
            ? clean(failure)
            : clean([failure.message, failure["#text"]].filter(Boolean).join("\n\n"));

      // Playwright junit: name = "describe › title", classname = file
      const parts = name.split(" › ");
      const title = parts.at(-1) ?? name;
      const suitePath = parts.length > 1 ? parts.slice(0, -1).join(" › ") : classname || String(suite.name ?? "");
      const time = Number.parseFloat(tc.time);
      tests.push({
        file: String(tc.file ?? (framework === "playwright" ? classname : "")),
        suitePath,
        title,
        fullName: [classname || suite.name, name].filter(Boolean).join(" › "),
        status,
        flaky: false,
        durationMs: Number.isFinite(time) ? Math.round(time * 1000) : null,
        error,
        tags: [],
      });
    }
  }
  return { framework, format: "junit", startedAt, tests };
}

function guessFramework(suites: XmlNode[]): Framework {
  if (suites.some((s) => /testcafe/i.test(String(s.name ?? "")))) return "testcafe";
  const cases = suites.flatMap((s) => arr<XmlNode>(s.testcase));
  if (cases.some((c) => String(c.name ?? "").includes(" › "))) return "playwright";
  if (cases.some((c) => /selenium|webdriver/i.test(String(c.classname ?? "")))) return "selenium";
  return "junit";
}
