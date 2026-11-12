/**
 * What the "Run it yourself" box says about a spec text. TestBench does not run tests: this only reads the text a person is about to run somewhere else.
 *  - `hasFixme`: a `fixme` call is still in the code (`test.fixme(...)`, `test.describe.fixme(...)`). Playwright skips such a test, so it is not runnable yet. A mention in a comment or in a
 *    string does not count.
 *  - `todoLines`: how many lines still say TODO. A test that still has TODO lines may pass without checking anything.
 * Neither says the test is correct: nothing here has looked at what the test does.
 */
export interface SpecRunState { hasFixme: boolean; todoLines: number }

const STRINGS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** The code of a spec: block comments, line comments and the inside of string literals taken out. */
export function codeOf(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(STRINGS, '""').replace(/\/\/.*$/, ""))
    .join("\n");
}

export function specRunState(text: string): SpecRunState {
  return {
    hasFixme: /\bfixme\s*\(/.test(codeOf(text)),
    todoLines: text.split("\n").filter((l) => /\bTODO\b/.test(l)).length,
  };
}

/** The file name as one shell word: left alone when it is plain, otherwise in single quotes. */
export const shellWord = (s: string) => (/^[A-Za-z0-9._\/-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The command that runs this one spec file with Playwright. */
export const runCommand = (file: string) => `npx playwright test ${shellWord(file)}`;

export const todoNotice = (n: number) => (n === 1 ? "1 TODO line is still in the text" : `${n} TODO lines are still in the text`);
