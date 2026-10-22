export * as DesktopCli from "./desktop-cli"

import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import installer from "../../../../../install?raw"
import { DesktopPaths } from "../paths"
import { BUNDLED_CLI_VERSION_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { parseCliVersion } from "./cli-version"

const execFileAsync = promisify(execFile)

export interface Resolved {
  readonly version: string
  readonly command: readonly string[]
  readonly binary?: string
  readonly argv: readonly string[]
  readonly runtime?: string
}

export interface Interface {
  readonly resolve: Effect.Effect<Resolved>
  readonly install: Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/DesktopCli") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const path = yield* Path.Path

    const resolve = yield* Effect.cached(
      make().pipe(Effect.provide(yield* Effect.context<FileSystem.FileSystem | Path.Path>()), Effect.orDie),
    )

    const install = Effect.gen(function* () {
      if (process.platform !== "darwin") return yield* Effect.fail(new Error("CLI installation requires macOS"))
      const cli = yield* resolve

      if (!cli.binary) return yield* Effect.fail(new Error("Bundled CLI executable is unavailable"))
      const home = app.getPath("home")

      if (cli.runtime) {
        yield* installRuntime(cli.runtime, cli.argv, cli.version, home)

        return path.join(home, ".opencode", "bin", "opencode")
      }

      yield* runInstaller(cli.binary, home)

      return path.join(home, ".opencode", "bin", "opencode")
    })

    return Service.of({ resolve, install })
  }),
)

const make = Effect.fn("DesktopCli.resolve")(function* () {
  const development = !app.isPackaged && process.env.OPENCODE_DESKTOP_CLI_DEV
  const version = process.env.OPENCODE_VERSION ?? "local"

  const cli = development
    ? {
        version,
        // Bun's transpiler cache key includes the define table, and the dev version changes on every
        // run. Reading it from the inherited environment keeps the define fixed and the cache warm.
        command: [
          "bun",
          "run",
          "--cwd",
          development,
          "--define=OPENCODE_VERSION=process.env.OPENCODE_VERSION",
          "src/index.ts",
        ],
        binary: undefined,
        argv: [],
        runtime: undefined,
      }
    : yield* resolveBundledCli(!app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1")

  return cli satisfies Resolved
})

type Layout = {
  readonly command: readonly string[]
  readonly binary: string
  readonly argv: readonly string[]
  readonly root: string
  readonly runtime?: string
}

const RuntimeManifest = Schema.Struct({ argv: Schema.Array(Schema.String), version: Schema.String })

// The fork ships the CLI as a Node runtime directory (node + opencode.mjs + assets) because the Bun
// executable it replaces cannot start on macOS 12.7.
const resolveLayout = Effect.fn("DesktopCli.resolveLayout")(function* (bundled: string) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const stat = yield* fs.stat(bundled).pipe(Effect.orElseSucceed(() => undefined))

  if (stat?.type !== "Directory")
    return {
      command: [bundled],
      binary: bundled,
      argv: [],
      root: path.dirname(bundled),
      runtime: undefined,
    } satisfies Layout

  const argv = runtimeArgv(bundled)
  const node = path.join(bundled, "node")
  const script = path.join(bundled, "opencode.mjs")

  return {
    command: [node, ...argv, script],
    binary: node,
    argv,
    root: path.dirname(bundled),
    runtime: bundled,
  } satisfies Layout
})

function runtimeArgv(directory: string) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "opencode-cli.json"), "utf8"))

    return Schema.decodeUnknownSync(RuntimeManifest)(manifest).argv
  } catch {
    return []
  }
}

const resolveBundledCli = Effect.fn("DesktopCli.resolveBundled")(function* (isolated: boolean) {
  const path = yield* Path.Path
  const paths = yield* DesktopPaths.resolve

  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, executableName())
    : path.join(paths.developmentResourcesRoot, isolated ? developmentExecutableName() : executableName())

  yield* Effect.logInfo("v2 CLI executable resolved", { bundled, packaged: app.isPackaged })
  const layout = yield* resolveLayout(bundled)
  const version = yield* bundledVersion(layout)
  const staged = app.isPackaged || isolated ? yield* installCli(layout, version) : layout

  return {
    version,
    binary: staged.binary,
    command: staged.command,
    argv: staged.argv,
    runtime: staged.runtime,
  }
})

// Spawning the bundled executable for `--version` costs ~400 ms of startup on a 200 MB binary (and
// several seconds on the first launch after an update, while the antivirus scans it). The build
// writes the version next to the executable, so a packaged app never spawns; the per-identity cache
// covers executables that arrived without that file.
const bundledVersion = Effect.fn("DesktopCli.bundledVersion")(function* (layout: Layout) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // Synchronous on purpose: this sits on the path to the first window's IPC port, and a queued
  // async read waits behind everything else the main thread is doing at that moment.
  const shipped = yield* Effect.sync(() => {
    try {
      return readFileSync(path.join(layout.root, "opencode-cli.version"), "utf8").trim()
    } catch {
      return ""
    }
  })

  if (shipped) {
    yield* Effect.logInfo("v2 CLI version bundled", { version: shipped })

    return shipped
  }

  const stat = yield* fs.stat(layout.binary).pipe(Effect.orElseSucceed(() => undefined))
  const identity = stat ? `${stat.size}:${Option.getOrUndefined(stat.mtime)?.getTime() ?? ""}` : undefined
  const store = getStore()
  const cached = Option.getOrUndefined(Schema.decodeUnknownOption(VersionCache)(store.get(BUNDLED_CLI_VERSION_KEY)))

  if (identity && cached?.path === layout.binary && cached.identity === identity) {
    yield* Effect.logInfo("v2 CLI version reused", { version: cached.version })

    return cached.version
  }

  const version = parseCliVersion(yield* run(layout.command, ["--version"]))

  if (identity)
    store.set(BUNDLED_CLI_VERSION_KEY, { path: layout.binary, identity, version } satisfies typeof VersionCache.Type)

  return version
})

const VersionCache = Schema.Struct({ path: Schema.String, identity: Schema.String, version: Schema.String })

const ExecFailure = Schema.Struct({ stdout: Schema.optional(Schema.String), stderr: Schema.optional(Schema.String) })

const installCli = Effect.fn("DesktopCli.install")(function* (layout: Layout, version: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  // x64 and ARM64 installers share userData on Windows ARM64, so a same-version switch must not reuse the other copy.
  const stage = `${version}-${process.arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
  const directory = path.join(app.getPath("userData"), "cli", stage)

  if (layout.runtime) {
    const runtime = layout.runtime
    const destination = path.join(directory, "opencode-cli")
    const staged = {
      command: [path.join(destination, "node"), ...layout.argv, path.join(destination, "opencode.mjs")],
      binary: path.join(destination, "node"),
      argv: layout.argv,
      root: destination,
      runtime: destination,
    } satisfies Layout

    if (existsSync(path.join(destination, "opencode.mjs"))) {
      yield* Effect.logInfo("v2 CLI runtime staged", { path: destination, version })

      return staged
    }

    yield* fs.remove(directory, { recursive: true, force: true })
    yield* fs.makeDirectory(directory, { recursive: true })
    yield* Effect.tryPromise(() => cp(runtime, destination, { recursive: true }))
    yield* Effect.logInfo("v2 CLI runtime staged", { path: destination, version })

    return staged
  }

  const destination = path.join(directory, executableName())

  if (existsSync(destination)) {
    yield* Effect.logInfo("v2 CLI staged executable reused", { path: destination, version })

    return {
      command: [destination],
      binary: destination,
      argv: [],
      root: directory,
      runtime: undefined,
    } satisfies Layout
  }

  const temp = destination + `.${process.pid}.tmp`
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.copyFile(layout.binary, temp)

  if (process.platform !== "win32") yield* fs.chmod(temp, 0o755)
  yield* fs
    .rename(temp, destination)
    .pipe(Effect.catch((error) => fs.remove(temp, { force: true }).pipe(Effect.andThen(Effect.fail(error)))))
  yield* Effect.logInfo("v2 CLI executable staged", { source: layout.binary, path: destination, version })

  return {
    command: [destination],
    binary: destination,
    argv: [],
    root: directory,
    runtime: undefined,
  } satisfies Layout
})

// The user-level install copies the whole runtime and leaves a launcher behind, because the Node
// binary alone cannot start the CLI without the bundle next to it.
const installRuntime = Effect.fn("DesktopCli.installRuntime")(function* (
  runtime: string,
  argv: readonly string[],
  version: string,
  home: string,
) {
  const target = join(home, ".opencode", "runtime", version)
  const launcher = join(home, ".opencode", "bin", "opencode")
  const script = `#!/bin/sh\nexec ${JSON.stringify(join(target, "node"))} ${argv.map((arg) => JSON.stringify(arg)).join(" ")} ${JSON.stringify(join(target, "opencode.mjs"))} "$@"\n`

  yield* Effect.tryPromise(async () => {
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await cp(runtime, target, { recursive: true })
    await mkdir(dirname(launcher), { recursive: true })
    await writeFile(launcher, script)
    await chmod(launcher, 0o755)
  })
  yield* Effect.logInfo("v2 CLI runtime installed", { path: launcher, version })
})

const run = Effect.fn("DesktopCli.run")(function* (command: readonly string[], args: string[]) {
  const [executable, ...prefix] = command

  if (!executable) return yield* Effect.fail(new Error("CLI command is empty"))

  yield* Effect.logInfo("v2 CLI command started", { binary: executable, args })

  const result = yield* Effect.tryPromise(() =>
    execFileAsync(executable, [...prefix, ...args], { windowsHide: true }),
  ).pipe(
    Effect.tapError((error) => {
      const output = Option.getOrUndefined(Schema.decodeUnknownOption(ExecFailure)(error.cause))

      return Effect.logError("v2 CLI command failed", {
        args,
        error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        stdout: output?.stdout?.trim() ?? "",
        stderr: output?.stderr?.trim() ?? "",
      })
    }),
  )

  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  yield* Effect.logInfo("v2 CLI command completed", { args, stdout, stderr })

  return stdout
})

const runInstaller = Effect.fn("DesktopCli.installForUser")(function* (binary: string, home: string) {
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const child = spawn("/bin/bash", ["-s", "--", "--binary", binary], {
          env: { ...process.env, HOME: home },
          stdio: ["pipe", "ignore", "pipe"],
        })

        let stderr = ""
        child.stderr.on("data", (chunk) => (stderr += chunk))
        child.on("error", reject)
        child.on("close", (code) => {
          if (code === 0) return resolve()
          reject(new Error(stderr.trim() || `CLI installer exited with code ${code}`))
        })
        child.stdin.end(installer)
      }),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
})

function executableName() {
  return process.platform === "win32" ? "opencode-cli.exe" : "opencode-cli"
}

function developmentExecutableName() {
  return process.platform === "win32" ? "opencode-cli-dev.exe" : "opencode-cli-dev"
}
