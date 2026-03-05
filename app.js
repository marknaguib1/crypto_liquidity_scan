// app.js (UPDATED: less strict so you actually get signals)
// Changes made:
// 1) Volume spike: 2.0x -> 1.4x
// 2) RSI confirm: LONG <45 (was <35), SHORT >55 (was >65)
// 3) Equal-high/low tolerance: 0.1% -> 0.2%
// 4) Trend alignment made slightly less punishing when against bias
// Everything else remains signals-only.

const BINANCE = "https://fapi.binance.com";
const AO = "https://api.allorigins.win/raw?url=";

const el = (id) => document.getElementById(id);
const logBox = el("logs");
const signalsBox = el("signals");

let running = false;
let timer = null;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logBox.textContent = `[${ts}] ${msg}\n` + logBox.textContent;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e1) {
    const prox = AO + encodeURIComponent(url);
    const r2 = await fetch(prox, { cache: "no-store" });
    if (!r2.ok) throw new Error(`Proxy HTTP ${r2.status}`);
    return await r2.json();
  }
}

function ema(values, period) {
  const k = 2 / (period + 1);
  let out = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 2) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
}

// Equal highs/lows: find 3 swing highs/lows that cluster within tolerance
function findEqualLevels(highs, lows, tolPct = 0.002) { // UPDATED: default 0.2% (was 0.1%)
  const pivH = [];
  const pivL = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) pivH.push({ i, v: highs[i] });
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) pivL.push({ i, v: lows[i] });
  }
  function cluster(pivs) {
    pivs = pivs.slice(-25); // a bit more history
    for (let a = 0; a < pivs.length; a++) {
      const base = pivs[a].v;
      const band = base * tolPct;
      const hits = pivs.filter((p) => Math.abs(p.v - base) <= band);
      if (hits.length >= 3) return base;
    }
    return null;
  }
  return { eqHigh: cluster(pivH), eqLow: cluster(pivL) };
}

function scoreSignal({ sweep, trendAlign, volSpike, momentum, volatility }) {
  // weights: 30/20/20/15/15
  return Math.round(
    sweep * 30 +
      trendAlign * 20 +
      volSpike * 20 +
      momentum * 15 +
      volatility * 15
  );
}

function addSignalCard(sig) {
  const card = document.createElement("div");
  card.className = "card " + (sig.direction === "LONG" ? "good" : "bad");
  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><b>🚨 LIQUIDITY TRAP SIGNAL</b></div>
      <div class="mono">${sig.time}</div>
    </div>
    <div><b>Pair:</b> ${sig.symbol} &nbsp; <b>Direction:</b> ${sig.direction} &nbsp; <b>Score:</b> ${sig.score}</div>
    <div class="mono">Entry: ${sig.entry}  |  Stop: ${sig.stop}  |  Target: ${sig.target}</div>
    <div class="muted"><b>Reason:</b> ${sig.reason.join(" • ")}</div>
  `;
  signalsBox.prepend(card);
  while (signalsBox.children.length > 30) signalsBox.removeChild(signalsBox.lastChild);
}

async function getServerTime() {
  const data = await fetchJson(`${BINANCE}/fapi/v1/time`);
  return new Date(data.serverTime).toLocaleTimeString();
}

async function scanOnce() {
  el("srvTime").textContent = await getServerTime();
  el("lastScan").textContent = new Date().toLocaleTimeString();

  const universe = parseInt(el("universe").value, 10);
  const scoreMin = parseInt(el("scoreMin").value, 10);

  const tickers = await fetchJson(`${BINANCE}/fapi/v1/ticker/24hr`);
  const sorted = tickers
    .filter((t) => t.symbol.endsWith("USDT"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, universe);

  const [book, prem] = await Promise.all([
    fetchJson(`${BINANCE}/fapi/v1/ticker/bookTicker`),
    fetchJson(`${BINANCE}/fapi/v1/premiumIndex`),
  ]);
  const bookMap = new Map(book.map((x) => [x.symbol, x]));
  const premMap = new Map(prem.map((x) => [x.symbol, x]));

  const candidates = [];
  for (const t of sorted) {
    const sym = t.symbol;
    const qv = parseFloat(t.quoteVolume);
    if (qv < 50_000_000) continue;

    const b = bookMap.get(sym);
    if (!b) continue;
    const bid = parseFloat(b.bidPrice),
      ask = parseFloat(b.askPrice);
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > 0.0005) continue; // 0.05%

    const p = premMap.get(sym);
    let fr = p && p.lastFundingRate != null ? Math.abs(parseFloat(p.lastFundingRate)) : 0;
    if (fr > 0.005) continue; // ±0.5%

    candidates.push({ sym, mid, spreadPct, qv, fr });
  }

  log(`Universe ${universe} → Tradable ${candidates.length}`);

  const maxEval = Math.min(25, candidates.length);
  for (let i = 0; i < maxEval; i++) {
    const sym = candidates[i].sym;

    const [k1m, k5m] = await Promise.all([
      fetchJson(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=1m&limit=120`),
      fetchJson(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=5m&limit=120`),
    ]);

    const c1 = k1m.map((x) => parseFloat(x[4]));
    const h1 = k1m.map((x) => parseFloat(x[2]));
    const l1 = k1m.map((x) => parseFloat(x[3]));
    const v1 = k1m.map((x) => parseFloat(x[5]));

    const c5 = k5m.map((x) => parseFloat(x[4]));

    const ema20 = ema(c5, 20).at(-1);
    const ema50 = ema(c5, 50).at(-1);
    const bias =
      Math.abs(ema20 - ema50) / ((ema20 + ema50) / 2) < 0.0005
        ? "NEUTRAL"
        : ema20 > ema50
        ? "BULL"
        : "BEAR";

    const r = rsi(c1, 14);
    if (r == null) continue;

    const volAvg = avg(v1.slice(-21, -1));
    const volNow = v1.at(-1);

    // UPDATED: 2.0x -> 1.4x (more signals)
    const volSpike = volNow > 1.4 * volAvg;

    // UPDATED: tolerance now 0.2% default inside function; call with 0.002 explicitly
    const levels = findEqualLevels(h1, l1, 0.002);

    const lastClose = c1.at(-1);
    const lastHigh = h1.at(-1);
    const lastLow = l1.at(-1);

    let direction = null;
    const reason = [];

    if (levels.eqLow && lastLow < levels.eqLow && lastClose > levels.eqLow) {
      direction = "LONG";
      reason.push("Sweep below equal lows + reclaim");
    }
    if (levels.eqHigh && lastHigh > levels.eqHigh && lastClose < levels.eqHigh) {
      direction = "SHORT";
      reason.push("Sweep above equal highs + reject");
    }
    if (!direction) continue;

    if (!volSpike) continue;
    reason.push(`Volume spike ${(volNow / Math.max(1e-9, volAvg)).toFixed(2)}x`);

    // UPDATED RSI thresholds:
    // LONG: <45 (was <35)
    // SHORT: >55 (was >65)
    if (direction === "LONG" && r < 45) reason.push(`RSI ${r.toFixed(1)} (long confirm)`);
    else if (direction === "SHORT" && r > 55) reason.push(`RSI ${r.toFixed(1)} (short confirm)`);
    else continue;

    // UPDATED: trend alignment less punishing when against bias (0.35 instead of 0.2)
    const trendAlign =
      bias === "NEUTRAL"
        ? 0.75
        : (direction === "LONG" && bias === "BULL") || (direction === "SHORT" && bias === "BEAR")
        ? 1
        : 0.35;

    // Volatility factor (simple)
    const range =
      h1.slice(-20).reduce((a, b) => Math.max(a, b), -Infinity) -
      l1.slice(-20).reduce((a, b) => Math.min(a, b), Infinity);
    const volFactor = Math.min(1, (range / lastClose) / 0.008); // slightly easier than 1%

    const score = scoreSignal({
      sweep: 1,
      trendAlign,
      volSpike: 1,
      momentum: 1,
      volatility: volFactor,
    });

    if (score < scoreMin) continue;

    let entry = lastClose;
    let stop, target;
    const slPad = 0.0015;

    if (direction === "LONG") {
      stop = lastLow * (1 - slPad);
      const risk = entry - stop;
      target = entry + 1.3 * risk;
    } else {
      stop = lastHigh * (1 + slPad);
      const risk = stop - entry;
      target = entry - 1.3 * risk;
    }

    addSignalCard({
      time: new Date().toLocaleTimeString(),
      symbol: sym,
      direction,
      score,
      entry: entry.toFixed(4),
      stop: stop.toFixed(4),
      target: target.toFixed(4),
      reason: reason.concat([`Bias: ${bias}`, `EMA20/50: ${ema20.toFixed(4)} / ${ema50.toFixed(4)}`]),
    });

    log(`Signal ${sym} ${direction} score=${score} bias=${bias}`);
  }
}

function setRunning(on) {
  running = on;
  el("status").textContent = on ? "RUNNING" : "STOPPED";
  el("toggleBtn").textContent = on ? "Stop Scan" : "Start Scan";
}

el("toggleBtn").onclick = async () => {
  if (!running) {
    setRunning(true);
    log("Starting scan loop…");
    const interval = Math.max(5, parseInt(el("intervalSec").value, 10));
    try {
      await scanOnce();
    } catch (e) {
      log(`Error: ${e.message}`);
    }
    timer = setInterval(async () => {
      if (!running) return;
      try {
        await scanOnce();
      } catch (e) {
        log(`Error: ${e.message}`);
      }
    }, interval * 1000);
  } else {
    setRunning(false);
    if (timer) clearInterval(timer);
    timer = null;
    log("Stopped.");
  }
};

el("testBtn").onclick = () => {
  addSignalCard({
    time: new Date().toLocaleTimeString(),
    symbol: "TESTUSDT",
    direction: "LONG",
    score: 99,
    entry: "1.0000",
    stop: "0.9900",
    target: "1.0130",
    reason: ["Test signal (in-app only)", "Use Start Scan for live signals"],
  });
  log("Test signal added.");
};

(async () => {
  try {
    el("srvTime").textContent = await getServerTime();
  } catch {
    el("srvTime").textContent = "CORS/Network issue";
  }
})();
