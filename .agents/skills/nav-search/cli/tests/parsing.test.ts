import { describe, expect, test } from "bun:test"
import {
  cleanHtml,
  detailToResult,
  extractAdData,
  extractAds,
  extractRscBlob,
  extractTotal,
  finnUrl,
  normalizeId,
  parseDeadline,
  resolveRscRef,
  toDetail,
  toResult,
  type NavAd,
} from "../src/helpers.js"
import { navAd, rscPage } from "./helpers.js"

describe("extractRscBlob", () => {
  test("joins chunks so objects split across them survive", () => {
    const payload = JSON.stringify({ uuid: "x".repeat(40), title: "Split Across Chunks" })
    const blob = extractRscBlob(rscPage(payload))
    expect(blob).toContain('"title":"Split Across Chunks"')
  })

  test("decodes escaped quotes and unicode escapes", () => {
    const html = `<script>self.__next_f.push([1,"{\\"title\\":\\"Caf\\u00e9 \\\\ drift\\"}"])</script>`
    const blob = extractRscBlob(html)
    expect(blob).toContain('"title":"Café \\ drift"')
  })

  test("returns empty string when the page has no RSC chunks", () => {
    expect(extractRscBlob("<html><body>nothing here</body></html>")).toBe("")
  })
})

describe("extractAds", () => {
  test("extracts an ad from a realistic RSC page", () => {
    const ads = extractAds(extractRscBlob(rscPage(JSON.stringify(navAd()))))
    expect(ads).toHaveLength(1)
    expect(ads[0].title).toBe("Devops-utvikler")
    expect(ads[0].employer?.name).toBe("Instech Solutions")
  })

  test("handles braces inside ad prose without unbalancing", () => {
    const ad = navAd({ description: "Vi bruker {curly} og \\\"sitater\\\" i teksten }}}" })
    const ads = extractAds(extractRscBlob(rscPage(JSON.stringify(ad))))
    expect(ads).toHaveLength(1)
    expect(ads[0].uuid).toBe(navAd().uuid)
  })

  test("deduplicates repeated uuids", () => {
    const one = JSON.stringify(navAd())
    const ads = extractAds(extractRscBlob(rscPage(`[${one},${one}]`)))
    expect(ads).toHaveLength(1)
  })

  test("skips a malformed ad but keeps the rest", () => {
    const good = JSON.stringify(navAd({ uuid: "aaaaaaaa-0000-0000-0000-000000000001" }))
    // A truncated object followed by a valid one.
    const blob = `{"uuid":"broken","title":  ,,,} ${good}`
    const ads = extractAds(blob)
    expect(ads.map((a) => a.uuid)).toEqual(["aaaaaaaa-0000-0000-0000-000000000001"])
  })

  test("ignores objects with a uuid but no title", () => {
    expect(extractAds('{"uuid":"deadbeef-0000-0000-0000-000000000000","score":1}')).toHaveLength(0)
  })
})

describe("extractTotal", () => {
  test("reads the totalAds marker", () => {
    expect(extractTotal('{"totalAds":213,"ads":[]}')).toBe(213)
  })
  test("returns null when absent", () => {
    expect(extractTotal("{}")).toBeNull()
  })
})

describe("resolveRscRef", () => {
  const blob = ['0:{"a":1}', '2c:T14d0,<p>Full annonsetekst med æ ø å</p>', '2d:T10,neste'].join("\n")

  test("resolves a lazy reference to its streamed chunk", () => {
    expect(resolveRscRef(blob, "$2c")).toBe("<p>Full annonsetekst med æ ø å</p>")
  })

  // The hex length prefix counts bytes, not JS-string characters. Norwegian ads
  // are full of æ/ø/å, so trusting it would truncate mid-word.
  test("is not fooled by the byte-vs-character length prefix", () => {
    const text = resolveRscRef(blob, "$2c")
    expect(text).toContain("æ ø å")
    expect(text).not.toContain("neste")
  })

  test("passes through a literal that is not a reference", () => {
    expect(resolveRscRef(blob, "<p>inline</p>")).toBe("<p>inline</p>")
  })

  test("returns null for a dangling reference or empty input", () => {
    expect(resolveRscRef(blob, "$ff")).toBeNull()
    expect(resolveRscRef(blob, undefined)).toBeNull()
  })
})

describe("extractAdData", () => {
  // A detail page keys the main ad `adData` with `id` + camelCase, while the
  // `{"uuid":` objects on the same page are the *suggested* ads sidebar.
  const detailBlob = [
    '{"adData":{"id":"80df5041-7bb3-4ba5-87d4-c814e6770e8f","status":"ACTIVE","title":"Devops-utvikler",',
    '"source":"FINN","reference":"469427096","published":"2026-07-14T08:12:27.9+02:00",',
    '"adTextHtml":"$2c","engagementType":"Fast","extent":"Heltid","positionCount":2,',
    '"employer":{"orgnr":"974004313","name":"Instech Solutions","sector":"Privat"},',
    '"application":{"applicationDueDate":null,"applicationDueLabel":"Snarest","applicationUrl":"https://www.finn.no/job-apply/469427096/apply"},',
    '"locationList":[{"city":"BERGEN","county":"VESTLAND","municipal":"BERGEN"}]}}',
    "\n2c:T100,<p>Vi søker en utvikler</p>",
  ].join("")

  test("extracts the main ad, not a suggested one", () => {
    const ad = extractAdData(detailBlob)
    expect(ad?.id).toBe("80df5041-7bb3-4ba5-87d4-c814e6770e8f")
    expect(ad?.employer?.name).toBe("Instech Solutions")
  })

  test("returns null when the page carries no adData", () => {
    expect(extractAdData('{"suggestions":[{"uuid":"x","title":"y"}]}')).toBeNull()
  })

  test("resolves the ad text a FINN-sourced ad carries on the detail page", () => {
    const ad = extractAdData(detailBlob)!
    const job = detailToResult(ad, detailBlob)
    // The search payload leaves description empty for FINN ads; detail does not.
    expect(job.description).toBe("Vi søker en utvikler")
    expect(job.finn_url).toBe("https://www.finn.no/469427096")
  })

  test("falls back to the label when there is no due date", () => {
    const job = detailToResult(extractAdData(detailBlob)!, detailBlob)
    expect(job.deadline).toBe("Snarest")
  })

  test("maps the camelCase detail fields", () => {
    const job = detailToResult(extractAdData(detailBlob)!, detailBlob)
    expect(job.employment_type).toBe("Fast")
    expect(job.extent).toBe("Heltid")
    expect(job.positions).toBe(2)
    expect(job.sector).toBe("Privat")
    expect(job.location).toBe("Bergen, Vestland")
  })
})

describe("toResult", () => {
  test("maps a NAV ad onto the portal contract", () => {
    const r = toResult(navAd() as NavAd)
    expect(r.id).toBe("80df5041-7bb3-4ba5-87d4-c814e6770e8f")
    expect(r.title).toBe("Devops-utvikler")
    expect(r.company).toBe("Instech Solutions")
    expect(r.date).toBe("2026-07-14")
    expect(r.url).toContain("/stillinger/stilling/80df5041")
  })

  test("titlecases NAV's uppercase place names", () => {
    expect(toResult(navAd() as NavAd).location).toBe("Bergen, Vestland")
  })

  test("collapses Oslo, Oslo to a single Oslo", () => {
    const ad = navAd({ locationList: [{ city: "OSLO", county: "OSLO", municipal: "OSLO" }] })
    expect(toResult(ad as NavAd).location).toBe("Oslo")
  })

  test("missing values are null, not omitted", () => {
    const ad = navAd({ employer: {}, locationList: [], published: undefined, applicationDue: "" })
    const r = toResult(ad as NavAd)
    expect(r.company).toBeNull()
    expect(r.location).toBeNull()
    expect(r.date).toBeNull()
    expect(r.deadline).toBeNull()
    // The keys must still be present — the contract forbids omitting them.
    for (const key of ["company", "location", "date", "deadline", "source", "finn_url"]) {
      expect(Object.keys(r)).toContain(key)
    }
  })

  test("falls back to jobTitle, then a placeholder", () => {
    expect(toResult(navAd({ title: "" }) as NavAd).title).toBe("Devops-utvikler")
    expect(toResult(navAd({ title: "", jobTitle: "" }) as NavAd).title).toBe("(uten tittel)")
  })
})

describe("finnUrl", () => {
  test("builds the canonical finn link for FINN-sourced ads", () => {
    expect(finnUrl(navAd() as NavAd)).toBe("https://www.finn.no/469427096")
  })
  test("is null for ads NAV did not get from finn", () => {
    expect(finnUrl(navAd({ source: "IMPORTAPI" }) as NavAd)).toBeNull()
  })
  test("is null when the reference is not a finn ad id", () => {
    expect(finnUrl(navAd({ reference: "ABC-123" }) as NavAd)).toBeNull()
  })
})

describe("parseDeadline", () => {
  test("converts dd.mm.yyyy to ISO", () => {
    expect(parseDeadline("21.08.2026")).toBe("2026-08-21")
  })
  test("trims an ISO timestamp to the date", () => {
    expect(parseDeadline("2026-08-09T00:00:00")).toBe("2026-08-09")
  })
  test("keeps meaningful free text such as Snarest", () => {
    expect(parseDeadline("Snarest")).toBe("Snarest")
  })
  test("is null for empty input", () => {
    expect(parseDeadline("")).toBeNull()
    expect(parseDeadline(undefined)).toBeNull()
  })
})

describe("cleanHtml", () => {
  test("turns block markup into readable prose", () => {
    expect(cleanHtml("<p>Vi søker</p><ul><li>Java</li><li>Kotlin</li></ul>")).toBe("Vi søker\nJava\nKotlin")
  })
  test("decodes entities", () => {
    expect(cleanHtml("<p>drift &amp; utvikling</p>")).toBe("drift & utvikling")
  })
  test("is null for the empty description FINN ads carry", () => {
    expect(cleanHtml("")).toBeNull()
    expect(cleanHtml(null)).toBeNull()
  })
})

describe("toDetail", () => {
  test("adds employer and category detail", () => {
    const d = toDetail(navAd({ description: "<p>Hei</p>", engagementtype: "Fast" }) as NavAd)
    expect(d.description).toBe("Hei")
    expect(d.employer_orgnr).toBe("974004313")
    expect(d.categories).toEqual(["Programvareutviklere"])
    expect(d.employment_type).toBe("Fast")
  })
})

describe("normalizeId", () => {
  test("accepts a bare uuid", () => {
    const id = "80df5041-7bb3-4ba5-87d4-c814e6770e8f"
    expect(normalizeId(id)).toBe(id)
  })
  test("extracts a uuid from a full ad URL", () => {
    expect(normalizeId("https://arbeidsplassen.nav.no/stillinger/stilling/80df5041-7bb3-4ba5-87d4-c814e6770e8f")).toBe(
      "80df5041-7bb3-4ba5-87d4-c814e6770e8f",
    )
  })
  test("rejects input with no uuid", () => {
    expect(normalizeId("not-an-id")).toBeNull()
    expect(normalizeId("")).toBeNull()
  })
})
