/* Render the latest ap30 forecast. Fetches site/data/latest.json and
 * site/data/status.json, fills the metadata block, paints the status banner,
 * and draws a Chart.js line plot of the 24-step forecast.
 */
(async () => {
  const LATEST_URL = "./data/latest.json";
  const STATUS_URL = "./data/status.json";
  const STALE_MS = 2 * 60 * 60 * 1000;  // 2 hours

  const $ = (id) => document.getElementById(id);
  const fmtUTC = (iso) => {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  };
  const fmtKST = (iso) => {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`;
  };
  const fmtDual = (iso) => iso ? `${fmtUTC(iso)} / ${fmtKST(iso)}` : "—";

  // Compact UTC formatter for x-axis tick labels (e.g., "Apr 24 13:00").
  // Chart.js picks tick positions in browser-local time by default; this
  // callback re-formats the tick value in UTC so axis labels match the
  // axis title.
  const fmtTickUTC = (ms) => {
    const d = new Date(ms);
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
  };

  const showBanner = (kind, text) => {
    const el = $("status-banner");
    el.className = `status-banner ${kind}`;
    el.textContent = text;
  };

  const fetchJSON = async (url) => {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  };

  // Status.json controls the banner. Missing or "error" → red. "warn" → yellow.
  // "ok" + stale data → yellow override.
  let status = null;
  try {
    status = await fetchJSON(STATUS_URL);
  } catch {
    showBanner("error", "Status file unavailable — pipeline may not have run yet.");
  }

  let latest;
  try {
    latest = await fetchJSON(LATEST_URL);
  } catch {
    showBanner("error", "Forecast data unavailable. The pipeline may not have produced any output yet.");
    return;
  }

  // Populate metadata block.
  $("meta-anchor").textContent = fmtDual(latest.anchor_timestamp_utc);
  $("meta-run").textContent = fmtDual(latest.run_timestamp_utc);
  $("meta-model").textContent = latest.model?.profile ?? "—";
  $("meta-mae").textContent =
    latest.model?.val_mae_at_train != null
      ? latest.model.val_mae_at_train.toFixed(4)
      : "—";
  const filled = latest.input?.missing_data_filled_fraction;
  $("meta-missing").textContent =
    filled != null ? `${(filled * 100).toFixed(1)}%` : "—";
  const sha = latest.model?.checkpoint_sha256 ?? "";
  $("meta-sha").textContent = sha ? sha.slice(0, 12) : "—";
  $("last-fetched").textContent = fmtDual(new Date().toISOString());

  // Banner precedence: explicit status error/warn > staleness > data-quality.
  const runAgeMs = Date.now() - new Date(latest.run_timestamp_utc).getTime();
  if (status?.status === "error") {
    showBanner("error",
      `Pipeline error: ${status.last_error?.message ?? "unknown"}. Showing last successful forecast.`);
  } else if (status?.status === "warn") {
    showBanner("warn",
      `${status.last_error?.message ?? "Pipeline warning."} Showing last successful forecast.`);
  } else if (runAgeMs > STALE_MS) {
    const hours = (runAgeMs / 3_600_000).toFixed(1);
    showBanner("warn", `Data is stale: last successful run was ${hours} hours ago.`);
  } else if (filled != null && filled > 0.05) {
    showBanner("warn",
      `${(filled * 100).toFixed(1)}% of input data was filled from upstream gaps.`);
  } else {
    showBanner("ok", "Forecast is current.");
  }

  // Build chart datasets. Historical observations (gray, no markers) are drawn
  // before the anchor; the forecast (blue, markers) starts at the anchor.
  const forecast = latest.forecast ?? [];
  const history = latest.history ?? [];
  const forecastPoints = forecast.map((e) => ({
    x: new Date(e.target_timestamp_utc),
    y: e.ap30,
  }));
  const historyPoints = history.map((e) => ({
    x: new Date(e.timestamp_utc),
    y: e.ap30,
  }));

  // Bridge the last observed point to the first forecast point so the two
  // segments visually connect at the anchor.
  const bridge = historyPoints.length > 0 && forecastPoints.length > 0
    ? [historyPoints[historyPoints.length - 1], forecastPoints[0]]
    : [];

  const ctx = $("forecast-chart").getContext("2d");
  // eslint-disable-next-line no-undef
  new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "ap30 observed (history)",
          data: historyPoints,
          borderColor: "#6b7280",
          backgroundColor: "#6b7280",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.15,
        },
        {
          label: "ap30 forecast",
          data: forecastPoints,
          borderColor: "#2563eb",
          backgroundColor: "#2563eb",
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.15,
        },
        {
          label: "bridge",
          data: bridge,
          borderColor: "#6b7280",
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          showLine: true,
          fill: false,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: { filter: (item) => item.text !== "bridge" },
        },
        tooltip: {
          filter: (item) => item.dataset.label !== "bridge",
          callbacks: {
            title: (items) => {
              const d = items[0].parsed.x;
              const iso = new Date(d).toISOString();
              return `${fmtUTC(iso)}\n${fmtKST(iso)}`;
            },
            label: (item) => `${item.dataset.label.replace(/\s*\(.*\)$/, "")} = ${item.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "hour" },
          title: { display: true, text: "UTC" },
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 10,
            callback: (value) => fmtTickUTC(value),
          },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "ap30" },
        },
      },
    },
  });
})();
