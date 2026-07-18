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

function buildQuery(opts: SearchOpts, from: number): string {
  const p = new URLSearchParams()
  if (opts.query) p.set("q", opts.query)
  // NAV's page size is fixed at 25 and it ignores `size`; paging is by offset.
  if (from > 0) p.set("from", String(from))
  if (opts.jobage > 0 && opts.jobage < 9999) p.set("published", `now-${opts.jobage}d`)
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
  // Hard cap so a large --limit can never turn into an unbounded crawl.
  const maxPages = Math.min(10, Math.ceil(wanted / PAGE_SIZE))

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
      rows.push(toResult(ad))
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
