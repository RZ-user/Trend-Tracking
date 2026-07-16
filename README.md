# Trend Tracking Dashboard

A personal trend-tracking dashboard for Nasdaq 100 and CSI 300 market snapshots.

## Public GitHub Pages build

The public build is a read-only market snapshot. It includes public market data,
trend states, risk indicators, and strategy calculations. Personal allocation
inputs are stored only in the visitor's browser with `localStorage`; they are not
written into the repository or the generated snapshot files.

```bash
npm ci
npm run export:pages
```

The generated static site is written to `docs/`. GitHub Actions rebuilds and
publishes it on manual runs, pushes to `main`, and weekday scheduled runs.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run build
```

The full local/private application can refresh market data through its API. The
GitHub Pages version has no server, so its refresh button reloads the latest
published snapshot.
