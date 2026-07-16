const STORAGE_KEY = "trend-tracker-preferences-v2";
const EXECUTION_STORAGE_KEY = "trend-tracker-execution-settings-v1";
const FUND_BASKETS_STORAGE_KEY = "trend-tracker-fund-baskets-v1";
const SNAPSHOT_STORAGE_KEY = "trend-tracker-signal-snapshots-v1";
const MIN_VISIBLE_DAYS = 35;
const DEFAULT_VISIBLE_DAYS = 260;
const STATIC_SNAPSHOT_MODE = document.documentElement.dataset.hostMode === "static";
const STATIC_HISTORY_FILES = {
  "^NDX": "NDX.json",
  "000300.SS": "CSI300.json",
};

function readStorage(key, fallback = {}) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") || fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The dashboard still works when browser storage is unavailable.
  }
}

const storedPreferences = readStorage(STORAGE_KEY, {});
const storedMovingAverages = storedPreferences.visibleMovingAverages || {};
const state = {
  summary: null,
  selected: storedPreferences.selectedSymbol || null,
  history: [],
  activeView: ["decision", "environment", "guide"].includes(storedPreferences.activeView) ? storedPreferences.activeView : "decision",
  visibleMovingAverages: {
    ma50: Boolean(storedMovingAverages.ma50),
    ma100: Boolean(storedMovingAverages.ma100),
    ma200: storedMovingAverages.ma200 !== false,
  },
  visibleDays: Math.max(MIN_VISIBLE_DAYS, Number(storedPreferences.visibleDays) || DEFAULT_VISIBLE_DAYS),
  savedChartViews: storedPreferences.chartViews || {},
  view: { start: 0, end: 0 },
  drag: null,
  hover: null,
  timelineKey: null,
  chartFullscreen: false,
};

document.documentElement.classList.add("js");

const $ = (id) => document.getElementById(id);
const MARKER_STYLES = {
  recover: { color: "#c9574d", radius: 2.6, fill: false, shape: "circle", key: "up" },
  uptrend: { color: "#c9574d", radius: 3.8, fill: true, shape: "circle", key: "up" },
  retreat: { color: "#258d6a", radius: 2.6, fill: false, shape: "circle", key: "down" },
  downtrend: { color: "#258d6a", radius: 3.8, fill: true, shape: "circle", key: "down" },
  recover2nd: { color: "#c9574d", radius: 3.2, fill: false, shape: "diamond", key: "up" },
  retreat2nd: { color: "#258d6a", radius: 3.2, fill: false, shape: "diamond", key: "down" },
};
const WORKSPACE_META = {
  decision: {
    title: "决策看板",
    fallback: "价格趋势、目标仓位与场外执行",
  },
  environment: {
    title: "环境研判",
    fallback: "宏观、风险与双动量确认",
  },
  guide: {
    title: "指标说明",
    fallback: "策略规则、判断顺序与指标定义",
  },
};

function fmtNum(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "暂无";
  return Number(value).toFixed(digits);
}

function fmtPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "暂无";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function fmtPointPct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "暂无";
  return `${Number(value).toFixed(digits)}%`;
}

function fmtRiskValue(item) {
  if (item?.value_text) return item.value_text;
  if (!item?.available || item.value === null || item.value === undefined || Number.isNaN(Number(item.value))) return "暂无";
  if (item.unit === "%") return `${Number(item.value).toFixed(2)}%`;
  if (item.unit === "ratio") return `${Number(item.value).toFixed(2)}x`;
  return Number(item.value).toFixed(2);
}

function fmtSigned(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "暂无";
  const number = Number(value);
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function persistPreferences() {
  writeStorage(STORAGE_KEY, {
    selectedSymbol: state.selected,
    activeView: state.activeView,
    visibleMovingAverages: state.visibleMovingAverages,
    visibleDays: state.visibleDays,
    chartViews: state.savedChartViews,
  });
}

function referenceDate() {
  const dates = (state.summary?.latest || []).map((item) => item.date).filter(Boolean).sort();
  return dates.at(-1) || new Date().toISOString().slice(0, 10);
}

function parseDateValue(value, monthly = false) {
  if (!value) return null;
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}$/.test(raw)
    ? `${raw}-${monthly ? "28" : "01"}T00:00:00Z`
    : `${raw.slice(0, 10)}T00:00:00Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function freshnessInfo(date, cadence = "market") {
  const thresholds = { market: 7, monthly: 75, monthEnd: 45 };
  const valueDate = parseDateValue(date, cadence === "monthly");
  const currentDate = parseDateValue(referenceDate());
  if (!valueDate || !currentDate) return { ageDays: null, stale: false, label: "日期未知" };
  const ageDays = Math.max(0, Math.floor((currentDate - valueDate) / 86400000));
  const stale = ageDays > (thresholds[cadence] || thresholds.market);
  return { ageDays, stale, label: stale ? `滞后 ${ageDays} 天` : "数据正常" };
}

function staleBadgeHtml(info) {
  return info?.stale ? `<em class="freshness-badge">${escapeHtml(info.label)}</em>` : "";
}

const FUND_BASKET_DEFINITIONS = [
  { id: "ashare", name: "A股基金", shortName: "A股篮子", symbol: "000300.SS", tone: "ashare" },
  { id: "us", name: "美股基金", shortName: "美股篮子", symbol: "^NDX", tone: "us" },
  { id: "defensive", name: "债券与货币基金", shortName: "稳健篮子", symbol: null, tone: "defensive" },
];
const BASKET_COLORS = {
  ashare: "#f06a64",
  us: "#8b6fe8",
  defensive: "#3fc99a",
  unclassified: "#77747e",
};
const REBALANCE_POLICY = {
  noActionPp: 2,
  contributionPp: 5,
  redemptionReviewPp: 8,
  quarterMonths: [3, 6, 9, 12],
};
const EXECUTION_TRANSITION = {
  opportunityStepPp: 5,
  confirmedStepPp: 10,
  normalReductionStepPp: 10,
};

const DEFAULT_FUND_BASKET_SETTINGS = {
  baskets: Object.fromEntries(
    FUND_BASKET_DEFINITIONS.map((definition) => [
      definition.id,
      { actualPct: null },
    ])
  ),
};

function optionalNumber(value, min = 0, max = Number.POSITIVE_INFINITY) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function basketActualPct(basket) {
  const positions = (Array.isArray(basket?.funds) ? basket.funds : [])
    .map((fund) => optionalNumber(fund.positionPct ?? fund.weightPct, 0, 100))
    .filter((value) => value !== null);
  if (positions.length) return Math.min(100, positions.reduce((sum, value) => sum + value, 0));
  return optionalNumber(basket?.actualPct, 0, 100);
}

function normalizeFundBasketSettings(raw = {}) {
  const baskets = {};
  for (const definition of FUND_BASKET_DEFINITIONS) {
    const source = raw?.baskets?.[definition.id] || {};
    baskets[definition.id] = {
      actualPct: basketActualPct(source),
    };
  }
  return { baskets };
}

function fundBasketSettings() {
  const stored = readStorage(FUND_BASKETS_STORAGE_KEY, null);
  if (stored) return normalizeFundBasketSettings(stored);

  const migrated = normalizeFundBasketSettings(DEFAULT_FUND_BASKET_SETTINGS);
  const legacy = readStorage(EXECUTION_STORAGE_KEY, {});
  const symbolMap = { "000300.SS": "ashare", "^NDX": "us" };
  for (const [symbol, basketId] of Object.entries(symbolMap)) {
    const value = legacy?.[symbol]?.currentPositionPct;
    if (value !== null && value !== undefined && value !== "") {
      migrated.baskets[basketId].actualPct = optionalNumber(value, 0, 100);
    }
  }
  return migrated;
}

function saveFundBasketSettings(settings) {
  writeStorage(FUND_BASKETS_STORAGE_KEY, normalizeFundBasketSettings(settings));
}

function basketDefinitionFor(item) {
  return FUND_BASKET_DEFINITIONS.find((definition) => definition.symbol === item?.symbol)
    || FUND_BASKET_DEFINITIONS[0];
}

function strategicReferenceTargets() {
  return { ashare: 30, us: 30, defensive: 40, label: "长期基准 60/40" };
}

function dualMomentumTargets() {
  const allocation = state.summary?.dual_momentum?.allocation || {};
  if (allocation.mode === "risk_on" && allocation.symbol === "^NDX") {
    return { ashare: 20, us: 40, defensive: 40, label: "月度偏向美股" };
  }
  if (allocation.mode === "risk_on" && allocation.symbol === "000300.SS") {
    return { ashare: 40, us: 20, defensive: 40, label: "月度偏向 A 股" };
  }
  if (allocation.mode === "defensive") {
    return { ashare: 0, us: 0, defensive: 100, label: "月度转向稳健" };
  }
  return { ...strategicReferenceTargets(), label: "月度沿用长期基准" };
}

function trendPositionCaps() {
  const latest = state.summary?.latest || [];
  const capFor = (symbol) => {
    const value = Number(latest.find((item) => item.symbol === symbol)?.position_pct);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  };
  return {
    ashare: capFor("000300.SS"),
    us: capFor("^NDX"),
    defensive: 100,
    label: "六类趋势上限",
  };
}

function finalExecutionTargets() {
  const strategic = strategicReferenceTargets();
  const momentum = dualMomentumTargets();
  const caps = trendPositionCaps();
  const ashare = Math.min(momentum.ashare, caps.ashare);
  const us = Math.min(momentum.us, caps.us);
  const defensive = Math.max(0, 100 - ashare - us);
  return {
    ashare,
    us,
    defensive,
    label: "策略中枢仓位",
    strategic,
    momentum,
    caps,
    constrained: ashare < momentum.ashare || us < momentum.us,
  };
}

function latestForBasket(basketId) {
  const definition = FUND_BASKET_DEFINITIONS.find((entry) => entry.id === basketId);
  return (state.summary?.latest || []).find((item) => item.symbol === definition?.symbol) || null;
}

function isHardRiskSignal(item) {
  const defenseDistance = Number(item?.distance_to_defense_pct);
  return item?.primary_state === "downtrend"
    || (Number.isFinite(defenseDistance) && defenseDistance <= 0);
}

function opportunityStep(item) {
  if (item?.state === "uptrend" && item?.primary_state === "uptrend") return EXECUTION_TRANSITION.confirmedStepPp;
  if (["recover", "retreat2nd"].includes(item?.state)) return EXECUTION_TRANSITION.opportunityStepPp;
  return 0;
}

function transitionTarget(actual, strategyTarget, item) {
  if (actual === null || actual === undefined || actual === "") return Number(strategyTarget);
  const current = Number(actual);
  const strategy = Number(strategyTarget);
  if (!Number.isFinite(current) || !Number.isFinite(strategy)) return strategy;
  if (Math.abs(strategy - current) <= REBALANCE_POLICY.noActionPp) return strategy;
  if (strategy < current) {
    if (isHardRiskSignal(item)) return strategy;
    return Math.max(strategy, current - EXECUTION_TRANSITION.normalReductionStepPp);
  }
  const step = opportunityStep(item);
  return step > 0 ? Math.min(strategy, current + step) : current;
}

function currentExecutionTargets(actualByBasket = {}) {
  const strategy = finalExecutionTargets();
  const ashare = transitionTarget(actualByBasket.ashare, strategy.ashare, latestForBasket("ashare"));
  const us = transitionTarget(actualByBasket.us, strategy.us, latestForBasket("us"));
  const defensive = Math.max(0, 100 - ashare - us);
  return {
    ashare,
    us,
    defensive,
    label: "本期执行仓位",
    strategy,
  };
}

function targetPctText(value) {
  const number = Number(value);
  return Number.isInteger(number) ? `${number}%` : `${number.toFixed(1)}%`;
}

function localDateFromIso(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateIsoLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function lastWeekdayOfMonth(year, monthIndex) {
  const date = new Date(year, monthIndex + 1, 0, 12);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() - 1);
  }
  return date;
}

function nextMonthlyReviewDate(baseDate) {
  for (let offset = 0; offset < 14; offset += 1) {
    const monthDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1, 12);
    const candidate = lastWeekdayOfMonth(monthDate.getFullYear(), monthDate.getMonth());
    if (candidate >= baseDate) return candidate;
  }
  return lastWeekdayOfMonth(baseDate.getFullYear(), baseDate.getMonth());
}

function nextQuarterlyReviewDate(baseDate) {
  for (let offset = 0; offset < 18; offset += 1) {
    const monthDate = new Date(baseDate.getFullYear(), baseDate.getMonth() + offset, 1, 12);
    const monthNumber = monthDate.getMonth() + 1;
    if (!REBALANCE_POLICY.quarterMonths.includes(monthNumber)) continue;
    const candidate = lastWeekdayOfMonth(monthDate.getFullYear(), monthDate.getMonth());
    if (candidate >= baseDate) return candidate;
  }
  return lastWeekdayOfMonth(baseDate.getFullYear(), 11);
}

function rebalanceAssessment(snapshot, item) {
  const itemDate = localDateFromIso(item?.date);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const baseDate = itemDate && itemDate > today ? itemDate : today;
  const complete = snapshot.entries.every((entry) => entry.actual !== null);
  const deviations = snapshot.entries
    .filter((entry) => entry.actual !== null)
    .map((entry) => ({ ...entry, deviation: Number(entry.actual) - Number(entry.target) }));
  const maxAbsolute = deviations.length
    ? Math.max(...deviations.map((entry) => Math.abs(entry.deviation)))
    : null;
  const maxOverweight = deviations.length
    ? Math.max(0, ...deviations.map((entry) => entry.deviation))
    : 0;
  let level = "等待持仓";
  let tone = "pending";
  let action = "填写三个篮子后判断";
  if (complete && maxAbsolute <= REBALANCE_POLICY.noActionPp) {
    level = "无需调平";
    tone = "stable";
    action = "保持原定投节奏";
  } else if (complete && maxAbsolute <= REBALANCE_POLICY.contributionPp) {
    level = "调整定投";
    tone = "watch";
    action = "只调整新增资金方向";
  } else if (complete) {
    level = "启动调平";
    tone = "active";
    action = "月末开始用新增资金调平";
  }
  return {
    complete,
    maxAbsolute,
    maxOverweight,
    level,
    tone,
    action,
    monthlyDate: dateIsoLocal(nextMonthlyReviewDate(baseDate)),
    quarterlyDate: dateIsoLocal(nextQuarterlyReviewDate(baseDate)),
    redemptionReview: complete && maxOverweight >= REBALANCE_POLICY.redemptionReviewPp,
  };
}

function personalizedExecution(item) {
  const settings = fundBasketSettings();
  const definition = basketDefinitionFor(item);
  const basket = settings.baskets[definition.id];
  const actualByBasket = Object.fromEntries(
    FUND_BASKET_DEFINITIONS.map((entry) => [entry.id, basketActualPct(settings.baskets[entry.id])])
  );
  const executionTargets = currentExecutionTargets(actualByBasket);
  const target = executionTargets[definition.id];
  const actual = basketActualPct(basket);
  const gap = target === null || actual === null ? null : target - actual;
  let action = item?.fund_execution?.action || "按计划执行";
  let note = `${definition.name}尚未填写实际持仓占比，暂时只按趋势提示参与强度。`;

  if (gap !== null && (item?.primary_state === "downtrend" || Number(item?.distance_to_defense_pct) <= 0)) {
    action = "暂停该篮子新增";
    note = `价格防守条件已触发，先暂停新增；场外基金不因一次信号强制赎回，优先等待低成本处理窗口。`;
  } else if (gap !== null && gap > REBALANCE_POLICY.noActionPp) {
    action = "优先补充篮子";
    note = `${definition.name}实际 ${actual.toFixed(1)}%，本期执行 ${target.toFixed(1)}%，缺口 ${gap.toFixed(1)} 个百分点。`;
  } else if (gap !== null && gap < -REBALANCE_POLICY.noActionPp) {
    action = "暂停该篮子定投";
    note = `${definition.name}高于本期执行仓位 ${Math.abs(gap).toFixed(1)} 个百分点，优先把新增资金分配给其他篮子，不主动为小幅偏离支付赎回成本。`;
  } else if (gap !== null) {
    action = item?.dca_action || "保持现有节奏";
    note = `${definition.name}实际仓位与本期执行仓位相差不超过 ${REBALANCE_POLICY.noActionPp} 个百分点，按当前趋势保持节奏。`;
  }

  return {
    action,
    note,
    target,
    actual,
    gap,
    referenceLabel: executionTargets.label,
    settings,
    basket,
    definition,
  };
}

function stateTextClass(label) {
  if (!label) return "";
  if (label.includes("回升") || label.includes("上升")) return "state-up-text";
  if (label.includes("回撤") || label.includes("下降")) return "state-down-text";
  return "";
}

function stateLabelHtml(label) {
  const className = stateTextClass(label);
  return `<span class="${className}">${escapeHtml(label)}</span>`;
}

function marketPhaseText(item) {
  return item?.market_phase?.text || "暂无";
}

function movingAverageArrangement(item) {
  const rawValues = [item?.ma50, item?.ma100, item?.ma200];
  if (rawValues.some((value) => value === null || value === undefined)) {
    return { label: "暂无", tone: "mixed" };
  }
  const [ma50, ma100, ma200] = rawValues.map(Number);
  if (![ma50, ma100, ma200].every(Number.isFinite)) {
    return { label: "暂无", tone: "mixed" };
  }
  if (ma50 > ma100 && ma100 > ma200) {
    return { label: "多头排列", tone: "bull" };
  }
  if (ma50 < ma100 && ma100 < ma200) {
    return { label: "空头排列", tone: "bear" };
  }
  return { label: "均线交错", tone: "mixed" };
}

function displaySymbol(itemOrSymbol) {
  const item =
    typeof itemOrSymbol === "string"
      ? (state.summary?.latest || []).find((entry) => entry.symbol === itemOrSymbol)
      : itemOrSymbol;
  if (!item) return String(itemOrSymbol || "");
  if (String(item.asset_type || "").includes("A股") && item.name) return item.name;
  return item.symbol || item.name || "";
}

function transitionChangeHtml(item) {
  if (!item) return escapeHtml("暂无变化");
  return `${stateLabelHtml(item.fromLabel)}<span class="transition-arrow">→</span>${stateLabelHtml(item.toLabel)}`;
}

function setRunStatus(text) {
  $("runStatus").textContent = text;
}

function replayMotion(node, className = "content-refreshed") {
  if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  node.classList.remove(className);
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add(className)));
}

function markInterfaceReady() {
  requestAnimationFrame(() => document.body.classList.add("ui-ready"));
}

function updateWorkspaceHeading() {
  const meta = WORKSPACE_META[state.activeView] || WORKSPACE_META.decision;
  const title = $("viewTitle");
  if (title) title.textContent = meta.title;
}

function setWorkspaceView(view, { focus = false } = {}) {
  if (!WORKSPACE_META[view]) return;
  state.activeView = view;
  persistPreferences();
  document.body.dataset.workspaceView = view;

  for (const button of document.querySelectorAll("[data-workspace-view]")) {
    const active = button.dataset.workspaceView === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
    if (active) replayMotion(panel, "view-refreshed");
  }

  updateWorkspaceHeading();
  if (view === "decision") requestAnimationFrame(drawChart);
  if (focus) $("viewTitle")?.focus({ preventScroll: true });
}

function setupWorkspaceNavigation() {
  for (const button of document.querySelectorAll("[data-workspace-view]")) {
    button.addEventListener("click", () => setWorkspaceView(button.dataset.workspaceView));
  }
  setWorkspaceView(state.activeView);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function loadSummary() {
  const summaryUrl = STATIC_SNAPSHOT_MODE
    ? `./data/summary.json?v=${Date.now()}`
    : "/api/summary";
  state.summary = await fetchJson(summaryUrl);
  const latest = state.summary.latest || [];
  if (!latest.some((item) => item.symbol === state.selected) && latest.length) {
    state.selected = latest.find((item) => item.symbol === state.summary.config.main_symbol)?.symbol || latest[0].symbol;
  }
  persistPreferences();
  renderTabs();
  renderRiskLayer();
  renderMacroEnvironment();
  renderAshareObservationMap();
  renderDualMomentum();
  renderContextSummary();
  if (state.selected) await loadHistory(state.selected);
  renderSelected();
  renderRunStatus();
  markInterfaceReady();
}

async function loadHistory(symbol) {
  const historyFile = STATIC_HISTORY_FILES[symbol];
  const historyUrl = STATIC_SNAPSHOT_MODE && historyFile
    ? `./data/history/${historyFile}?v=${Date.now()}`
    : `/api/history?symbol=${encodeURIComponent(symbol)}&days=${getHistoryRows()}`;
  const payload = await fetchJson(historyUrl);
  state.history = payload.history || [];
  restoreChartView();
  drawChart();
  replayMotion(document.querySelector(".chart-wrap"), "chart-refreshed");
}

function getHistoryRows() {
  const years = Number(state.summary?.config?.lookback_years || 10);
  return Math.ceil(years * 260 + 80);
}

function renderRunStatus() {
  const run = state.summary?.last_run;
  if (!run) {
    setRunStatus("尚未更新");
    return;
  }
  const status = run.status === "ok" ? "已更新" : run.status;
  setRunStatus(`${status} · ${new Date(run.finished_at || run.started_at).toLocaleString()}`);
}

function renderTabs() {
  const container = $("symbolTabs");
  container.innerHTML = "";
  for (const item of state.summary.latest || []) {
    const button = document.createElement("button");
    button.className = `symbol-tab ${item.symbol === state.selected ? "active" : ""}`;
    button.dataset.symbol = item.symbol;
    const viewLabel = String(item.asset_type || "").includes("A股") ? "A 股" : "纳指";
    button.innerHTML = `<strong>${escapeHtml(viewLabel)}</strong><span>${escapeHtml(displaySymbol(item))}</span>`;
    button.setAttribute("aria-label", `${viewLabel}工作区：${displaySymbol(item)}`);
    button.addEventListener("click", async () => {
      state.selected = item.symbol;
      persistPreferences();
      renderTabs();
      await loadHistory(item.symbol);
      renderSelected();
    });
    container.appendChild(button);
  }
}

function signalSnapshot(item) {
  const risk = currentRisk()?.overall || {};
  const macro = state.summary?.macro_environment?.overall || {};
  const momentum = state.summary?.dual_momentum?.allocation || {};
  return {
    trend: item.state_label,
    position: `${item.position_pct}%`,
    execution: item.fund_execution?.action || "暂无",
    dca: item.dca_action || "暂无",
    risk: risk.label || "暂无",
    macro: macro.label || "暂无",
    momentum: momentum.label || "暂无",
  };
}

function renderChangeDigest(item) {
  const container = $("changeDigest");
  if (!container || !item) return;
  const snapshots = readStorage(SNAPSHOT_STORAGE_KEY, {});
  const previous = snapshots[item.symbol];
  const next = signalSnapshot(item);
  snapshots[item.symbol] = next;
  writeStorage(SNAPSHOT_STORAGE_KEY, snapshots);
  if (!previous) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const labels = { trend: "趋势", position: "目标仓位", execution: "场外执行", dca: "定投", risk: "风险", macro: "宏观", momentum: "月度偏向" };
  const changes = Object.keys(next)
    .filter((key) => previous[key] !== undefined && previous[key] !== next[key])
    .map((key) => `<span><b>${escapeHtml(labels[key])}</b>${escapeHtml(previous[key])}<i>→</i>${escapeHtml(next[key])}</span>`);
  container.hidden = changes.length === 0;
  container.innerHTML = changes.length ? `<strong>本次变化</strong>${changes.join("")}` : "";
}

function renderExecutionPlan(item) {
  const container = $("executionPlan");
  if (!container || !item) return;
  const plan = personalizedExecution(item);
  const actualText = plan.actual === null || !Number.isFinite(plan.actual) ? "待填写" : `${plan.actual.toFixed(1)}%`;
  const gapText = plan.gap === null || !Number.isFinite(plan.gap) ? "待计算" : `${plan.gap >= 0 ? "+" : ""}${plan.gap.toFixed(1)}pp`;
  container.innerHTML = `
    <div class="execution-plan-head"><span>${escapeHtml(plan.definition.name)}</span><button type="button" data-open-execution-settings>管理篮子</button></div>
    <strong>${escapeHtml(plan.action)}</strong>
    <p>${escapeHtml(plan.note)}</p>
    <div class="execution-plan-stats"><span>实际 ${escapeHtml(actualText)}</span><span>本期 ${escapeHtml(targetPctText(plan.target))}</span><span>差额 ${escapeHtml(gapText)}</span></div>
  `;
}

function allocationSnapshot() {
  const settings = fundBasketSettings();
  const strategy = finalExecutionTargets();
  const rawEntries = FUND_BASKET_DEFINITIONS.map((definition) => ({
    ...definition,
    actual: basketActualPct(settings.baskets[definition.id]),
    color: BASKET_COLORS[definition.id],
  }));
  const hasAny = rawEntries.some((entry) => entry.actual !== null);
  const rawTotal = rawEntries.reduce((sum, entry) => sum + Number(entry.actual || 0), 0);
  const normalized = rawTotal > 100.05;
  const factor = normalized ? 100 / rawTotal : 1;
  const actualByBasket = Object.fromEntries(
    rawEntries.map((entry) => [entry.id, entry.actual === null ? null : Number(entry.actual) * factor])
  );
  const execution = currentExecutionTargets(actualByBasket);
  const entries = rawEntries.map((entry) => ({
    ...entry,
    normalizedActual: actualByBasket[entry.id],
    target: execution[entry.id],
    strategyTarget: strategy[entry.id],
  }));
  const sources = entries
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      value: Number(entry.normalizedActual || 0),
      displayValue: Number(entry.actual || 0),
      color: entry.color,
    }))
    .filter((entry) => entry.value > 0.005);
  const unclassified = normalized ? 0 : Math.max(0, 100 - rawTotal);
  if (unclassified > 0.005) {
    sources.push({
      id: "unclassified",
      name: "未归类",
      value: unclassified,
      displayValue: unclassified,
      color: BASKET_COLORS.unclassified,
    });
  }
  return {
    entries,
    sources,
    executionTargets: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      value: entry.target,
      displayValue: entry.target,
      color: entry.color,
    })),
    strategyTargets: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      value: entry.strategyTarget,
      displayValue: entry.strategyTarget,
      color: entry.color,
    })),
    rawTotal,
    unclassified,
    normalized,
    hasAny,
    label: execution.label,
    strategyLabel: strategy.label,
    strategic: strategy.strategic,
    momentum: strategy.momentum,
    caps: strategy.caps,
    constrained: strategy.constrained,
  };
}

function buildAllocationSankey(snapshot) {
  const width = 1000;
  const height = 270;
  const top = 48;
  const availableHeight = 184;
  const nodeWidth = 16;
  const leftX = 26;
  const middleX = width / 2 - nodeWidth / 2;
  const rightX = width - 42;
  const nodeGap = 12;
  const maxNodeCount = Math.max(snapshot.sources.length, snapshot.executionTargets.length, snapshot.strategyTargets.length);
  const scale = (availableHeight - nodeGap * Math.max(0, maxNodeCount - 1)) / 100;

  function layoutNodes(nodes, x) {
    const usedHeight = nodes.reduce((sum, node) => sum + node.value * scale, 0) + nodeGap * Math.max(0, nodes.length - 1);
    let y = top + Math.max(0, (availableHeight - usedHeight) / 2);
    return nodes.map((node) => {
      const layout = { ...node, x, y, height: Math.max(1, node.value * scale), inOffset: 0, outOffset: 0 };
      y += layout.height + nodeGap;
      return layout;
    });
  }

  const sourceNodes = layoutNodes(snapshot.sources, leftX);
  const executionNodes = layoutNodes(snapshot.executionTargets, middleX);
  const strategyNodes = layoutNodes(snapshot.strategyTargets, rightX);

  function connectStages(fromNodes, toNodes, stage) {
    const fromById = Object.fromEntries(fromNodes.map((node) => [node.id, node]));
    const toById = Object.fromEntries(toNodes.map((node) => [node.id, node]));
    const fromRemain = Object.fromEntries(fromNodes.map((node) => [node.id, node.value]));
    const toRemain = Object.fromEntries(toNodes.map((node) => [node.id, node.value]));
    const stageFlows = [];

    for (const definition of FUND_BASKET_DEFINITIONS) {
      const source = fromById[definition.id];
      const target = toById[definition.id];
      if (!source || !target) continue;
      const amount = Math.min(fromRemain[source.id], toRemain[target.id]);
      if (amount > 0.005) {
        stageFlows.push({ source, target, amount, stage });
        fromRemain[source.id] -= amount;
        toRemain[target.id] -= amount;
      }
    }

    for (const source of fromNodes) {
      for (const target of toNodes) {
        const amount = Math.min(fromRemain[source.id], toRemain[target.id]);
        if (amount <= 0.005) continue;
        stageFlows.push({ source, target, amount, stage });
        fromRemain[source.id] -= amount;
        toRemain[target.id] -= amount;
      }
    }
    return stageFlows;
  }

  const flows = [
    ...connectStages(sourceNodes, executionNodes, "current-execution"),
    ...connectStages(executionNodes, strategyNodes, "execution-strategy"),
  ];

  const gradients = [];
  const paths = flows.map((flow, index) => {
    const strokeWidth = Math.max(1, flow.amount * scale);
    const y1 = flow.source.y + flow.source.outOffset * scale + strokeWidth / 2;
    const y2 = flow.target.y + flow.target.inOffset * scale + strokeWidth / 2;
    flow.source.outOffset += flow.amount;
    flow.target.inOffset += flow.amount;
    const gradientId = `allocation-flow-${flow.stage}-${index}`;
    const startX = flow.source.x + nodeWidth;
    const endX = flow.target.x;
    const controlOne = startX + (endX - startX) * 0.42;
    const controlTwo = startX + (endX - startX) * 0.58;
    gradients.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${startX}" y1="${y1.toFixed(2)}" x2="${endX}" y2="${y2.toFixed(2)}"><stop offset="0" stop-color="${flow.source.color}"/><stop offset="1" stop-color="${flow.target.color}"/></linearGradient>`);
    return `<path d="M ${startX} ${y1.toFixed(2)} C ${controlOne.toFixed(2)} ${y1.toFixed(2)}, ${controlTwo.toFixed(2)} ${y2.toFixed(2)}, ${endX} ${y2.toFixed(2)}" fill="none" stroke="url(#${gradientId})" stroke-width="${strokeWidth.toFixed(2)}" stroke-opacity="0.52"><title>${escapeHtml(flow.source.name)} → ${escapeHtml(flow.target.name)} ${flow.amount.toFixed(1)}%</title></path>`;
  }).join("");

  function nodeMarkup(node, side) {
    const labelX = side === "right" ? node.x - 10 : node.x + nodeWidth + 10;
    const anchor = side === "right" ? "end" : "start";
    const digits = side === "left" ? 1 : 0;
    return `
      <g class="sankey-node sankey-node-${side}">
        <rect x="${node.x}" y="${node.y.toFixed(2)}" width="${nodeWidth}" height="${Math.max(3, node.height).toFixed(2)}" rx="3" fill="${node.color}"/>
        <text x="${labelX}" y="${(node.y + node.height / 2 + 4).toFixed(2)}" text-anchor="${anchor}">${escapeHtml(node.name)} ${node.displayValue.toFixed(digits)}%</text>
        <title>${escapeHtml(side === "left" ? "当前实际占比" : side === "middle" ? "结合信号强度后的本期执行仓位" : "趋势与双动量共同给出的策略中枢仓位")}</title>
      </g>
    `;
  }

  return `
    <svg class="allocation-sankey" viewBox="0 0 ${width} ${height}" role="img" aria-label="当前仓位流向本期执行仓位，再逐步靠近策略中枢仓位">
      <defs>${gradients.join("")}</defs>
      <text class="sankey-axis-title" x="26" y="25">当前仓位</text>
      <text class="sankey-axis-title" x="${width / 2}" y="25" text-anchor="middle">本期执行仓位</text>
      <text class="sankey-axis-title" x="${width - 26}" y="25" text-anchor="end">策略中枢仓位</text>
      <g class="sankey-links">${paths}</g>
      <g class="sankey-nodes">${sourceNodes.map((node) => nodeMarkup(node, "left")).join("")}${executionNodes.map((node) => nodeMarkup(node, "middle")).join("")}${strategyNodes.map((node) => nodeMarkup(node, "right")).join("")}</g>
    </svg>
  `;
}

function renderDecisionOutput(item, snapshot) {
  const container = $("decisionOutput");
  if (!container) return;
  if (!snapshot.hasAny) {
    container.innerHTML = `
      <div class="decision-output-top">
        <div class="decision-output-copy"><span>本期动作</span><strong>先填写三个篮子的持仓占比</strong></div>
        <button type="button" data-open-execution-settings>填写持仓</button>
      </div>
    `;
    return;
  }
  const underweight = snapshot.entries.filter((entry) => entry.actual === null || entry.target - Number(entry.actual || 0) > REBALANCE_POLICY.noActionPp);
  const overweight = snapshot.entries.filter((entry) => entry.actual !== null && entry.target - entry.actual < -REBALANCE_POLICY.noActionPp);
  let headline = "已接近本期执行仓位，保持当前节奏";
  if (underweight.length && overweight.length) {
    headline = `${overweight.map((entry) => entry.name).join("、")}暂停新增；新增资金优先补${underweight.map((entry) => entry.name).join("、")}`;
  } else if (underweight.length) {
    headline = `新增资金优先补${underweight.map((entry) => entry.name).join("、")}`;
  } else if (overweight.length) {
    headline = `${overweight.map((entry) => entry.name).join("、")}暂停新增，先核对未归类仓位`;
  }
  container.innerHTML = `
    <div class="decision-output-top">
      <div class="decision-output-copy">
        <span>本期动作</span>
        <strong>${escapeHtml(headline)}</strong>
      </div>
      <button type="button" data-open-execution-settings>更新持仓</button>
    </div>
  `;
}

function renderAllocationFlow(snapshot) {
  const container = $("fundBasketOverview");
  if (!container) return;
  if (!snapshot.hasAny) {
    container.innerHTML = `
      <div class="allocation-flow-head"><div><span>仓位与资金流</span><strong>等待持仓数据</strong></div></div>
      <div class="allocation-flow-empty">填写三个篮子的持仓占比后生成仓位路径。</div>
    `;
    return;
  }
  container.innerHTML = `
    <div class="allocation-flow-head">
      <div><span>仓位与资金流</span></div>
    </div>
    <div class="allocation-sankey-scroll">${buildAllocationSankey(snapshot)}</div>
  `;
}

function renderDecisionWorkspace() {
  const selected = current();
  const context = $("summaryContext");
  if (!selected) {
    if (context) context.textContent = "等待数据";
    const snapshot = allocationSnapshot();
    renderDecisionOutput(null, snapshot);
    renderAllocationFlow(snapshot);
    return;
  }
  if (context) context.textContent = `${displaySymbol(selected)} · ${selected.date}`;
  const snapshot = allocationSnapshot();
  renderDecisionOutput(selected, snapshot);
  renderAllocationFlow(snapshot);
  replayMotion($("decisionOutput"));
}

function renderSelected() {
  const item = current();
  if (!item) return;
  const maArrangement = movingAverageArrangement(item);
  $("currentSymbol").textContent = `${displaySymbol(item)} · ${fmtNum(item.price)}`;

  const pill = $("statePill");
  pill.textContent = item.state_label;
  pill.className = `state-pill state-${item.state || "unknown"}`;
  renderExecutionPlan(item);

  const rows = [
    ["市场环境", marketPhaseText(item)],
    ["均线排列", maArrangement.label],
    ["50 日均线", fmtNum(item.ma50)],
    ["100 日均线", fmtNum(item.ma100)],
    ["200 日均线", fmtNum(item.ma200)],
    ["防守线", fmtNum(item.defense_line)],
    ["突破线", fmtNum(item.breakout_line)],
    ["距离防守线", fmtPct(item.distance_to_defense_pct)],
    ["距离突破线", fmtPct(item.distance_to_breakout_pct)],
  ];
  $("metricList").innerHTML = rows
    .map(([k, v]) => {
      const longValue = String(v).length > 18;
      const maClass = k === "均线排列" ? `ma-arrangement ${maArrangement.tone}` : "";
      return `<div class="metric-row ${longValue ? "long" : ""}"><dt>${k}</dt><dd class="${maClass}">${v}</dd></div>`;
    })
    .join("");
  replayMotion($("metricList"));

  renderRiskLayer();
  renderMacroEnvironment();
  renderContextSummary();
  renderDecisionWorkspace();
  renderChangeDigest(item);
  renderDataQuality();
  updateWorkspaceHeading();
}

function renderContextSummary() {
  const container = $("contextSummary");
  const overallNode = $("contextOverall");
  if (!container || !overallNode) return;
  const macro = state.summary?.macro_environment || {};
  const risk = currentRisk() || {};
  const momentum = state.summary?.dual_momentum || {};
  const selected = current();
  const macroOverall = macro.overall || {};
  const relevance = macro.relevance_by_symbol?.[state.selected] || {};
  const riskOverall = risk.overall || {};
  const allocation = momentum.allocation || {};
  const isAshare = String(selected?.asset_type || "").includes("A股");
  const focusLabel = isAshare ? "沪深 300 主趋势" : "价格趋势优先";
  const focusTip = isAshare
    ? "A 股工作区先以沪深 300 的六类趋势和关键线作交易支点；创业板、全 A、中证 2000 等放在指标说明中作为后续观察地图。"
    : "纳指工作区先看六类趋势、关键线和均线；人民币宏观指标只作间接参考，美元风险条件更重要。";
  const riskTone = riskOverall.tone || "watch";
  const verdict = riskTone === "stress" || riskTone === "extreme" ? "风险优先" : "趋势优先";
  overallNode.textContent = verdict;
  container.innerHTML = `
    <div class="context-chip" tabindex="0" data-tip="${escapeHtml(`${macroOverall.note || ""} ${relevance.note || ""}`.trim())}">
      <span>宏观</span><strong class="${escapeHtml(macroOverall.tone || "missing")}">${escapeHtml(macroOverall.label || "暂无")}</strong>
    </div>
    <div class="context-chip" tabindex="0" data-tip="${escapeHtml(riskOverall.note || "风险层综合波动率、实际利率和信用利差，只用于限制风险放大。")}">
      <span>风险</span><strong class="${escapeHtml(riskTone)}">${escapeHtml(riskOverall.label || "暂无")}</strong>
    </div>
    <div class="context-chip" tabindex="0" data-tip="${escapeHtml(allocation.reason || "双动量按完整月末比较纳指与沪深 300 的相对和绝对动量。")}">
      <span>月度偏向</span><strong class="${escapeHtml(allocation.tone || "missing")}">${escapeHtml(allocation.label || "暂无")}</strong>
    </div>
    <div class="context-chip context-focus" tabindex="0" data-tip="${escapeHtml(focusTip)}">
      <span>判断支点</span><strong>${escapeHtml(focusLabel)}</strong>
    </div>
  `;
}

function renderMacroEnvironment() {
  const payload = state.summary?.macro_environment;
  const overallNode = $("macroOverall");
  const grid = $("macroEnvironment");
  const note = $("macroNote");
  if (!overallNode || !grid || !note) return;
  if (!payload?.enabled) {
    overallNode.textContent = "未启用";
    grid.innerHTML = `<div class="macro-cell"><span>状态</span><strong>宏观环境层未启用</strong></div>`;
    note.textContent = "";
    return;
  }
  const overall = payload.overall || {};
  const interest = payload.interest || {};
  const housing = payload.housing || {};
  const relevance = payload.relevance_by_symbol?.[state.selected] || {};
  const interestFreshness = freshnessInfo(interest.date, "market");
  const housingFreshness = freshnessInfo(housing.date, "monthly");
  overallNode.textContent = overall.label || "暂无";
  overallNode.title = overall.note || "";
  const spread = interest.bank_spread_bp === null || interest.bank_spread_bp === undefined ? "暂无" : `${fmtNum(interest.bank_spread_bp)} BP`;
  const housingChange = `环比 ${fmtPointPct(housing.mom)} · 同比 ${fmtPointPct(housing.yoy)}`;
  grid.innerHTML = `
    <div class="macro-cell macro-lead" tabindex="0" data-tip="${escapeHtml(overall.note || "宏观层只做环境确认。")}">
      <span>综合环境</span>
      <strong class="macro-value ${escapeHtml(overall.tone || "missing")}">${escapeHtml(overall.label || "暂无")}</strong>
    </div>
    <div class="macro-cell" tabindex="0" data-tip="人民币短端国债收益率越低，通常越有利于权益估值；它不是单独的买入信号。">
      <span>人民币估值条件</span>
      <strong class="macro-value ${escapeHtml(interest.tone || "missing")}">${escapeHtml(interest.label || "暂无")}</strong>
      <small>${escapeHtml(interest.date || "暂无日期")} ${staleBadgeHtml(interestFreshness)}</small>
    </div>
    <div class="macro-cell" tabindex="0" data-tip="1 年国债代表短端资金价格，10 年国债反映长期增长和通胀预期。">
      <span>1年国债 / 10年国债</span>
      <strong>${escapeHtml(`${fmtPointPct(interest.gov_1y)} / ${fmtPointPct(interest.gov_10y)}`)}</strong>
      <small>人民币无风险利率曲线</small>
    </div>
    <div class="macro-cell" tabindex="0" data-tip="AAA 银行金融债曲线反映银行融资环境；与国债的差值扩大通常代表信用或流动性压力上升。">
      <span>1年 AAA 银行曲线</span>
      <strong>${escapeHtml(fmtPointPct(interest.bank_1y))}</strong>
      <small>较国债 ${escapeHtml(spread)}</small>
    </div>
    <div class="macro-cell" tabindex="0" data-tip="北京二手住宅价格用于观察楼市修复，但必须结合成交量和挂牌量确认。">
      <span>北京二手住宅</span>
      <strong class="macro-value ${escapeHtml(housing.tone || "missing")}">${escapeHtml(housing.label || "暂无")}</strong>
      <small>${escapeHtml(housingChange)} · ${escapeHtml(housing.date || "暂无")} ${staleBadgeHtml(housingFreshness)}</small>
    </div>
    <div class="macro-cell" tabindex="0" data-tip="${escapeHtml(relevance.note || "说明该宏观条件与当前市场的关联程度。")}">
      <span>对当前标的</span>
      <strong class="macro-value ${escapeHtml(relevance.tone || "missing")}">${escapeHtml(relevance.label || "暂无")}</strong>
    </div>
  `;
  const sourceText = (payload.sources || []).map((source) => `${source.name} ${source.date}`).join(" · ");
  note.textContent = [payload.method_note, housing.listing_note, sourceText ? `数据：${sourceText}` : ""].filter(Boolean).join(" ");
}

function formatObservationValue(item) {
  if (!item?.available || item.value === null || item.value === undefined) return "暂无数据";
  if (item.unit === "%") return `${Number(item.value).toFixed(2)}%`;
  return Number(item.value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderAshareObservationMap() {
  const container = $("ashareObservationMap");
  if (!container) return;
  const payload = state.summary?.a_share_observation_map;
  const items = payload?.items || [];
  if (!payload?.enabled || !items.length) {
    container.innerHTML = `<article><span>数据状态</span><strong>观察地图暂无数据</strong></article>`;
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const change = item.change_20_pct === null || item.change_20_pct === undefined
        ? ""
        : `近20日 ${Number(item.change_20_pct) >= 0 ? "+" : ""}${Number(item.change_20_pct).toFixed(2)}%`;
      const tone = item.tone === "positive" ? "positive" : item.tone === "negative" ? "negative" : "";
      const source = [item.date || "暂无日期", item.source_note || ""].filter(Boolean).join(" · ");
      return `
        <article tabindex="0" data-tip="${escapeHtml(item.description || "该指标用于解释 A 股市场环境，不直接生成交易信号。")}">
          <span>${escapeHtml(item.category || "观察指标")}</span>
          <strong>${escapeHtml(item.name || item.id || "--")}</strong>
          <div class="guide-stat">
            <b>${escapeHtml(formatObservationValue(item))}</b>
            ${change ? `<em class="${tone}">${escapeHtml(change)}</em>` : ""}
          </div>
          <small class="guide-source">${escapeHtml(source)}</small>
        </article>
      `;
    })
    .join("");
}

function renderRiskLayer() {
  const risk = currentRisk();
  const overall = risk?.overall;
  const summary = $("riskOverall");
  const grid = $("riskLayer");
  if (!summary || !grid) return;
  if (!risk) {
    summary.textContent = "等待数据";
    grid.innerHTML = "";
    return;
  }
  const staleCount = Number(overall?.stale_count || 0);
  summary.textContent = `${overall?.label || "暂无"} · ${overall?.available_count || 0} 项${staleCount ? ` · ${staleCount} 项降权` : ""}`;
  summary.title = overall?.note || "";
  const cards = [...(risk.items || []), ...(risk.derived || [])];
  grid.innerHTML = cards
    .map((item) => {
      const change = item.change_20 === null || item.change_20 === undefined ? "" : `近20期 ${fmtSigned(item.change_20)}`;
      const date = item.date || "暂无日期";
      const detail = change ? `${date} · ${change}` : date;
      const tone = item.tone || "missing";
      const freshness = item.freshness || freshnessInfo(item.date, "market");
      return `
        <div class="risk-card ${escapeHtml(tone)} ${freshness.stale ? "stale" : ""}" tabindex="0" data-tip="${escapeHtml(item.description || "该指标用于观察市场风险温度。")}">
          <span>${escapeHtml(item.name || item.id || "")}</span>
          <strong>${escapeHtml(fmtRiskValue(item))}</strong>
          <em class="risk-level ${escapeHtml(tone)}">${escapeHtml(item.level_label || "暂无")}</em>
          <small>${escapeHtml(detail)} ${staleBadgeHtml(freshness)}</small>
        </div>
      `;
    })
    .join("");
}

function renderDataQuality() {
  const container = $("dataQualityStrip");
  if (!container) return;
  const stale = [];
  const risk = currentRisk();
  for (const item of [...(risk?.items || []), ...(risk?.derived || [])]) {
    const freshness = item.freshness || freshnessInfo(item.date, "market");
    if (item.available && freshness.stale) stale.push(`${item.name || item.id}（${freshness.label}）`);
  }
  const macro = state.summary?.macro_environment || {};
  const macroChecks = [
    ["人民币利率", macro.interest?.date, "market"],
    ["北京二手住宅", macro.housing?.date, "monthly"],
  ];
  for (const [name, date, cadence] of macroChecks) {
    const freshness = freshnessInfo(date, cadence);
    if (freshness.stale) stale.push(`${name}（${freshness.label}）`);
  }
  const momentum = state.summary?.dual_momentum || {};
  const momentumFreshness = freshnessInfo(momentum.cutoff_date, "monthEnd");
  if (momentum.enabled && momentumFreshness.stale) stale.push(`双动量（月末数据${momentumFreshness.label}）`);
  container.hidden = stale.length === 0;
  container.innerHTML = stale.length
    ? `<strong>数据时效提醒</strong><span>${escapeHtml(stale.join("；"))}。过期风险指标已从综合风险温度中降权。</span>`
    : "";
}

function currentRisk() {
  return state.summary?.risks_by_symbol?.[state.selected] || state.summary?.risk;
}

function renderDualMomentum() {
  const payload = state.summary?.dual_momentum;
  const grid = $("dualMomentum");
  const review = $("momentumReview");
  const note = $("momentumNote");
  if (!grid || !review || !note) return;
  if (!payload?.enabled) {
    review.textContent = "未启用";
    grid.innerHTML = `<div class="momentum-cell"><span>状态</span><strong>双动量未启用</strong></div>`;
    note.textContent = "";
    return;
  }

  const allocation = payload.allocation || {};
  const alignment = payload.alignment || {};
  const assets = payload.assets || [];
  review.textContent = `截至 ${payload.cutoff_date || "暂无"} · 下次 ${payload.next_review || "暂无"}`;
  const assetCells = assets
    .map((asset) => {
      const available = asset.available && asset.momentum !== null && asset.momentum !== undefined;
      const momentumClass = available ? (Number(asset.momentum) > Number(payload.absolute_threshold || 0) ? "positive" : "negative") : "missing";
      const value = available ? fmtPct(asset.momentum) : "数据不足";
      const dates = available ? `${asset.base_date} → ${asset.as_of_date}` : asset.reason || "暂无说明";
      const freshness = freshnessInfo(asset.as_of_date, "monthEnd");
      return `
        <div class="momentum-cell" tabindex="0" data-tip="比较最近 ${payload.lookback_trading_days} 个交易日收益；高于零代表绝对动量为正。">
          <span>${escapeHtml(asset.label || asset.symbol)} · ${payload.lookback_trading_days}日</span>
          <strong class="momentum-value ${momentumClass}">${escapeHtml(value)}</strong>
          <small>${escapeHtml(dates)} ${staleBadgeHtml(freshness)}</small>
        </div>
      `;
    })
    .join("");
  const spreadValue =
    payload.spread === null || payload.spread === undefined
      ? "暂无"
      : `${(Number(payload.spread) * 100).toFixed(2)} 个百分点`;
  grid.innerHTML = `
    <div class="momentum-cell momentum-lead" tabindex="0" data-tip="相对动量先选择纳指与沪深 300 中较强者，绝对动量再判断是否应该持有风险资产。">
      <span>月度配置偏向</span>
      <strong class="momentum-allocation ${escapeHtml(allocation.tone || "missing")}">${escapeHtml(allocation.label || "暂无")}</strong>
      <small>${escapeHtml(allocation.reason || "暂无说明")}</small>
    </div>
    ${assetCells}
    <div class="momentum-cell" tabindex="0" data-tip="两个风险资产过去一年收益率之差，只表示配置偏向，不代表短期交易信号。">
      <span>相对领先幅度</span>
      <strong>${escapeHtml(spreadValue)}</strong>
      <small>仅比较两个风险资产</small>
    </div>
    <div class="momentum-cell momentum-alignment" tabindex="0" data-tip="检查月度配置方向是否与当前六类趋势一致；冲突时不强制追涨换仓。">
      <span>与趋势系统配合</span>
      <strong class="${escapeHtml(alignment.tone || "missing")}">${escapeHtml(alignment.label || "暂无")}</strong>
      <small>${escapeHtml(alignment.note || "暂无说明")}</small>
    </div>
  `;
  const warnings = payload.quality?.warnings || [];
  const warningText = warnings.length ? ` 数据提醒：${warnings.join("；")}。` : "";
  note.textContent = [payload.method_note, payload.execution_note, payload.scope_note, warningText.trim()]
    .filter(Boolean)
    .join(" ");
}

function stateTransitionLabel(item) {
  const rows = state.history || [];
  const currentIndex = rows.findIndex((row) => row.date === item.date && row.symbol === item.symbol);
  let previous = null;
  if (currentIndex > 0) {
    for (let idx = currentIndex - 1; idx >= 0; idx -= 1) {
      if (rows[idx].state_label && rows[idx].state_label !== item.state_label) {
        previous = rows[idx].state_label;
        break;
      }
    }
  }
  return previous ? `${previous}→${item.state_label}` : item.state_label;
}


function visibleHistory() {
  const rows = state.history.filter((item) => item.price);
  if (!rows.length) return [];
  return rows.slice(state.view.start, state.view.end + 1);
}

function timelineSegments(rows) {
  const segments = [];
  rows.forEach((row, index) => {
    const stateKey = row.state || row.primary_state || "unknown";
    const label = row.state_label || stateKey;
    const previous = segments[segments.length - 1];
    if (previous && previous.state === stateKey) {
      previous.endDate = row.date;
      previous.endPrice = row.price;
      previous.days += 1;
      return;
    }
    segments.push({
      state: stateKey,
      label,
      startDate: row.date,
      endDate: row.date,
      startPrice: row.price,
      endPrice: row.price,
      days: 1,
      fromLabel: index > 0 ? rows[index - 1].state_label : null,
    });
  });
  return segments;
}

function renderTrendVisualization(force = false) {
  const timeline = $("stateTimeline");
  const range = $("timelineRange");
  const count = $("transitionCount");
  if (!timeline || !range || !count) return;
  const rows = visibleHistory();
  const key = `${state.selected || ""}:${state.view.start}:${state.view.end}:${state.history.length}`;
  if (!force && key === state.timelineKey) return;
  state.timelineKey = key;

  if (!rows.length) {
    timeline.innerHTML = `<div class="timeline-empty">暂无趋势数据</div>`;
    range.textContent = "等待数据";
    count.textContent = "0 次";
    renderTransitionHistory([]);
    return;
  }

  const segments = timelineSegments(rows);
  const totalDays = rows.length;
  timeline.innerHTML = segments
    .map((segment) => {
      const ratio = segment.days / totalDays;
      const compact = ratio < 0.075 ? " compact" : "";
      const change = segment.fromLabel && segment.fromLabel !== segment.label ? `${segment.fromLabel}→${segment.label}` : `延续${segment.label}`;
      return `
        <div
          class="timeline-segment state-${escapeHtml(segment.state)}${compact}"
          style="flex-grow:${segment.days}"
          tabindex="0"
          data-label="${escapeHtml(segment.label)}"
          data-change="${escapeHtml(change)}"
          data-start="${escapeHtml(segment.startDate)}"
          data-end="${escapeHtml(segment.endDate)}"
          data-days="${segment.days}"
          data-start-price="${escapeHtml(fmtNum(segment.startPrice))}"
          data-end-price="${escapeHtml(fmtNum(segment.endPrice))}"
          aria-label="${escapeHtml(`${change}，${segment.startDate} 至 ${segment.endDate}，${segment.days} 个交易日`)}"
        ><span>${escapeHtml(segment.label)}</span></div>
      `;
    })
    .join("");

  const middleRow = rows[Math.floor((rows.length - 1) / 2)];
  $("timelineStart").textContent = rows[0].date;
  $("timelineMiddle").textContent = middleRow?.date || "--";
  $("timelineEnd").textContent = rows[rows.length - 1].date;
  range.textContent = `${segments.length} 个状态区段 · 与价格图同步`;
  const transitions = transitionHistory(rows);
  count.textContent = `${transitions.length} 次`;
  renderTransitionHistory(transitions);
}

function renderTransitionHistory(transitions = transitionHistory(visibleHistory())) {
  const list = $("notesList");
  list.className = "transition-list";
  if (!transitions.length) {
    list.innerHTML = `<li><span class="transition-date">暂无</span><span class="transition-change">当前区间内没有状态切换</span></li>`;
    return;
  }
  list.innerHTML = transitions
    .map(
      (item) => `
        <li>
          <span class="transition-date">${escapeHtml(item.date)}</span>
          <span class="transition-change">${transitionChangeHtml(item)}</span>
          <span class="transition-price">${escapeHtml(fmtNum(item.price))}</span>
        </li>
      `
    )
    .join("");
}

function transitionHistory(rows = state.history || []) {
  const transitions = [];
  for (let idx = rows.length - 1; idx > 0; idx -= 1) {
    const currentRow = rows[idx];
    const previousRow = rows[idx - 1];
    if (currentRow.state_label && previousRow.state_label && currentRow.state_label !== previousRow.state_label) {
      transitions.push({
        date: currentRow.date,
        fromLabel: previousRow.state_label,
        toLabel: currentRow.state_label,
        change: `${previousRow.state_label}→${currentRow.state_label}`,
        price: currentRow.price,
      });
    }
  }
  return transitions;
}


function setupIndicatorTooltip() {
  const tooltip = document.createElement("div");
  tooltip.className = "legend-tooltip";
  document.body.appendChild(tooltip);
  let activeTarget = null;

  for (const target of document.querySelectorAll("[data-tip]")) {
    target.setAttribute("title", target.dataset.tip || "");
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "0");
  }

  const positionTooltip = (event) => {
    const gap = 14;
    const edge = 12;
    const width = tooltip.offsetWidth || 260;
    const height = tooltip.offsetHeight || 60;
    let left = event.clientX + gap;
    let top = event.clientY + gap;
    if (left + width > window.innerWidth - edge) left = event.clientX - width - gap;
    if (top + height > window.innerHeight - edge) top = event.clientY - height - gap;
    tooltip.style.left = `${Math.max(edge, left)}px`;
    tooltip.style.top = `${Math.max(edge, top)}px`;
  };

  const showTooltip = (target, event) => {
    activeTarget = target;
    const tooltipHost = target.closest?.("dialog") || document.body;
    if (tooltip.parentElement !== tooltipHost) tooltipHost.appendChild(tooltip);
    tooltip.textContent = target.dataset.tip || "";
    tooltip.classList.add("visible");
    if (event) {
      positionTooltip(event);
      return;
    }
    const rect = target.getBoundingClientRect();
    positionTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.bottom });
  };

  const hideTooltip = () => {
    activeTarget = null;
    tooltip.classList.remove("visible");
  };

  document.addEventListener("mouseover", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (!target) return;
    showTooltip(target, event);
  });

  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (!target) return;
    showTooltip(target);
  });

  document.addEventListener("mousemove", (event) => {
    if (!activeTarget) return;
    positionTooltip(event);
  });

  document.addEventListener("mouseout", (event) => {
    const target = event.target.closest?.("[data-tip]");
    if (!target || target.contains(event.relatedTarget)) return;
    hideTooltip();
  });

  document.addEventListener("focusout", (event) => {
    if (!event.target.closest?.("[data-tip]")) return;
    hideTooltip();
  });

  window.addEventListener("resize", hideTooltip);
}

let fundBasketDraft = null;

function updateFundBasketFormSummary() {
  if (!fundBasketDraft) return;
  const enteredActuals = FUND_BASKET_DEFINITIONS
    .map(({ id }) => basketActualPct(fundBasketDraft.baskets[id]))
    .filter((value) => value !== null);
  const actualTotal = enteredActuals.length
    ? enteredActuals.reduce((sum, value) => sum + value, 0)
    : null;
  const status = $("basketTargetStatus");
  if (status) {
    const remaining = actualTotal === null ? null : 100 - actualTotal;
    status.textContent = actualTotal === null
      ? "尚未填写持仓占比"
      : Math.abs(remaining) <= 0.05
        ? "已完整记录 100%"
        : remaining > 0
          ? `已记录 ${actualTotal.toFixed(1)}% · 尚有 ${remaining.toFixed(1)}% 未归类`
          : `合计 ${actualTotal.toFixed(1)}% · 超出 ${Math.abs(remaining).toFixed(1)}%`;
    status.classList.toggle("warning", actualTotal !== null && Math.abs(remaining) > 0.05);
    status.classList.toggle("complete", actualTotal !== null && Math.abs(remaining) <= 0.05);
  }
  const actualByBasket = Object.fromEntries(
    FUND_BASKET_DEFINITIONS.map(({ id }) => [id, basketActualPct(fundBasketDraft.baskets[id])])
  );
  const targets = currentExecutionTargets(actualByBasket);
  for (const definition of FUND_BASKET_DEFINITIONS) {
    const actual = basketActualPct(fundBasketDraft.baskets[definition.id]);
    const gap = actual === null ? null : targets[definition.id] - actual;
    const gapNode = document.querySelector(`[data-basket-gap="${definition.id}"]`);
    if (gapNode) {
      gapNode.textContent = gap === null
        ? "填写后计算偏离"
        : Math.abs(gap) <= 0.05
          ? "与本期仓位一致"
          : `${gap > 0 ? "低于" : "高于"}目标 ${Math.abs(gap).toFixed(1)} 个百分点`;
    }
  }
}

function renderFundBasketEditor() {
  const editor = $("fundBasketEditor");
  if (!editor || !fundBasketDraft) return;

  const activeBasketId = basketDefinitionFor(current()).id;
  const actualByBasket = Object.fromEntries(
    FUND_BASKET_DEFINITIONS.map(({ id }) => [id, basketActualPct(fundBasketDraft.baskets[id])])
  );
  const targets = currentExecutionTargets(actualByBasket);
  const strategy = targets.strategy;
  editor.innerHTML = FUND_BASKET_DEFINITIONS.map((definition) => {
    const basket = fundBasketDraft.baskets[definition.id];
    const actual = basketActualPct(basket);
    const target = targets[definition.id];
    const gap = actual === null ? null : target - actual;
    return `
      <section class="fund-basket-card ${definition.tone} ${definition.id === activeBasketId ? "active" : ""}" data-basket-id="${definition.id}">
        <div class="fund-basket-head">
          <div><i aria-hidden="true"></i><h3>${escapeHtml(definition.name)}</h3></div>
          <span>${escapeHtml(targets.label)}</span>
        </div>
        <div class="basket-allocation-grid">
          <label><span>当前持仓占比</span><div class="inline-input"><input type="number" min="0" max="100" step="0.1" data-basket-field="actualPct" data-basket-id="${definition.id}" value="${actual ?? ""}" placeholder="待填写" /><em>%</em></div></label>
          <div class="basket-reference"><span>本期执行仓位</span><strong>${targetPctText(target)}</strong><small data-basket-gap="${definition.id}">${gap === null ? "填写后计算偏离" : Math.abs(gap) <= 0.05 ? "与本期仓位一致" : `${gap > 0 ? "低于" : "高于"}本期仓位 ${Math.abs(gap).toFixed(1)} 个百分点`}</small><small>策略中枢 ${targetPctText(strategy[definition.id])}</small></div>
        </div>
      </section>
    `;
  }).join("");
  updateFundBasketFormSummary();
}

function fillExecutionSettingsForm(settings = fundBasketSettings()) {
  fundBasketDraft = normalizeFundBasketSettings(settings);
  renderFundBasketEditor();
}

function openExecutionSettings() {
  const dialog = $("executionSettings");
  if (!dialog || !state.selected) return;
  $("executionSettingsSymbol").textContent = "三个基金篮子";
  fillExecutionSettingsForm();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function setupExecutionSettings() {
  const dialog = $("executionSettings");
  const form = $("executionSettingsForm");
  if (!dialog || !form) return;
  $("closeExecutionSettingsBtn")?.addEventListener("click", () => dialog.close());
  $("resetExecutionSettingsBtn")?.addEventListener("click", () => fillExecutionSettingsForm(DEFAULT_FUND_BASKET_SETTINGS));
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-open-execution-settings]")) openExecutionSettings();
  });
  dialog.addEventListener("input", (event) => {
    if (!fundBasketDraft) return;
    const target = event.target;
    const basketId = target.dataset.basketId || target.closest?.("[data-basket-id]")?.dataset.basketId;
    if (!basketId || !fundBasketDraft.baskets[basketId]) return;
    if (target.dataset.basketField) {
      fundBasketDraft.baskets[basketId].actualPct = optionalNumber(target.value, 0, 100);
      updateFundBasketFormSummary();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveFundBasketSettings(fundBasketDraft || DEFAULT_FUND_BASKET_SETTINGS);
    dialog.close();
    renderSelected();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
}

function setChartFullscreen(enabled) {
  const area = document.querySelector(".chart-area");
  const button = $("fullscreenChartBtn");
  if (!area || !button) return;
  state.chartFullscreen = enabled;
  area.classList.toggle("chart-focus-mode", enabled);
  document.body.classList.toggle("chart-fullscreen-open", enabled);
  button.textContent = enabled ? "×" : "⛶";
  button.title = enabled ? "退出全屏" : "全屏查看";
  button.setAttribute("aria-label", button.title);
  requestAnimationFrame(drawChart);
}

function setupFullscreenChart() {
  $("fullscreenChartBtn")?.addEventListener("click", () => setChartFullscreen(!state.chartFullscreen));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.chartFullscreen) setChartFullscreen(false);
  });
}

function setupMovingAverageToggles() {
  for (const button of document.querySelectorAll("[data-line-toggle]")) {
    const field = button.dataset.lineToggle;
    const syncButton = () => {
      const active = Boolean(state.visibleMovingAverages[field]);
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    };
    syncButton();
    button.addEventListener("click", () => {
      state.visibleMovingAverages[field] = !state.visibleMovingAverages[field];
      persistPreferences();
      syncButton();
      drawChart();
    });
  }
}

function current() {
  return (state.summary?.latest || []).find((item) => item.symbol === state.selected);
}

function persistChartView() {
  if (!state.selected || !state.history.length) return;
  const startDate = state.history[state.view.start]?.date;
  const endDate = state.history[state.view.end]?.date;
  if (!startDate || !endDate) return;
  state.visibleDays = state.view.end - state.view.start + 1;
  state.savedChartViews[state.selected] = { startDate, endDate };
  persistPreferences();
}

function restoreChartView() {
  const saved = state.savedChartViews[state.selected];
  if (saved) {
    const start = state.history.findIndex((item) => item.date >= saved.startDate);
    let end = -1;
    for (let index = state.history.length - 1; index >= 0; index -= 1) {
      if (state.history[index].date <= saved.endDate) {
        end = index;
        break;
      }
    }
    if (start >= 0 && end >= start) {
      state.view = { start, end };
      state.timelineKey = null;
      updateRangeText();
      return;
    }
  }
  resetChartView();
}

function resetChartView() {
  const end = Math.max(0, state.history.length - 1);
  const start = Math.max(0, end - state.visibleDays + 1);
  state.view = { start, end };
  state.timelineKey = null;
  updateRangeText();
  persistChartView();
}

function clampView(start, end) {
  const maxEnd = Math.max(0, state.history.length - 1);
  let nextStart = Math.round(start);
  let nextEnd = Math.round(end);
  const span = Math.max(MIN_VISIBLE_DAYS, nextEnd - nextStart + 1);
  if (span >= maxEnd + 1) {
    state.view = { start: 0, end: maxEnd };
    updateRangeText();
    return;
  }
  if (nextStart < 0) {
    nextEnd -= nextStart;
    nextStart = 0;
  }
  if (nextEnd > maxEnd) {
    const shift = nextEnd - maxEnd;
    nextStart = Math.max(0, nextStart - shift);
    nextEnd = maxEnd;
  }
  if (nextEnd - nextStart + 1 < MIN_VISIBLE_DAYS) {
    nextEnd = Math.min(maxEnd, nextStart + MIN_VISIBLE_DAYS - 1);
  }
  state.view = { start: nextStart, end: nextEnd };
  updateRangeText();
}

function zoomChart(factor, anchorRatio = 0.5) {
  if (!state.history.length) return;
  const { start, end } = state.view;
  const visible = end - start + 1;
  const nextVisible = Math.max(MIN_VISIBLE_DAYS, Math.min(state.history.length, visible * factor));
  const anchorIndex = start + visible * anchorRatio;
  const nextStart = anchorIndex - nextVisible * anchorRatio;
  clampView(nextStart, nextStart + nextVisible - 1);
  persistChartView();
  drawChart();
}

function updateRangeText() {
  const text = $("rangeText");
  if (!state.history.length) return;
  const start = state.history[state.view.start]?.date || "";
  const end = state.history[state.view.end]?.date || "";
  if (text) text.textContent = `${start} → ${end}`;
  if (chartWrap) {
    chartWrap.dataset.rangeStart = start;
    chartWrap.dataset.rangeEnd = end;
    chartWrap.dataset.visibleDays = String(state.view.end - state.view.start + 1);
    chartWrap.setAttribute("aria-label", `价格图 ${start} 至 ${end}`);
  }
}

function drawChart() {
  const canvas = $("priceChart");
  const ctx = canvas.getContext("2d");
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(cssWidth * ratio);
  canvas.height = Math.floor(cssHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  hideChartHoverCard();

  const fullData = state.history.filter((item) => item.price);
  if (!fullData.length) {
    ctx.fillStyle = "#92909a";
    ctx.fillText("暂无历史数据", 24, 32);
    renderTrendVisualization();
    return;
  }
  const maxEnd = fullData.length - 1;
  if (state.view.end > maxEnd || state.view.end < state.view.start) {
    state.view = { start: 0, end: maxEnd };
  }
  const data = fullData.slice(state.view.start, state.view.end + 1);

  const pad = { left: 54, right: 112, top: 22, bottom: 38 };
  const width = cssWidth - pad.left - pad.right;
  const height = cssHeight - pad.top - pad.bottom;
  const values = [];
  for (const item of data) {
    values.push(item.price);
    for (const field of ["ma50", "ma100", "ma200"]) {
      if (state.visibleMovingAverages[field] && item[field]) values.push(item[field]);
    }
    if (item.defense_line) values.push(item.defense_line);
    if (item.breakout_line) values.push(item.breakout_line);
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const low = min - span * 0.08;
  const high = max + span * 0.08;
  const x = (idx) => pad.left + (idx / Math.max(1, data.length - 1)) * width;
  const y = (value) => pad.top + (1 - (value - low) / (high - low)) * height;

  drawGrid(ctx, pad, width, height, low, high, y);
  drawTimeGrid(ctx, data, pad, width, height);
  drawLine(ctx, data, x, y, "price", "#e7e4eb", 2);
  if (state.visibleMovingAverages.ma50) drawLine(ctx, data, x, y, "ma50", "#d778a5", 1.25);
  if (state.visibleMovingAverages.ma100) drawLine(ctx, data, x, y, "ma100", "#61b7aa", 1.35);
  if (state.visibleMovingAverages.ma200) drawLine(ctx, data, x, y, "ma200", "#7d8fdf", 1.6);
  drawStepLine(ctx, data, x, y, "defense_line", "#e2a63c", 2.2, [8, 7]);
  drawStepLine(ctx, data, x, y, "breakout_line", "#ff6257", 2.2, [7, 6]);
  drawLatestThresholdLabel(ctx, data, x, y, "defense_line", "#e2a63c", "防守", cssWidth, cssHeight);
  drawLatestThresholdLabel(ctx, data, x, y, "breakout_line", "#ff6257", "突破", cssWidth, cssHeight);
  drawStateMarkers(ctx, data, x, y, cssHeight);
  drawAxisLabels(ctx, data, pad, width, cssHeight);
  drawHoverSelection(ctx, data, pad, width, height, x, y, cssWidth, cssHeight);
  if (chartWrap) chartWrap.dataset.tickCount = String(chartTickIndexes(data.length, width).length);
  updateRangeText();
  renderTrendVisualization();
}

function setupTimelineInteraction() {
  const wrap = $("timelineWrap");
  const tooltip = $("timelineTooltip");
  if (!wrap || !tooltip) return;

  const show = (segment, clientX) => {
    tooltip.innerHTML = `
      <strong class="${stateTextClass(segment.dataset.label)}">${escapeHtml(segment.dataset.change)}</strong>
      <span>${escapeHtml(segment.dataset.start)} → ${escapeHtml(segment.dataset.end)}</span>
      <span>${escapeHtml(segment.dataset.days)} 个交易日</span>
      <span>${escapeHtml(segment.dataset.startPrice)} → ${escapeHtml(segment.dataset.endPrice)}</span>
    `;
    tooltip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const tooltipWidth = tooltip.offsetWidth || 190;
    const localX = clientX === null ? segment.getBoundingClientRect().left + segment.getBoundingClientRect().width / 2 - wrapRect.left : clientX - wrapRect.left;
    const left = Math.max(8, Math.min(wrapRect.width - tooltipWidth - 8, localX - tooltipWidth / 2));
    tooltip.style.left = `${left}px`;
  };

  const hide = () => {
    tooltip.hidden = true;
  };

  wrap.addEventListener("pointermove", (event) => {
    const segment = event.target.closest?.(".timeline-segment");
    if (!segment) {
      hide();
      return;
    }
    show(segment, event.clientX);
  });
  wrap.addEventListener("pointerleave", hide);
  wrap.addEventListener("focusin", (event) => {
    const segment = event.target.closest?.(".timeline-segment");
    if (segment) show(segment, null);
  });
  wrap.addEventListener("focusout", hide);
}

function drawGrid(ctx, pad, width, height, low, high, y) {
  ctx.save();
  ctx.strokeStyle = "#2a2730";
  ctx.fillStyle = "#92909a";
  ctx.lineWidth = 1;
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  for (let i = 0; i <= 4; i++) {
    const value = low + ((high - low) * i) / 4;
    const yy = y(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, yy);
    ctx.lineTo(pad.left + width, yy);
    ctx.stroke();
    ctx.fillText(value.toFixed(0), 10, yy + 4);
  }
  ctx.restore();
}

function chartTickIndexes(length, width) {
  if (!length) return [];
  const maxTicks = width < 260
    ? 2
    : Math.max(3, Math.min(9, Math.floor(width / 105)));
  const count = Math.min(length, maxTicks);
  const indexes = new Set();
  for (let i = 0; i < count; i += 1) {
    indexes.add(Math.round((i * (length - 1)) / Math.max(1, count - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

function drawTimeGrid(ctx, data, pad, width, height) {
  const indexes = chartTickIndexes(data.length, width);
  ctx.save();
  ctx.strokeStyle = "#201e25";
  ctx.lineWidth = 1;
  for (const idx of indexes) {
    const xx = pad.left + (idx / Math.max(1, data.length - 1)) * width;
    ctx.beginPath();
    ctx.moveTo(xx, pad.top);
    ctx.lineTo(xx, pad.top + height);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLine(ctx, data, x, y, field, color, width, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  data.forEach((item, idx) => {
    const value = item[field];
    if (value === null || value === undefined) {
      started = false;
      return;
    }
    if (!started) {
      ctx.moveTo(x(idx), y(value));
      started = true;
    } else {
      ctx.lineTo(x(idx), y(value));
    }
  });
  ctx.stroke();
  ctx.restore();
}

function drawStepLine(ctx, data, x, y, field, color, width, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let started = false;
  let prevValue = null;
  data.forEach((item, idx) => {
    const value = item[field];
    if (value === null || value === undefined) {
      started = false;
      prevValue = null;
      return;
    }
    const xx = x(idx);
    const yy = y(value);
    if (!started) {
      ctx.moveTo(xx, yy);
      started = true;
    } else {
      ctx.lineTo(xx, y(prevValue));
      ctx.lineTo(xx, yy);
    }
    prevValue = value;
  });
  ctx.stroke();
  ctx.restore();
}

function drawLatestThresholdLabel(ctx, data, x, y, field, color, label, cssWidth, cssHeight) {
  const idx = data.length - 1;
  const value = data[idx]?.[field];
  if (value === null || value === undefined) return;
  const text = `${label} ${fmtNum(value)}`;
  ctx.save();
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  const labelWidth = ctx.measureText(text).width + 12;
  const labelHeight = 22;
  const rawY = y(value);
  const yy = Math.max(labelHeight / 2 + 2, Math.min(cssHeight - labelHeight / 2 - 2, rawY));
  let xx = x(idx) + 8;
  if (xx + labelWidth > cssWidth - 8) xx = cssWidth - labelWidth - 8;
  xx = Math.max(8, xx);
  const boxY = yy - labelHeight / 2;
  ctx.fillStyle = "rgba(18, 17, 22, 0.94)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  roundRect(ctx, xx, boxY, labelWidth, labelHeight, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, xx + 6, boxY + 15);
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawStateMarkers(ctx, data, x, y, cssHeight) {
  ctx.save();
  for (let idx = 1; idx < data.length; idx += 1) {
    const item = data[idx];
    const prev = data[idx - 1];
    const primaryTurn = item.primary_state !== prev.primary_state;
    const secondaryTurn = item.state !== prev.state && ["recover2nd", "retreat2nd"].includes(item.state);
    if (!primaryTurn && !secondaryTurn) continue;
    const markerState = primaryTurn ? item.primary_state : item.state;
    const style = MARKER_STYLES[markerState] || MARKER_STYLES.recover;
    const cx = x(idx);
    const cy = y(item.price);
    if (primaryTurn) {
      drawKeyCross(ctx, cx, cy, style, cssHeight);
    }
    drawMarker(ctx, cx, cy, style);
  }
  ctx.restore();
}

function drawMarker(ctx, cx, cy, style) {
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.fill ? style.color : "#121116";
  if (style.shape === "diamond") {
    const r = style.radius + 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, style.radius, 0, Math.PI * 2);
  }
  ctx.fill();
  if (!style.fill || style.shape === "diamond") {
    ctx.stroke();
  }
  ctx.restore();
}

function drawKeyCross(ctx, cx, cy, style, cssHeight) {
  const size = 5;
  const keyY = style.key === "down" ? Math.min(cy + 13, cssHeight - 52) : Math.max(cy - 13, 26);
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 2.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - size, keyY);
  ctx.lineTo(cx + size, keyY);
  ctx.moveTo(cx, keyY - size);
  ctx.lineTo(cx, keyY + size);
  ctx.stroke();
  ctx.restore();
}

function drawAxisLabels(ctx, data, pad, width, cssHeight) {
  ctx.save();
  ctx.fillStyle = "#92909a";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textBaseline = "middle";
  const indexes = chartTickIndexes(data.length, width);
  for (const idx of indexes) {
    const label = data[idx]?.date || "";
    const labelWidth = ctx.measureText(label).width;
    const xx = pad.left + (idx / Math.max(1, data.length - 1)) * width;
    const textX = Math.max(6, Math.min(pad.left + width - labelWidth, xx - labelWidth / 2));
    ctx.fillText(label, textX, cssHeight - 16);
  }
  ctx.restore();
}

function drawHoverSelection(ctx, data, pad, width, height, x, y, cssWidth, cssHeight) {
  if (!state.hover || !data.length) return;
  const { x: hoverX, y: hoverY } = state.hover;
  const plotRight = pad.left + width;
  const plotBottom = pad.top + height;
  if (hoverX < pad.left || hoverX > plotRight || hoverY < pad.top || hoverY > plotBottom) return;

  const idx = Math.max(0, Math.min(data.length - 1, Math.round(((hoverX - pad.left) / Math.max(1, width)) * (data.length - 1))));
  const item = data[idx];
  if (!item?.price) return;
  const cx = x(idx);
  const cy = y(item.price);
  const rows = [
    item.date,
    `${displaySymbol(state.selected || item.symbol)} ${fmtNum(item.price)}`,
    item.state_label || "",
  ].filter(Boolean);

  ctx.save();
  ctx.strokeStyle = "rgba(231, 228, 235, 0.42)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(cx, pad.top);
  ctx.lineTo(cx, plotBottom);
  ctx.moveTo(pad.left, cy);
  ctx.lineTo(plotRight, cy);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#121116";
  ctx.strokeStyle = "#e7e4eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  showChartHoverCard(rows, cx, cy, cssWidth, cssHeight);
  ctx.restore();
}

function showChartHoverCard(rows, cx, cy, cssWidth, cssHeight) {
  const card = $("chartHoverCard");
  if (!card) return;
  const stateLabel = rows[2] || "";
  card.innerHTML = `
    <div class="hover-date">${escapeHtml(rows[0])}</div>
    <div class="hover-price">${escapeHtml(rows[1])}</div>
    ${stateLabel ? `<div class="hover-state ${stateTextClass(stateLabel)}">${escapeHtml(stateLabel)}</div>` : ""}
  `;
  card.hidden = false;
  const cardWidth = card.offsetWidth || 132;
  const cardHeight = card.offsetHeight || 72;
  let left = cx + 12;
  let top = cy - cardHeight - 12;
  if (left + cardWidth > cssWidth - 8) left = cx - cardWidth - 12;
  if (top < 8) top = cy + 12;
  if (top + cardHeight > cssHeight - 8) top = cssHeight - cardHeight - 8;
  card.style.left = `${Math.max(8, left)}px`;
  card.style.top = `${Math.max(8, top)}px`;
}

function hideChartHoverCard() {
  const card = $("chartHoverCard");
  if (!card) return;
  card.hidden = true;
}

async function updateNow() {
  const button = $("refreshBtn");
  button.disabled = true;
  button.classList.add("is-spinning");
  document.body.classList.add("is-updating");
  setRunStatus(STATIC_SNAPSHOT_MODE ? "正在读取公开快照..." : "正在更新行情...");
  try {
    if (!STATIC_SNAPSHOT_MODE) await fetchJson("/api/update", { method: "POST" });
    await loadSummary();
  } catch (error) {
    setRunStatus("更新失败");
    console.error(error);
    alert(STATIC_SNAPSHOT_MODE
      ? "公开行情快照暂时无法读取，请稍后再试。"
      : "云端行情暂时无法更新，已保留最近一次完整数据。");
  } finally {
    button.disabled = false;
    button.classList.remove("is-spinning");
    document.body.classList.remove("is-updating");
    markInterfaceReady();
  }
}

$("refreshBtn").addEventListener("click", updateNow);
$("zoomOutBtn").addEventListener("click", () => zoomChart(1.35));
$("zoomInBtn").addEventListener("click", () => zoomChart(0.7));
$("resetZoomBtn").addEventListener("click", () => {
  resetChartView();
  drawChart();
});

const chartWrap = document.querySelector(".chart-wrap");
const chartCanvas = $("priceChart");
chartCanvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = chartCanvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  zoomChart(event.deltaY < 0 ? 0.82 : 1.22, ratio);
});
chartCanvas.addEventListener("pointerdown", (event) => {
  chartCanvas.setPointerCapture(event.pointerId);
  chartWrap.classList.add("dragging");
  state.drag = {
    x: event.clientX,
    start: state.view.start,
    end: state.view.end,
  };
});
chartCanvas.addEventListener("pointermove", (event) => {
  if (!state.history.length) return;
  const rect = chartCanvas.getBoundingClientRect();
  if (!state.drag) {
    state.hover = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    drawChart();
    return;
  }
  const visible = state.drag.end - state.drag.start + 1;
  const pixelsPerDay = rect.width / Math.max(1, visible - 1);
  const dayDelta = Math.round((state.drag.x - event.clientX) / pixelsPerDay);
  clampView(state.drag.start + dayDelta, state.drag.end + dayDelta);
  drawChart();
});
chartCanvas.addEventListener("pointerup", (event) => {
  state.drag = null;
  persistChartView();
  chartWrap.classList.remove("dragging");
  try {
    chartCanvas.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released by the browser.
  }
});
chartCanvas.addEventListener("pointerleave", () => {
  if (state.drag) persistChartView();
  state.drag = null;
  state.hover = null;
  chartWrap.classList.remove("dragging");
  drawChart();
});
chartCanvas.addEventListener("dblclick", () => {
  resetChartView();
  drawChart();
});
window.addEventListener("resize", drawChart);

setupIndicatorTooltip();
setupExecutionSettings();
setupFullscreenChart();
setupWorkspaceNavigation();
setupMovingAverageToggles();
setupTimelineInteraction();

loadSummary().catch(async () => {
  setRunStatus("正在生成初始数据...");
  await updateNow();
});
