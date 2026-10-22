#!/usr/bin/env bun
import { $ } from "bun"

import { copyCliRuntimeToResources, resolveChannel } from "./utils"

const channel = resolveChannel()

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

// Every channel ships the Node runtime layout: the Bun executable it replaces needs macOS 13.
if (!Bun.env.OPENCODE_CLI_DIST) {
  throw new Error("OPENCODE_CLI_DIST is required; build the CLI with packages/cli/script/build-node.ts --runtime-layout")
}

await copyCliRuntimeToResources(Bun.env.OPENCODE_CLI_DIST)
