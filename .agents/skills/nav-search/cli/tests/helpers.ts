import { join } from "node:path"

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run the real CLI as a subprocess and capture its streams. */
export async function runCLI(args: string[], env: Record<string, string> = {}): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/** Parse the CLI's stdout as JSON, failing loudly on a non-zero exit. */
export function parseJSON(result: CLIResult): unknown {
  if (result.exitCode !== 0) {
    throw new Error(`CLI exited ${result.exitCode}: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

/**
 * Wrap a JSON payload in the RSC envelope arbeidsplassen streams, so parser
 * tests exercise the real chunking + escaping path rather than a tidy fixture.
 * Splitting across two chunks is deliberate: ad objects straddle chunk
 * boundaries on the live site, and joining before parsing is what handles it.
 */
export function rscPage(payload: string, splitAt?: number): string {
  const escaped = payload.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

  // Each push() on the live site is independently a valid JS string literal, so
  // a chunk never ends mid-escape. Walk the cut backwards off any trailing
  // backslash run so the fixture keeps that property.
  let cut = splitAt ?? Math.floor(escaped.length / 2)
  let backslashes = 0
  while (cut - 1 - backslashes >= 0 && escaped[cut - 1 - backslashes] === "\\") backslashes++
  if (backslashes % 2 === 1) cut -= 1

  const chunks = [escaped.slice(0, cut), escaped.slice(cut)]
  return chunks.map((c) => `<script>self.__next_f.push([1,"${c}"])</script>`).join("\n")
}

/** A realistic NAV ad object, overridable per test. */
export function navAd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "80df5041-7bb3-4ba5-87d4-c814e6770e8f",
    source: "FINN",
    published: "2026-07-14T08:12:27.926555764+02:00",
    jobTitle: "Devops-utvikler",
    title: "Devops-utvikler",
    description: "",
    applicationDue: "21.08.2026",
    locationList: [
      {
        country: "NORGE",
        address: "Solheimsgaten 5",
        city: "BERGEN",
        postalCode: "5058",
        county: "VESTLAND",
        municipal: "BERGEN",
      },
    ],
    categoryList: [{ categoryType: "STYRK08", name: "Programvareutviklere" }],
    employer: { name: "Instech Solutions", orgnr: "974004313", homepage: "https://www.instech.no/" },
    reference: "469427096",
    status: "ACTIVE",
    expires: "2026-08-21T00:00:00+02:00",
    ...overrides,
  }
}
