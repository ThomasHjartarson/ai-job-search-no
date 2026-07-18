import { afterEach, describe, expect, test } from "bun:test"
import { runSearch, type SearchOpts } from "../src/commands/search.js"
import { runDetail } from "../src/commands/detail.js"
import { navAd, rscPage } from "./helpers.js"

const realFetch = globalThis.fetch
const realWrite = process.stdout.write

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite
})

/** Serve one canned HTML body for every request, recording the URLs asked for. */
function mockHtml(body: string, status = 200): { urls: string[] } {
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    return new Response(body, { status, headers: { "content-type": "text/html" } })
  }) as typeof fetch
  return { urls }
}

/** Capture whatever the command writes to stdout. */
function captureStdout(): { text: () => string } {
  let out = ""
  process.stdout.write = ((chunk: string) => {
    out += chunk
    return true
  }) as typeof process.stdout.write

  return { text: () => out }
}

function searchOpts(overrides: Partial<SearchOpts> = {}): SearchOpts {
  return {
    query: "utvikler",
    jobage: 9999,
    page: 1,
    limit: 25,
    format: "json",
    counties: [],
    municipals: [],
    sources: [],
    ...overrides,
  }
}

describe("runSearch", () => {
  test("emits the portal contract envelope", async () => {
    mockHtml(rscPage(`{"totalAds":213,"ads":[${JSON.stringify(navAd())}]}`))
    const out = captureStdout()

    expect(await runSearch(searchOpts())).toBe(0)

    const parsed = JSON.parse(out.text())
    expect(parsed.meta).toEqual({ count: 1, page: 1, total: 213 })
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].id).toBe(navAd().uuid)
    expect(parsed.results[0].finn_url).toBe("https://www.finn.no/469427096")
  })

  test("builds the query NAV expects", async () => {
    const { urls } = mockHtml(rscPage('{"totalAds":0}'))
    captureStdout()

    await runSearch(searchOpts({ query: "data scientist", jobage: 14, counties: ["Oslo", "vestland fylke"] }))

    const url = new URL(urls[0])
    expect(url.pathname).toBe("/stillinger")
    expect(url.searchParams.get("q")).toBe("data scientist")
    // `published` is an enum NAV's UI limits to now/d, now-3d and now-7d. A
    // 14-day window has no server-side equivalent, so the param is omitted and
    // the cutoff is applied client-side. Sending "now-14d" here made NAV 500.
    // See tests/jobage.test.ts.
    expect(url.searchParams.has("published")).toBe(false)
    // County names are uppercased and the "fylke" suffix dropped for NAV.
    expect(url.searchParams.getAll("county")).toEqual(["OSLO", "VESTLAND"])
  })

  test("sends a supported published bucket for windows NAV can express", async () => {
    const { urls } = mockHtml(rscPage('{"totalAds":0}'))
    captureStdout()

    await runSearch(searchOpts({ jobage: 7 }))

    expect(new URL(urls[0]).searchParams.get("published")).toBe("now-7d")
  })

  test("pages by offset, not by a size param", async () => {
    const { urls } = mockHtml(rscPage('{"totalAds":0}'))
    captureStdout()

    await runSearch(searchOpts({ page: 3 }))

    const url = new URL(urls[0])
    expect(url.searchParams.get("from")).toBe("50")
    expect(url.searchParams.has("size")).toBe(false)
  })

  test("--source keeps only ads from that source", async () => {
    const finn = JSON.stringify(navAd({ uuid: "aaaaaaaa-0000-0000-0000-000000000001", source: "FINN" }))
    const nav = JSON.stringify(navAd({ uuid: "bbbbbbbb-0000-0000-0000-000000000002", source: "IMPORTAPI" }))
    mockHtml(rscPage(`{"totalAds":2,"ads":[${finn},${nav}]}`))
    const out = captureStdout()

    await runSearch(searchOpts({ sources: ["FINN"] }))

    const parsed = JSON.parse(out.text())
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].source).toBe("FINN")
  })

  test("an unreachable NAV reports SEARCH_FAILED rather than throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as typeof fetch
    let err = ""
    const realErr = process.stderr.write
    process.stderr.write = ((c: string) => {
      err += c
      return true
    }) as typeof process.stderr.write

    const code = await runSearch(searchOpts())
    process.stderr.write = realErr

    expect(code).toBe(1)
    expect(JSON.parse(err).code).toBe("SEARCH_FAILED")
  })
})

const AD_ID = "80df5041-7bb3-4ba5-87d4-c814e6770e8f"

/** A detail page: `adData` plus a lazily-streamed ad text chunk. */
function detailPage(overrides: Record<string, unknown> = {}, adText = "<p>Vi søker en utvikler</p>"): string {
  const adData = {
    id: AD_ID,
    status: "ACTIVE",
    title: "Devops-utvikler",
    source: "FINN",
    reference: "469427096",
    published: "2026-07-14T08:12:27.9+02:00",
    adTextHtml: "$2c",
    employer: { orgnr: "974004313", name: "Instech Solutions", sector: "Privat" },
    application: { applicationDueLabel: "Snarest", applicationUrl: "https://www.finn.no/job-apply/469427096/apply" },
    locationList: [{ city: "BERGEN", county: "VESTLAND", municipal: "BERGEN" }],
    ...overrides,
  }
  return rscPage(`{"adData":${JSON.stringify(adData)}}\n2c:T100,${adText}`)
}

function captureStderr(): { text: () => string; restore: () => void } {
  let err = ""
  const real = process.stderr.write
  process.stderr.write = ((c: string) => {
    err += c
    return true
  }) as typeof process.stderr.write
  return { text: () => err, restore: () => void (process.stderr.write = real) }
}

describe("runDetail", () => {
  test("returns the requested ad with its full text", async () => {
    mockHtml(detailPage())
    const out = captureStdout()

    expect(await runDetail({ id: AD_ID, format: "json" })).toBe(0)

    const job = JSON.parse(out.text())
    expect(job.id).toBe(AD_ID)
    // NAV does carry the posting text for FINN-sourced ads on the detail page,
    // even though the search payload leaves `description` empty.
    expect(job.description).toBe("Vi søker en utvikler")
    expect(job.finn_url).toBe("https://www.finn.no/469427096")
  })

  test("a page with no adData is NOT_FOUND", async () => {
    // NAV answers a missing ad with HTTP 200 and only suggested ads.
    mockHtml(rscPage(`{"suggestions":[${JSON.stringify(navAd())}]}`))
    const err = captureStderr()

    const code = await runDetail({ id: AD_ID, format: "json" })
    err.restore()

    expect(code).toBe(1)
    expect(JSON.parse(err.text()).code).toBe("NOT_FOUND")
  })

  // Regression: a detail page embeds suggested ads too. Returning one of those
  // instead of the requested ad would mean applying to the wrong job.
  test("never returns a different ad than the one requested", async () => {
    mockHtml(detailPage({ id: "99999999-0000-0000-0000-000000000009", title: "En helt annen stilling" }))
    const err = captureStderr()

    const code = await runDetail({ id: AD_ID, format: "json" })
    err.restore()

    expect(code).toBe(1)
    expect(JSON.parse(err.text()).code).toBe("ID_MISMATCH")
    expect(err.text()).not.toContain("En helt annen stilling")
  })

  test("a genuine 404 is NOT_FOUND", async () => {
    mockHtml("", 404)
    const err = captureStderr()

    const code = await runDetail({ id: AD_ID, format: "json" })
    err.restore()

    expect(code).toBe(1)
    expect(JSON.parse(err.text()).code).toBe("NOT_FOUND")
  })

  test("plain output renders the posting and the finn link", async () => {
    mockHtml(detailPage())
    const out = captureStdout()

    await runDetail({ id: AD_ID, format: "plain" })

    expect(out.text()).toContain("Vi søker en utvikler")
    expect(out.text()).toContain("https://www.finn.no/469427096")
    expect(out.text()).toContain("Søknadsfrist: Snarest")
  })
})
