/**
 * Browser-safe Kaffelogic .klog parser
 * 
 * This module exports parsing functions that work in both Node.js and browser environments.
 * For browser use, pass the raw file content as a string.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoastFingerprint {
  profileName: string
  roastLevel: number
  dropTempTarget: number
  loadSizeGrams: number
  ambientTempC: number
  expectedFcTempC: number
  totalRoastTimeSeconds: number
  dropTempActual: number
  turningPointTimeSeconds: number
  turningPointTempC: number
  firstCrackTimeSeconds: number | null
  firstCrackTempC: number | null
  developmentTimeSeconds: number | null
  dtrPercent: number | null
  avgRorPreFc: number | null
  avgRorDevelopment: number | null
  logFileName: string
  parsedAt: string
}

export interface TimeRow {
  time: number
  temp: number        // °C — filtered bean temperature (column #=temp)
  meanTemp: number    // °C — smoothed/mean bean temperature (column =mean_temp)
  actualRor: number   // °C/min — rate of rise (column =actual_ROR)
  profileTemp?: number
  profileRor?: number
  powerKw?: number
  fanRpm?: number
}

export interface KlogHeader {
  profileName: string
  profileDesigner: string
  roastLevel: number
  roastLevels: number[]
  loadSizeGrams: number
  ambientTempC: number
  expectedFcTempC: number
  preheatPower: number
  roastRequiredPower: number
  [key: string]: string | number | number[]
}

export interface ParsedKlog {
  header: KlogHeader
  rows: TimeRow[]
  fingerprint: RoastFingerprint
}

// ── Header parsing ────────────────────────────────────────────────────────────

function parseHeader(lines: string[]): KlogHeader {
  const kv: Record<string, string> = {}

  for (const line of lines) {
    if (line.startsWith('offsets') || line.startsWith('time\t')) break
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      kv[key] = value
    }
  }

  const roastLevels = (kv['roast_levels'] ?? '')
    .split(',')
    .map(Number)
    .filter(n => !isNaN(n))

  return {
    profileName: kv['profile_short_name'] ?? kv['profile_file_name'] ?? 'unknown',
    profileDesigner: kv['profile_designer'] ?? '',
    roastLevel: Number(kv['roasting_level'] ?? 0),
    roastLevels,
    loadSizeGrams: Number(kv['boost_load_size'] ?? kv['reference_load_size'] ?? 0),
    ambientTempC: Number(kv['ambient_temperature'] ?? 0),
    expectedFcTempC: Number(kv['expect_fc'] ?? 0),
    preheatPower: Number(kv['preheat_power'] ?? 0),
    roastRequiredPower: Number(kv['roast_required_power'] ?? 0),
    ...kv,
  }
}

// ── Time-series parsing ───────────────────────────────────────────────────────

function stripColPrefix(name: string): string {
  return name.replace(/^[#=^]+/, '')
}

function parseTimeSeries(lines: string[]): TimeRow[] {
  let headerIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('time\t')) {
      headerIdx = i
      break
    }
  }
  if (headerIdx < 0) return []

  const colNames = lines[headerIdx].split('\t').map(stripColPrefix)
  const idxTime = colNames.indexOf('time')
  const idxTemp = colNames.indexOf('temp')
  const idxMeanTemp = colNames.indexOf('mean_temp')
  const idxActualRor = colNames.indexOf('actual_ROR')
  const idxProfile = colNames.indexOf('profile')
  const idxProfileRor = colNames.indexOf('profile_ROR')
  const idxPower = colNames.indexOf('power_kW')
  const idxFan = colNames.indexOf('actual_fan_RPM')

  if (idxTime < 0 || idxTemp < 0 || idxMeanTemp < 0) {
    throw new Error('Required columns "time", "temp", and "mean_temp" not found in log')
  }

  const rows: TimeRow[] = []

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const parts = line.split('\t')
    const time = parseFloat(parts[idxTime])
    const temp = parseFloat(parts[idxTemp])
    const meanTemp = parseFloat(parts[idxMeanTemp])
    const actualRor = idxActualRor >= 0 ? parseFloat(parts[idxActualRor]) : NaN

    if (isNaN(time) || isNaN(temp) || isNaN(meanTemp)) continue

    rows.push({
      time,
      temp,
      meanTemp,
      actualRor: isNaN(actualRor) ? 0 : actualRor,
      profileTemp: idxProfile >= 0 ? parseFloat(parts[idxProfile]) : undefined,
      profileRor: idxProfileRor >= 0 ? parseFloat(parts[idxProfileRor]) : undefined,
      powerKw: idxPower >= 0 ? parseFloat(parts[idxPower]) : undefined,
      fanRpm: idxFan >= 0 ? parseFloat(parts[idxFan]) : undefined,
    })
  }

  return rows
}

// ── Fingerprint computation ───────────────────────────────────────────────────

function computeFingerprint(
  header: KlogHeader,
  rows: TimeRow[],
  fileName: string,
  rawLines: string[]
): RoastFingerprint {
  const dropTempTarget = interpolateDropTempTarget(header.roastLevel, header.roastLevels)

  // Prefer the explicit !roast_end marker when present; it's authoritative.
  const roastEndTime = parseRoastEndTime(rawLines)

  // Truncate at the drop point. If the log has an explicit roast_end marker we use
  // that; otherwise fall back to the temperature-peak heuristic.
  const roastRows = truncateAtDropPoint(rows, dropTempTarget, roastEndTime)
  const lastRow = roastRows[roastRows.length - 1]
  const totalTime = lastRow.time
  // Use the filtered temp column for actual drop temp — mean_temp lags and can
  // read several °C low/high around the drop point.
  const dropTempActual = lastRow.temp

  const turningPoint = findTurningPoint(roastRows)
  // Use the filtered temp column for FC detection — mean_temp is a lagging average
  // that reports first crack 5–20 seconds later than it actually occurs.
  const fc = findFirstCrack(roastRows, header.expectedFcTempC)

  const developmentTime = fc ? totalTime - fc.time : null
  const dtrPercent = (developmentTime && totalTime)
    ? (developmentTime / totalTime) * 100
    : null

  const avgRorPreFc = fc
    ? averageRor(roastRows, turningPoint.time, fc.time)
    : averageRor(roastRows, turningPoint.time, totalTime)

  const avgRorDevelopment = fc
    ? averageRor(roastRows, fc.time, totalTime)
    : null

  return {
    profileName: header.profileName,
    roastLevel: header.roastLevel,
    dropTempTarget,
    loadSizeGrams: header.loadSizeGrams,
    ambientTempC: header.ambientTempC,
    expectedFcTempC: header.expectedFcTempC,
    totalRoastTimeSeconds: round(totalTime),
    dropTempActual: round(dropTempActual),
    turningPointTimeSeconds: round(turningPoint.time),
    turningPointTempC: round(turningPoint.meanTemp),
    firstCrackTimeSeconds: fc ? round(fc.time) : null,
    firstCrackTempC: fc ? round(fc.temp) : null,
    developmentTimeSeconds: developmentTime ? round(developmentTime) : null,
    dtrPercent: dtrPercent ? round(dtrPercent, 1) : null,
    avgRorPreFc: avgRorPreFc ? round(avgRorPreFc, 1) : null,
    avgRorDevelopment: avgRorDevelopment ? round(avgRorDevelopment, 1) : null,
    logFileName: fileName,
    parsedAt: new Date().toISOString(),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Interpolate the target drop temperature for fractional roast levels.
 * Kaffelogic levels are continuous (e.g. 2.3), but roast_levels only lists
 * the integer level targets. Linearly interpolate between adjacent entries.
 */
function interpolateDropTempTarget(level: number, levels: number[]): number {
  if (levels.length === 0) return 0
  if (level <= 1) return levels[0] ?? 0
  if (level >= levels.length) return levels[levels.length - 1] ?? 0

  const lowerIdx = Math.floor(level) - 1
  const upperIdx = lowerIdx + 1
  const fraction = level - Math.floor(level)

  const lower = levels[lowerIdx]
  const upper = levels[upperIdx]
  if (lower == null || upper == null) return 0

  return lower + fraction * (upper - lower)
}

/**
 * Parse the explicit !roast_end marker if the log contains one.
 * This is the authoritative end-of-roast timestamp from the Kaffelogic.
 */
function parseRoastEndTime(lines: string[]): number | null {
  for (const line of lines) {
    if (line.startsWith('!roast_end:')) {
      const value = line.slice('!roast_end:'.length).trim()
      const parsed = parseFloat(value)
      if (!isNaN(parsed)) return parsed
    }
  }
  return null
}

/**
 * Truncate rows at the actual drop point.
 * Priority:
 *   1. Explicit !roast_end marker from the log
 *   2. Peak of the filtered temp column (if it exceeds the target drop temp)
 *   3. Keep all rows (partial log / no clear peak)
 */
function truncateAtDropPoint(rows: TimeRow[], dropTempTarget: number, roastEndTime: number | null): TimeRow[] {
  if (roastEndTime != null) {
    const idx = rows.findIndex(r => r.time >= roastEndTime)
    if (idx >= 0) return rows.slice(0, idx + 1)
  }

  // Fallback: find peak filtered temp and truncate there.
  let peakIdx = 0
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].temp > rows[peakIdx].temp) peakIdx = i
  }
  if (rows[peakIdx].temp < dropTempTarget) return rows
  return rows.slice(0, peakIdx + 1)
}

function findTurningPoint(rows: TimeRow[]): TimeRow {
  let minRow = rows[0]
  for (const row of rows) {
    if (row.time < 5) continue
    if (row.time > 60) break
    if (row.meanTemp < minRow.meanTemp) minRow = row
  }
  return minRow
}

function findFirstCrack(rows: TimeRow[], fcTempC: number): TimeRow | null {
  if (!fcTempC) return null
  for (const row of rows) {
    if (row.temp >= fcTempC) return row
  }
  return null
}

function averageRor(rows: TimeRow[], fromTime: number, toTime: number): number | null {
  const window = rows.filter(r => r.time >= fromTime && r.time <= toTime)
  if (window.length < 2) return null
  const sum = window.reduce((s, r) => s + r.actualRor, 0)
  return sum / window.length
}

function round(n: number, decimals = 2): number {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a .klog file from raw content string.
 * Works in both Node.js and browser environments.
 */
export function parseKlog(rawContent: string, fileName = 'roast.klog'): ParsedKlog {
  const lines = rawContent.split(/\r?\n/)
  const header = parseHeader(lines)
  const rows = parseTimeSeries(lines)

  if (rows.length === 0) {
    throw new Error('No time-series data found in log file')
  }

  const fingerprint = computeFingerprint(header, rows, fileName, lines)

  return {
    header,
    rows,
    fingerprint,
  }
}

/**
 * Format seconds as mm:ss
 */
export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Keep the first point, then points ≥ intervalSeconds after the last kept, always the last.
 */
export function downsampleRows(rows: TimeRow[], intervalSeconds = 2): TimeRow[] {
  if (rows.length === 0) return []
  if (rows.length === 1) return [rows[0]]

  const kept: TimeRow[] = [rows[0]]
  let lastKeptTime = rows[0].time

  for (let i = 1; i < rows.length - 1; i++) {
    if (rows[i].time >= lastKeptTime + intervalSeconds) {
      kept.push(rows[i])
      lastKeptTime = rows[i].time
    }
  }

  const last = rows[rows.length - 1]
  if (kept[kept.length - 1] !== last) {
    kept.push(last)
  }
  return kept
}

export type KlogEventKind = 'tp' | 'fc' | 'drop'

/**
 * TP / FC / drop from fingerprint times (truthy, same as RoastLogChart).
 */
export function klogEvents(
  fp: RoastFingerprint
): Array<{ kind: KlogEventKind; timeSeconds: number }> {
  const events: Array<{ kind: KlogEventKind; timeSeconds: number }> = []
  if (fp.turningPointTimeSeconds) {
    events.push({ kind: 'tp', timeSeconds: fp.turningPointTimeSeconds })
  }
  if (fp.firstCrackTimeSeconds) {
    events.push({ kind: 'fc', timeSeconds: fp.firstCrackTimeSeconds })
  }
  if (fp.totalRoastTimeSeconds) {
    events.push({ kind: 'drop', timeSeconds: fp.totalRoastTimeSeconds })
  }
  return events
}
