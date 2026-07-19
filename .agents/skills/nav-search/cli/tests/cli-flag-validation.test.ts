import { describe, expect, test } from "bun:test"
import { runCLI } from "./helpers.js"

// These assert on validation error codes that are emitted BEFORE any network
// call, so the suite is network-free and safe to run in CI.

describe("flag validation", () => {
  for (const name of ["jobage", "page", "limit"]) {
    test(`--${name} rejects a non-numeric value`, async () => {
      const result = await runCLI(["search", `--${name}`, "abc"])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    })

    // Regression: parseInt used to accept "-1" and truncate "1.5" to 1, and the
    // Math.max(1, ...) clamp then silently substituted 1 instead of erroring.
    test(`--${name} rejects a negative value instead of silently clamping`, async () => {
      const result = await runCLI(["search", `--${name}`, "-1"])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    })

    test(`--${name} rejects zero`, async () => {
      const result = await runCLI(["search", `--${name}`, "0"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    })

    test(`--${name} rejects a fractional value`, async () => {
      const result = await runCLI(["search", `--${name}`, "1.5"])
      expect(result.exitCode).toBe(1)
      expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
    })
  }
})

describe("detail argument handling", () => {
  test("a missing id is NO_ID", async () => {
    const result = await runCLI(["detail"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("NO_ID")
  })

  test("an unparseable id is BAD_ID and never hits the network", async () => {
    const result = await runCLI(["detail", "not-a-uuid"])
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ID")
  })
})

describe("command dispatch", () => {
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

  test("--help exits 0 when a command is given", async () => {
    const result = await runCLI(["search", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SEARCH FLAGS")
  })
})
