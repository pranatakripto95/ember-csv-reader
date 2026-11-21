# Ember CSV Reader

[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/pranatakripto95/ember-csv-reader/rank.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/pranatakripto95/ember-csv-reader/reward.svg)](https://make.fun/c/csv-reader-speed-01-run-20261121)

A faster drop-in for make.fun's own csv-reader 1.0.0, built for the make.fun
[csv-reader-speed-01-run-20261121](https://make.fun/c/csv-reader-speed-01-run-20261121)
bounty. `solve.js` answers every case exactly as csv-reader 1.0.0 does —
same `{columns, rows, errors}`, including broken CSV (unclosed quotes,
stray CRs, quote junk, short and long rows) — only faster.

## How it is faster

The reference walks the text one character at a time and builds every
field with `value += c`. This reader instead:

- takes a fast path per record: when a record's line holds no double
  quote at all, the whole line is split natively on `,` in one go;
- otherwise reads field by field, jumping between delimiters with
  `indexOf` (native scans) instead of stepping character by character;
- finds a quoted field's closing quote with `indexOf`, slices its
  content out whole, and only transforms it (`""` to `"`, CR/CRLF to
  LF) when the content actually holds those sequences;
- never allocates per character: field values are slices (or a split)
  of the input, joined only when stray CRs have to be dropped.

## Layout

- `solve.js` — the parser: `run(input)` returns csv-reader's answer
  for `{text, header}`.
- `main.ts` — the driver the harness runs: reads every case from
  `/input/cases.json`, answers each with `run`, writes
  `/output/answers.json`.
- `package.json` — `{"type": "module"}`, so `solve.js` loads as an
  ES module.

Dependency-free, Node 22, no network, no WebAssembly, no native addons.
