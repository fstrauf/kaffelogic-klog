# kaffelogic-klog

Unofficial parser for Kaffelogic `.klog` roast logs.

**Not affiliated with, endorsed by, or associated with Kaffelogic.** This is an independent, reverse-engineered parser of the text `.klog` format produced by Kaffelogic roast logs. Kaffelogic is a trademark of its respective owner.

## Install

```bash
npm i kaffelogic-klog
```

Requires Node.js 20+. The parser itself is browser-safe (no `fs` / `path`).

## Usage

```ts
import { parseKlog } from 'kaffelogic-klog'

const raw = await file.text()
const { header, rows, fingerprint } = parseKlog(raw, file.name)

console.log(fingerprint.dtrPercent, fingerprint.avgRorPreFc)
```

CLI (path in → fingerprint summary):

```bash
npx kaffelogic-klog roast.klog
npx kaffelogic-klog roast.klog --json
```

## Example: Kenya Gatugi Peaberry

Public summary of winning batch **R-087** (from BrewedLate roast-case-study JSON). The full narrative lives at [`/roast-logs/kenya-gatugi-peaberry`](/roast-logs/kenya-gatugi-peaberry).

| Batch | DTR | Avg RoR pre-FC | Avg RoR development | Loss* |
|-------|-----|----------------|---------------------|-------|
| R-087 | 15.4% | 28.6 °C/min | 7.2 °C/min | 11.67% |

\*Loss is a **batch-weight** metric — `(green − roasted) / green * 100` — not a field in the `.klog` file.

## Format

See [FORMAT.md](./FORMAT.md) for header keys, TSV columns, `!roast_end`, and derived-metric formulas (DTR, RoR, TP, FC, drop).

## License

[MIT](./LICENSE) © 2026 Florian Strauf
