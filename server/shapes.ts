import { z } from "zod";

/** Field shapes shared by audit packages (bugs, manual tests) and requirement import. */

export const idText = z.string().min(1).max(120).regex(/^[\w.:\-/]+$/, "use letters, digits and . _ : - /");
export const str = (max: number) => z.string().max(max);

/** A WCAG success criterion number such as 2.4.3 or 1.4.10. */
export const wcagCriterion = z.string().trim().regex(/^[1-4]\.\d{1,2}\.\d{1,2}$/, "not a WCAG success criterion such as 2.4.3");

/** A device, a viewport size or a breakpoint a test or requirement applies to. At least one of device, width and breakpoint is named. */
export const viewportSchema = z
  .object({
    device: str(100).optional(),
    width: z.number().int().min(100).max(10000).optional(),
    height: z.number().int().min(100).max(10000).optional(),
    breakpoint: str(50).optional(),
  })
  .refine((v) => !!(v.device?.trim() || v.width || v.breakpoint?.trim()), "name a device, a width or a breakpoint");

export type Viewport = z.infer<typeof viewportSchema>;

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;

/** Same value, same JSON: lists are de-duplicated and viewports get a fixed key order, so equal content hashes equal. */
export const normViewports = (v: Viewport[]): Viewport[] =>
  v.map((x) => ({
    ...(x.device?.trim() ? { device: x.device.trim() } : {}),
    ...(x.width ? { width: x.width } : {}),
    ...(x.height ? { height: x.height } : {}),
    ...(x.breakpoint?.trim() ? { breakpoint: x.breakpoint.trim() } : {}),
  }));
export const normWcag = (w: string[]): string[] => [...new Set(w)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
