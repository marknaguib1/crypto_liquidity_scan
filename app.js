// app.js (FULL SCRIPT — UPDATED to actually produce LIVE signals)
// What changed vs prior versions:
// ✅ Adds SESSION liquidity levels (1h/4h/Daily High/Low) as valid sweep targets
//    (Equal highs/lows alone can be too rare → zero signals forever)
// ✅ Keeps equal highs/lows too (best quality when found)
// ✅ Sweep can happen within last N candles (default 3) and confirm reclaim/reject on latest close
// ✅ Looser, phone-friendly thresholds: vol spike 1.3x, RSI 48/52, eq tolerance 0.25%
// ✅ Adds Clear Signals button support if present in index.html (id="clearBtn")
// ✅ Labels TEST vs LIVE clearly
// Still signals-only. Public Binance data only. No trading, no keys.

const BINANCE = "https://fapi.binance.com";
const AO = "https://api.allorigins.win/raw?url=";

const el = (id) => document.getElementById(id);
const logBox = el("logs");
const signalsBox = el("signals");

let running = false;
let timer = null;

// ---------------- TUNING KNOBS (phone-friendly) ----------------
const SWEEP_LOOKBACK = 3;       // sweep can occur within last 3 candles
const EQ_TOL = 0.0025;          // 0.25% equal highs/lows tolerance (looser)
const VOL_SPIKE_MULT = 1.3;     // volume spike threshold (looser)
const RSI_LONG_MAX = 48;        // RSI confirm long (looser)
const RSI_SHORT_MIN = 52;       // RSI confirm short (looser)
const SL_PAD = 0.0015;          // 0.15% stop pad beyond sweep
const MAX_EVAL = 25;            // symbols evaluated per scan (performance guard)
const KLINE_LIMIT = 360;        // 1m klines fetched (enough for 4h and “daily proxy”)

// Session level lookbacks (in 1m candles)
const WIN_1H = 60;
const WIN_4H = 240;

// ---------------------------------------------------------------

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logBox.textContent = `[${ts}] ${msg}\n` + logBox.textContent;
}

async function fetchJson(url) {
  // Try direct, then fallback through AllOrigins (for CORS blocks).
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
  let prev = values[0];
  const out = [prev];
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

// Equal highs/lows: find 3 swing highs/lows clustered within tolerance
function findEqualLevels(highs, lows, tolPct = EQ_TOL) {
  const pivH = [];
  const pivL = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) pivH.push({ i, v: highs[i] });
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) pivL.push({ i, v: lows[i] });
  }

  function cluster(pivs) {
    pivs = pivs.slice(-30);
    for (let a = 0; a < pivs.length; a++) {
      const base = pivs[a].v;
      const band = base * tolPct;
      const hits = pivs.filter(p => Math.abs(p.v - base) <= band);
      if (hits.length >= 3) return base;
    }
    return null;
  }

  return { eqHigh: cluster(pivH), eqLow: cluster(pivL) };
}

// Session levels from existing 1m history
function sessionLevels(highs, lows) {
  const hi1h = Math.max(...highs.slice(-WIN_1H));
  const lo1h = Math.min(...lows.slice(-WIN_1H));

  const hi4h = Math.max(...highs.slice(-WIN_4H));
  const lo4h = Math.min(...lows.slice(-WIN_4H));

  // "Daily proxy" using all fetched candles (not true daily, but good enough for phone dashboard)
  const hiD = Math.max(...highs);
  const loD = Math.min(...lows);

  return { hi1h, lo1h, hi4h, lo4h, hiD, loD };
}

// Sweep helpers (within lookback)
function sweptBelow(level, lows, lookback = SWEEP_LOOKBACK) {
  const start = Math.max(0, lows.length - lookback);
  for (let i = start; i < lows.length; i++) if (lows[i] < level) return true;
  return false;
}
function sweptAbove(level, highs, lookback = SWEEP_LOOKBACK) {
  const start = Math.max(0, highs.length - lookback);
  for (let i = start; i < highs.length; i++) if (highs[i] > level) return true;
  return false;
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

  const badge = sig.isTest
    ? `<span class="pill" style="background:#fff3b0;">TEST</span>`
    : `<span class="pill" style="background:#e7f3ff;">LIVE</span>`;

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><b>🚨 LIQUIDITY TRAP SIGNAL</b> ${badge}</div>
      <div class="mono">${sig.time}</div>
    </div>
    <div><b>Pair:</b> ${sig.symbol} &nbsp; <b>Direction:</b> ${sig.direction} &nbsp; <b>Score:</b> ${sig.score}</div>
    <div class="mono">Entry: ${sig.entry}  |  Stop: ${sig.stop}  |  Target: ${sig.target}</div>
    <div class="muted"><b>Reason:</b> ${sig.reason.join(" • ")}</div>
  `;
  signalsBox.prepend(card);

  // keep last 50
  while (signalsBox.children.length > 50) signalsBox.removeChild(signalsBox.lastChild);
}

function clearSignals() {
  signalsBox.innerHTML = "";
  log("Signals cleared.");
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

  // 1) Top universe by quote volume
  const tickers = await fetchJson(`${BINANCE}/fapi/v1/ticker/24hr`);
  const sorted = tickers
    .filter(t => t.symbol.endsWith("USDT"))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, universe);

  // 2) Spread + funding filters
  const [book, prem] = await Promise.all([
    fetchJson(`${BINANCE}/fapi/v1/ticker/bookTicker`),
    fetchJson(`${BINANCE}/fapi/v1/premiumIndex`)
  ]);

  const bookMap = new Map(book.map(x => [x.symbol, x]));
  const premMap = new Map(prem.map(x => [x.symbol, x]));

  const candidates = [];
  for (const t of sorted) {
    const sym = t.symbol;
    const qv = parseFloat(t.quoteVolume);
    if (qv < 50_000_000) continue;

    const b = bookMap.get(sym);
    if (!b) continue;
    const bid = parseFloat(b.bidPrice), ask = parseFloat(b.askPrice);
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > 0.0005) continue; // 0.05%

    const p = premMap.get(sym);
    const fr = p && p.lastFundingRate != null ? Math.abs(parseFloat(p.lastFundingRate)) : 0;
    if (fr > 0.005) continue; // ±0.5%

    candidates.push(sym);
  }

  log(`Universe ${universe} → Tradable ${candidates.length}`);

  // 3) Evaluate up to MAX_EVAL per scan to avoid phone overload
  const maxEval = Math.min(MAX_EVAL, candidates.length);

  for (let i = 0; i < maxEval; i++) {
    const sym = candidates[i];

    // klines (public)
    const [k1m, k5m] = await Promise.all([
      fetchJson(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=1m&limit=${KLINE_LIMIT}`),
      fetchJson(`${BINANCE}/fapi/v1/klines?symbol=${sym}&interval=5m&limit=180`)
    ]);

    const c1 = k1m.map(x => parseFloat(x[4]));
    const h1 = k1m.map(x => parseFloat(x[2]));
    const l1 = k1m.map(x => parseFloat(x[3]));
    const v1 = k1m.map(x => parseFloat(x[5]));

    const c5 = k5m.map(x => parseFloat(x[4]));

    // Bias (5m EMA20/50)
    const ema20 = ema(c5, 20).at(-1);
    const ema50 = ema(c5, 50).at(-1);

    const bias =
      Math.abs(ema20 - ema50) / ((ema20 + ema50) / 2) < 0.0005
        ? "NEUTRAL"
        : (ema20 > ema50 ? "BULL" : "BEAR");

    // RSI (1m)
    const r = rsi(c1, 14);
    if (r == null) continue;

    // Volume spike (1m)
    const volAvg = avg(v1.slice(-31, -1));
    const volNow = v1.at(-1);
    const volSpike = volNow > VOL_SPIKE_MULT * volAvg;

    // Liquidity levels
    const eq = findEqualLevels(h1, l1, EQ_TOL);
    const sess = sessionLevels(h1, l1);

    const lastClose = c1.at(-1);

    // ---- Trap detection vs multiple level types ----
    let direction = null;
    const reason = [];

    const longLevels = [];
    const shortLevels = [];

    // Equal levels (if found)
    if (eq.eqLow) longLevels.push({ name: "Equal Lows", level: eq.eqLow });
    if (eq.eqHigh) shortLevels.push({ name: "Equal Highs", level: eq.eqHigh });

    // Session levels (always exist)
    longLevels.push(
      { name: "1h Low", level: sess.lo1h },
      { name: "4h Low", level: sess.lo4h },
      { name: "Daily Low", level: sess.loD }
    );
    shortLevels.push(
      { name: "1h High", level: sess.hi1h },
      { name: "4h High", level: sess.hi4h },
      { name: "Daily High", level: sess.hiD }
    );

    // LONG: swept below within lookback + latest close reclaimed above
    for (const L of longLevels) {
      if (sweptBelow(L.level, l1, SWEEP_LOOKBACK) && lastClose > L.level) {
        direction = "LONG";
        reason.push(`Sweep+reclaim vs ${L.name}`);
        break;
      }
    }

    // SHORT: swept above within lookback + latest close rejected below
    if (!direction) {
      for (const L of shortLevels) {
        if (sweptAbove(L.level, h1, SWEEP_LOOKBACK) && lastClose < L.level) {
          direction = "SHORT";
          reason.push(`Sweep+reject vs ${L.name}`);
          break;
        }
      }
    }

    if (!direction) continue;

    // Confirmations
    if (!volSpike) continue;
    reason.push(`Vol ${(volNow / Math.max(1e-9, volAvg)).toFixed(2)}x`);

    if (direction === "LONG" && r < RSI_LONG_MAX) reason.push(`RSI ${r.toFixed(1)} long`);
    else if (direction === "SHORT" && r > RSI_SHORT_MIN) reason.push(`RSI ${r.toFixed(1)} short`);
    else continue;

    // Trend alignment score
    const trendAlign =
      bias === "NEUTRAL"
        ? 0.75
        : ((direction === "LONG" && bias === "BULL") || (direction === "SHORT" && bias === "BEAR"))
          ? 1
          : 0.40;

    // Volatility factor (range last 30m)
    const hi30 = Math.max(...h1.slice(-30));
    const lo30 = Math.min(...l1.slice(-30));
    const range = hi30 - lo30;
    const volFactor = Math.min(1, (range / lastClose) / 0.007); // ~0.7% range = "good"

    const score = scoreSignal({
      sweep: 1,
      trendAlign,
      volSpike: 1,
      momentum: 1,
      volatility: volFactor
    });

    if (score < scoreMin) continue;

    // Stops/Targets based on sweep extreme within lookback
    let entry = lastClose;
    let stop, target;

    if (direction === "LONG") {
      const sweepLow = Math.min(...l1.slice(-SWEEP_LOOKBACK));
      stop = sweepLow * (1 - SL_PAD);
      const risk = entry - stop;
      target = entry + 1.3 * risk;
    } else {
      const sweepHigh = Math.max(...h1.slice(-SWEEP_LOOKBACK));
      stop = sweepHigh * (1 + SL_PAD);
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
      isTest: false,
      reason: reason.concat([
        `Bias: ${bias}`,
        `EMA20/50: ${ema20.toFixed(4)}/${ema50.toFixed(4)}`,
        `Sweep≤${SWEEP_LOOKBACK}c`,
      ])
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
    isTest: true,
    reason: ["Test signal (in-app only)", "Use Start Scan for live signals"]
  });
  log("Test signal added.");
};

// Optional Clear Signals button (only works if you add <button id="clearBtn">Clear Signals</button> in index.html)
const clearBtn = document.getElementById("clearBtn");
if (clearBtn) clearBtn.onclick = clearSignals;

// Init server time label
(async () => {
  try {
    el("srvTime").textContent = await getServerTime();
  } catch {
    el("srvTime").textContent = "CORS/Network issue";
  }
})();
