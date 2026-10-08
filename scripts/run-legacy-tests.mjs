// Runs the pre-vitest offline self-tests (they import lib/, so `npm test`
// builds the host half first). Any failing script fails the whole run.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scripts = readdirSync(here).filter((name) => /^test-.*\.mjs$/.test(name)).sort()
let failed = 0
for (const name of scripts) {
  const run = spawnSync(process.execPath, [join(here, name)], { encoding: 'utf8' })
  if (run.status === 0) {
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}\n${run.stdout}\n${run.stderr}`)
  }
}
if (failed > 0) process.exit(1)
