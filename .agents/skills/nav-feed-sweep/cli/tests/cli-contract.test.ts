import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { runCLI } from "./helpers.js"

// Network-free: these assert on validation errors emitted before any request.

describe("flag validation", () => {
  for (const name of ["since", "limit"]) {
    test(`--${name} rejects a non-numeric value`, async () => {
      const result = await runCLI(["sweep", `--${name}`, "abc"])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    })
  }
})

describe("command dispatch", () => {
  test("a missing detail id is NO_ID", async () => {
    const result = await runCLI(["detail"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NO_ID")
  })

  test("an unparseable detail id is BAD_ID", async () => {
    const result = await runCLI(["detail", "not-a-uuid"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ID")
  })

  test("an unknown command is BAD_CMD", async () => {
    const result = await runCLI(["frobnicate"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_CMD")
  })

  test("no command prints help and exits 1", async () => {
    const result = await runCLI([])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("USAGE")
  })

  test("help explains this is a feed, not a search index", async () => {
    const result = await runCLI(["sweep", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("not a search index")
    expect(result.stdout).toContain("nav-search")
  })
})

/**
 * Regression: the CLIs used to end with `process.exit(code)`, which discards
 * stdout that has not drained. Piped output was therefore cut at the 64KB pipe
 * buffer — a 145KB result set arrived as 65536 bytes of invalid JSON. /scrape
 * consumes this output through a pipe, so the corruption was silent and real.
 *
 * runCLI pipes stdout, so a large payload here reproduces the original bug.
 */
describe("large piped output", () => {
  test("output well over 64KB survives the pipe intact", async () => {
    // Serve a big feed from localhost so the real CLI produces a real large
    // payload. Loopback only — no network access, and nothing reaches NAV.
    const items = Array.from({ length: 400 }, (_, i) => {
      const uuid = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`
      return {
        id: uuid,
        url: `/api/v1/feedentry/${uuid}`,
        title: "Stillingsannonse",
        date_modified: "2026-07-18T08:12:27+02:00",
        _feed_entry: {
          uuid,
          status: "ACTIVE",
          title: `Utvikler nummer ${i} med en ganske lang tittel for volum`,
          businessName: `Bedrift ${i} AS`,
          municipal: "BERGEN",
        },
      }
    })

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/api/publicToken") {
          return new Response("token:\neyJhbGciOiJIUzI1NiJ9.test.sig")
        }
        return Response.json({ items, next_url: null, next_id: null })
      },
    })

    try {
      // The output must go through a REAL shell pipe with a downstream reader.
      // Bun.spawn's own pipe drains too eagerly to reproduce this: reading the
      // child's stdout directly returns the full payload even with the bug,
      // whereas `| cat` truncates at exactly 65536 bytes. Verified both ways.
      const cliPath = join(import.meta.dir, "..", "src", "cli.ts")
      const proc = Bun.spawn(["sh", "-c", `bun run ${cliPath} sweep --limit 400 --format json | cat`], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NAV_FEED_URL: `http://localhost:${server.port}` },
      })
      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      expect(stdout.length).toBeGreaterThan(64 * 1024)
      expect(stdout.length).not.toBe(65536) // the exact symptom of the old bug
      // Must parse — the bug cut it mid-string at the buffer boundary.
      expect(JSON.parse(stdout).results).toHaveLength(400)
    } finally {
      server.stop(true)
    }
  })
})
