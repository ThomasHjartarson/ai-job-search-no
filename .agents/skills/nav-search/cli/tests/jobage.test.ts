import { describe, expect, test } from "bun:test"
import { cutoffDate, publishedParam } from "../src/commands/search.js"

/**
 * Regression cover for the `--jobage` 500. NAV's `published` filter is an enum
 * (`now/d`, `now-3d`, `now-7d`); sending `now-14d` or `now-30d` made
 * arbeidsplassen answer HTTP 500, which surfaced as a bare "request failed"
 * that read like an outage. `--jobage 14` is the value the job-scraper's own
 * date filter specifies, so the documented recipe failed every time.
 */
describe("publishedParam", () => {
  test("only ever emits values NAV's UI actually offers", () => {
    const allowed = new Set(["now-3d", "now-7d"])
    for (let days = 1; days <= 400; days++) {
      const value = publishedParam(days)
      if (value !== null) expect(allowed.has(value)).toBe(true)
    }
  })

  test("never emits the arbitrary now-Nd values that 500", () => {
    for (const days of [1, 2, 14, 21, 30, 60, 90]) {
      expect(publishedParam(days)).not.toBe(`now-${days}d`)
    }
  })

  test("snaps to the tightest bucket that still contains the window", () => {
    expect(publishedParam(1)).toBe("now-3d")
    expect(publishedParam(3)).toBe("now-3d")
    expect(publishedParam(4)).toBe("now-7d")
    expect(publishedParam(7)).toBe("now-7d")
  })

  test("drops the param entirely beyond 7 days, since NAV cannot express it", () => {
    expect(publishedParam(8)).toBeNull()
    expect(publishedParam(14)).toBeNull()
    expect(publishedParam(30)).toBeNull()
  })

  test("treats the unbounded sentinel and nonsense input as no filter", () => {
    expect(publishedParam(9999)).toBeNull()
    expect(publishedParam(0)).toBeNull()
    expect(publishedParam(-5)).toBeNull()
    expect(publishedParam(Number.NaN)).toBeNull()
  })

  test("never narrows below what the caller asked for", () => {
    // A bucket that covers fewer days than requested would silently hide ads.
    const covers: Record<string, number> = { "now-3d": 3, "now-7d": 7 }
    for (let days = 1; days <= 7; days++) {
      const value = publishedParam(days)
      if (value) expect(covers[value]).toBeGreaterThanOrEqual(days)
    }
  })
})

describe("cutoffDate", () => {
  const now = new Date("2026-07-19T12:00:00Z")

  test("computes an inclusive ISO cutoff N days back", () => {
    expect(cutoffDate(1, now)).toBe("2026-07-18")
    expect(cutoffDate(7, now)).toBe("2026-07-12")
    expect(cutoffDate(30, now)).toBe("2026-06-19")
  })

  test("crosses month and year boundaries correctly", () => {
    expect(cutoffDate(30, new Date("2026-01-15T00:00:00Z"))).toBe("2025-12-16")
  })

  test("returns null when there is no window to enforce", () => {
    expect(cutoffDate(9999, now)).toBeNull()
    expect(cutoffDate(0, now)).toBeNull()
    expect(cutoffDate(Number.NaN, now)).toBeNull()
  })

  test("stays exact where the server bucket is wider than the request", () => {
    // jobage=1 is served by now-3d, so the client cutoff is what makes it 1 day.
    expect(publishedParam(1)).toBe("now-3d")
    expect(cutoffDate(1, now)).toBe("2026-07-18")
  })
})
