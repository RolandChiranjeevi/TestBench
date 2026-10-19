import { db, ensureMilestone } from "./db.ts";
import { createRequirement, setRequirementCases } from "./requirements.ts";
import { importReport } from "./importers/import.ts";
import { parseReport } from "./importers/parse.ts";

type Step = [action: string, expected: string];
interface DemoCase { title: string; priority: string; tags: string[]; pre?: string; steps: Step[] }

const SUITES: Record<string, DemoCase[]> = {
  Authentication: [
    {
      title: "Log in with valid credentials",
      priority: "critical",
      tags: ["smoke", "auth"],
      pre: "A registered user exists",
      steps: [
        ["Open /login", "Login form is shown"],
        ["Enter a valid email and password", "Fields accept input, password is masked"],
        ["Click Sign in", "User lands on the dashboard and sees their name"],
      ],
    },
    {
      title: "Show an error for a wrong password",
      priority: "high",
      tags: ["auth"],
      steps: [
        ["Open /login and enter a valid email with a wrong password", "—"],
        ["Click Sign in", "Inline error 'Wrong email or password' appears; no redirect"],
      ],
    },
    {
      title: "Reset password via email link",
      priority: "medium",
      tags: ["auth", "email"],
      steps: [
        ["Click Forgot password and submit the account email", "Confirmation message is shown"],
        ["Open the reset link from the email", "New password form is shown"],
        ["Set a new password and log in with it", "Login succeeds"],
      ],
    },
  ],
  Cart: [
    {
      title: "Add a product to the cart",
      priority: "critical",
      tags: ["smoke", "cart"],
      steps: [
        ["Open any product page", "Price and Add to cart button are visible"],
        ["Click Add to cart", "Cart badge shows 1"],
      ],
    },
    {
      title: "Change quantity in the cart",
      priority: "high",
      tags: ["cart"],
      steps: [
        ["Open the cart with one product", "—"],
        ["Increase quantity to 3", "Line total and cart total update"],
      ],
    },
    {
      title: "Apply a discount code",
      priority: "medium",
      tags: ["cart", "promo"],
      steps: [
        ["Enter code SAVE10 in the cart", "10% discount line appears"],
        ["Enter an expired code", "Error 'Code has expired' is shown"],
      ],
    },
  ],
  Checkout: [
    {
      title: "Complete checkout with card payment",
      priority: "critical",
      tags: ["smoke", "checkout", "payments"],
      pre: "Cart contains at least one product",
      steps: [
        ["Click Checkout and fill in the shipping address", "Shipping options load"],
        ["Pay with test card 4242 4242 4242 4242", "Payment is accepted"],
        ["Wait for the confirmation page", "Order number is shown and a confirmation email is sent"],
      ],
    },
    {
      title: "Validate required address fields",
      priority: "high",
      tags: ["checkout", "validation"],
      steps: [["Submit the address form empty", "Each required field shows an error"]],
    },
    {
      title: "Order confirmation email content",
      priority: "low",
      tags: ["email"],
      steps: [["Place an order and open the confirmation email", "Items, totals and address match the order"]],
    },
  ],
};

export function seedDemo() {
  const existing = db.prepare("SELECT * FROM projects WHERE key = 'SHOP'").get();
  if (existing) return existing;

  const project = db.prepare("INSERT INTO projects (name, key) VALUES ('Demo Shop', 'SHOP') RETURNING *").get() as { id: number };
  const caseIds: number[] = [];
  db.transaction(() => {
    let n = 1;
    Object.entries(SUITES).forEach(([name, cases], si) => {
      const suite = db
        .prepare("INSERT INTO suites (project_id, name, position) VALUES (?, ?, ?) RETURNING id")
        .get(project.id, name, si) as { id: number };
      for (const c of cases) {
        const row = db
          .prepare(`
            INSERT INTO cases (project_id, suite_id, number, title, preconditions, priority, tags, position)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
          .get(project.id, suite.id, n, c.title, c.pre ?? "", c.priority, JSON.stringify(c.tags), n) as { id: number };
        c.steps.forEach(([action, expected], i) =>
          db.prepare("INSERT INTO case_steps (case_id, position, action, expected) VALUES (?, ?, ?, ?)").run(row.id, i, action, expected),
        );
        caseIds.push(row.id);
        n++;
      }
    });
    db.prepare("UPDATE projects SET next_case_number = ? WHERE id = ?").run(n, project.id);
  })();

  // Two nightly Playwright runs (the second has a failure and a flaky test) and one TestCafe run.
  for (const [day, failing] of [[2, false], [1, true]] as const) {
    importReport(parseReport(JSON.stringify(playwrightReport(day, failing))), {
      projectId: project.id,
      source: "upload",
      title: `Nightly e2e · chromium`,
      environment: "staging",
      milestone: failing ? "Sprint 42" : "Sprint 41",
      meta: { files: ["results.json"] },
    });
  }
  importReport(parseReport(testcafeReport()), {
    projectId: project.id,
    source: "upload",
    title: "TestCafe regression",
    environment: "staging",
    milestone: "Sprint 42",
    meta: { files: ["xunit.xml"] },
  });

  // A manual run that is partly done.
  const run = db
    .prepare("INSERT INTO runs (project_id, title, kind, source, environment, milestone) VALUES (?, 'Sprint 42 regression', 'manual', 'manual', 'staging', 'Sprint 42') RETURNING id")
    .get(project.id) as { id: number };
  ensureMilestone(project.id, "Sprint 42");

  // Two reusable selections: smoke-tagged cases, and everything.
  const mkTemplate = db.prepare("INSERT INTO run_templates (project_id, name, environment) VALUES (?, ?, ?) RETURNING id");
  const link = db.prepare("INSERT INTO run_template_cases (template_id, case_id) VALUES (?, ?)");
  const smoke = mkTemplate.get(project.id, "Smoke test", "staging") as { id: number };
  const all = mkTemplate.get(project.id, "Full regression", "staging") as { id: number };
  const smokeIds = (db.prepare("SELECT id, tags FROM cases WHERE project_id = ?").all(project.id) as { id: number; tags: string }[]).filter((c) => (JSON.parse(c.tags) as string[]).includes("smoke"));
  for (const c of smokeIds) link.run(smoke.id, c.id);
  for (const id of caseIds) link.run(all.id, id);
  const statuses = ["passed", "passed", "failed", "passed", "untested", "untested", "blocked", "untested", "untested"];
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  caseIds.forEach((caseId, i) =>
    db
      .prepare("INSERT INTO results (run_id, case_id, status, notes, position, executed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        run.id,
        caseId,
        statuses[i],
        statuses[i] === "failed" ? "Reset email arrived after ~4 minutes; link had already expired." : statuses[i] === "blocked" ? "Payment sandbox down." : "",
        i,
        statuses[i] === "untested" ? null : now,
      ),
  );

  // A few requirements linked to cases by their order above (login 1-2, reset 3, cart 4-5, ...).
  const REQS: { title: string; priority: string; source: string; description: string; cases: number[] }[] = [
    { title: "A customer can log in with email and password", priority: "critical", source: "SHOP-101", description: "Valid credentials sign the customer in; invalid ones show a clear error without revealing which part was wrong.", cases: [0, 1] },
    { title: "A customer can reset a forgotten password by email", priority: "high", source: "SHOP-102", description: "The reset link is valid for 30 minutes and can be used once.", cases: [2] },
    { title: "A customer can manage items in the cart", priority: "high", source: "SHOP-110", description: "Add, change quantity and remove items; totals update immediately.", cases: [3, 4] },
    { title: "Prices are shown including VAT for EU customers", priority: "medium", source: "SHOP-125", description: "", cases: [] },
  ];
  for (const r of REQS) {
    const id = createRequirement(project.id, { title: r.title, priority: r.priority, source: r.source, description: r.description });
    setRequirementCases(id, project.id, r.cases.map((i) => caseIds[i]).filter((x) => x != null));
  }
  return project;
}

function playwrightReport(daysAgo: number, failing: boolean) {
  const start = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const test = (status: string, duration: number, error?: string, retries = 0) => ({
    projectName: "chromium",
    status,
    results: Array.from({ length: retries + 1 }, (_, i) => ({
      retry: i,
      duration: Math.round(duration / (retries + 1)),
      status: i < retries ? "failed" : status === "unexpected" ? "failed" : status === "skipped" ? "skipped" : "passed",
      error: i < retries || status === "unexpected" ? { message: error ?? "Timed out 5000ms waiting for expect(locator).toBeVisible()" } : undefined,
    })),
  });
  const spec = (title: string, file: string, t: ReturnType<typeof test>) => ({ title, file, tags: [], tests: [t] });
  return {
    config: {},
    stats: { startTime: start },
    suites: [
      {
        title: "auth.spec.ts",
        file: "auth.spec.ts",
        suites: [
          {
            title: "Login",
            file: "auth.spec.ts",
            specs: [
              spec("@SHOP-1 logs in with valid credentials", "auth.spec.ts", test("expected", 2100)),
              spec("@SHOP-2 shows error on wrong password", "auth.spec.ts", test("expected", 1400)),
            ],
          },
        ],
      },
      {
        title: "cart.spec.ts",
        file: "cart.spec.ts",
        specs: [
          spec("@SHOP-4 adds product to cart", "cart.spec.ts", test(failing ? "flaky" : "expected", 3200, undefined, failing ? 1 : 0)),
          spec("@SHOP-5 updates quantity", "cart.spec.ts", test("expected", 1800)),
          spec(
            "@SHOP-6 applies discount code",
            "cart.spec.ts",
            test(failing ? "unexpected" : "expected", 2600, "Error: expect(received).toHaveText(expected)\n\nExpected: \"-10%\"\nReceived: \"-0%\""),
          ),
        ],
      },
      {
        title: "checkout.spec.ts",
        file: "checkout.spec.ts",
        specs: [
          spec("@SHOP-7 completes checkout with card", "checkout.spec.ts", test("expected", 6400)),
          spec("guest checkout shows account upsell", "checkout.spec.ts", test("skipped", 0)),
        ],
      },
    ],
  };
}

function testcafeReport() {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<testsuite name="TestCafe Tests: Firefox 131.0 / macOS 15" tests="3" failures="1" skipped="0" errors="1" time="14.2" timestamp="${new Date().toUTCString()}">
  <testcase classname="Checkout" file="tests/checkout.js" name="@SHOP-8 required address fields are validated" time="4.1"></testcase>
  <testcase classname="Checkout" file="tests/checkout.js" name="shipping options load for EU address" time="5.3">
    <failure><![CDATA[AssertionError: expected 0 to be above 0
    Browser: Firefox 131.0 / macOS 15
    at tests/checkout.js:42:31]]></failure>
  </testcase>
  <testcase classname="Header" file="tests/header.js" name="search suggestions appear" time="4.8"></testcase>
</testsuite>`;
}
