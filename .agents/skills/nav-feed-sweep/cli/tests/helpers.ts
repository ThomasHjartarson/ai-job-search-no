import { join } from "node:path"

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run the real CLI as a subprocess and capture its streams (piped, not a tty). */
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

/** A feed item as the JSON Feed API returns it. */
export function feedItem(overrides: Partial<Record<string, unknown>> = {}, entry: Record<string, unknown> = {}) {
  const uuid = (entry.uuid as string) ?? "80df5041-7bb3-4ba5-87d4-c814e6770e8f"
  return {
    id: uuid,
    url: `/api/v1/feedentry/${uuid}`,
    title: "Stillingsannonse",
    date_modified: "2026-07-18T08:12:27.926555764+02:00",
    _feed_entry: {
      uuid,
      status: "ACTIVE",
      title: "Devops-utvikler",
      businessName: "INSTECH SOLUTIONS AS",
      municipal: "BERGEN",
      ...entry,
    },
    ...overrides,
  }
}

export function feedPage(items: unknown[], next: string | null = null) {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "NAV job vacancy feed",
    items,
    next_url: next,
    next_id: next ? "next-id" : null,
  })
}
