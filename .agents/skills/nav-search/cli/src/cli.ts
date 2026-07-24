#!/usr/bin/env bun
// Self-contained CLI for searching arbeidsplassen.nav.no, NAV's public Norwegian
// job board. No external CLI framework and zero runtime dependencies, so it runs
// anywhere `bun` is available with nothing installed beyond the repo clone.
//
// NAV republishes a large share of finn.no's ads (65-76% of results on typical
// tech/commercial queries) and links back to each finn posting, so this is the
// main way to reach finn.no inventory through a channel that permits automation.
// NAV's robots.txt is fully open.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { baseUrl } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

// Short-flag aliases.
const ALIAS: Record<string, string> = { q: "query", n: "limit" }

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("-")) {
      ;(flags._ as string[]).push(a)
      continue
    }
    const name = a.replace(/^-+/, "")
    const key = ALIAS[name] ?? name
    const next = argv[i + 1]
    // A flag with no following value (or another flag next) is a boolean.
    let value: string | boolean = true
    if (next !== undefined && !next.startsWith("-")) {
      value = next
      i++
    }
    flags[key] = value
  }
  return flags
}

type FlagValue = string | boolean | string[] | undefined

/** Split a comma-separated value ("Oslo,Vestland") into a trimmed list. */
function commaList(raw: FlagValue): string[] {
  if (typeof raw !== "string") return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

const HELP = `nav-search — search arbeidsplassen.nav.no (NAV's Norwegian job board)

USAGE
  bun run src/cli.ts search [-q "<søkeord>"] [filters] [--format json|table|plain]
  bun run src/cli.ts detail <uuid|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords (title, skill, role). Optional.
  --jobage <days>         Published within N days. Windows over 7 days are
                          filtered client-side (NAV only supports 3 and 7).
  --page <n>              1-indexed page (25 ads per page). Default 1.
  --limit, -n <n>         Max results to return. Default 25; pages are fetched
                          serially as needed, capped at 10 pages.
  --county <names>        Fylke filter, comma-separated. e.g. --county Oslo,Vestland
  --municipal <names>     Kommune filter, comma-separated. e.g. --municipal Bergen
  --source <names>        Keep only these NAV sources, comma-separated.
                          FINN | IMPORTAPI | AMEDIA | DIR (--source FINN for finn.no ads only)
  --format <fmt>          json (default) | table | plain.

DETAIL
  <uuid|url>              A NAV ad uuid (a search result's id) or a full
                          https://arbeidsplassen.nav.no/stillinger/stilling/<uuid> URL.

EXAMPLES
  bun run src/cli.ts search -q "utvikler" --county Oslo --limit 10 --format table
  bun run src/cli.ts search -q "data scientist" --jobage 14 --format table
  bun run src/cli.ts search -q "prosjektleder" --county Vestland --source FINN --format plain
  bun run src/cli.ts detail 80df5041-7bb3-4ba5-87d4-c814e6770e8f --format plain

NOTE
  For FINN-sourced ads NAV stores metadata only — the posting text lives on
  finn.no. Every such result carries a "finn_url" pointing at the original ad.

Source: ${baseUrl()} (public, no API key; robots.txt permits automated access).
`

// jobage/page/limit are all counts: a non-integer, zero, or negative value is a
// mistake, not something to silently coerce. parseInt would accept "-1" and
// truncate "1.5" to 1; Number + Number.isInteger rejects both so the caller
// hears about it instead of getting a quietly wrong result set.
function parseIntFlag(name: string, raw: string | boolean | string[], min = 1): number | null {
  const num = Number(String(raw))
  if (!Number.isInteger(num)) {
    process.stderr.write(JSON.stringify({ error: `--${name} must be an integer, got "${raw}"`, code: "BAD_ARG" }) + "\n")
    return null
  }
  if (num < min) {
    process.stderr.write(JSON.stringify({ error: `--${name} must be >= ${min}, got "${raw}"`, code: "BAD_ARG" }) + "\n")
    return null
  }
  return num
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  if (cmd === "search") {
    const fmt = (flags.format as string) || "json"

    for (const name of ["jobage", "page", "limit"] as const) {
      if (flags[name] !== undefined) {
        const v = parseIntFlag(name, flags[name])
        if (v === null) return 1
        flags[name] = String(v)
      }
    }

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      limit: flags.limit ? Math.max(1, parseInt(flags.limit as string, 10)) : 25,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SearchOpts["format"],
      counties: commaList(flags.county),
      municipals: commaList(flags.municipal),
      sources: commaList(flags.source).map((s) => s.toUpperCase()),
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires a <uuid|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const fmt = (flags.format as string) || "json"
    const opts: DetailOpts = { id, format: fmt === "plain" ? "plain" : "json" }
    return runDetail(opts)
  }

  process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
  return 1
}

// Set exitCode rather than calling process.exit(): process.exit() discards
// buffered stdout that has not drained, truncating large JSON output at the 64KB
// pipe boundary. /scrape consumes this output through a pipe, so that corrupts
// real searches.
//
// The trigger is process.exit() *plus more than one HTTP request in the same
// process* — a command that fetches a token first, or pages, is affected; a
// single-request one is not (measured: 65536 bytes vs 137910 on the same CLI,
// with and without a preceding token fetch).
//
// The .catch() reports an otherwise-unhandled rejection as structured JSON on
// stderr (upstream #203); it too sets exitCode instead of process.exit() so a
// partially-written stdout buffer still drains.
main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        code: "INTERNAL_ERROR",
      }) + "\n",
    )
    process.exitCode = 1
  })
