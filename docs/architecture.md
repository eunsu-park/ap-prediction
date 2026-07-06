# Architecture / 시스템 구조

This document explains how `ap-prediction` works end-to-end: which pieces
exist, how data flows from the live upstream feeds to the browser, and how
the dashboard page connects to the main personal site at `www.eunsu.me`.

이 문서는 `ap-prediction`이 전체적으로 어떻게 동작하는지 설명합니다. 구성
요소, 실시간 피드에서 브라우저까지의 데이터 흐름, 대시보드 페이지가 개인
사이트(`www.eunsu.me`)와 어떻게 연결되는지 다룹니다.

For the runtime behaviour of a single forecast (data collection, imputation,
status classification, the retry rule), see
[docs/forecast-process.md](forecast-process.md).
단일 예보의 런타임 동작(데이터 수집·보간·상태 판정·재시도 규칙)은
[docs/forecast-process.md](forecast-process.md)를 참고하세요.

---

## 1. Overview / 개요

`ap-prediction` publishes a live 12-hour ap30 geomagnetic-index forecast
chart at `https://www.eunsu.me/ap-prediction/`. A GitHub Actions cron
re-runs the inference pipeline every 10 minutes (three attempts per 30-min
anchor), writes a fresh `latest.json`, and deploys the updated static site
to GitHub Pages.

`ap-prediction`은 12시간 ap30 지자기 지수 예측 차트를
`https://www.eunsu.me/ap-prediction/`에 공개합니다. GitHub Actions cron이
10분마다(30분 anchor당 3회 시도) 추론 파이프라인을 재실행하고 새
`latest.json`을 기록한 뒤, 업데이트된 정적 사이트를 GitHub Pages에
배포합니다.

**Design tenets / 설계 원칙**

- **Self-contained in-tree.** The inference engine is inlined under
  `vendor/realtime-regression-sw/`, and the model weights
  (`model_best.pth`) and normalizer stats (`table_stats.pkl`) are committed
  in-tree under `vendor/realtime-regression-sw/checkpoint/`. A forecast run
  needs only a plain checkout — no git submodule, no GitHub Release
  download, no cache step.
  **자기완결형(in-tree).** 추론 엔진은 `vendor/realtime-regression-sw/`에
  인라인되어 있고, 모델 가중치(`model_best.pth`)와 정규화 통계
  (`table_stats.pkl`)는 `vendor/realtime-regression-sw/checkpoint/`에 함께
  커밋됩니다. 예보 실행에는 단순 checkout만 필요 — submodule·Release
  다운로드·캐시 단계 없음.
- **Matched-pair invariant.** `model_best.pth` and `table_stats.pkl` must
  come from the same training run. Mismatched files silently produce
  miscalibrated forecasts; there is no runtime check, so the pairing is
  enforced by process (they are swapped together, see §5).
  **매칭 페어 불변식.** `model_best.pth`와 `table_stats.pkl`은 동일 학습
  실행에서 나와야 합니다. 불일치 시 조용히 miscalibrated 예측이 나오며
  런타임 검증이 없으므로, 페어링은 절차로 보장합니다(항상 함께 교체, §5).
- **Static site.** Everything the browser consumes is JSON on disk
  (`site/data/latest.json` + `status.json`). No backend API, no database,
  no server-side rendering.
  **정적 사이트.** 브라우저는 디스크의 JSON(`site/data/latest.json` +
  `status.json`)만 소비합니다. 백엔드 API·DB·서버사이드 렌더링 없음.

---

## 2. Component map / 구성 요소

This repository is self-contained: the workflow, the inlined engine, the
committed checkpoint, and the site all live together. Two other
repositories are involved only at the edges — one upstream (where the engine
is developed) and one downstream (the homepage that links to the dashboard).

본 레포는 자기완결형입니다. 워크플로·인라인 엔진·커밋된 체크포인트·사이트가
한곳에 있습니다. 다른 두 레포는 경계에서만 관여합니다 — 하나는 상류(엔진
개발처), 하나는 하류(대시보드로 링크하는 홈페이지).

```
┌─────────────────────────────────────────────────────────────────────────┐
│  github.com/eunsu-park/geoindex-realtime        (engine dev / 엔진 개발) │
│    Train + validate the model here. On an upgrade, the engine source     │
│    and the checkpoint pair are re-inlined into ap-prediction (§5).       │
│    모델 학습·검증. 업그레이드 시 엔진 소스와 체크포인트 페어를              │
│    ap-prediction에 다시 인라인(§5).                                       │
└──────────────────────┬──────────────────────────────────────────────────┘
                       │ payload refresh (re-inline engine + swap checkpoint)
                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  github.com/eunsu-park/ap-prediction   (this repo, self-contained/본 레포)│
│    ├── .github/workflows/forecast.yml   ← cron + build + deploy          │
│    ├── vendor/realtime-regression-sw/   ← inlined engine (in-tree dir)   │
│    │   ├── src/, scripts/run_realtime.py   inference engine + CLI        │
│    │   └── checkpoint/                                                   │
│    │       ├── model_best.pth           ← committed weights / 커밋 가중치│
│    │       └── table_stats.pkl          ← committed normalizer stats     │
│    ├── configs/realtime.ci.yaml         ← CI path overrides             │
│    ├── scripts/update_site_data.py      ← JSON post-process             │
│    ├── site/index.html                  ← page shell / 페이지 골격      │
│    ├── site/main.js                     ← Chart.js renderer             │
│    └── site/data/                                                       │
│        ├── latest.json                  ← most recent forecast          │
│        ├── status.json                  ← pipeline health               │
│        └── forecast_history.json/.csv   ← per-anchor archives           │
└──────────────────────┬──────────────────────────────────────────────────┘
                       │ actions/deploy-pages@v4 (artifact)
                       ▼
          www.eunsu.me/ap-prediction/       (served page / 공개 URL)
          eunsu-park.github.io/ap-prediction/ (alias, auto-redirect)

┌─────────────────────────────────────────────────────────────────────────┐
│  github.com/eunsu-park/eunsu-park.github.io                             │
│    ├── _config.yml   (url: https://www.eunsu.me)                        │
│    ├── CNAME         (www.eunsu.me)                                     │
│    └── _includes/navigation.html   ← sidebar link to /ap-prediction     │
│                                      사이드바 링크                       │
└──────────────────────┬──────────────────────────────────────────────────┘
                       ▼
          www.eunsu.me/                     (main CV site / 메인 사이트)
```

**Why keep them separate / 왜 분리했나**

- `geoindex-realtime` is the engine's development home. Training and
  validation happen there; `ap-prediction` only ever receives a vetted,
  re-inlined payload, so day-to-day model-code churn never destabilizes the
  live dashboard.
  `geoindex-realtime`는 엔진 개발처. 학습·검증은 그곳에서, `ap-prediction`은
  검증된 페이로드만 받아 인라인하므로 모델 코드 변동이 라이브 대시보드를
  흔들지 않습니다.
- `eunsu-park.github.io` is a separate Jekyll CV site. It stays clean — the
  forecast auto-commits land in `ap-prediction`, not here, so a 10-min cron
  never triggers its Jekyll rebuild.
  `eunsu-park.github.io`는 독립 Jekyll CV 사이트. forecast auto-commit은
  `ap-prediction`에만 쌓이므로 10분 주기 cron이 Jekyll 리빌드를 유발하지
  않습니다.

---

## 3. Data flow / 데이터 흐름

Every anchor (new every 30 min, up to three attempts), one full cycle from
upstream feed to browser happens:
anchor마다(30분마다 새로 생기며 최대 3회 시도), 업스트림 피드에서 브라우저까지
한 사이클이 돕니다:

```
┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ NOAA SWPC plasma     │   │ NOAA SWPC magnetic   │   │ GFZ Hp30/ap30        │
│ (1-min cadence)      │   │ (1-min cadence)      │   │ (30-min cadence)     │
└──────────┬───────────┘   └──────────┬───────────┘   └──────────┬───────────┘
           └──────────────┬──────────────┘                       │
                          ▼                                      ▼
                ┌─────────────────────────────────────────────────────┐
                │ vendor/realtime-regression-sw — run_realtime.py     │
                │                                                     │
                │  1. Fetch the three HTTP feeds (requests + retry)   │
                │  2. Aggregate 1-min → 30-min bins                   │
                │  3. Compute anchor t_end = floor(now - 2min, 30min) │
                │  4. Build the 24-row × 22-col event window (impute) │
                │  5. Normalize with table_stats.pkl                  │
                │  6. Run model_best.pth (GNN + PatchTST, CPU)        │
                │  7. Denormalize; emit 24-step ap30 forecast + MCD   │
                │  8. Write JSON + CSV to results/predictions/…       │
                └──────────────────────┬──────────────────────────────┘
                                       │
                                       ▼
                ┌─────────────────────────────────────────────────────┐
                │ ap-prediction — update_site_data.py                 │
                │                                                     │
                │  1. Locate newest JSON under vendor/.../results/    │
                │  2. Read it                                         │
                │  3. Locate the paired event CSV                     │
                │     (dataset/events/{anchor_stem}.csv)              │
                │  4. Embed the last 96 rows of observed (datetime,   │
                │     ap30) as the "history" array (48 h of display)  │
                │  5. Write site/data/latest.json (don't-downgrade)   │
                │  6. Refresh status.json + forecast_history.json/csv │
                └──────────────────────┬──────────────────────────────┘
                                       │
                                       ▼ (git commit + push site/data to main)
                                       │
                                       ▼ (actions/deploy-pages artifact)
                                       │
                                       ▼
                ┌─────────────────────────────────────────────────────┐
                │ Browser — site/main.js                              │
                │                                                     │
                │  1. fetch("./data/latest.json", {cache:"no-store"}) │
                │  2. fetch("./data/status.json", {cache:"no-store"}) │
                │  3. Populate metadata block (UTC + KST)             │
                │  4. Paint status banner based on status.json        │
                │  5. Render Chart.js: gray history + blue forecast   │
                │     + MCD band + "now" divider at the anchor        │
                │  6. x-axis tick labels formatted in UTC             │
                └─────────────────────────────────────────────────────┘
```

### 3.1 Input / 입력

- **NOAA SWPC real-time solar wind** — plasma (density, speed, temp) and
  IMF magnetic field (Bx/By/Bz/Bt). 7-day rolling JSON.
- **GFZ Potsdam Hp30/ap30 nowcast** — 30-min geomagnetic index observed
  values. Text file, published within minutes of each 30-min boundary.

- **NOAA SWPC 실시간 태양풍** — plasma(밀도, 속도, 온도)과 IMF 자기장
  (Bx/By/Bz/Bt). 7일 롤링 JSON.
- **GFZ 포츠담 Hp30/ap30 nowcast** — 30분 지자기 지수 관측값. 텍스트 파일,
  각 30분 경계 직후 발행.

### 3.2 Anchor computation / Anchor 계산

The "anchor time" `t_end` is the most recent completed 30-min boundary,
minus a 2-minute safety offset to let the publishers finish posting:

Anchor 시각 `t_end`은 가장 최근에 완료된 30분 경계에서 발행자가 게시를
마칠 수 있도록 2분의 안전 오프셋을 뺀 값입니다:

```
t_end = floor(now - 2min, to 30-min boundary)
```

Example / 예시: at 14:13 UTC → `t_end = 14:00 UTC`. At 14:45 UTC
→ `t_end = 14:30 UTC`.

If the input window cannot be filled even after imputation, `t_end` may
roll back one 30-min step (up to 2 attempts). Beyond that, the CLI exits
with code 2 (data gap). See [forecast-process.md](forecast-process.md) §3
for the full imputation policy.

입력 윈도우가 보간 후에도 채워지지 않으면 `t_end`를 30분씩 rollback(최대
2회). 그 이상이면 CLI가 exit code 2(데이터 공백)로 종료합니다. 보간 정책
전체는 [forecast-process.md](forecast-process.md) §3 참고.

### 3.3 Model I/O shape / 모델 입출력 shape

Active profile: **`in12h_out12h_gnn_patchtst`** — an 8-node GNN with a
PatchTST temporal backend.
활성 프로파일: **`in12h_out12h_gnn_patchtst`** — 8-노드 GNN + PatchTST
시간 백엔드.

| Tensor | Shape | Description |
|--------|-------|-------------|
| Input  | `(1, 24, 22)` | 1 batch × 24 timesteps (12 hours × 30-min) × 22 vars |
| Output | `(1, 24, 1)`  | 1 batch × 24 timesteps (12 hours × 30-min) × 1 var (ap30) |

22 input variables: 21 solar-wind parameters (v/np/t ×avg/min/max,
Bx/By/Bz/Bt ×avg/min/max) + ap30.

The input ordering and normalization schema are **safety-critical
invariants** — the input window and the `table_stats.pkl` used to normalize
it must match the trained model.

입력 순서와 정규화 스키마는 **안전 불변식**입니다 — 입력 윈도우와 정규화에
쓰는 `table_stats.pkl`은 학습된 모델과 일치해야 합니다.

> Note: the 24-row figure above is the **model input window** (12 h). The
> `history` array embedded into `latest.json` for the chart is a separate,
> longer 96-row (48 h) slice of observed ap30 used only for display.
> 참고: 위의 24-row는 **모델 입력창**(12 h)입니다. 차트용으로
> `latest.json`에 담기는 `history` 배열은 표시 전용의 별도 96-row(48 h)
> 관측 ap30입니다.

---

## 4. The GitHub Actions workflow / GitHub Actions 워크플로

File: [.github/workflows/forecast.yml](../.github/workflows/forecast.yml)

### 4.1 Triggers / 트리거

```yaml
on:
  schedule:
    - cron: '8,18,28,38,48,58 * * * *'   # every 10 min; 3 attempts per anchor
  workflow_dispatch:                      # manual trigger from the UI
    inputs:
      now: {description: 'ISO8601 anchor override', required: false}
```

- **Cron** — fires every 10 minutes. Each 30-min anchor gets three attempts:
  the `:00` anchor at `:08`/`:18`/`:28`, the `:30` anchor at
  `:38`/`:48`/`:58`. The `:08` offset gives publishers time to post. A
  later attempt only overwrites an earlier one when its status is the same
  or better (**don't-downgrade**, see §4.5), so a transient failure never
  clobbers a good forecast. GitHub schedules are best-effort and may be
  delayed or dropped, so not all three attempts always fire.
  Cron은 10분마다 발사. 각 30분 anchor는 3회 시도(`:00`→`:08`/`:18`/`:28`,
  `:30`→`:38`/`:48`/`:58`). `:08` 오프셋은 발행 대기 시간. 나중 시도는
  status가 같거나 높을 때만 앞선 것을 덮어씀(**don't-downgrade**, §4.5).
  GitHub 예약은 best-effort라 지연·드롭될 수 있어 3회가 항상 다 돌지는 않음.
- **workflow_dispatch** — manual trigger with optional `now` parameter for
  replaying a specific anchor (debugging / backfill).
  수동 트리거, `now`로 특정 anchor 재실행 가능.

### 4.2 Concurrency / 동시성

```yaml
concurrency:
  group: forecast
  cancel-in-progress: false
```

If the previous run is still going, queue the next one rather than
cancel it. Prevents the pipeline from eating its own tail under heavy
scheduler drift.
이전 실행이 진행 중이면 다음 것을 취소하지 않고 대기. 스케줄러 드리프트
하에서 파이프라인이 자신을 잠식하는 것을 방지.

### 4.3 Permissions / 권한

```yaml
permissions:
  contents: write       # auto-commit site/data/*.json
  pages: write          # for actions/deploy-pages
  id-token: write       # OIDC token required by deploy-pages
```

### 4.4 Steps / 단계

Because the engine and checkpoint are committed in-tree, the workflow is a
plain checkout followed by install → infer → post-process → deploy. There
is **no** `submodules: true`, **no** `actions/cache` for weights, and **no**
`gh release download` step.

엔진과 체크포인트가 in-tree로 커밋되어 있으므로, 워크플로는 단순 checkout →
설치 → 추론 → 후처리 → 배포입니다. `submodules: true`도, 가중치용
`actions/cache`도, `gh release download` 단계도 **없습니다**.

| # | Step | Purpose |
|---|------|---------|
| 1 | `actions/checkout@v4` (no submodules) | Pull this self-contained repo, including the inlined engine + committed checkpoint |
| 2 | `actions/setup-python@v5` (3.12, pip cache keyed on `vendor/realtime-regression-sw/requirements.txt`) | Python runtime + speed up subsequent installs |
| 3 | `pip install torch --index-url .../cpu` | **CPU-only** PyTorch wheel (~200 MB instead of ~1.5 GB for CUDA) |
| 4 | `pip install -r vendor/realtime-regression-sw/requirements.txt` | numpy, pandas, pyarrow, omegaconf, pyyaml, requests, tqdm, matplotlib |
| 5 | `python scripts/run_realtime.py --config ../../configs/realtime.ci.yaml --device cpu --verbose` (in `vendor/realtime-regression-sw`) | **Inference**. Optional `--now`. Real exit code captured via `set +e` → `$GITHUB_OUTPUT`; the step always `exit 0` |
| 6 | `python scripts/update_site_data.py --exit-code X` | Post-process: copy JSON, embed history, update `status.json` + archives |
| 7 | `git add site/data` + commit + push | Persist `site/data/*` changes to `main` (skipped if nothing changed) |
| 8 | Job summary | Append anchor + first-horizon ap30 to the Actions run summary |
| 9 | `actions/configure-pages@v5` | Signal to Pages: "we're deploying now" |
| 10 | `actions/upload-pages-artifact@v3 path:site` | Upload the `site/` tree as a Pages artifact |
| 11 | `actions/deploy-pages@v4` | Publish the artifact to the live site |

### 4.5 Failure handling / 실패 처리

The inference step always exits 0 (its real code is captured separately), so
the workflow **never fails** on inference errors. The failure state is
recorded in `status.json` and rendered as a banner on the page:

추론 단계는 항상 exit 0(실제 코드는 별도 기록)이므로 워크플로 자체는 추론
오류로 **절대 실패하지 않음**. 실패 상태는 `status.json`에 기록되어 페이지
배너로 표출:

| Inference exit code | `status.json.status` | Page banner |
|---------------------|----------------------|-------------|
| `0` (success)       | `"ok"`               | Green: "Forecast is current." |
| `2` (data gap)      | `"warn"`             | Yellow: upstream data gap |
| other non-zero      | `"error"`            | Red: inference error |

When the run fails, `latest.json` is **not overwritten** — the page keeps
showing the last successful forecast with the warning banner on top. Every
run is also recorded into the per-anchor archives
(`forecast_history.json`/`.csv`) with an `ok`/`imputed`/`failed` status, and
the **don't-downgrade** rule (`ok` > `imputed` > `failed`) governs whether a
later attempt overwrites an earlier record for the same anchor. See
[forecast-process.md](forecast-process.md) §5–§8 for the full classification
and banner logic.

실패 시 `latest.json`은 **덮어쓰지 않음**. 페이지는 마지막 성공 예측을 유지한
채 경고 배너만 표시. 매 실행은 per-anchor 아카이브
(`forecast_history.json`/`.csv`)에 `ok`/`imputed`/`failed` status로 기록되며,
같은 anchor의 앞선 기록을 나중 시도가 덮어쓸지는 **don't-downgrade**
규칙(`ok` > `imputed` > `failed`)이 결정. 분류·배너 로직 전체는
[forecast-process.md](forecast-process.md) §5–§8 참고.

---

## 5. Model asset delivery / 모델 자산 전달

### 5.1 Why commit the weights in-tree / 왜 가중치를 in-tree로 커밋하나

- `model_best.pth` (~4–5 MB) is small enough that committing it — rather
  than fetching it from a Release at runtime — makes every run reproducible
  from a single checkout, with no external dependency to break.
  `model_best.pth`(~4–5 MB)는 충분히 작아, 런타임에 Release에서 받는 대신
  커밋해 두면 단일 checkout만으로 모든 실행이 재현 가능하고 외부 의존이
  깨질 일이 없습니다.
- The weights and `table_stats.pkl` live side by side under
  `checkpoint/` and are **always swapped together**, making the matched-pair
  coupling a git-level fact rather than a runtime hope.
  가중치와 `table_stats.pkl`은 `checkpoint/` 아래 나란히 두고 **항상 함께
  교체**되므로, 매칭 페어 결합이 런타임의 기대가 아니라 git 수준의 사실이
  됩니다.

### 5.2 Updating the checkpoint (payload refresh) / 체크포인트 갱신(페이로드 리프레시)

Because the engine and weights are vendored in-tree, an upgrade is a
**payload refresh**, not a submodule bump or a Release upload:

엔진과 가중치가 in-tree로 벤더링되어 있으므로, 업그레이드는 submodule 이동이나
Release 업로드가 아니라 **페이로드 리프레시**입니다:

1. **Develop and validate** the new engine/model in
   `eunsu-park/geoindex-realtime`.
   새 엔진/모델을 `eunsu-park/geoindex-realtime`에서 개발·검증.
2. **Re-inline the engine** into `vendor/realtime-regression-sw/` (source
   under `src/` + `scripts/`) and **swap the checkpoint pair** under
   `vendor/realtime-regression-sw/checkpoint/` — replace both
   `model_best.pth` and `table_stats.pkl` from the **same training run**.
   엔진을 `vendor/realtime-regression-sw/`에 다시 인라인(`src/` + `scripts/`)
   하고 `vendor/realtime-regression-sw/checkpoint/`의 체크포인트 페어를 교체 —
   `model_best.pth`와 `table_stats.pkl`을 **동일 학습 실행**에서 함께 교체.
3. **Update `configs/realtime.ci.yaml` if the architecture/shape changed**
   (`profile.*`, `experiment.name`, `window.lookback_steps`,
   `window.forecast_steps`, and `model_provenance.*`). For a same-shape
   retrain, only `model_provenance.*` (the displayed val metrics) needs to
   change. Commit the config change **together with** the checkpoint swap so
   the repo is never in a mismatched state.
   **아키텍처/shape가 바뀌면 `configs/realtime.ci.yaml` 갱신**(`profile.*`,
   `experiment.name`, `window.lookback_steps`, `window.forecast_steps`,
   `model_provenance.*`). 동일 shape 재학습이면 `model_provenance.*`(표시용
   val 지표)만 변경. config 변경은 체크포인트 교체와 **같은 커밋에** 반영해
   불일치 상태를 만들지 않도록.
4. **Commit and push.** The matched-pair invariant holds by construction —
   both files come from the same run, so there is nothing to reconcile at
   runtime.
   **커밋·푸시.** 매칭 페어 불변식은 구성상 성립 — 두 파일이 같은 실행에서
   오므로 런타임에 조정할 것이 없음.

> The `sync_to_njit.py` script performs exactly this payload refresh when
> promoting a validated version from this dev/staging repo to the
> production `njit-research/ap-prediction` repo: it copies the engine trees,
> the checkpoint pair, and the web/config payload, applying dev→prod
> reference rewrites, and never touches `.github/` or the bot-maintained
> `site/data/`.
> `sync_to_njit.py`는 검증된 버전을 이 dev/staging 레포에서 프로덕션
> `njit-research/ap-prediction`으로 승격할 때 바로 이 페이로드 리프레시를
> 수행합니다 — 엔진 트리·체크포인트 페어·web/config 페이로드를 복사하며
> dev→prod 참조 재작성 후, `.github/`와 봇 관리 `site/data/`는 건드리지 않음.

#### Rolling back / 롤백

Reverting is a `git revert` of the payload-refresh commit (which restores
the previous engine + checkpoint pair together), followed by a push and an
optional manual run. Because the pair is versioned atomically in git, the
rollback can never desync the weights from the stats.

롤백은 페이로드 리프레시 커밋의 `git revert`(이전 엔진 + 체크포인트 페어를
함께 복원) 후 push, 필요 시 수동 실행. 페어가 git에 원자적으로 버전 관리되므로
롤백이 가중치와 통계를 어긋나게 할 수 없음.

---

## 6. GitHub Pages deployment / GitHub Pages 배포

### 6.1 "Actions" source vs branch source / 배포 모드

We use **Source: GitHub Actions** (not "Deploy from a branch"). This
means:
**Source: GitHub Actions**를 사용. 의미:

- No `gh-pages` branch exists. Publishing is done by uploading a Pages
  artifact (`actions/upload-pages-artifact@v3`) and then calling
  `actions/deploy-pages@v4`.
  `gh-pages` 브랜치 없음. Pages 아티팩트 업로드 + `deploy-pages`로 배포.
- Each run re-deploys the full `site/` directory. This keeps the build
  deterministic and means `main` branch history is not mixed with a
  parallel `gh-pages` history.
  매 실행이 `site/` 전체를 재배포. 빌드가 결정적이며 `main` 히스토리가
  `gh-pages` 병행 히스토리와 섞이지 않음.

### 6.2 URL resolution / URL 작동 원리

The repo name `ap-prediction` becomes the URL path:

`github.com/eunsu-park/ap-prediction` repo name (`ap-prediction`)
→ project Pages URL path (`/ap-prediction/`).

레포 이름이 URL 경로가 됩니다.

Because the user account has a user-page repo (`eunsu-park.github.io`)
with a custom domain (`CNAME = www.eunsu.me`), the custom domain is
**automatically inherited** by all project Pages. Therefore both of the
following URLs serve the same content:

사용자 페이지 레포(`eunsu-park.github.io`)에 커스텀 도메인(`CNAME =
www.eunsu.me`)이 설정되어 있어, 모든 프로젝트 페이지가 자동으로 커스텀
도메인을 **상속**받습니다. 따라서 아래 두 URL이 동일 콘텐츠 제공:

- Primary: `https://www.eunsu.me/ap-prediction/`
- Alias: `https://eunsu-park.github.io/ap-prediction/` (301 redirects
  to the primary)

### 6.3 Cache behavior / 캐시 동작

- JSON files (`latest.json`, `status.json`) are fetched with
  `cache: "no-store"` in `main.js`, so browsers always request a fresh
  copy.
  JSON 파일은 `cache: "no-store"`로 항상 새로 요청.
- HTML and JS files (`index.html`, `main.js`) use GitHub Pages' default
  cache headers. The browser may cache them aggressively — if the page
  visibly lags behind, a hard refresh (`Cmd+Shift+R` / `Ctrl+F5`)
  forces a fresh pull.
  HTML/JS는 기본 캐시 헤더 사용. 강제 새로고침으로 최신화 가능.

---

## 7. Homepage integration / 메인 사이트 연동

The main site (`www.eunsu.me`) is a Jekyll blog in
`github.com/eunsu-park/eunsu-park.github.io`. Integration is **one
line** in `_includes/navigation.html`:

메인 사이트는 `eunsu-park/eunsu-park.github.io`의 Jekyll 블로그. 연동은
`_includes/navigation.html`에 **한 줄** 추가로 완료:

```html
<li><a href="{{ site.baseurl }}/ap-prediction">
  <i class="fas fa-chart-line"></i> AP Forecast
</a></li>
```

**How the link actually works / 링크 동작 원리**

1. Jekyll renders `{{ site.baseurl }}/ap-prediction` → `/ap-prediction`
   (since `baseurl` is empty in `_config.yml`).
   Jekyll이 `{{ site.baseurl }}/ap-prediction`을 `/ap-prediction`으로 렌더링.
2. Browser clicks on `<a href="/ap-prediction">` → navigates to
   `https://www.eunsu.me/ap-prediction`.
   브라우저가 `<a href="/ap-prediction">` 클릭 → `https://www.eunsu.me/ap-prediction`으로 이동.
3. GitHub Pages receives the request for `/ap-prediction/` and serves
   the content from the `ap-prediction` project Pages artifact (i.e.
   the `site/` directory this repo publishes).
   GitHub Pages가 `/ap-prediction/` 요청을 받아 본 레포의 project Pages 아티팩트에서 콘텐츠 제공.

Nothing else is shared between the two sites — no CSS, no JavaScript,
no layout. They just happen to live under the same domain.

두 사이트 간 CSS, JS, 레이아웃 공유 없음 — 같은 도메인 아래 경로만 공유.

---

## 8. Files & responsibilities / 파일과 책임

### 8.1 In `ap-prediction` / 본 레포

| Path | Purpose |
|------|---------|
| [`.github/workflows/forecast.yml`](../.github/workflows/forecast.yml) | Cron-triggered build+deploy pipeline (plain checkout, no submodules/Release) |
| [`configs/realtime.ci.yaml`](../configs/realtime.ci.yaml) | CI path overrides for the inlined engine (checkpoint, stats, event_dir, results_dir all relative to `vendor/realtime-regression-sw/`) + active profile + model provenance |
| [`scripts/update_site_data.py`](../scripts/update_site_data.py) | Post-process: read latest forecast JSON, embed 96-step observed history from the event CSV, write `site/data/latest.json` + `status.json` + `forecast_history.json`/`.csv` (don't-downgrade) |
| [`scripts/sync_to_njit.py`](../scripts/sync_to_njit.py) | Promote a validated payload (engine + checkpoint + web/config) from this dev/staging repo to production `njit-research/ap-prediction` |
| [`site/index.html`](../site/index.html) | Static page shell. Inline CSS. Loads Chart.js v4 + date-fns adapter from jsDelivr CDN |
| [`site/main.js`](../site/main.js) | Fetches `latest.json` + `status.json`, fills metadata, paints banner, renders history + forecast + MCD band with a "now" divider at the anchor, UTC-formatted x-axis ticks, tooltips showing both UTC and KST |
| [`site/data/latest.json`](../site/data/latest.json) | Most recent forecast payload (auto-committed by the workflow) |
| [`site/data/status.json`](../site/data/status.json) | Pipeline health (auto-committed by the workflow) |
| [`vendor/realtime-regression-sw/`](../vendor/realtime-regression-sw) | **Vendored in-tree directory** — the inlined inference engine (`src/`, `scripts/`) + committed `checkpoint/model_best.pth` and `table_stats.pkl`. Not a git submodule. |

### 8.2 `latest.json` schema / 스키마

```json
{
  "run_timestamp_utc":    "2026-04-25T00:00:07Z",
  "anchor_timestamp_utc": "2026-04-24T14:30:00Z",
  "model": {
    "profile":          "in12h_out12h_gnn_patchtst",
    "checkpoint_path":  "./checkpoint/model_best.pth",
    "checkpoint_sha256":"d5d87bcbf905...",
    "val_loss_at_train": 0.245454,
    "val_mae_at_train":  0.3781,
    "val_rmse_at_train": 0.4956
  },
  "input": {
    "event_csv": "/.../dataset/events/20260424143000.csv",
    "sources": {
      "noaa_plasma_url": "...",
      "noaa_mag_url":    "...",
      "gfz_hpo_url":     "..."
    },
    "missing_data_filled_fraction": 0.017
  },
  "forecast": [                                // 24 entries = 12 hours
    {"horizon_steps":1, "horizon_minutes":30, "target_timestamp_utc":"...", "ap30":7.2},
    ...
  ],
  "history": [                                 // 96 entries = 48 hours (added by update_site_data.py)
    {"timestamp_utc":"...", "ap30":9.0},
    ...
  ]
}
```

### 8.3 `status.json` schema / 스키마

```json
{
  "status":            "ok" | "warn" | "error",
  "last_success_utc":  "2026-04-25T00:00:07Z",
  "last_attempt_utc":  "2026-04-25T00:00:07Z",
  "last_error": null | {
    "code":    <int>,
    "message": "..."
  }
}
```

---

## 9. Cost and quota / 비용과 할당량

- GitHub Actions Linux runner minutes are **unlimited and free for
  public repos**. The 10-min cron uses roughly 2,000–4,000 runner minutes
  per month depending on how many attempts fire; cost is $0.
  공개 레포의 Linux 러너 분은 **무제한 무료**. 10분 주기는 시도 수에 따라
  월 약 2,000–4,000 러너 분 사용, 비용 $0.
- GitHub Pages bandwidth: 100 GB/month soft limit per user. Our static
  site is a few hundred KB; nowhere near the limit.
  GitHub Pages 대역폭: 사용자당 월 100 GB soft limit. 정적 사이트가 수백 KB
  수준이라 한도와 무관.
- NOAA and GFZ feeds are unauthenticated public JSON/text; no API key
  or quota to worry about.
  NOAA와 GFZ 피드는 비인증 공개 JSON/텍스트; API 키나 할당량 걱정 없음.

---

## 10. Known limitations / 알려진 한계

1. **Scheduler drift** — GitHub Actions cron is best-effort. A run
   scheduled for :18 UTC may start late, and some attempts may be dropped
   entirely under load. The three-attempts-per-anchor design absorbs most
   of this, and the anchor computation always aligns to the most recent
   30-min boundary, but the "last updated" timestamp on the page reflects
   the actual run time, not the slot time.
   GitHub Actions cron은 best-effort. :18 예정이 늦게 시작하거나 부하 시 일부
   시도가 드롭될 수 있음. anchor당 3회 시도가 이를 대부분 흡수하고 anchor는
   항상 최근 30분 경계에 정렬되지만, 페이지의 "last updated"는 실제 실행
   시각을 반영.
2. **Matched-pair invariant is process-enforced** — `model_best.pth` and
   `table_stats.pkl` must come from the same training run; there is no
   runtime check that they match. Committing them together in-tree and
   always swapping them as a pair (§5) makes a mismatch a git-review-visible
   mistake rather than a silent runtime one, but the guarantee is still
   procedural, not automatic.
   매칭 페어 불변식은 절차로 보장 — `model_best.pth`와 `table_stats.pkl`은
   동일 학습 실행에서 와야 하며 런타임 검증 없음. in-tree로 함께 커밋하고
   항상 페어로 교체(§5)하면 불일치가 조용한 런타임 오류가 아니라 git 리뷰에서
   보이는 실수가 되지만, 보장은 여전히 절차적.
3. **No historical archive on the page** — the page renders `latest.json`
   plus the recent observed history. Longer-term forecasts are accumulated
   in `forecast_history.json`/`.csv` but are not yet surfaced in the UI
   (kept for future re-exposure; also present in git history of
   `site/data/`).
   페이지 히스토리 아카이브 없음 — 페이지는 `latest.json`과 최근 관측 history를
   렌더링. 장기 예보는 `forecast_history.json`/`.csv`에 누적되지만 아직 UI에
   노출되지 않음(추후 재노출용, git 히스토리에도 존재).

---

## 11. Extending the dashboard / 대시보드 확장 가이드

Candidate next steps, in rough order of effort:
다음 확장 후보 (대략적 난이도 순):

1. **Historical accuracy view** — `forecast_history.json`/`.csv` already
   archive each anchor's first-horizon forecast with its status. Surface a
   secondary chart: "forecast-vs-realized MAE over the last N days" by
   joining archived forecasts against the later observed ap30.
   과거 정확도 뷰 — `forecast_history.json`/`.csv`가 이미 각 anchor의
   첫-horizon 예보와 status를 아카이브. 이후 관측 ap30과 조인해 "최근 N일
   forecast-vs-realized MAE" 보조 차트 추가.
2. **hp30 as a second target** — currently only ap30 is on the page. The
   engine also supports hp30 variants. Add a second line to the chart with a
   toggle.
   hp30 이중 타겟 — ap30만 표시 중. 엔진은 hp30 변형도 지원. 토글로 두 번째
   라인 추가.
3. **Attention heatmap** — `plot_attention` exists in the engine but emits
   PNG. For interactive use, serialize attention weights to JSON and render
   with a canvas heatmap library.
   Attention 히트맵 — 엔진에 `plot_attention`이 있으나 PNG 생성. JSON 직렬화
   후 인터랙티브 히트맵 렌더링.

Each of these would be additive — none require restructuring the
current pipeline.
모두 가산적 변경 — 현재 파이프라인 재구조화 불필요.
