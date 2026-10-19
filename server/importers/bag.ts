import { unzipSync } from "fflate";
import { parseReport, type ParsedReport } from "./parse.ts";

/** Largest single file we will read out of an upload or artifact. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * A read-only set of files, backed by a zip or by files held in memory.
 * Entry names are only ever used to look files up, never as paths on disk.
 */
export interface FileBag {
  names: string[];
  size(name: string): number;
  read(name: string): Uint8Array | null;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");

/** Lists a zip's entries up front and decompresses single files on demand, so big videos are only read if needed. */
export function bagFromZip(bytes: Uint8Array): FileBag {
  const sizes = new Map<string, number>();
  unzipSync(bytes, {
    filter: (f) => {
      if (!f.name.endsWith("/")) sizes.set(norm(f.name), f.originalSize);
      return false;
    },
  });
  return {
    names: [...sizes.keys()],
    size: (n) => sizes.get(n) ?? 0,
    read: (name) => {
      if ((sizes.get(name) ?? Infinity) > MAX_FILE_BYTES) return null;
      const out = unzipSync(bytes, { filter: (f) => norm(f.name) === name });
      const key = Object.keys(out)[0];
      return key ? out[key] : null;
    },
  };
}

export function bagFromFiles(files: Map<string, Uint8Array>): FileBag {
  const map = new Map([...files].map(([k, v]) => [norm(k), v]));
  return {
    names: [...map.keys()],
    size: (n) => map.get(n)?.length ?? 0,
    read: (n) => ((map.get(n)?.length ?? Infinity) > MAX_FILE_BYTES ? null : (map.get(n) ?? null)),
  };
}

export function mergeBags(bags: FileBag[]): FileBag {
  const owner = new Map<string, FileBag>();
  for (const b of bags) for (const n of b.names) if (!owner.has(n)) owner.set(n, b);
  return { names: [...owner.keys()], size: (n) => owner.get(n)?.size(n) ?? 0, read: (n) => owner.get(n)?.read(n) ?? null };
}

/** Every JUnit XML / Playwright JSON file in the bag that parses as a test report. Other files are skipped. */
export function readReports(bag: FileBag): ParsedReport[] {
  const reports: ParsedReport[] = [];
  for (const name of bag.names) {
    if (!/\.(xml|json)$/i.test(name) || name.includes("node_modules/")) continue;
    const bytes = bag.read(name);
    if (!bytes) continue;
    try {
      const report = parseReport(Buffer.from(bytes).toString("utf8"));
      if (report.tests.length) reports.push(report);
    } catch {
      // Not a test report (package.json, coverage output, ...).
    }
  }
  return reports;
}

/**
 * A Playwright run is often reported twice (JSON and JUnit) into the same artifact. They describe the same tests under
 * different names, so keeping both would double every count. Keep the JSON, which also carries attempts and attachments.
 */
export function dedupeReports(reports: ParsedReport[]): ParsedReport[] {
  return reports.some((r) => r.format === "playwright-json") ? reports.filter((r) => !(r.format === "junit" && r.framework === "playwright")) : reports;
}

/**
 * Playwright records attachment paths from the machine that ran the tests, e.g.
 * /home/runner/work/app/app/test-results/login-fails/test-failed-1.png. In an uploaded artifact the same file is
 * `test-results/login-fails/test-failed-1.png` or `login-fails/test-failed-1.png`, so match on the longest path suffix.
 * A bare file name only matches when it is unique, because every test folder has its own `test-failed-1.png`.
 */
export function resolveEntry(bag: FileBag, originalPath: string): string | null {
  const abs = norm(originalPath);
  const base = abs.slice(abs.lastIndexOf("/") + 1);
  let best: string | null = null;
  let bestSegments = 0;
  let baseMatches = 0;
  for (const name of bag.names) {
    if (name === abs || abs.endsWith("/" + name)) {
      const segments = name.split("/").length;
      if (segments > bestSegments) {
        best = name;
        bestSegments = segments;
      }
    }
    if (name === base || name.endsWith("/" + base)) baseMatches++;
  }
  return best && (bestSegments >= 2 || baseMatches === 1) ? best : null;
}
