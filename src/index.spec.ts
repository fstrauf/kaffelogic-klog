import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  downsampleRows,
  klogEvents,
  parseKlog,
  type RoastFingerprint,
  type TimeRow,
} from './index.js'

function row(time: number): TimeRow {
  return { time, temp: 180, meanTemp: 180, actualRor: 8 }
}

function fingerprint(overrides: Partial<RoastFingerprint> = {}): RoastFingerprint {
  return {
    profileName: 'test',
    roastLevel: 2,
    dropTempTarget: 200,
    loadSizeGrams: 120,
    ambientTempC: 20,
    expectedFcTempC: 196,
    totalRoastTimeSeconds: 0,
    dropTempActual: 205,
    turningPointTimeSeconds: 0,
    turningPointTempC: 90,
    firstCrackTimeSeconds: null,
    firstCrackTempC: null,
    developmentTimeSeconds: null,
    dtrPercent: null,
    avgRorPreFc: null,
    avgRorDevelopment: null,
    logFileName: 'test.klog',
    parsedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'minimal.klog')
const MINIMAL_KLOG = readFileSync(fixturePath, 'utf-8')

describe('downsampleRows', () => {
  it('keeps first + last and ~2s steps on a 1 Hz 10s series', () => {
    const rows = Array.from({ length: 11 }, (_, i) => row(i))
    const downsampled = downsampleRows(rows, 2)
    expect(downsampled.map((r) => r.time)).toEqual([0, 2, 4, 6, 8, 10])
    expect(downsampled[0]).toBe(rows[0])
    expect(downsampled[downsampled.length - 1]).toBe(rows[rows.length - 1])
  })

  it('returns [] for an empty series', () => {
    expect(downsampleRows([])).toEqual([])
  })

  it('leaves an already-sparse series unchanged', () => {
    const rows = [row(0), row(5), row(10)]
    expect(downsampleRows(rows, 2)).toEqual(rows)
  })
})

describe('klogEvents', () => {
  it('emits TP, FC, and drop when fingerprint times are present', () => {
    expect(klogEvents(fingerprint({
      turningPointTimeSeconds: 45,
      firstCrackTimeSeconds: 360,
      totalRoastTimeSeconds: 480,
    }))).toEqual([
      { kind: 'tp', timeSeconds: 45 },
      { kind: 'fc', timeSeconds: 360 },
      { kind: 'drop', timeSeconds: 480 },
    ])
  })

  it('emits FC-only when that is the only truthy time', () => {
    expect(klogEvents(fingerprint({
      firstCrackTimeSeconds: 360,
    }))).toEqual([{ kind: 'fc', timeSeconds: 360 }])
  })

  it('returns [] when all times are null or 0', () => {
    expect(klogEvents(fingerprint({
      turningPointTimeSeconds: 0,
      firstCrackTimeSeconds: null,
      totalRoastTimeSeconds: 0,
    }))).toEqual([])
  })
})

describe('parseKlog', () => {
  const parsed = parseKlog(MINIMAL_KLOG, 'minimal.klog')

  it('reads the header keys the parser uses', () => {
    expect(parsed.header.profileName).toBe('Test')
    expect(parsed.header.profileDesigner).toBe('Fixture')
    expect(parsed.header.roastLevel).toBe(2.5)
    expect(parsed.header.roastLevels).toEqual([180, 190, 200, 210, 220])
    expect(parsed.header.loadSizeGrams).toBe(120)
    expect(parsed.header.ambientTempC).toBe(20)
    expect(parsed.header.expectedFcTempC).toBe(196)
    expect(parsed.header.preheatPower).toBe(800)
    expect(parsed.header.roastRequiredPower).toBe(750)
    expect(parsed.header['profile_short_name']).toBe('Test')
    expect(parsed.header['profile_file_name']).toBe('Test.kpro')
    expect(parsed.header['boost_load_size']).toBe('120')
    expect(parsed.header['reference_load_size']).toBe('120')
    expect(parsed.header['expect_fc']).toBe('196')
  })

  it('interpolates roast_levels for a fractional roasting_level', () => {
    // level 2.5 → halfway between roast_levels[1]=190 and [2]=200
    expect(parsed.fingerprint.dropTempTarget).toBe(195)
    expect(parsed.fingerprint.roastLevel).toBe(2.5)
  })

  it('truncates at !roast_end even when later rows are hotter', () => {
    expect(parsed.fingerprint.totalRoastTimeSeconds).toBe(480)
    expect(parsed.rows.some((r) => r.time > 480)).toBe(true)
    expect(Math.max(...parsed.rows.map((r) => r.temp))).toBeGreaterThan(
      parsed.fingerprint.dropTempActual,
    )
  })

  it('detects FC when filtered temp crosses expect_fc', () => {
    expect(parsed.fingerprint.expectedFcTempC).toBe(196)
    expect(parsed.fingerprint.firstCrackTimeSeconds).toBe(360)
    expect(parsed.fingerprint.firstCrackTempC).toBe(196)
    const fcRow = parsed.rows.find((r) => r.time === 360)
    expect(fcRow?.temp).toBeGreaterThanOrEqual(196)
    const beforeFc = parsed.rows.filter((r) => r.time < 360)
    expect(beforeFc.every((r) => r.temp < 196)).toBe(true)
  })

  it('computes DTR as development / total * 100', () => {
    const { fingerprint: fp } = parsed
    expect(fp.developmentTimeSeconds).toBe(120)
    expect(fp.totalRoastTimeSeconds).toBe(480)
    expect(fp.dtrPercent).toBe(25)
    expect(fp.dtrPercent).toBe(
      Math.round(((fp.developmentTimeSeconds! / fp.totalRoastTimeSeconds) * 100) * 10) / 10,
    )
    expect(fp.avgRorPreFc).not.toBeNull()
    expect(fp.avgRorDevelopment).not.toBeNull()
  })

  it('finds TP as min meanTemp in the 5–60s window', () => {
    const window = parsed.rows.filter((r) => r.time >= 5 && r.time <= 60)
    const minMean = Math.min(...window.map((r) => r.meanTemp))
    const tp = window.find((r) => r.meanTemp === minMean)
    expect(parsed.fingerprint.turningPointTimeSeconds).toBe(tp?.time)
    expect(parsed.fingerprint.turningPointTempC).toBe(Math.round((tp?.meanTemp ?? 0) * 100) / 100)
    expect(parsed.fingerprint.turningPointTimeSeconds).toBe(30)
  })

  it('throws when required TSV columns are missing', () => {
    const missing = [
      'profile_short_name: Test',
      'expect_fc: 196',
      'time\t#=temp',
      '0\t90',
    ].join('\n')
    expect(() => parseKlog(missing)).toThrow(
      'Required columns "time", "temp", and "mean_temp" not found in log',
    )
  })
})
