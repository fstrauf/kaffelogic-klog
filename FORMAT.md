# Unofficial Kaffelogic `.klog` format

This document describes the `.klog` fields this parser reads and the metrics it derives. It is **not** an official Kaffelogic specification.

A `.klog` file is a UTF-8 text roast log: a `key: value` header, then a tab-separated time series. Event markers such as `!roast_end` may appear anywhere as their own lines.

## Header keys

Lines before the TSV header (`time\t…`) or an `offsets` line are parsed as `key: value`. The first colon splits key and value; both sides are trimmed.

| Key | Role |
|-----|------|
| `profile_short_name` | Display profile name. Preferred over `profile_file_name`. |
| `profile_file_name` | Fallback profile name when `profile_short_name` is missing. |
| `profile_designer` | Profile author string. |
| `roasting_level` | Continuous roast level (e.g. `2.3`). |
| `roast_levels` | Comma-separated integer-level target drop temperatures (°C). Fractional `roasting_level` is linearly interpolated between adjacent entries. |
| `boost_load_size` | Load size in grams. Preferred over `reference_load_size`. |
| `reference_load_size` | Fallback load size in grams. |
| `ambient_temperature` | Ambient temperature (°C). |
| `expect_fc` | Expected first-crack temperature (°C). Used as the FC threshold. |
| `preheat_power` | Preheat power (device units, typically W). |
| `roast_required_power` | Required roast power (device units, typically W). |

Unknown header keys are retained as raw strings on `KlogHeader`.

`roast_levels` interpolation: Kaffelogic levels are continuous (e.g. `2.3`), but `roast_levels` only lists the integer level targets. Linearly interpolate between adjacent entries. Level `≤ 1` uses the first entry; level `≥` the list length uses the last.

## TSV columns

The time-series header is the first line that starts with `time\t`. Column names may carry `#`, `=`, or `^` prefixes (any combination, e.g. `#=temp`, `=mean_temp`, `#=^actual_ROR`). Prefixes are stripped before lookup.

Required columns:

| Column | Field | Meaning |
|--------|-------|---------|
| `time` | `TimeRow.time` | Seconds from charge. |
| `temp` | `TimeRow.temp` | Filtered bean temperature (°C). |
| `mean_temp` | `TimeRow.meanTemp` | Smoothed / mean bean temperature (°C). |

If `time`, `temp`, or `mean_temp` is missing, the parser throws.

Optional columns:

| Column | Field | Meaning |
|--------|-------|---------|
| `actual_ROR` | `TimeRow.actualRor` | Rate of rise (°C/min). Missing or NaN becomes `0`. |
| `profile` | `TimeRow.profileTemp` | Profile target temperature (°C). |
| `profile_ROR` | `TimeRow.profileRor` | Profile target RoR (°C/min). |
| `power_kW` | `TimeRow.powerKw` | Heater power (kW). |
| `actual_fan_RPM` | `TimeRow.fanRpm` | Fan speed (RPM). |

Rows with non-numeric `time`, `temp`, or `mean_temp` are skipped.

## `!roast_end`

A line `!roast_end: <seconds>` is the authoritative end-of-roast timestamp from the roaster.

**`roast_end` wins over peak-temp truncate.** When the marker is present, rows are cut at the first sample whose `time >= roast_end`. Only if the marker is absent does the parser fall back to the peak of the filtered `temp` column (and only if that peak meets the interpolated drop-temp target). If there is no marker and no peak at or above target, all rows are kept (partial log).

## Derived metrics

These live on `RoastFingerprint`. They are computed after drop-point truncation.

| Metric | Formula / rule |
|--------|----------------|
| Turning point (TP) | Row with the minimum `meanTemp` among samples with `time` in **5–60 s** (samples before 5 s are skipped; search stops after 60 s). |
| First crack (FC) | First row whose filtered **`temp` ≥ `expect_fc`**. **FC uses filtered `temp` vs `expect_fc`**, not `meanTemp`. `meanTemp` is a lagging average that reports first crack 5–20 seconds later than it actually occurs. If `expect_fc` is missing or `0`, FC is `null`. |
| Drop | Last remaining row after truncation. Actual drop temperature is that row's filtered `temp` (`meanTemp` lags and can read several °C low/high around the drop point). |
| Total roast time | Drop row `time` (seconds). |
| Development time | `totalRoastTime − firstCrackTime` when FC was found; otherwise `null`. |
| DTR | `(developmentTime / totalRoastTime) * 100` when both are truthy; otherwise `null`. Rounded to 1 decimal. |
| Avg RoR pre-FC | Mean of `actualRor` from TP time through FC time (inclusive). If FC is missing, from TP through drop. `null` if the window has fewer than 2 samples. Rounded to 1 decimal. |
| Avg RoR development | Mean of `actualRor` from FC time through drop. `null` if FC is missing or the window has fewer than 2 samples. Rounded to 1 decimal. |
| Drop temp target | Interpolated from `roasting_level` + `roast_levels` as above. |

## Roast loss is not in this file

**Roast loss is not a `.klog` field.** It is computed from batch weights:

```
loss% = (green − roasted) / green * 100
```

Do not expect a loss column, header key, or parser field. Logs record temperatures and machine state; green and roasted mass come from the roast record, not the `.klog`.
