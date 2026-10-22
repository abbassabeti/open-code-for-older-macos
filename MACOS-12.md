# macOS 12.7 (Monterey) support

This fork builds OpenCode for macOS 12.7 Monterey. Upstream ships macOS 13 (Ventura) binaries only,
so four upstream components had to change.

## What changed and why

| Component | Upstream | Here | Reason |
| --- | --- | --- | --- |
| CLI runtime | Bun executable (`opencode-cli`) | Node 22 runtime directory (`node` + `opencode.mjs` + `assets`) | Bun requires macOS 13.0. Node 22 binaries are compiled with an 11.0 deployment target, so they start on 12.7. |
| Desktop shell | Electron 44.9.1 | Electron 43.8.3 | Electron 44 requires Ventura; Electron 43 is the last line that still ships Monterey binaries. |
| fff search library | `@ff-labs/fff-bin-*` prebuilt dylib (macOS 13.0) | rebuilt from source with `MACOSX_DEPLOYMENT_TARGET=12.0` | The published dylib refuses to load on 12.7. |
| TUI native library | `@opentui/core-*` prebuilt dylib (macOS 13.0) | rebuilt from the v0.6.6 tag with Zig 0.16.0 | The published dylib refuses to load on 12.7. The TUI still cannot start there, for a different reason: see the known limits. |
| App bundle | no floor | `LSMinimumSystemVersion` 12.0 | Keeps the app from launching on systems it cannot run on. |

Two smaller changes come with the Node runtime:

- `nodeExecArgv` dropped `--experimental-ffi`. Node 22 has no such flag; the FFI path already uses the
  `ffi-rs` native addon, so nothing needed it.
- The Node bundle is compiled with `target: "node22"` instead of `node26`.

The CLI is no longer a single executable. The desktop app spawns
`<Resources>/opencode-cli/node <argv> <Resources>/opencode-cli/opencode.mjs`, and the user-level
install copies that directory to `~/.opencode/runtime/<version>` with a launcher in
`~/.opencode/bin/opencode`.

## Installing

Prebuilt apps are published as release assets on
[the macos-12.7 branch](https://github.com/abbassabeti/open-code-for-older-macos/releases):

| Asset | Machine |
| --- | --- |
| `OpenCode-macos12.7-x64.zip` | Intel |
| `OpenCode-macos12.7-arm64.zip` | Apple Silicon |

```bash
unzip OpenCode-macos12.7-x64.zip
mv OpenCode.app /Applications/
xattr -dr com.apple.quarantine /Applications/OpenCode.app   # the builds are unsigned
open /Applications/OpenCode.app
```

The app bundles its own Node runtime, so nothing has to be installed on the machine. The terminal
client comes from the app's "Install CLI" command, which copies the runtime to
`~/.opencode/runtime/<version>` and leaves a launcher in `~/.opencode/bin/opencode`.

The terminal **UI does not work on 12.7** (see the known limits). The server and the non-interactive
commands do: `opencode serve`, `opencode run "..."`.

## Building

Building needs macOS 13 or newer: Bun, the build runtime of this repository, does not start on
Monterey. Build on a modern Mac and copy the app over.

```bash
bun install
script/build-macos12.sh arm64   # or: script/build-macos12.sh x64
```

The script rebuilds fff and opentui, builds the Node CLI runtime layout, builds the Electron app,
packages it unsigned, and audits every Mach-O it produced. Rust and Zig are downloaded into the
repository cache when they are missing, so the only prerequisite is Bun.

Individual steps:

```bash
script/build-fff-macos12.sh arm64
script/build-opentui-macos12.sh arm64
OPENCODE_FFF_DYLIB="$PWD/packages/cli/.cache/fff/aarch64-apple-darwin/libfff_c.dylib" \
  OPENCODE_OPENTUI_LIB="$PWD/packages/cli/.cache/opentui/aarch64-macos.12.0/libopentui.dylib" \
  bun packages/cli/script/build-node.ts --runtime-layout --target=darwin-arm64 --outdir=dist/node
cd packages/desktop
OPENCODE_CLI_TARGET=aarch64-apple-darwin OPENCODE_CLI_DIST="$PWD/../../packages/cli/dist" \
  bun ./scripts/prepare.ts && bun run build
npx electron-builder --mac --dir --publish never --config electron-builder.config.ts
bun script/verify-macos-minos.ts packages/desktop/dist/mac*/*.app
```

## Verifying

`script/verify-macos-minos.ts` walks a built tree, finds every Mach-O, reads its `LC_BUILD_VERSION`
minimum and fails when any of them needs a newer macOS than the floor. That is the closest proxy to
running on 12.7 that a modern build machine can offer; the real check needs a Monterey machine.

```bash
bun script/verify-macos-minos.ts packages/desktop/dist/mac-arm64/OpenCode.app
```

## Known limits

- **The TUI does not run on 12.7.** The terminal UI renders through opentui's native library, which
  needs an FFI backend: Bun's `dlopen` (Bun itself requires macOS 13) or Node's built-in `node:ffi`
  (Node 26.1+ with `--experimental-ffi`, and those binaries target macOS 13.5). No runtime that can
  load it starts on 12.7, so the terminal UI stays out of reach here until opentui's Node backend
  moves to a plain addon such as the `ffi-rs` package the CLI already ships for fff. The desktop app
  and the server API are unaffected: neither loads the opentui library.
- **Unsigned builds.** The packaging step here is unsigned and unnotarised, so Gatekeeper blocks the
  first launch: `xattr -dr com.apple.quarantine /Applications/OpenCode.app`.
- **Chromium support.** Electron 43 still runs on Monterey, but Chromium no longer ships security
  fixes for that macOS version.
