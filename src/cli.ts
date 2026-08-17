#!/usr/bin/env node
/**
 * Kaffelogic .klog file parser
 *
 * Parses a raw Kaffelogic roast log and extracts a structured "roast fingerprint".
 *
 * Usage:
 *   npx tsx src/cli.ts <path-to-log.klog>
 *   npx tsx src/cli.ts <path-to-log.klog> --json
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseKlog } from './index.js'
import type { RoastFingerprint } from './index.js'

/**
 * Thin file-path wrapper around the browser-safe parseKlog.
 */
function parseKlogFile(filePath: string): RoastFingerprint {
  const raw = readFileSync(resolve(filePath), 'utf-8')
  return parseKlog(raw, basename(filePath)).fingerprint
}

// ── Human-readable summary ────────────────────────────────────────────────────

function formatSummary(fp: RoastFingerprint): string {
  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════',
    ' Roast Fingerprint',
    '═══════════════════════════════════════════════════',
    ` File:          ${fp.logFileName}`,
    ` Profile:       ${fp.profileName}`,
    ` Level:         L${fp.roastLevel} → target drop ${fp.dropTempTarget}°C`,
    ` Load:          ${fp.loadSizeGrams}g`,
    ` Ambient:       ${fp.ambientTempC}°C`,
    '───────────────────────────────────────────────────',
    ' Timing',
    `   Total time:  ${formatTime(fp.totalRoastTimeSeconds)}`,
    `   Turning pt:  ${formatTime(fp.turningPointTimeSeconds)} @ ${fp.turningPointTempC}°C`,
    fp.firstCrackTimeSeconds != null
      ? `   First crack: ${formatTime(fp.firstCrackTimeSeconds)} @ ${fp.firstCrackTempC}°C`
      : '   First crack: not reached in this log',
    fp.developmentTimeSeconds != null
      ? `   Development: ${formatTime(fp.developmentTimeSeconds)} (DTR ${fp.dtrPercent}%)`
      : '   Development: n/a',
    '───────────────────────────────────────────────────',
    ' Rate of Rise (°C/min)',
    `   Pre-FC:      ${fp.avgRorPreFc ?? 'n/a'}`,
    `   Development: ${fp.avgRorDevelopment ?? 'n/a'}`,
    '───────────────────────────────────────────────────',
    ` Actual drop:   ${fp.dropTempActual}°C`,
    '═══════════════════════════════════════════════════',
    '',
  ]
  return lines.join('\n')
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === '--help') {
    console.log(`
Usage: kaffelogic-klog <path-to-log.klog> [--json]

Options:
  --json   Output raw JSON fingerprint instead of human-readable summary
`.trim())
    process.exit(0)
  }

  const filePath = args[0]
  const jsonOnly = args.includes('--json')

  try {
    const fingerprint = parseKlogFile(filePath)

    if (jsonOnly) {
      console.log(JSON.stringify(fingerprint, null, 2))
    } else {
      console.log(formatSummary(fingerprint))
      console.log('JSON fingerprint:')
      console.log(JSON.stringify(fingerprint, null, 2))
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${message}`)
    process.exit(1)
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  void main()
}
