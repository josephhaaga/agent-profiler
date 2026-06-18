# fake-utils

A small TypeScript utility library. Work in progress.

## Usage

```ts
import { clamp, sum, truncate, groupBy, formatDuration, deepMerge } from "./src/index.ts";
```

## Known issues

- `clamp()` returns the wrong value when `value === max`
- `sum()` throws on empty arrays
- `formatDuration()` is not implemented yet

## Build

```bash
npm install
npm run build
npm test
```
