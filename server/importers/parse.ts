import { XMLParser } from "fast-xml-parser";

export type Framework = "playwright" | "testcafe" | "selenium" | "junit";
export type TestStatus = "passed" | "failed" | "skipped";

export interface SourceLocation { file: string; line: number; column: number }

/** One try of a test. Playwright retries produce several attempts per test. */
export interface AttemptDetail {
  retry: number;
  status: string;
  durationMs: number | null;
  startTime: string | null;
  errors: { message: string; location?: SourceLocation }[];
  stdout: string;
  stderr: string;
}

/** Extra Playwright information shown when a test is expanded. */
export interface TestDetail {
  attempts: AttemptDetail[];
  annotations: { type: string; description?: string }[];
  location?: SourceLocation;
  projectName?: string;
}

/** A file Playwright attached to an attempt (screenshot, video, trace...). `path` is where it was on the machine that ran the tests. */
export interface AttachmentRef { attempt: number; name: string; contentType: string; path: string }

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
  detail?: TestDetail;
  attachments?: AttachmentRef[];
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

interface PwError { message?: string; location?: SourceLocation }
interface PwResult {
  status: string; duration: number; retry: number; startTime?: string; error?: PwError; errors?: PwError[];
  stdout?: { text?: string; buffer?: string }[]; stderr?: { text?: string; buffer?: string }[];
  attachments?: { name: string; contentType: string; path?: string }[];
}
interface PwTest { projectName?: string; status: string; results: PwResult[]; annotations?: { type: string; description?: string }[] }
interface PwSpec { title: string; file: string; line?: number; column?: number; tags?: string[]; tests: PwTest[] }
interface PwSuite { title: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] }

const ATTACHMENT_LIMIT_PER_TEST = 20;

function parsePlaywrightJson(json: { suites?: PwSuite[]; stats?: { startTime?: string }; config?: { rootDir?: string } }): ParsedReport {
  if (!isPlaywrightJson(json)) throw new Error("JSON file is not a Playwright JSON report");
  const tests: ParsedTest[] = [];
  // Reports carry absolute paths from the machine that ran the tests; show them relative to the project root.
  const rootDir = (json.config?.rootDir ?? "").replace(/\\/g, "/").replace(/\/$/, "");
  const rel = (p: string) => {
    const n = p.replace(/\\/g, "/");
    return rootDir && n.startsWith(rootDir + "/") ? n.slice(rootDir.length + 1) : n;
  };
  const relLoc = (l?: SourceLocation): SourceLocation | undefined => (l ? { ...l, file: rel(l.file) } : undefined);
  const text = (chunks?: { text?: string }[]) => (chunks ?? []).map((c) => c.text ?? "").join("");

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
          detail: {
            attempts: t.results.map((r) => ({
              retry: r.retry,
              status: r.status,
              durationMs: r.duration ?? null,
              startTime: r.startTime ?? null,
              errors: (r.errors?.length ? r.errors : r.error ? [r.error] : []).map((e) => ({ message: clean(e.message), location: relLoc(e.location) })).filter((e) => e.message),
              stdout: clean(text(r.stdout)),
              stderr: clean(text(r.stderr)),
            })),
            annotations: (t.annotations ?? []).filter((a) => a.type !== "skip").map((a) => ({ type: a.type, description: a.description })),
            location: spec.line ? { file: rel(spec.file ?? f), line: spec.line, column: spec.column ?? 0 } : undefined,
            projectName: t.projectName || undefined,
          },
          attachments: t.results
            .flatMap((r) => (r.attachments ?? []).flatMap((a) => (a.path ? [{ attempt: r.retry, name: a.name, contentType: a.contentType, path: a.path }] : [])))
            .slice(0, ATTACHMENT_LIMIT_PER_TEST),
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
