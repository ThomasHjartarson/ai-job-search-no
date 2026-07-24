// Data source: arbeidsplassen.nav.no — NAV's public job board, the Norwegian
// state employment service. robots.txt is fully permissive (`Disallow:` empty).
//
// Why this portal is the backbone of the Norwegian setup: NAV republishes a large
// share of finn.no's job ads (measured 65-76% of results for tech/commercial
// queries), and each republished ad carries its canonical finn.no link. So this
// skill reaches most of finn's inventory through a channel that welcomes it.
//
// The search page is a Next.js app that streams its data as React Server
// Component chunks — `self.__next_f.push([1,"<escaped json>"])`. We concatenate
// those chunks, unescape them, and pull the ad objects out. Same shape of trick
// as jobindex-search's `extractStash`, different envelope.

export const DEFAULT_BASE_URL = "https://arbeidsplassen.nav.no"

/** Base URL: NAV_BASE_URL (for testing against a mirror) or the default. */
export function baseUrl(): string {
  const raw = (process.env.NAV_BASE_URL ?? "").trim()
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "")
}

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

// A normal browser UA. NAV serves its search page to anyone; we identify as a
// browser because that is what the page expects, not to disguise anything.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

/** NAV serves 25 ads per search page and ignores a `size` param. */
export const PAGE_SIZE = 25

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * GET an HTML page from arbeidsplassen. Retries 429/5xx with exponential backoff
 * plus jitter; returns `null` on 404 rather than throwing, so a dead ad id
 * degrades to "not found" instead of an error. Connection failures fail fast.
 */
export async function fetchHtml(path: string): Promise<string | null> {
  const url = `${baseUrl()}${path}`
  const maxRetries = 6
  let delay = 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "nb,no,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw new Error(
        `could not reach arbeidsplassen.nav.no at ${baseUrl()} (${e instanceof Error ? e.message : String(e)})`,
      )
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`arbeidsplassen request failed: ${response.status} ${response.statusText}`)
      }
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`arbeidsplassen request failed: ${response.status} ${response.statusText}`)
    }
    return await response.text()
  }
  throw new Error("arbeidsplassen request failed after retries")
}

/** Decode the JS string escapes used inside an RSC chunk literal. */
function decodeJsString(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc: string) => {
    switch (esc[0]) {
      case "u":
        return String.fromCharCode(parseInt(esc.slice(1), 16))
      case "x":
        return String.fromCharCode(parseInt(esc.slice(1), 16))
      case "n":
        return "\n"
      case "r":
        return "\r"
      case "t":
        return "\t"
      case "b":
        return "\b"
      case "f":
        return "\f"
      default:
        // Covers \" \\ \/ and any other single-character escape.
        return esc
    }
  })
}

/**
 * Concatenate every RSC chunk on the page into one decoded blob. The ad payload
 * is split across chunk boundaries, so joining before parsing is what makes the
 * objects whole.
 */
export function extractRscBlob(html: string): string {
  const chunks: string[] = []
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) chunks.push(m[1])
  return decodeJsString(chunks.join(""))
}

const AD_MARKER = '{"uuid":"'

/**
 * Pull JSON objects out of the blob by brace-balancing from each `{"uuid":"`.
 * String-aware so braces inside ad prose can't unbalance the scan, and each
 * object is parsed independently — one malformed ad cannot break the page.
 */
export function extractAds(blob: string): NavAd[] {
  const ads: NavAd[] = []
  const seen = new Set<string>()
  let idx = 0

  while ((idx = blob.indexOf(AD_MARKER, idx)) !== -1) {
    const start = idx
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1

    for (let i = start; i < blob.length; i++) {
      const ch = blob[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }

    if (end === -1) break // truncated payload; stop rather than mis-parse
    idx = end

    try {
      const ad = JSON.parse(blob.slice(start, end)) as NavAd
      // An ad needs an identity and a title to be usable downstream.
      if (!ad.uuid || seen.has(ad.uuid)) continue
      if (!ad.title && !ad.jobTitle) continue
      seen.add(ad.uuid)
      ads.push(ad)
    } catch {
      // Not an ad object (or malformed) — skip it and keep going.
    }
  }
  return ads
}

/**
 * Resolve an RSC lazy reference such as `"$2c"`.
 *
 * Large strings are not inlined; the payload holds `"$<id>"` and the value
 * arrives later in the stream as `<id>:T<hexlen>,<content>`. We bound the
 * content by scanning to the next chunk marker rather than trusting the hex
 * length, because that length counts bytes while this blob is a JS string —
 * they diverge the moment the ad contains æ, ø or å, which Norwegian ads do.
 */
export function resolveRscRef(blob: string, value: string | undefined): string | null {
  if (!value) return null
  const m = value.match(/^\$([0-9a-f]+)$/i)
  if (!m) return value // already a literal
  const id = m[1]

  const start = blob.search(new RegExp(`(^|\\n)${id}:T[0-9a-f]+,`, "i"))
  if (start === -1) return null
  const comma = blob.indexOf(",", start)
  if (comma === -1) return null

  const rest = blob.slice(comma + 1)
  const next = rest.search(/\n[0-9a-f]{1,4}:/i)
  return (next === -1 ? rest : rest.slice(0, next)).trim() || null
}

/**
 * The main ad object on a detail page. This is a *different shape* from the
 * search payload: it is keyed `adData`, uses `id` rather than `uuid`, and uses
 * camelCase throughout. The `{"uuid":` objects on a detail page are the
 * *suggested* ads in the sidebar — parsing those and returning one would mean
 * handing back the wrong job.
 */
export function extractAdData(blob: string): NavAdDetail | null {
  const marker = '"adData":'
  const at = blob.indexOf(marker)
  if (at === -1) return null
  const start = at + marker.length
  if (blob[start] !== "{") return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < blob.length; i++) {
    const ch = blob[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(blob.slice(start, i + 1)) as NavAdDetail
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Total matching ads reported by the page, or null when the marker is absent. */
export function extractTotal(blob: string): number | null {
  const m = blob.match(/"totalAds":(\d+)/)
  return m ? parseInt(m[1], 10) : null
}

/** One work location as NAV stores it. */
export interface NavLocation {
  country?: string
  address?: string
  city?: string
  postalCode?: string
  county?: string
  municipal?: string
}

/** A NAV ad — the fields this skill reads (the wire shape carries more). */
export interface NavAd {
  uuid: string
  title?: string
  jobTitle?: string
  description?: string
  source?: string
  reference?: string
  status?: string
  published?: string
  expires?: string
  applicationDue?: string
  locationList?: NavLocation[]
  employer?: { name?: string; orgnr?: string; homepage?: string; sector?: string }
  categoryList?: Array<{ categoryType?: string; name?: string }>
  searchtagsai?: string[]
  engagementtype?: string
  extent?: string
  positioncount?: number
  applicationUrl?: string
  sourceurl?: string
}

/**
 * A search result in the portal-skill contract shape. `id` is the NAV uuid (what
 * `detail <id>` consumes); missing values are `null`, never omitted.
 *
 * `source`, `finn_url`, `county` and `municipal` are a permitted superset —
 * `finn_url` in particular is why this skill is useful: it is the canonical
 * finn.no ad, which is where the full posting text lives.
 */
export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  source: string | null
  finn_url: string | null
  county: string | null
  municipal: string | null
  deadline: string | null
}

/**
 * The detail page's ad object (`adData`). Note this is camelCase and keyed `id`,
 * where the search payload is lowercase and keyed `uuid` — two different shapes
 * from the same site.
 */
export interface NavAdDetail {
  id: string
  status?: string
  title?: string
  jobTitle?: string
  shortSummary?: string
  source?: string
  medium?: string
  reference?: string
  published?: string
  updated?: string
  expires?: string
  adTextHtml?: string // usually an RSC ref like "$2c"
  sourceUrl?: string
  engagementType?: string
  extent?: string
  jobPercentage?: string | number
  positionCount?: number
  jobArrangement?: string
  remoteOptions?: string
  workLanguages?: string[]
  aiCompetences?: string[]
  locationList?: NavLocation[]
  employer?: { orgnr?: string; name?: string; sector?: string; homepage?: string; descriptionHtml?: string }
  application?: {
    applicationDueDate?: string | null
    applicationDueLabel?: string | null
    applicationEmail?: string | null
    applicationUrl?: string | null
  }
  contactList?: Array<{ name?: string; email?: string; phone?: string; title?: string }>
}

/** A job detail: the search result plus description, employer and tags. */
export interface JobDetailResult extends JobResult {
  description: string | null
  employer_orgnr: string | null
  employer_homepage: string | null
  sector: string | null
  employment_type: string | null
  extent: string | null
  positions: number | null
  categories: string[]
  tags: string[]
  apply_url: string | null
  status: string | null
}

/** NAV stores place names uppercase; render them as words rather than shouting. */
function titleCase(s: string | undefined): string | null {
  if (!s) return null
  return (
    s
      .toLocaleLowerCase("nb-NO")
      .replace(/(^|[\s\-/])([\p{L}])/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("nb-NO"))
      .trim() || null
  )
}

/** The ad's public page on arbeidsplassen. */
export function adUrl(uuid: string): string {
  return `${baseUrl()}/stillinger/stilling/${uuid}`
}

/**
 * The canonical finn.no ad for a FINN-sourced listing. NAV keeps finn's ad id in
 * `reference`, and finn resolves https://www.finn.no/<id> to the posting.
 */
export function finnUrl(ad: NavAd): string | null {
  if ((ad.source ?? "").toUpperCase() !== "FINN") return null
  const ref = (ad.reference ?? "").trim()
  return /^\d+$/.test(ref) ? `https://www.finn.no/${ref}` : null
}

/** Normalise NAV's two deadline spellings (ISO, or dd.mm.yyyy) to YYYY-MM-DD. */
export function parseDeadline(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const dmy = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  const iso = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  // Free text such as "Snarest" / "Fortløpende" is meaningful; keep it as-is.
  return trimmed
}

/**
 * "Bergen, Vestland" from the first work location, or null when absent. Oslo is
 * both a city and a county, so drop the repeat rather than print "Oslo, Oslo".
 */
function locationLabel(ad: NavAd): string | null {
  const loc = ad.locationList?.[0]
  if (!loc) return null
  const place = titleCase(loc.city) ?? titleCase(loc.municipal)
  const county = titleCase(loc.county)
  const parts = place && county && place !== county ? [place, county] : [place ?? county]
  return parts.filter(Boolean).join(", ") || null
}

/** Reshape a NAV ad into the contract search-result fields. */
export function toResult(ad: NavAd): JobResult {
  const loc = ad.locationList?.[0]
  return {
    id: ad.uuid,
    title: ad.title || ad.jobTitle || "(uten tittel)",
    company: ad.employer?.name || null,
    location: locationLabel(ad),
    date: ad.published ? ad.published.slice(0, 10) : null,
    url: adUrl(ad.uuid),
    source: ad.source || null,
    finn_url: finnUrl(ad),
    county: titleCase(loc?.county),
    municipal: titleCase(loc?.municipal),
    deadline: parseDeadline(ad.applicationDue),
  }
}

/** Reshape a NAV ad into the detail result (adds description, employer, tags). */
export function toDetail(ad: NavAd): JobDetailResult {
  return {
    ...toResult(ad),
    description: cleanHtml(ad.description),
    employer_orgnr: ad.employer?.orgnr || null,
    employer_homepage: ad.employer?.homepage || null,
    sector: ad.employer?.sector || null,
    employment_type: ad.engagementtype || null,
    extent: ad.extent || null,
    positions: typeof ad.positioncount === "number" ? ad.positioncount : null,
    categories: (ad.categoryList ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)),
    tags: ad.searchtagsai ?? [],
    apply_url: ad.applicationUrl || ad.sourceurl || null,
    status: ad.status || null,
  }
}

/**
 * Reshape a detail-page `adData` object into the detail result, resolving the
 * lazily-streamed ad text.
 *
 * Worth knowing: NAV *does* carry the full posting text for FINN-sourced ads
 * here, even though the search payload leaves `description` empty. So a detail
 * lookup is usually enough and there is no need to fetch the ad from finn.no.
 */
export function detailToResult(ad: NavAdDetail, blob: string): JobDetailResult {
  const loc = ad.locationList?.[0]
  const place = titleCase(loc?.city) ?? titleCase(loc?.municipal)
  const county = titleCase(loc?.county)
  const location = (place && county && place !== county ? [place, county] : [place ?? county])
    .filter(Boolean)
    .join(", ")

  const finn =
    (ad.source ?? "").toUpperCase() === "FINN" && /^\d+$/.test((ad.reference ?? "").trim())
      ? `https://www.finn.no/${ad.reference!.trim()}`
      : null

  const due = ad.application?.applicationDueDate ?? undefined
  const deadline = parseDeadline(due) ?? ad.application?.applicationDueLabel ?? null

  return {
    id: ad.id,
    title: ad.title || ad.jobTitle || "(uten tittel)",
    company: ad.employer?.name || null,
    location: location || null,
    date: ad.published ? ad.published.slice(0, 10) : null,
    url: adUrl(ad.id),
    source: ad.source || null,
    finn_url: finn,
    county,
    municipal: titleCase(loc?.municipal),
    deadline,
    description: cleanHtml(resolveRscRef(blob, ad.adTextHtml)) ?? cleanHtml(ad.shortSummary),
    employer_orgnr: ad.employer?.orgnr || null,
    employer_homepage: ad.employer?.homepage || null,
    sector: ad.employer?.sector || null,
    employment_type: ad.engagementType || null,
    extent: ad.extent || null,
    positions: typeof ad.positionCount === "number" ? ad.positionCount : null,
    categories: [],
    tags: ad.aiCompetences ?? [],
    apply_url: ad.application?.applicationUrl || ad.sourceUrl || null,
    status: ad.status || null,
  }
}

function numericEntity(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => numericEntity(parseInt(dec, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => numericEntity(parseInt(hex, 16)))
    .replace(/&nbsp;/g, " ")
}

/**
 * Strip an ad description's HTML into readable prose. Null for empty input —
 * which is the norm for FINN-sourced ads, where NAV keeps only the metadata and
 * the posting text lives on finn.no (see `finn_url`).
 */
export function cleanHtml(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html.replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
  const text = decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/** Extract a NAV uuid from a bare uuid or any arbeidsplassen ad URL. */
export function normalizeId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const m = trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? m[1].toLowerCase() : null
}
