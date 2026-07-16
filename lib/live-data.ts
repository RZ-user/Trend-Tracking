import snapshotSummary from "@/data/summary.json";
import snapshotNDX from "@/data/history/NDX.json";
import snapshotCSI300 from "@/data/history/CSI300.json";

// Remote market payloads are schema-flexible and normalized before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonMap = Record<string, any>;
type PriceRow = { symbol: string; date: string; price: number };

const STATE_META: Record<string, JsonMap> = {
  uptrend: { label: "上升趋势", tone: "up" },
  recover: { label: "自然回升", tone: "watch" },
  retreat: { label: "自然回撤", tone: "guard" },
  downtrend: { label: "下降趋势", tone: "down" },
  recover2nd: { label: "次级回升", tone: "watch" },
  retreat2nd: { label: "次级回撤", tone: "guard" },
};

const POSITION_RULES: Record<string, number> = {
  uptrend: 0.8,
  recover: 0.35,
  retreat: 0.4,
  recover2nd: 0.2,
  retreat2nd: 0.55,
  downtrend: 0,
};

const DCA_RULES: Record<string, JsonMap> = {
  uptrend: { action: "正常定投", multiplier: 1, note: "趋势确认，按基准定投金额执行。" },
  recover: { action: "保持小额定投", multiplier: 0.5, note: "自然回升尚未突破确认，用小额定投保持参与。" },
  retreat: { action: "保持小额定投", multiplier: 0.3, note: "自然回撤阶段不加大定投，只保留小额计划。" },
  recover2nd: { action: "停止定投", multiplier: 0, note: "下降趋势中的次级反弹，等待趋势确认。" },
  retreat2nd: { action: "保持小额定投", multiplier: 0.5, note: "上升趋势内的次级回撤，保持小额定投但不放大。" },
  downtrend: { action: "停止定投", multiplier: 0, note: "下降趋势确认，停止新增定投。" },
};

const BASE_HISTORIES: Record<string, JsonMap[]> = {
  "^NDX": snapshotNDX as JsonMap[],
  "000300.SS": snapshotCSI300 as JsonMap[],
};

let cache: { at: number; value: { summary: JsonMap; histories: Record<string, JsonMap[]> } } | null = null;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function round(value: number | null | undefined, digits = 6): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rollingSma(values: number[], window: number): Array<number | null> {
  const result: Array<number | null> = [];
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index];
    if (index >= window) total -= values[index - window];
    result.push(index + 1 >= window ? total / window : null);
  }
  return result;
}

function mergePrices(base: JsonMap[], live: PriceRow[]): PriceRow[] {
  const rows = new Map<string, PriceRow>();
  for (const item of base) {
    if (item.date && Number.isFinite(Number(item.price))) {
      rows.set(item.date, { symbol: item.symbol, date: item.date, price: Number(item.price) });
    }
  }
  for (const item of live) rows.set(item.date, item);
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function previousCalendarDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

async function fetchTencentDaily(storageSymbol: string, quoteSymbol: string, count = 420): Promise<PriceRow[]> {
  const isUs = quoteSymbol.startsWith("us");
  const path = isUs ? "usfqkline" : "fqkline";
  const rows: PriceRow[] = [];
  let remaining = Math.max(1, count);
  let endDate = "";

  while (remaining > 0) {
    const pageSize = Math.min(remaining, 1000);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/${path}/get?param=${encodeURIComponent(quoteSymbol)},day,,${endDate},${pageSize},qfq`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json,text/plain,*/*" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`行情源返回 ${response.status}`);
    const payload = await response.json() as JsonMap;
    const data = payload?.data?.[quoteSymbol] || {};
    const raw = data.day || data.qfqday || [];
    if (!raw.length) break;
    for (const item of raw) {
      const price = Number(item?.[2]);
      if (item?.[0] && Number.isFinite(price)) rows.push({ symbol: storageSymbol, date: item[0], price });
    }
    remaining -= raw.length;
    if (raw.length < pageSize || !raw[0]?.[0]) break;
    endDate = previousCalendarDate(raw[0][0]);
  }
  if (!rows.length) throw new Error(`${storageSymbol} 暂无可用行情`);
  return [...new Map(rows.map((row) => [row.date, row])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

function displayState(primary: string, price: number, high: number, low: number, turnRate: number): string {
  if (primary === "uptrend" && high) {
    const pullback = 1 - price / high;
    if (pullback >= turnRate / 2 && pullback < turnRate) return "retreat2nd";
  }
  if (primary === "downtrend" && low) {
    const rebound = price / low - 1;
    if (rebound >= turnRate / 2 && rebound < turnRate) return "recover2nd";
  }
  return primary;
}

function defenseLine(primary: string, high: number, lastLow: number | null, turnRate: number, breakRate: number): number | null {
  if (!["uptrend", "recover", "retreat"].includes(primary)) return null;
  const highLine = high * (1 - turnRate);
  return lastLow === null ? highLine : Math.max(highLine, lastLow * (1 - breakRate));
}

function suggestedPosition(state: string, primary: string, price: number, ma50: number | null, ma100: number | null, ma200: number | null, defense: number | null): number {
  let value = POSITION_RULES[state] ?? POSITION_RULES[primary] ?? 0;
  if (ma200 !== null && price < ma200) value = Math.min(value, 0.2);
  if (ma50 !== null && ma100 !== null && ma200 !== null) {
    if (ma50 > ma100 && ma100 > ma200 && price > ma200 && primary === "uptrend") value = Math.min(0.9, value + 0.1);
    else if (ma50 < ma100 && ["recover", "retreat"].includes(primary)) value = Math.min(value, 0.25);
  }
  if (defense !== null && price <= defense) value = Math.min(value, 0.2);
  return Math.max(0, Math.min(1, value));
}

function dcaAction(state: string, primary: string, price: number, ma200: number | null, defense: number | null): JsonMap {
  let current = { ...(DCA_RULES[state] || DCA_RULES[primary]) };
  if (ma200 !== null && price < ma200) current = { action: "停止定投", multiplier: 0, note: "价格低于 200 日均线，暂停新增定投。" };
  if (defense !== null && price <= defense) current = { action: "停止定投", multiplier: 0, note: "价格跌破防守线，停止定投并优先控制回撤。" };
  return current;
}

function actionText(state: string, primary: string, previousPrimary: string, position: number, previousPosition: number): string {
  const pct = Math.round(position * 100);
  if (primary === "downtrend") return "清仓/防守";
  if (previousPrimary === "downtrend" && primary === "recover") return `小仓观察到 ${pct}%`;
  if (previousPrimary !== "uptrend" && primary === "uptrend") return `确认趋势，加到 ${pct}%`;
  if (position > previousPosition + 0.12) return `加仓到 ${pct}%`;
  if (position < previousPosition - 0.12) return `减仓到 ${pct}%`;
  if (["retreat", "retreat2nd"].includes(state)) return `防守观察，维持 ${pct}%`;
  return `不动，维持 ${pct}%`;
}

function marketPhase(item: JsonMap): JsonMap {
  let score = 0;
  const reasons: string[] = [];
  if (item.ma200 !== null) {
    if (item.price >= item.ma200) { score += 2; reasons.push("价格在 200 日均线上方"); }
    else { score -= 2; reasons.push("价格在 200 日均线下方"); }
  }
  if (item.ma50 !== null && item.ma100 !== null && item.ma200 !== null) {
    if (item.ma50 > item.ma100 && item.ma100 > item.ma200) { score += 1; reasons.push("均线多头排列"); }
    else if (item.ma50 < item.ma100 && item.ma100 < item.ma200) { score -= 1; reasons.push("均线空头排列"); }
  }
  if (item.primary_state === "uptrend") { score += 2; reasons.push("主趋势为上升趋势"); }
  else if (["recover", "retreat"].includes(item.primary_state)) { score += 1; reasons.push("主趋势仍在修复/回撤观察区"); }
  else if (item.primary_state === "downtrend") { score -= 2; reasons.push("主趋势为下降趋势"); }
  const bull = score > 0;
  const label = score >= 3 ? "牛市" : score > 0 ? "偏牛" : score <= -3 ? "熊市" : "偏熊";
  return { label, icon: bull ? "🐂" : "🐻", tone: bull ? "bull" : "bear", score, text: `${bull ? "🐂" : "🐻"} ${label}`, note: reasons.join("；") };
}

function computeSignals(symbol: string, prices: PriceRow[]): JsonMap[] {
  if (!prices.length) return [];
  const values = prices.map((row) => row.price);
  const ma50 = rollingSma(values, 50);
  const ma100 = rollingSma(values, 100);
  const ma200 = rollingSma(values, 200);
  const turnRate = 0.06;
  const breakRate = 0.03;
  let primary = "recover";
  let anchorHigh = values[0];
  let anchorLow = values[0];
  let lastMajorHigh: number | null = null;
  let lastMajorLow: number | null = null;
  let previousPosition = 0;
  let previousPrimary = primary;
  const result: JsonMap[] = [];

  prices.forEach((row, index) => {
    const price = row.price;
    const notes: string[] = [];
    if (price > anchorHigh) anchorHigh = price;
    if (price < anchorLow) anchorLow = price;
    const previousState = primary;
    if (["uptrend", "recover"].includes(primary) && price <= anchorHigh * (1 - turnRate)) {
      lastMajorHigh = anchorHigh; primary = "retreat"; anchorLow = price;
      notes.push("从高点回撤达到 6%，进入自然回撤。");
    }
    if (["downtrend", "retreat"].includes(primary) && price >= anchorLow * (1 + turnRate)) {
      lastMajorLow = anchorLow; primary = "recover"; anchorHigh = price;
      notes.push("从低点反弹达到 6%，进入自然回升。");
    }
    if (lastMajorHigh !== null && price >= lastMajorHigh * (1 + breakRate) && (ma200[index] === null || price > Number(ma200[index]))) {
      if (primary !== "uptrend") notes.push("突破关键高点 3%，确认上升趋势。");
      primary = "uptrend"; anchorHigh = Math.max(anchorHigh, price);
    }
    if (lastMajorLow !== null && price <= lastMajorLow * (1 - breakRate)) {
      if (primary !== "downtrend") notes.push("跌破关键低点 3%，确认下降趋势。");
      primary = "downtrend"; anchorLow = Math.min(anchorLow, price);
    }
    if (ma200[index] !== null && price < Number(ma200[index])) {
      if (primary === "uptrend") { primary = "retreat"; notes.push("价格跌破 200 日均线，上升趋势降级为防守状态。"); }
      else if (primary === "recover") notes.push("价格仍在 200 日均线下方，自然回升只能按观察处理。");
    }
    const state = displayState(primary, price, anchorHigh, anchorLow, turnRate);
    const defense = defenseLine(primary, anchorHigh, lastMajorLow, turnRate, breakRate);
    const breakout = (lastMajorHigh ?? anchorHigh) * (1 + breakRate);
    const loss = lastMajorLow === null ? null : lastMajorLow * (1 - breakRate);
    const position = suggestedPosition(state, primary, price, ma50[index], ma100[index], ma200[index], defense);
    const dca = dcaAction(state, primary, price, ma200[index], defense);
    if (previousState !== primary && !notes.length) notes.push(`状态从 ${STATE_META[previousState].label} 切换到 ${STATE_META[primary].label}。`);
    if (ma200[index] !== null && price < Number(ma200[index])) notes.push("200 日均线过滤：不建议重仓做多。");
    if (defense !== null && price <= defense) notes.push("价格已接近或跌破防守线，优先控制回撤。");
    if (!notes.length) notes.push("信号未发生实质变化，按系统仓位执行。");
    const signal: JsonMap = {
      symbol, date: row.date, price: round(price), state, primary_state: primary,
      state_label: STATE_META[state].label,
      action: actionText(state, primary, previousPrimary, position, previousPosition),
      suggested_position: round(position, 4), dca_action: dca.action,
      dca_multiplier: dca.multiplier, dca_note: dca.note,
      ma50: round(ma50[index]), ma100: round(ma100[index]), ma200: round(ma200[index]),
      anchor_high: round(anchorHigh), anchor_low: round(anchorLow),
      last_major_high: round(lastMajorHigh), last_major_low: round(lastMajorLow),
      defense_line: round(defense), breakout_line: round(breakout), trend_loss_line: round(loss),
      drawdown_pct: round(anchorHigh ? price / anchorHigh - 1 : null),
      distance_to_defense_pct: round(defense ? price / defense - 1 : null),
      distance_to_breakout_pct: round(breakout ? price / breakout - 1 : null),
      notes, tone: STATE_META[state].tone, position_pct: Math.round(position * 100),
      dca_pct: Math.round(Number(dca.multiplier) * 100),
    };
    signal.market_phase = marketPhase(signal);
    result.push(signal);
    previousPosition = position;
    previousPrimary = primary;
  });
  return result;
}

function fundExecution(item: JsonMap): JsonMap {
  const limited = item.symbol === "^NDX";
  const defense = Number(item.distance_to_defense_pct);
  const breakout = Number(item.distance_to_breakout_pct);
  const notes: string[] = [];
  let action = "按计划执行";
  if (item.primary_state === "downtrend" || (Number.isFinite(defense) && defense <= 0)) {
    action = "优先防守";
    notes.push("跌破防守条件时优先控制回撤；非极端信号下，不为小幅仓位差强行付费卖出。");
  } else if (["recover", "recover2nd"].includes(item.state)) {
    action = "小额参与";
    notes.push("目标仓位是方向，不要求当天补到位；尚未突破确认，先小额参与。");
  } else if (["retreat", "retreat2nd"].includes(item.state)) {
    action = "不主动赎回";
    notes.push("回撤未破防守线时，不因目标仓位小幅变化频繁卖出。");
  } else if (item.primary_state === "uptrend") {
    action = "分批补足";
    notes.push("趋势确认时以目标仓位为方向，场外基金按批次执行。");
  }
  if (limited) notes.push("纳指标的如遇限购，按每日额度分批执行。");
  if (Number.isFinite(breakout) && breakout < 0 && ["小额参与", "不主动赎回"].includes(action)) notes.push("收盘有效突破确认线后，再提高补仓速度。");
  return { action, target_pct: item.position_pct, note: notes.join("") };
}

function classifyRisk(id: string, value: number): JsonMap {
  let score = 0;
  if (id === "VIX") score = value >= 32 ? 3 : value >= 22 ? 2 : value >= 15 ? 1 : 0;
  else if (id === "VXN") score = value >= 40 ? 3 : value >= 28 ? 2 : value >= 20 ? 1 : 0;
  else if (id === "SYMBOL_DRAWDOWN") score = value >= 15 ? 3 : value >= 9 ? 2 : value >= 4 ? 1 : 0;
  else if (id === "SYMBOL_VOL20") score = value >= 35 ? 3 : value >= 25 ? 2 : value >= 16 ? 1 : 0;
  const labels = ["平静", "中性", "偏高", "极端"];
  const tones = ["calm", "watch", "stress", "extreme"];
  return { score, level: tones[score], level_label: labels[score], tone: tones[score] };
}

function overallRisk(items: JsonMap[], derived: JsonMap[] = []): JsonMap {
  const allAvailable = [...items, ...derived].filter((item) => item.available);
  const available = allAvailable.filter((item) => !item.freshness?.stale);
  const scores = available.map((item) => Number(item.score || 0));
  const max = scores.length ? Math.max(...scores) : 0;
  const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const value = max >= 3
    ? { label: "极端", tone: "extreme", note: "至少一个风险指标进入极端区间，优先控制回撤。" }
    : average >= 1.45 || max >= 2
      ? { label: "偏高", tone: "stress", note: "风险温度偏高，趋势信号仍有效，但不宜放大仓位。" }
      : average >= 0.7
        ? { label: "中性", tone: "watch", note: "风险环境中性，按主趋势系统执行。" }
        : { label: "平静", tone: "calm", note: "风险温度较低，继续以价格趋势为主。" };
  return {
    ...value,
    score: round(average, 2),
    available_count: available.length,
    stale_count: allAvailable.length - available.length,
  };
}

function parseDataDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value);
  const normalized = /^\d{4}-\d{2}$/.test(raw) ? `${raw}-01T00:00:00Z` : `${raw.slice(0, 10)}T00:00:00Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateAgeDays(value: unknown, referenceDate: string): number | null {
  const date = parseDataDate(value);
  const reference = parseDataDate(referenceDate);
  if (!date || !reference) return null;
  return Math.max(0, Math.floor((reference.getTime() - date.getTime()) / 86_400_000));
}

function annotateRiskFreshness(risk: JsonMap, referenceDate: string, thresholdDays = 7): JsonMap {
  const annotate = (item: JsonMap) => {
    const ageDays = dateAgeDays(item.date, referenceDate);
    const stale = ageDays !== null && ageDays > thresholdDays;
    return {
      ...item,
      freshness: {
        age_days: ageDays,
        stale,
        threshold_days: thresholdDays,
        label: stale ? `滞后 ${ageDays} 天` : "数据正常",
      },
    };
  };
  const items = (risk.items || []).map(annotate);
  const derived = (risk.derived || []).map(annotate);
  return { ...risk, items, derived, overall: overallRisk(items, derived), reference_date: referenceDate };
}

function annualVolatility(history: JsonMap[], window = 20): number | null {
  const prices = history.slice(-(window + 1)).map((item) => Number(item.price)).filter(Number.isFinite);
  if (prices.length < window + 1) return null;
  const returns = prices.slice(1).map((price, index) => price / prices[index] - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function symbolRisk(history: JsonMap[]): JsonMap {
  const latest = history.at(-1);
  if (!latest) return { overall: overallRisk([]), items: [], derived: [] };
  const drawdown = Math.abs(Math.min(0, Number(latest.drawdown_pct || 0))) * 100;
  const distance = Number(latest.distance_to_defense_pct || 0) * 100;
  const maDistance = latest.ma200 ? (Number(latest.price) / Number(latest.ma200) - 1) * 100 : null;
  const volatility = annualVolatility(history);
  const items: JsonMap[] = [
    { id: "SYMBOL_TREND_STATE", name: "趋势状态", date: latest.date, value_text: latest.state_label, unit: "text", available: true, change_20: null, description: "当前六类趋势状态，越偏向回撤或下降，风险越高。", score: ["downtrend", "recover2nd"].includes(latest.state) ? 2 : ["retreat", "retreat2nd"].includes(latest.state) ? 1 : 0, level_label: ["downtrend", "recover2nd"].includes(latest.state) ? "偏高" : "平静", tone: ["downtrend", "recover2nd"].includes(latest.state) ? "stress" : "calm" },
    { id: "SYMBOL_DEFENSE_BUFFER", name: "距防守线", date: latest.date, value: round(distance, 2), unit: "%", available: true, change_20: null, description: "收盘价距离防守线的百分比，越接近或跌破，风险越高。", score: distance <= 0 ? 2 : distance < 3 ? 1 : 0, level_label: distance <= 0 ? "偏高" : distance < 3 ? "中性" : "平静", tone: distance <= 0 ? "stress" : distance < 3 ? "watch" : "calm" },
    { id: "SYMBOL_DRAWDOWN", name: "当前回撤", date: latest.date, value: round(drawdown, 2), unit: "%", available: true, change_20: null, description: "相对本轮趋势高点的回撤幅度。", ...classifyRisk("SYMBOL_DRAWDOWN", drawdown) },
  ];
  if (maDistance !== null) items.push({ id: "SYMBOL_MA200_DISTANCE", name: "200日偏离", date: latest.date, value: round(maDistance, 2), unit: "%", available: true, change_20: null, description: "收盘价相对 200 日均线的位置。", score: maDistance < 0 ? 2 : maDistance < 3 ? 1 : 0, level_label: maDistance < 0 ? "偏高" : maDistance < 3 ? "中性" : "平静", tone: maDistance < 0 ? "stress" : maDistance < 3 ? "watch" : "calm" });
  if (volatility !== null) items.push({ id: "SYMBOL_VOL20", name: "20日波动", date: latest.date, value: round(volatility, 2), unit: "%", available: true, change_20: null, description: "近 20 个交易日收益率年化波动。", ...classifyRisk("SYMBOL_VOL20", volatility) });
  return { overall: overallRisk(items), items, derived: [] };
}

function previousMonthEnd(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

function dualMomentum(histories: Record<string, JsonMap[]>, latest: JsonMap[]): JsonMap {
  const cutoff = previousMonthEnd();
  const assets = [
    { symbol: "^NDX", label: "纳指100" },
    { symbol: "000300.SS", label: "沪深300" },
  ].map((asset) => {
    const rows = histories[asset.symbol].filter((item) => item.date <= cutoff);
    if (rows.length <= 250) return { ...asset, available: false, reason: "历史数据不足" };
    const current = rows.at(-1)!;
    const base = rows.at(-(251))!;
    const momentum = Number(current.price) / Number(base.price) - 1;
    return { ...asset, available: true, momentum: round(momentum), as_of_date: current.date, price: current.price, base_date: base.date, base_price: base.price, positive: momentum > 0 };
  });
  const ranked = [...assets].filter((item) => item.available).sort((a, b) => Number(b.momentum) - Number(a.momentum));
  const leader = ranked[0];
  const spread = ranked.length > 1 ? Number(ranked[0].momentum) - Number(ranked[1].momentum) : null;
  const allocation = leader && Number(leader.momentum) > 0
    ? { mode: "risk_on", symbol: leader.symbol, label: `偏向${leader.label}`, tone: "positive", reason: `${leader.label}相对动量领先，且绝对动量高于 0%。` }
    : { mode: "defensive", symbol: null, label: "转向货币/短债", tone: "defensive", reason: "风险资产最高动量仍不高于 0%。" };
  const selected = latest.find((item) => item.symbol === allocation.symbol);
  const aligned = !selected || ["uptrend", "recover"].includes(selected.primary_state);
  const alignment = allocation.mode === "defensive"
    ? { label: "防守一致", tone: "positive", note: "双动量与趋势层均指向降低风险。" }
    : aligned
      ? { label: "趋势确认", tone: "positive", note: "配置偏向与当前价格趋势一致。" }
      : { label: "趋势待确认", tone: "watch", note: "双动量给出月度偏向，但价格趋势尚未确认。" };
  return { enabled: true, name: "简化双动量", lookback_trading_days: 250, review_frequency: "monthly", cutoff_date: cutoff, next_review: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")} 月末`, absolute_threshold: 0, assets, leader_symbol: leader?.symbol || null, spread: round(spread), allocation, alignment, quality: { complete: ranked.length === 2, warnings: [] }, method_note: "以上一个完整月末为截止点，分别计算最近 250 个交易日收益。", execution_note: "双动量先给出月度配置目标，再由六类趋势仓位限制 A 股和美股上限；未使用的风险仓位转入债券货币篮子。方向改变时优先调整新增资金与定投。", scope_note: "指数价格口径，不含基金跟踪误差、申赎费、限购和汇率影响。" };
}

async function refreshObservationMap(summary: JsonMap): Promise<void> {
  const configured = summary.config?.a_share_observation_map?.items || [];
  const existing = new Map((summary.a_share_observation_map?.items || []).map((item: JsonMap) => [item.id, item]));
  const refreshed = await Promise.all(configured.map(async (item: JsonMap) => {
    if (item.kind === "macro" || !item.quote_symbol) return existing.get(item.id) || item;
    try {
      const rows = await fetchTencentDaily(item.storage_symbol || item.id, item.quote_symbol, 40);
      const latest = rows.at(-1)!;
      const base = rows.length >= 21 ? rows.at(-21)! : null;
      const change = base ? (latest.price / base.price - 1) * 100 : null;
      return { ...(existing.get(item.id) || item), available: true, value: round(latest.price), date: latest.date, change_20_pct: round(change), tone: change === null ? "missing" : change > 0 ? "positive" : change < 0 ? "negative" : "watch" };
    } catch {
      return existing.get(item.id) || item;
    }
  }));
  summary.a_share_observation_map = { ...(summary.a_share_observation_map || {}), enabled: true, items: refreshed };
}

async function refreshMarketRisk(summary: JsonMap): Promise<void> {
  const risk = clone(summary.risk || { items: [], derived: [] });
  try {
    const rows = await fetchTencentDaily("^VIX", "usVIX", 40);
    const latest = rows.at(-1)!;
    const base = rows.length >= 21 ? rows.at(-21)! : null;
    const replacement = { id: "VIX", name: "全市场波动率", date: latest.date, value: round(latest.price, 4), unit: "index", source: "tencent", available: true, change_20: base ? round(latest.price - base.price, 4) : null, description: "标普 500 波动率，越高代表全市场避险情绪越重。", ...classifyRisk("VIX", latest.price) };
    risk.items = (risk.items || []).map((item: JsonMap) => item.id === "VIX" ? replacement : item);
  } catch {
    // Keep the last complete risk snapshot.
  }
  const byId = new Map((risk.items || []).map((item: JsonMap) => [item.id, item]));
  const vxn = byId.get("VXN");
  const vix = byId.get("VIX");
  risk.derived = vxn?.value && vix?.value ? [{ id: "VXN_VIX", name: "科技波动溢价", date: String(vxn.date) < String(vix.date) ? vxn.date : vix.date, value: round(Number(vxn.value) / Number(vix.value), 4), unit: "ratio", source: "derived", available: true, change_20: null, description: "VXN / VIX，观察纳指科技股风险是否明显高于全市场。", ...classifyRisk("VXN_VIX", Number(vxn.value) / Number(vix.value)) }] : [];
  risk.overall = overallRisk(risk.items || [], risk.derived || []);
  summary.risk = risk;
}

async function buildDataset(): Promise<{ summary: JsonMap; histories: Record<string, JsonMap[]> }> {
  const summary = clone(snapshotSummary) as JsonMap;
  const liveResults = await Promise.allSettled([
    fetchTencentDaily("^NDX", "usNDX", 3000),
    fetchTencentDaily("000300.SS", "sh000300", 3000),
  ]);
  const mappings = ["^NDX", "000300.SS"];
  const histories: Record<string, JsonMap[]> = {};
  mappings.forEach((symbol, index) => {
    const live = liveResults[index].status === "fulfilled" ? liveResults[index].value : [];
    histories[symbol] = computeSignals(symbol, mergePrices(BASE_HISTORIES[symbol], live));
  });
  summary.latest = summary.latest.map((base: JsonMap) => {
    const latest = clone(histories[base.symbol].at(-1) || base);
    latest.name = base.name;
    latest.asset_type = base.asset_type;
    latest.fund_execution = fundExecution(latest);
    return latest;
  });
  summary.risks_by_symbol = {
    "^NDX": summary.risk,
    "000300.SS": symbolRisk(histories["000300.SS"]),
  };
  await Promise.all([refreshMarketRisk(summary), refreshObservationMap(summary)]);
  const latestDates = new Map(summary.latest.map((item: JsonMap) => [item.symbol, item.date]));
  summary.risk = annotateRiskFreshness(summary.risk, latestDates.get("^NDX") || summary.latest[0]?.date);
  summary.risks_by_symbol["^NDX"] = summary.risk;
  summary.risks_by_symbol["000300.SS"] = annotateRiskFreshness(
    summary.risks_by_symbol["000300.SS"],
    latestDates.get("000300.SS") || summary.latest[0]?.date,
  );
  summary.dual_momentum = dualMomentum(histories, summary.latest);
  const now = new Date().toISOString();
  const liveCount = liveResults.filter((item) => item.status === "fulfilled").length;
  summary.last_run = { id: "cloud", started_at: now, finished_at: now, status: liveCount ? "ok" : "snapshot", message: liveCount ? "云端行情已刷新" : "行情源暂不可用，已使用完整快照" };
  return { summary, histories };
}

export async function getDataset(force = false): Promise<{ summary: JsonMap; histories: Record<string, JsonMap[]> }> {
  const ttl = 30 * 60 * 1000;
  if (!force && cache && Date.now() - cache.at < ttl) return cache.value;
  const value = await buildDataset();
  cache = { at: Date.now(), value };
  return value;
}
