#!/usr/bin/env bun
// Fails when any Mach-O in a tree needs a newer macOS than the floor the fork supports.
//
// Usage: bun script/verify-macos-minos.ts <path> [floor]
// The floor defaults to 12.0 (macOS 12.7 Monterey).
import { readdir, stat } from "node:fs/promises"
import path from "node:path"

const floor = process.argv[3] ?? "12.0"
const root = process.argv[2]

if (!root) throw new Error("Usage: bun script/verify-macos-minos.ts <path> [floor]")

const MACH_O = new Set(["cffaedfe", "cefaedfe", "cafebabe", "bebafeca", "feedfacf"])

async function* walk(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walk(target)
    else if (entry.isFile()) yield target
  }
}

function compare(left: string, right: string) {
  const parse = (value: string) => value.split(".").map((part) => Number(part))
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

async function minos(file: string) {
  const handle = await Bun.file(file).slice(0, 4).arrayBuffer()
  const magic = [...new Uint8Array(handle)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  if (!MACH_O.has(magic)) return undefined
  const process = Bun.spawn(["otool", "-l", file], { stdout: "pipe", stderr: "ignore" })
  const output = await new Response(process.stdout).text()
  await process.exited
  const match = output.match(/minos (\d+(?:\.\d+)?)/)
  return match?.[1]
}

const failures: string[] = []
let checked = 0

for await (const file of walk(root)) {
  const info = await stat(file)
  if (!info.isFile() || info.size < 4) continue
  const version = await minos(file)
  if (!version) continue
  checked++
  if (compare(version, floor) > 0) failures.push(`${file} requires macOS ${version}`)
}

if (failures.length > 0) {
  console.error(`${failures.length} binary(s) above the macOS ${floor} floor:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`Checked ${checked} Mach-O binaries under ${root}: all support macOS ${floor} or older`)
