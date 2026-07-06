# ap-prediction

Public dashboard for 12-hour ap30 geomagnetic index forecasts.
공개 대시보드: 12시간 ap30 지자기 지수 예측.

- Deployed site: https://www.eunsu.me/ap-prediction/
  (also at https://eunsu-park.github.io/ap-prediction/)
- Inference engine + model weights: bundled in-tree under `vendor/realtime-regression-sw/`
  (engine developed in [eunsu-park/geoindex-realtime](https://github.com/eunsu-park/geoindex-realtime))
- Update cadence: a new anchor every 30 min; the cron fires every 10 min with
  three attempts per anchor (cron `8,18,28,38,48,58 * * * *`)
- Architecture details / 상세 설계: [docs/architecture.md](docs/architecture.md)

This repo is **self-contained** (same mechanism as the production
`njit-research/ap-prediction`): the engine is inlined and the checkpoint
(`model_best.pth` + `table_stats.pkl`) is committed in-tree, so a run needs only
a checkout — no submodule, no GitHub Release download.

## How it works (동작 원리)

1. `.github/workflows/forecast.yml` runs on a 10-min cron (three attempts per
   30-min anchor; a later attempt only overwrites an earlier one at equal-or-
   better status, so a transient failure never clobbers a good forecast).
2. It checks out this repo — the inference engine and the model checkpoint are
   committed in-tree — and runs `scripts/run_realtime.py`. If an upstream feed
   is unreachable the run exits with a "data gap" warning (exit 2) instead of
   failing hard.
3. `scripts/update_site_data.py` copies the newest forecast JSON into
   `site/data/latest.json`, refreshes `site/data/status.json`, and appends to
   the past-forecast archives (`forecast_history.json` / `.csv`).
4. The `site/` directory is published as a GitHub Pages artifact.
5. `site/index.html` fetches `data/latest.json` on load and renders a Chart.js
   line plot of the 24-step (12-hour) ap30 forecast.

## Repository layout (저장소 구조)

```
ap-prediction/
├── .github/workflows/forecast.yml   cron-triggered pipeline
├── vendor/realtime-regression-sw/   inlined inference engine
│   └── checkpoint/                  committed model_best.pth + table_stats.pkl
├── configs/realtime.ci.yaml         CI path overrides
├── scripts/update_site_data.py      post-process inference output
├── site/
│   ├── index.html                   page shell
│   ├── main.js                      Chart.js render + metadata
│   └── data/
│       ├── latest.json              most recent forecast (committed each run)
│       └── status.json              pipeline status for the banner
└── README.md
```

## One-time setup (최초 설정)

### Enable GitHub Pages

Settings → Pages → Build and deployment → Source: **GitHub Actions**.

No asset upload or submodule step is needed — the engine and checkpoint are
committed in-tree.

## Updating the engine / model (엔진·모델 갱신)

Because the engine and weights are vendored in-tree, an upgrade is a payload
refresh, not a submodule bump:

1. Develop and validate in `eunsu-park/geoindex-realtime`.
2. Re-inline the engine (`vendor/realtime-regression-sw/`) and replace the
   checkpoint pair under `vendor/realtime-regression-sw/checkpoint/`.
3. Commit. Matched-pair invariant: `model_best.pth` and `table_stats.pkl` must
   come from the same training run (no runtime validation).

## Trigger a run manually

Actions tab → "Forecast" workflow → "Run workflow".
Optionally provide an ISO8601 `now` to replay a specific anchor.

## Failure handling

`run_realtime.py` exit codes mapped by `scripts/update_site_data.py`:

- `0` → `status.json.status = "ok"`, `latest.json` updated
- `2` → `status.json.status = "warn"` (InsufficientDataError —
  upstream data gap), `latest.json` preserved
- other → `status.json.status = "error"`, `latest.json` preserved

The workflow itself always succeeds (the Actions badge stays green); the page
banner is the true health indicator.
