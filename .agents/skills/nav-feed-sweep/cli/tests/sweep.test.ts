import { afterEach, describe, expect, test } from "bun:test"
import { runSweep, type SweepOpts } from "../src/commands/sweep.js"
import { cleanHtml, parseDeadline, toDetail, toResult, normalizeId } from "../src/helpers.js"
import { feedItem, feedPage } from "./helpers.js"

const realFetch = globalThis.fetch
const realWrite = process.stdout.write

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite
})

/** Serve the token endpoint plus canned feed pages, recording requests. */
function mockFeed(pages: string[]): { urls: string[]; headers: Record<string, string>[] } {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  let page = 0

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    headers.push((init?.headers as Record<string, string>) ?? {})

    if (url.includes("/api/publicToken")) {
      return new Response("Current public token for Nav Job Vacancy Feed:\neyJhbGciOiJIUzI1NiJ9.test.sig")
    }
    const body = pages[Math.min(page, pages.length - 1)]
    page++
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch

  return { urls, headers }
}

function captureStdout(): { text: () => string } {
  let out = ""
  process.stdout.write = ((chunk: string) => {
    out += chunk
    return true
  }) as typeof process.stdout.write
  return { text: () => out }
}

function opts(overrides: Partial<SweepOpts> = {}): SweepOpts {
  return { since: 1, municipals: [], limit: 50, format: "json", includeInactive: false, ...overrides }
}

describe("runSweep", () => {
  test("emits the contract envelope", async () => {
    mockFeed([feedPage([feedItem()])])
    const out = captureStdout()

    expect(await runSweep(opts())).toBe(0)

    const parsed = JSON.parse(out.text())
    expect(parsed.meta.count).toBe(1)
    expect(parsed.results[0]).toMatchObject({
      id: "80df5041-7bb3-4ba5-87d4-c814e6770e8f",
      title: "Devops-utvikler",
      company: "INSTECH SOLUTIONS AS",
      location: "Bergen",
      status: "ACTIVE",
    })
    // The public ad page is more useful to a human than the API entry path.
    expect(parsed.results[0].url).toContain("arbeidsplassen.nav.no/stillinger/stilling/")
  })

  // The feed reports every ad *state change*. A third of a real page is INACTIVE
  // — reporting those as findable jobs would send someone after filled roles.
  test("drops INACTIVE entries by default", async () => {
    mockFeed([
      feedPage([
        feedItem({}, { uuid: "aaaaaaaa-0000-0000-0000-000000000001", status: "ACTIVE" }),
        feedItem({}, { uuid: "bbbbbbbb-0000-0000-0000-000000000002", status: "INACTIVE" }),
      ]),
    ])
    const out = captureStdout()

    await runSweep(opts())

    const parsed = JSON.parse(out.text())
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].status).toBe("ACTIVE")
  })

  test("--include-inactive keeps them", async () => {
    mockFeed([
      feedPage([
        feedItem({}, { uuid: "aaaaaaaa-0000-0000-0000-000000000001", status: "ACTIVE" }),
        feedItem({}, { uuid: "bbbbbbbb-0000-0000-0000-000000000002", status: "INACTIVE" }),
      ]),
    ])
    const out = captureStdout()

    await runSweep(opts({ includeInactive: true }))

    expect(JSON.parse(out.text()).results).toHaveLength(2)
  })

  test("bounds the walk with If-Modified-Since", async () => {
    const { headers } = mockFeed([feedPage([feedItem()])])
    captureStdout()

    await runSweep(opts({ since: 7 }))

    const feedCall = headers.find((h) => h["If-Modified-Since"])
    expect(feedCall).toBeDefined()
    const sent = new Date(feedCall!["If-Modified-Since"]).getTime()
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(sent - expected)).toBeLessThan(60_000)
  })

  test("filters on query and municipality", async () => {
    mockFeed([
      feedPage([
        feedItem({}, { uuid: "aaaaaaaa-0000-0000-0000-000000000001", title: "Devops-utvikler", municipal: "BERGEN" }),
        feedItem({}, { uuid: "bbbbbbbb-0000-0000-0000-000000000002", title: "Sykepleier", municipal: "BERGEN" }),
        feedItem({}, { uuid: "cccccccc-0000-0000-0000-000000000003", title: "Devops-utvikler", municipal: "OSLO" }),
      ]),
    ])
    const out = captureStdout()

    await runSweep(opts({ query: "utvikler", municipals: ["Bergen"] }))

    const parsed = JSON.parse(out.text())
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].id).toBe("aaaaaaaa-0000-0000-0000-000000000001")
  })

  test("follows next_url and deduplicates across pages", async () => {
    mockFeed([
      feedPage([feedItem({}, { uuid: "aaaaaaaa-0000-0000-0000-000000000001" })], "/api/v1/feed?id=2"),
      feedPage([
        feedItem({}, { uuid: "aaaaaaaa-0000-0000-0000-000000000001" }), // repeat
        feedItem({}, { uuid: "bbbbbbbb-0000-0000-0000-000000000002" }),
      ]),
    ])
    const out = captureStdout()

    await runSweep(opts({ limit: 10 }))

    expect(JSON.parse(out.text()).results).toHaveLength(2)
  })

  test("a rotated/rejected token explains how to fix it", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("publicToken")) return new Response("eyJhbGciOiJIUzI1NiJ9.test.sig")
      return new Response("nope", { status: 401 })
    }) as typeof fetch

    let err = ""
    const realErr = process.stderr.write
    process.stderr.write = ((c: string) => {
      err += c
      return true
    }) as typeof process.stderr.write

    const code = await runSweep(opts())
    process.stderr.write = realErr

    expect(code).toBe(1)
    expect(JSON.parse(err).code).toBe("SWEEP_FAILED")
    expect(err).toContain("NAV_FEED_TOKEN")
  })
})

describe("toResult / toDetail", () => {
  test("titlecases NAV's uppercase municipality", () => {
    expect(toResult(feedItem() as never).location).toBe("Bergen")
  })

  test("missing values are null, not omitted", () => {
    const r = toResult(feedItem({ date_modified: "" }, { businessName: "", municipal: "" }) as never)
    expect(r.company).toBeNull()
    expect(r.location).toBeNull()
    expect(r.date).toBeNull()
    for (const k of ["company", "location", "date", "status"]) expect(Object.keys(r)).toContain(k)
  })

  test("maps a feed entry's ad_content", () => {
    const d = toDetail({
      uuid: "80df5041-7bb3-4ba5-87d4-c814e6770e8f",
      status: "ACTIVE",
      ad_content: {
        title: "Devops-utvikler",
        description: "<p>Vi søker</p>",
        published: "2026-07-14T08:12:27+02:00",
        applicationDue: "21.08.2026",
        engagementtype: "Fast",
        employer: { name: "Instech Solutions", orgnr: "974004313" },
        workLocations: [{ city: "BERGEN", county: "VESTLAND", municipal: "BERGEN" }],
        categoryList: [{ name: "Programvareutviklere" }],
      },
    })
    expect(d.title).toBe("Devops-utvikler")
    expect(d.description).toBe("Vi søker")
    expect(d.date).toBe("2026-07-14")
    expect(d.deadline).toBe("2026-08-21")
    expect(d.location).toBe("Bergen, Vestland")
    expect(d.categories).toEqual(["Programvareutviklere"])
  })
})

describe("small helpers", () => {
  test("parseDeadline handles both formats and free text", () => {
    expect(parseDeadline("21.08.2026")).toBe("2026-08-21")
    expect(parseDeadline("2026-08-09T00:00:00")).toBe("2026-08-09")
    expect(parseDeadline("Snarest")).toBe("Snarest")
    expect(parseDeadline(undefined)).toBeNull()
  })

  test("cleanHtml turns markup into prose", () => {
    expect(cleanHtml("<p>Hei</p><ul><li>Java</li></ul>")).toBe("Hei\nJava")
    expect(cleanHtml("")).toBeNull()
  })

  test("normalizeId accepts a uuid or any URL containing one", () => {
    const id = "80df5041-7bb3-4ba5-87d4-c814e6770e8f"
    expect(normalizeId(id)).toBe(id)
    expect(normalizeId(`https://arbeidsplassen.nav.no/stillinger/stilling/${id}`)).toBe(id)
    expect(normalizeId("nope")).toBeNull()
  })
})
