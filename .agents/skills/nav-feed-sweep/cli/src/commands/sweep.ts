import {
  MAX_PAGES,
  fetchFeed,
  resolveToken,
  toResult,
  writeError,
  type FeedItem,
  type JobResult,
} from "../helpers.js"

export interface SweepOpts {
  since: number // days back
  query?: string
  municipals: string[]
  limit: number
  format: "json" | "table" | "plain"
  /** Include filled/expired ads. Off by default — see the note below. */
  includeInactive: boolean
}

function matches(item: FeedItem, opts: SweepOpts): boolean {
  const e = item._feed_entry

  // The feed reports every ad state change, so a third of a typical page is
  // filled or expired. Reporting those as findable jobs would be a lie.
  if (!opts.includeInactive && (e.status ?? "").toUpperCase() !== "ACTIVE") return false

  if (opts.query) {
    const needle = opts.query.toLowerCase()
    const hay = `${e.title ?? ""} ${item.title ?? ""} ${e.businessName ?? ""}`.toLowerCase()
    if (!hay.includes(needle)) return false
  }
  if (opts.municipals.length) {
    const m = (e.municipal ?? "").toLowerCase()
    if (!opts.municipals.some((want) => m.includes(want.toLowerCase()))) return false
  }
  return true
}

async function collect(opts: SweepOpts): Promise<{ rows: JobResult[]; scanned: number }> {
  const token = await resolveToken()
  const since = new Date(Date.now() - opts.since * 24 * 60 * 60 * 1000)

  const rows: JobResult[] = []
  const seen = new Set<string>()
  let scanned = 0
  let path = "/api/v1/feed"

  for (let page = 0; page < MAX_PAGES && rows.length < opts.limit; page++) {
    const feed = await fetchFeed(token, path, page === 0 ? since : undefined)
    const items = feed.items ?? []
    if (items.length === 0) break
    scanned += items.length

    for (const item of items) {
      const uuid = item._feed_entry?.uuid
      if (!uuid || seen.has(uuid)) continue
      if (!matches(item, opts)) continue
      seen.add(uuid)
      rows.push(toResult(item))
      if (rows.length >= opts.limit) break
    }

    if (!feed.next_url) break
    path = feed.next_url
  }

  return { rows: rows.slice(0, opts.limit), scanned }
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
    { header: "TITTEL", width: 40, cell: (r) => r.title },
    { header: "BEDRIFT", width: 26, cell: (r) => r.company ?? "—" },
    { header: "STED", width: 18, cell: (r) => r.location ?? "—" },
    { header: "ENDRET", width: 10, cell: (r) => r.date ?? "—" },
  ]
  const row = (cells: string[]) =>
    cells.map((c, i) => c.slice(0, columns[i].width).padEnd(columns[i].width)).join("  ")
  const header = row(columns.map((c) => c.header))
  return [header, "-".repeat(header.length), ...rows.map((r) => row(columns.map((c) => c.cell(r))))].join("\n")
}

function renderPlain(rows: JobResult[]): string {
  if (rows.length === 0) return "Ingen treff."
  return rows
    .map((r) =>
      [r.title, `  ${r.company ?? "—"} · ${r.location ?? "—"} · ${r.date ?? "—"}`, `  id: ${r.id}`, `  ${r.url}`].join(
        "\n",
      ),
    )
    .join("\n\n")
}

export async function runSweep(opts: SweepOpts): Promise<number> {
  try {
    const { rows, scanned } = await collect(opts)

    if (opts.format === "table") {
      process.stdout.write(renderTable(rows) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(renderPlain(rows) + "\n")
    } else {
      process.stdout.write(
        JSON.stringify(
          { meta: { count: rows.length, page: 1, total: rows.length, scanned, since_days: opts.since }, results: rows },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SWEEP_FAILED")
    return 1
  }
}
