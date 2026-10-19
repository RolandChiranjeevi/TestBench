import { chromium } from "playwright-core";

/**
 * Renders HTML to a PDF with a locally installed Chrome (no browser download).
 * The HTML is loaded from memory and external requests are blocked, so a report can never reach out to the network.
 */
export async function htmlToPdf(html: string, footerLabel: string): Promise<Uint8Array> {
  const browser = await chromium
    .launch({ channel: process.env.TESTBENCH_CHROME_CHANNEL ?? "chrome" })
    .catch((e: Error) => {
      throw new Error(`Couldn't start Chrome for PDF export (${e.message.split("\n")[0]}). Install Google Chrome, or set TESTBENCH_CHROME_CHANNEL=msedge.`);
    });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => {
      const url = route.request().url();
      return url.startsWith("data:") || url === "about:blank" ? route.continue() : route.abort();
    });
    await page.setContent(html, { waitUntil: "load" });
    const label = footerLabel.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font:8px -apple-system,Helvetica,Arial,sans-serif;color:#8a8f98;padding:0 14mm;display:flex;justify-content:space-between"><span>${label}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
  } finally {
    await browser.close();
  }
}
