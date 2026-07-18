import {
  PAGE_SIZE,
  extractAds,
  extractRscBlob,
  extractTotal,
  fetchHtml,
  toResult,
  writeError,
  type JobResult,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  jobage: number
  page: number
  limit: number
  format: "json" | "table" | "plain"
  counties: string[]
  municipals: string[]
  /** Keep only ads NAV attributes to this source (e.g. FINN). Empty means all. */
  sources: string[]
}

/**
 * NAV filters by county with uppercase names ("OSLO", "VESTLAND"). Accept
 * whatever casing the user typed, and tolerate the common "Vestland fylke" form.
 */
function normalizeRegion(value: string): string {
  return value
    .trim()
    .replace(/\s+fylke$/i, "")
    .replace(/\s+kommune$/i, "")
    .toLocaleUpperCase("nb-NO")
}

/**
 * NAV's `published` filter is an enum, not a free-form day count. Its UI emits
 * only three values: `now/d` (today), `now-3d` and `now-7d`. Any other value
 * (`now-1d`, `now-14d`, `now-30d`, ...) makes arbeidsplassen answer HTTP 500,
 * which used to surface as a bare "arbeidsplassen request failed: 500" and read
 * like NAV being down rather than a bad parameter.
 *
 * So we never send an arbitrary day count. We narrow server-side to the
 * tightest supported bucket that still *contains* the requested window, then
 * apply the exact cutoff client-side against each ad's date. Windows longer
 * than 7 days cannot be narrowed server-side at all and are filtered purely on
 * the returned dates.
 *
 * `now/d` is deliberately unused: it means "since midnight today", which is
 * narrower than "within 1 day" and would silently drop yesterday's ads.
 */
const SERVER_BUCKETS: ReadonlyArray<{ coversDays: number; value: string }> = [
  { coversDays: 3, value: "now-3d" },
  { coversDays: 7, value: "now-7d" },
]

/** True when `jobage` asks for a real window rather than "everything". */
function isBoundedWindow(jobage: number): boolean {
  return Number.isFinite(jobage) && jobage > 0 && jobage < 9999
}

/** The `published` value to send, or null when NAV cannot express this window. */
export function publishedParam(jobage: number): string | null {
  if (!isBoundedWindow(jobage)) return null
  return SERVER_BUCKETS.find((b) => jobage <= b.coversDays)?.value ?? null
}

/** Inclusive ISO date cutoff for `jobage` days back, or null when unfiltered. */
export function cutoffDate(jobage: number, now: Date = new Date()): string | null {
  if (!isBoundedWindow(jobage)) return null
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - Math.floor(jobage))
  return d.toISOString().slice(0, 10)
}

function buildQuery(opts: SearchOpts, from: number): string {
  const p = new URLSearchParams()
  if (opts.query) p.set("q", opts.query)
  // NAV's page size is fixed at 25 and it ignores `size`; paging is by offset.
  if (from > 0) p.set("from", String(from))
  const published = publishedParam(opts.jobage)
  if (published) p.set("published", published)
  for (const c of opts.counties) p.append("county", normalizeRegion(c))
  for (const m of opts.municipals) p.append("municipal", normalizeRegion(m))
  return p.toString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fetch enough 25-ad pages to satisfy `limit`, starting at `page`. Pages are
 * fetched serially with a short pause — this runs inside /scrape's parallel
 * portal fan-out, so it should not also burst requests of its own.
 */
async function collect(opts: SearchOpts): Promise<{ rows: JobResult[]; total: number | null }> {
  const wanted = opts.limit
  const rows: JobResult[] = []
  let total: number | null = null
  const startFrom = (opts.page - 1) * PAGE_SIZE
  const cutoff = cutoffDate(opts.jobage)
  // Windows longer than 7 days get no server-side narrowing, so a page can be
  // mostly older ads that we drop. Allow more pages in that case, still capped
  // at 10 — the loop stops as soon as `wanted` surviving rows are collected.
  const neededPages = Math.ceil(wanted / PAGE_SIZE)
  const filteredClientSide = cutoff !== null && publishedParam(opts.jobage) === null
  // Hard cap so a large --limit can never turn into an unbounded crawl.
  const maxPages = Math.min(10, filteredClientSide ? Math.max(neededPages, 10) : neededPages)

  for (let i = 0; i < maxPages && rows.length < wanted; i++) {
    if (i > 0) await sleep(400)
    const html = await fetchHtml(`/stillinger?${buildQuery(opts, startFrom + i * PAGE_SIZE)}`)
    if (html === null) break

    const blob = extractRscBlob(html)
    if (total === null) total = extractTotal(blob)

    const ads = extractAds(blob)
    if (ads.length === 0) break

    for (const ad of ads) {
      if (opts.sources.length && !opts.sources.includes((ad.source ?? "").toUpperCase())) continue
      const result = toResult(ad)
      // Exact date cutoff. Ads with no parsable date are kept and left for the
      // caller to judge, matching how the rest of the CLI treats missing values.
      if (cutoff && result.date && result.date < cutoff) continue
      rows.push(result)
    }
    // A short page means we reached the end of the result set.
    if (ads.length < PAGE_SIZE) break
  }

  return { rows: rows.slice(0, wanted), total }
}

interface Column {
  header: string
  width: number
  cell: (r: JobResult) => string
}

function renderTable(rows: JobResult[]): string {
  if (rows.length === 0) return "Ingen treff."
  const columns: Column[] = [
    { header: "ID", width: Math.max(2, ...rows.map((r) => r.id.length)), cell: (r) => r.id },
    { header: "TITTEL", width: 38, cell: (r) => r.title },
    { header: "BEDRIFT", width: 22, cell: (r) => r.company ?? "—" },
    { header: "STED", width: 20, cell: (r) => r.location ?? "—" },
    { header: "DATO", width: 10, cell: (r) => r.date ?? "—" },
    { header: "KILDE", width: 9, cell: (r) => r.source ?? "—" },
  ]
  const row = (cells: string[]) =>
    cells.map((c, i) => c.slice(0, columns[i].width).padEnd(columns[i].width)).join("  ")

  const header = row(columns.map((c) => c.header))
  const body = rows.map((r) => row(columns.map((c) => c.cell(r))))
  return [header, "-".repeat(header.length), ...body].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "Ingen treff."
  const block = (r: JobResult) =>
    [
      r.title,
      `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`,
      r.deadline ? `  frist: ${r.deadline}` : "",
      `  id: ${r.id}`,
      `  ${r.url}`,
      r.finn_url ? `  finn: ${r.finn_url}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  return rows.map(block).join("\n\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const { rows, total } = await collect(opts)

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(rows) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify({ meta: { count: rows.length, page: opts.page, total: total ?? rows.length }, results: rows }, null, 2) +
          "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
