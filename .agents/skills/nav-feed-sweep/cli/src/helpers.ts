// Data source: NAV's official job-vacancy feed (pam-stilling-feed).
//
// This is the *sanctioned* API — free, documented, and token-authenticated:
//   https://navikt.github.io/pam-stilling-feed/
//
// It is a chronological event feed, not a search index. There is no keyword
// parameter; you walk it from a point in time and filter client-side. That makes
// it the wrong tool for "find me devops jobs in Oslo" (use nav-search) and the
// right tool for "show me everything new since yesterday".
//
// Two things the feed will do to you if you are not careful:
//
//   * It emits every ad *state change*, not just live ads. A third of a typical
//     page is INACTIVE — filled or expired positions. Those must be dropped or
//     the sweep reports jobs that no longer exist.
//   * It reaches back to ~2019. Always bound it with --since; walking from the
//     start is both pointless and rude.

export const DEFAULT_BASE_URL = "https://pam-stilling-feed.nav.no"

/** The feed serves 1000 entries per page. */
export const PAGE_SIZE = 1000

/** Ceiling on pages per sweep, so a wide --since cannot walk years of history. */
export const MAX_PAGES = 10

export function baseUrl(): string {
  const raw = (process.env.NAV_FEED_URL ?? "").trim()
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "")
}

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "nav-feed-sweep-skill/1.0 (personal job search)"

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Resolve the bearer token.
 *
 * NAV_FEED_TOKEN is preferred — registering for a private token is free (email
 * nav.team.arbeidsplassen@nav.no) and is what NAV asks anyone building on the
 * feed to do. The public development token is the fallback; NAV rotates it at
 * irregular intervals, so a sudden 401 usually means it moved on.
 */
export async function resolveToken(): Promise<string> {
  const fromEnv = (process.env.NAV_FEED_TOKEN ?? "").trim()
  if (fromEnv) return fromEnv

  const response = await fetch(`${baseUrl()}/api/publicToken`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    throw new Error(
      `could not fetch NAV's public feed token (${response.status}). Set NAV_FEED_TOKEN to a registered token instead.`,
    )
  }
  // The endpoint answers with a human-readable blurb wrapping the JWT.
  const match = (await response.text()).match(/eyJ[A-Za-z0-9_.-]+/)
  if (!match) throw new Error("NAV's public token endpoint returned no recognisable token")
  return match[0]
}

/** A JSON Feed page as the API returns it. */
export interface FeedPage {
  items: FeedItem[]
  next_url?: string | null
  next_id?: string | null
}

export interface FeedItem {
  id: string
  url: string
  title: string
  date_modified: string
  _feed_entry: {
    uuid: string
    status: string
    title: string
    businessName?: string
    municipal?: string
    sistEndret?: string
  }
}

/** GET a feed page. `since` is sent as If-Modified-Since to bound the walk. */
export async function fetchFeed(token: string, path: string, since?: Date): Promise<FeedPage> {
  const url = path.startsWith("http") ? path : `${baseUrl()}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": UA,
  }
  if (since) headers["If-Modified-Since"] = since.toUTCString()

  let delay = 1000
  for (let attempt = 0; attempt <= 4; attempt++) {
    let response: Response
    try {
      response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15000) })
    } catch (e) {
      throw new Error(`could not reach the NAV feed (${e instanceof Error ? e.message : String(e)})`)
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "NAV rejected the feed token. The public token rotates — set NAV_FEED_TOKEN to a registered " +
          "token (free, email nav.team.arbeidsplassen@nav.no).",
      )
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 4) throw new Error(`NAV feed request failed: ${response.status} ${response.statusText}`)
      await sleep(delay + Math.floor(Math.random() * 500))
      delay = Math.min(delay * 2, 10000)
      continue
    }
    if (!response.ok) throw new Error(`NAV feed request failed: ${response.status} ${response.statusText}`)

    return (await response.json()) as FeedPage
  }
  throw new Error("NAV feed request failed after retries")
}

/** A sweep result in the portal-skill contract shape. */
export interface JobResult {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
  status: string | null
}

function titleCase(s: string | undefined): string | null {
  if (!s) return null
  return (
    s
      .toLocaleLowerCase("nb-NO")
      .replace(/(^|[\s\-/])([\p{L}])/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("nb-NO"))
      .trim() || null
  )
}

/** The ad's public page, which is what a person actually wants to open. */
export function adUrl(uuid: string): string {
  return `https://arbeidsplassen.nav.no/stillinger/stilling/${uuid}`
}

export function toResult(item: FeedItem): JobResult {
  const e = item._feed_entry
  return {
    id: e.uuid,
    title: e.title || item.title || "(uten tittel)",
    company: e.businessName || null,
    location: titleCase(e.municipal),
    date: item.date_modified ? item.date_modified.slice(0, 10) : null,
    url: adUrl(e.uuid),
    status: e.status || null,
  }
}

/** The full ad behind a feed entry. */
export interface FeedEntryDetail {
  uuid: string
  status?: string
  ad_content?: {
    title?: string
    jobtitle?: string
    description?: string
    published?: string
    expires?: string
    applicationDue?: string
    applicationUrl?: string
    link?: string
    source?: string
    sector?: string
    engagementtype?: string
    extent?: string
    positioncount?: number
    employer?: { name?: string; orgnr?: string; homepage?: string }
    workLocations?: Array<{ city?: string; county?: string; municipal?: string; address?: string }>
    categoryList?: Array<{ name?: string }>
  }
}

export interface JobDetailResult extends JobResult {
  description: string | null
  deadline: string | null
  employment_type: string | null
  extent: string | null
  sector: string | null
  source: string | null
  apply_url: string | null
  employer_orgnr: string | null
  categories: string[]
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

/** Normalise NAV's deadline spellings (ISO, dd.mm.yyyy, or free text). */
export function parseDeadline(raw: string | undefined): string | null {
  if (!raw) return null
  const t = raw.trim()
  if (!t) return null
  const dmy = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`
  const iso = t.match(/^(\d{4}-\d{2}-\d{2})/)
  return iso ? iso[1] : t
}

export function toDetail(entry: FeedEntryDetail): JobDetailResult {
  const a = entry.ad_content ?? {}
  const loc = a.workLocations?.[0]
  const place = titleCase(loc?.city) ?? titleCase(loc?.municipal)
  const county = titleCase(loc?.county)

  return {
    id: entry.uuid,
    title: a.title || a.jobtitle || "(uten tittel)",
    company: a.employer?.name || null,
    location: (place && county && place !== county ? [place, county] : [place ?? county]).filter(Boolean).join(", ") || null,
    date: a.published ? a.published.slice(0, 10) : null,
    url: adUrl(entry.uuid),
    status: entry.status || null,
    description: cleanHtml(a.description),
    deadline: parseDeadline(a.applicationDue),
    employment_type: a.engagementtype || null,
    extent: a.extent || null,
    sector: a.sector || null,
    source: a.source || null,
    apply_url: a.applicationUrl || a.link || null,
    employer_orgnr: a.employer?.orgnr || null,
    categories: (a.categoryList ?? []).map((c) => c.name).filter((n): n is string => Boolean(n)),
  }
}

/** Extract a NAV uuid from a bare uuid or any arbeidsplassen/feed URL. */
export function normalizeId(input: string): string | null {
  const m = input.trim().match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? m[1].toLowerCase() : null
}
