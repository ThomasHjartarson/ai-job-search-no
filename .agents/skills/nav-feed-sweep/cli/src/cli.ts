#!/usr/bin/env bun
// Self-contained CLI for NAV's official job-vacancy feed (pam-stilling-feed).
//
// This is the sanctioned API: free, documented, token-authenticated.
// https://navikt.github.io/pam-stilling-feed/
//
// It is a chronological event feed, NOT a search index — there is no keyword
// parameter, so filtering happens client-side after walking the feed. Use
// nav-search for "find me X in Y"; use this for "what is new since yesterday".

import { runSweep, type SweepOpts } from "./commands/sweep.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"
import { baseUrl } from "./helpers.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

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
    let value: string | boolean = true
    if (next !== undefined && !next.startsWith("-")) {
      value = next
      i++
    }
    flags[key] = value
  }
  return flags
}

function commaList(raw: string | boolean | string[] | undefined): string[] {
  if (typeof raw !== "string") return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

const HELP = `nav-feed-sweep — sweep NAV's official job-vacancy feed for what's new

  This is a chronological feed, not a search index. For keyword searching use
  nav-search. Use this to see everything published in a time window.

USAGE
  bun run src/cli.ts sweep [--since <days>] [-q "<ord>"] [--municipal <steder>]
  bun run src/cli.ts detail <uuid|url> [--format json|plain]

SWEEP FLAGS
  --since <days>          How far back to walk. Default 1. Always bounded — the
                          feed reaches back to ~2019.
  --query, -q <text>      Keep entries whose title or employer contains this.
  --municipal <names>     Kommune filter, comma-separated (e.g. Oslo,Bergen).
  --limit, -n <n>         Max results. Default 50.
  --include-inactive      Also report filled/expired ads. Off by default: about a
                          third of feed entries are INACTIVE state changes.
  --format <fmt>          json (default) | table | plain.

DETAIL
  <uuid|url>              A NAV ad uuid, or any arbeidsplassen/feed URL.

AUTH
  Set NAV_FEED_TOKEN to a registered token (free — email
  nav.team.arbeidsplassen@nav.no). Without it the public development token is
  fetched automatically; NAV rotates that one, so a 401 means it moved.

EXAMPLES
  bun run src/cli.ts sweep --since 1 --format table
  bun run src/cli.ts sweep --since 3 -q utvikler --municipal Oslo --format table
  bun run src/cli.ts detail 80df5041-7bb3-4ba5-87d4-c814e6770e8f --format plain

Source: ${baseUrl()} (official NAV API).
`

function parseIntFlag(name: string, raw: string | boolean | string[]): number | null {
  const val = parseInt(raw as string, 10)
  if (isNaN(val)) {
    process.stderr.write(JSON.stringify({ error: `--${name} must be a number, got "${raw}"`, code: "BAD_ARG" }) + "\n")
    return null
  }
  return val
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  if (cmd === "sweep") {
    const fmt = (flags.format as string) || "json"

    for (const name of ["since", "limit"] as const) {
      if (flags[name] !== undefined) {
        const v = parseIntFlag(name, flags[name])
        if (v === null) return 1
        flags[name] = String(v)
      }
    }

    const opts: SweepOpts = {
      since: flags.since ? Math.max(1, parseInt(flags.since as string, 10)) : 1,
      query: typeof flags.query === "string" ? flags.query : undefined,
      municipals: commaList(flags.municipal),
      limit: flags.limit ? Math.max(1, parseInt(flags.limit as string, 10)) : 50,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SweepOpts["format"],
      includeInactive: flags["include-inactive"] === true,
    }
    return runSweep(opts)
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
main().then((code) => {
  process.exitCode = code
})
