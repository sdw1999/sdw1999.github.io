// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-green; icon-glyph: coins;
//
// 자산 관리 (Asset Tracker) - Scriptable
// - 앱에서 실행: 자산 목록/추가/수정/삭제/새로고침
// - 위젯에서 실행: 총 자산, 일간 변동, 평가손익 요약
// - 데이터는 iCloud(Scriptable 폴더)의 assets.json 에만 저장됩니다. (GitHub에 올라가지 않음)
// - 시세는 Yahoo Finance 를 사용합니다. (주식/ETF/코인/환율)
//     한국주식: 005930.KS(코스피) / 035720.KQ(코스닥)   미국주식: AAPL, QQQ
//     코인: BTC-USD   환율은 자동 조회 (USD→KRW 등)

const FILE = "assets.json";
const BASE = "KRW";
const TYPES = [
  { key: "stock", label: "주식/ETF", live: true },
  { key: "crypto", label: "코인", live: true },
  { key: "cash", label: "현금/예금", live: false },
  { key: "manual", label: "기타(수동 시세)", live: false },
];
const COLORS = {
  up: Color.dynamic(new Color("#d32f2f"), new Color("#ff6b6b")), // 한국식: 상승=빨강
  down: Color.dynamic(new Color("#1976d2"), new Color("#64b5f6")), // 하락=파랑
  mute: Color.gray(),
};

// ---------- 저장소 ----------
const fm = FileManager.iCloud();
const path = fm.joinPath(fm.documentsDirectory(), FILE);

async function loadDB() {
  if (!fm.fileExists(path)) return { items: [], cache: {}, fx: {}, hide: false, updated: null, history: [] };
  if (fm.isFileStoredIniCloud(path) && !fm.isFileDownloaded(path)) await fm.downloadFileFromiCloud(path);
  try {
    const db = JSON.parse(fm.readString(path));
    return Object.assign({ items: [], cache: {}, fx: {}, hide: false, updated: null, history: [] }, db);
  } catch (e) {
    return { items: [], cache: {}, fx: {}, hide: false, updated: null, history: [] };
  }
}
function saveDB(db) {
  fm.writeString(path, JSON.stringify(db, null, 2));
}

// ---------- 시세 ----------
async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const req = new Request(url);
  req.timeoutInterval = 10;
  req.headers = { "User-Agent": "Mozilla/5.0" };
  const json = await req.loadJSON();
  const m = json.chart.result[0].meta;
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose ?? price;
  return { price, prev, currency: m.currency, name: m.shortName || m.symbol };
}

async function refresh(db) {
  const syms = [...new Set(db.items.filter((i) => TYPES.find((t) => t.key === i.type)?.live && i.symbol).map((i) => i.symbol))];
  const curs = [...new Set(db.items.map((i) => i.currency).filter((c) => c && c !== BASE))];
  const jobs = [];
  let symFail = 0, fxFail = 0;
  for (const s of syms) {
    jobs.push(yahoo(s).then((q) => (db.cache[s] = q)).catch(() => symFail++));
  }
  for (const c of curs) {
    jobs.push(yahoo(`${c}${BASE}=X`).then((q) => (db.fx[c] = { rate: q.price, prev: q.prev })).catch(() => fxFail++));
  }
  await Promise.all(jobs);
  db.updated = new Date().toISOString();
  // 시세 조회가 대부분 성공했을 때만 이번 달 스냅샷을 갱신 (실패한 값이 기록에 남지 않도록)
  if (db.items.length && fxFail === 0 && symFail <= Math.floor(syms.length * 0.2)) recordSnapshot(db);
  saveDB(db);
}

// ---------- 계산 ----------
function calc(db) {
  const rows = db.items.map((it) => {
    let price, prev;
    if (it.type === "cash") {
      price = 1;
      prev = 1;
    } else if (it.type === "manual") {
      price = it.price ?? 0;
      prev = price;
    } else {
      const q = db.cache[it.symbol];
      price = q ? q.price : it.price ?? 0;
      prev = q ? q.prev : price;
    }
    const cur = it.currency || BASE;
    const fx = cur === BASE ? { rate: 1, prev: 1 } : db.fx[cur] || { rate: it.fxLast || 0, prev: it.fxLast || 0 };
    const valueLocal = price * it.qty;
    const costLocal = (it.type === "cash" ? it.qty : it.avgCost ?? price) * (it.type === "cash" ? 1 : it.qty);
    const value = valueLocal * fx.rate;
    const prevValue = prev * it.qty * fx.prev;
    // costKRW(원화 환산 매입금액)가 있으면 그대로 사용 (환차손익 포함).
    // 없으면 매입 환율을 모르므로 현재 환율 기준으로 환산 (환차손익 미포함)
    const cost = it.costKRW != null ? it.costKRW : costLocal * fx.rate;
    return { it, price, cur, value, cost, day: value - prevValue, pl: value - cost, localDayPct: prev ? (price / prev - 1) * 100 : 0 };
  });
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const total = sum("value");
  const cost = sum("cost");
  const day = sum("day");
  const accounts = {};
  for (const r of rows) {
    const k = r.it.account || "기타";
    const a = (accounts[k] = accounts[k] || { name: k, value: 0, cost: 0, day: 0 });
    a.value += r.value;
    a.cost += r.cost;
    a.day += r.day;
  }
  const accList = Object.values(accounts).sort((a, b) => b.value - a.value);
  return { accList, rows, total, cost, day, pl: total - cost, dayPct: total - day ? (day / (total - day)) * 100 : 0, plPct: cost ? ((total - cost) / cost) * 100 : 0 };
}

// 시장 구분: 국내주식 / 해외주식 / 코인 / 기타 / 현금 (심볼·통화로 자동 판별)
const GROUPS = ["국내주식", "해외주식", "코인", "기타", "현금"];
function marketOf(it) {
  if (it.type === "cash") return "현금";
  if (it.type === "manual") return "기타";
  if (it.type === "crypto") return "코인";
  const domestic = (it.currency || BASE) === BASE || /\.(KS|KQ)$/i.test(it.symbol || "");
  return domestic ? "국내주식" : "해외주식";
}

// ---------- 포맷 ----------
function money(n, cur = BASE, hide = false) {
  if (hide) return "••••••";
  const d = cur === BASE ? 0 : 2;
  const s = Math.abs(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sym = { KRW: "₩", USD: "$", JPY: "¥", EUR: "€" }[cur] || cur + " ";
  return (n < 0 ? "-" : "") + sym + s;
}
const signed = (n, hide) => (hide ? "••••" : (n >= 0 ? "+" : "-") + money(Math.abs(n)));
const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const colorOf = (n) => (n > 0 ? COLORS.up : n < 0 ? COLORS.down : COLORS.mute);

// ---------- 월별 기록 ----------
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

// 이번 달 스냅샷을 만들거나 덮어씀 (월말에 가장 가까운 마지막 갱신값이 남음)
function recordSnapshot(db) {
  const a = analyze(db);
  const cls = {}, acct = {};
  a.classes.forEach((c) => (cls[c.name] = Math.round(c.value)));
  a.accounts.forEach((c) => (acct[c.name] = Math.round(c.value)));
  const snap = { m: monthKey(), d: new Date().toISOString(), total: Math.round(a.total), cost: Math.round(a.cost), cls, acct };
  db.history = (db.history || []).filter((h) => h.m !== snap.m).concat(snap).sort((x, y) => (x.m < y.m ? -1 : 1));
}

async function editHistory(db) {
  const al = new Alert();
  al.title = "월별 기록 추가/수정";
  al.message = "과거 월의 자산을 직접 기입하거나 수정합니다. (같은 월이 있으면 덮어씁니다)";
  al.addTextField("월 (예: 2026-06)", "");
  al.addTextField("총 평가금액 (원)", "");
  al.addTextField("투자원금 (원, 선택)", "");
  al.addAction("저장");
  al.addCancelAction("취소");
  if ((await al.presentAlert()) < 0) return;
  const m = al.textFieldValue(0).trim();
  const num = (t) => parseFloat(t.replace(/,/g, ""));
  const total = num(al.textFieldValue(1));
  const cost = num(al.textFieldValue(2));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m) || isNaN(total)) {
    const e = new Alert();
    e.title = "입력 확인";
    e.message = "월은 2026-06 형식, 총 평가금액은 숫자로 입력해 주세요.";
    e.addAction("확인");
    await e.presentAlert();
    return;
  }
  const prev = (db.history || []).find((h) => h.m === m) || {};
  const snap = Object.assign({}, prev, { m, d: prev.d || new Date().toISOString(), total: Math.round(total), cost: isNaN(cost) ? prev.cost ?? Math.round(total) : Math.round(cost), manual: true });
  db.history = (db.history || []).filter((h) => h.m !== m).concat(snap).sort((x, y) => (x.m < y.m ? -1 : 1));
  saveDB(db);
}

// ---------- 자산 분류 / 분석 ----------
const CLS_COLOR = { 국내주식: "#2f6fdb", 해외주식: "#12a594", 채권: "#8f6bd8", 금: "#e0a31a", 현금성: "#8a9a94" };
const CUR_REGION = { USD: "미국", JPY: "일본", EUR: "유럽", CNY: "중국", HKD: "중국" };

// 이름/심볼로 자산군을 자동 분류. 항목에 assetClass 를 직접 넣으면 그 값을 우선 사용.
// 반환: [{ cls, region, w }]  (혼합형은 비율로 쪼갬)
function classify(it) {
  const n = `${it.name || ""} ${it.symbol || ""}`;
  if (it.assetClass) return [{ cls: it.assetClass, region: it.region || "-", w: 1 }];
  if (it.type === "cash") return [{ cls: "현금성", region: "-", w: 1 }];
  if (/골드|금현물|gold/i.test(n)) return [{ cls: "금", region: "-", w: 1 }];
  if (/혼합/.test(n)) return [{ cls: "국내주식", region: "한국", w: 0.5 }, { cls: "채권", region: "-", w: 0.5 }];
  if (/KOFR|MMF|CD금리|머니마켓|파킹/i.test(n)) return [{ cls: "현금성", region: "-", w: 1 }];
  if (/국고채|국채|미국채|회사채|채권|TIPS/i.test(n)) return [{ cls: "채권", region: "-", w: 1 }];
  const region = /인도|nifty/i.test(n) ? "인도" : /차이나|CSI|중국/i.test(n) ? "중국" : /신흥국|MSCI/i.test(n) ? "신흥국" : /S&P|나스닥|nasdaq|미국/i.test(n) ? "미국" : null;
  if (region) return [{ cls: "해외주식", region, w: 1 }];
  const cur = it.currency || BASE;
  if (cur !== BASE) return [{ cls: "해외주식", region: CUR_REGION[cur] || "기타", w: 1 }];
  return [{ cls: "국내주식", region: "한국", w: 1 }];
}

function analyze(db) {
  const s = calc(db);
  const acc = (m, k, r, p) => {
    const a = (m[k] = m[k] || { name: k, value: 0, cost: 0, day: 0 });
    a.value += r.value * p;
    a.cost += r.cost * p;
    a.day += r.day * p;
  };
  const cls = {}, region = {}, account = {}, tax = {}, hold = {};
  let usdDirect = 0;
  for (const r of s.rows) {
    const k = r.it.account || "기타";
    acc(account, k, r, 1);
    acc(tax, /연금|IRP|DC|ISA/i.test(k) ? "절세계좌 (연금·IRP·DC·ISA)" : "일반계좌", r, 1);
    if (r.it.type !== "cash") {
      const hk = r.it.symbol || r.it.name;
      acc(hold, hk, r, 1);
      hold[hk].label = r.it.name;
    }
    if (r.cur !== BASE && !/\(H\)|헤지/.test(r.it.name || "")) usdDirect += r.value;
    for (const p of classify(r.it)) {
      acc(cls, p.cls, r, p.w);
      if (p.cls === "국내주식" || p.cls === "해외주식") acc(region, `${p.cls === "국내주식" ? "국내" : "해외"} · ${p.region}`, r, p.w);
    }
  }
  const T = s.total || 1;
  const list = (m, order) => Object.values(m).sort((a, b) => (order ? order.indexOf(a.name) - order.indexOf(b.name) : b.value - a.value));
  const classes = list(cls, ["국내주식", "해외주식", "채권", "금", "현금성"]).map((c) => Object.assign(c, { color: CLS_COLOR[c.name] || "#999" }));
  const holdings = list(hold).map((h) => Object.assign(h, { name: h.label || h.name }));
  const pc = (n) => (cls[n] ? cls[n].value / T : 0);
  const plPct = (n) => (cls[n] && cls[n].cost ? (cls[n].value / cls[n].cost - 1) * 100 : 0);

  // ----- 평가 (규칙 기반 코멘트) -----
  const eq = pc("국내주식") + pc("해외주식"), bd = pc("채권"), gd = pc("금"), cs = pc("현금성");
  const f = (x) => (x * 100).toFixed(1) + "%";
  const ins = [];
  ins.push({ t: "자산 배분", b: `주식 ${f(eq)} · 채권 ${f(bd)} · 금 ${f(gd)} · 현금성 ${f(cs)}. ` + (eq >= 0.6 ? "주식 비중이 높은 공격형 구성입니다. 시장 급락 때 평가액 변동이 큽니다." : eq <= 0.35 ? "방어적인 구성입니다." : "주식과 안전자산이 섞인 균형형에 가깝습니다.") });
  const eqTotal = (cls["국내주식"]?.value || 0) + (cls["해외주식"]?.value || 0) || 1;
  const regs = list(region).filter((x) => x.value > 0);
  if (regs[0] && regs[0].value / eqTotal > 0.35) ins.push({ t: "지역 쏠림", b: `주식 중 ${regs[0].name} 비중이 ${(regs[0].value / eqTotal * 100).toFixed(0)}%로 가장 큽니다. 한 지역 시장의 영향이 커질 수 있습니다.` });
  const ov = (cls["해외주식"]?.value || 0) / eqTotal;
  ins.push({ t: "국내/해외", b: `주식의 ${(ov * 100).toFixed(0)}%가 해외, ${((1 - ov) * 100).toFixed(0)}%가 국내입니다.` });
  const top = holdings.slice(0, 3);
  const big = top.filter((h) => h.value / T > 0.1);
  if (big.length) ins.push({ t: "종목 집중", b: `${big.map((h) => `${h.name} ${(h.value / T * 100).toFixed(1)}%`).join(", ")} — 한 종목이 전체의 10%를 넘습니다. (같은 종목은 모든 계좌를 합산했습니다)` });
  else ins.push({ t: "종목 집중", b: `최대 종목 비중 ${(top[0] ? top[0].value / T * 100 : 0).toFixed(1)}%로 특정 종목 쏠림은 크지 않습니다.` });
  if (cls["채권"] && plPct("채권") < -3) ins.push({ t: "채권", b: `채권 평가손익 ${plPct("채권").toFixed(1)}%. 금리 상승기에는 장기채(30년 등) 가격 변동이 큽니다. 만기·듀레이션이 긴 상품 비중을 점검해 보세요.` });
  if (cls["금"] && plPct("금") > 30) ins.push({ t: "금", b: `금 수익률 ${plPct("금").toFixed(0)}%로 비중이 ${f(gd)}까지 올라왔습니다. 목표 비중을 넘었다면 리밸런싱을 고려해 볼 만합니다.` });
  const best = classes.map((c) => ({ n: c.name, pl: c.value - c.cost })).sort((a, b) => b.pl - a.pl);
  if (best.length > 1) ins.push({ t: "손익 기여", b: `평가이익은 ${best[0].n}(${signed(best[0].pl)})이 가장 크고, ${best[best.length - 1].pl < 0 ? `${best[best.length - 1].n}(${signed(best[best.length - 1].pl)})이 손실입니다.` : "손실 자산군은 없습니다."}` });
  if (cs < 0.02) ins.push({ t: "현금성", b: `현금성 자산이 ${f(cs)}로 적습니다. 리밸런싱·긴급 자금용 현금은 별도로 확보돼 있는지 확인해 보세요.` });
  if (usdDirect / T > 0.03) ins.push({ t: "환율", b: `달러 직접 보유(환헤지 없음) 자산이 ${f(usdDirect / T)}입니다. 원/달러 변동이 평가액에 그대로 반영됩니다.` });
  ins.push({ t: "참고", b: "자산군은 종목명으로 자동 분류한 값이며(혼합형은 주식/채권 50:50), 투자 권유가 아닌 참고용 요약입니다." });

  return { total: s.total, cost: s.cost, classes, regions: regs, accounts: list(account), tax: list(tax), holdings, insights: ins, usdDirect };
}

function esc(t) {
  return String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
const shortWon = (n) => (Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + "억" : Math.round(n / 1e4).toLocaleString("ko-KR") + "만");

function reportHTML(db) {
  const a = analyze(db);
  const hide = db.hide;
  const T = a.total || 1;
  const pc = (v) => ((v / T) * 100).toFixed(1) + "%";
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  const arcs = a.classes.filter((c) => c.value > 0).map((c) => {
    const len = (c.value / T) * C;
    const e = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${c.color}" stroke-width="30" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 100 100)"/>`;
    off += len;
    return e;
  }).join("");
  const donut = `<svg viewBox="0 0 200 200" class="donut">${arcs}<text x="100" y="96" text-anchor="middle" class="dl">총 자산</text><text x="100" y="120" text-anchor="middle" class="dv">${hide ? "••••" : shortWon(a.total)}</text></svg>`;
  const legend = a.classes.map((c) => {
    const pl = c.cost ? (c.value / c.cost - 1) * 100 : 0;
    return `<div class="lg"><i style="background:${c.color}"></i><b>${c.name}</b><span class="r">${pc(c.value)}</span><small>${hide ? "" : shortWon(c.value) + " · "}손익 ${pl >= 0 ? "+" : ""}${pl.toFixed(1)}%</small></div>`;
  }).join("");
  const bars = (items, max, color) => items.filter((x) => x.value > 0).map((x) => {
    const w = Math.max(1, (x.value / max) * 100);
    return `<div class="bar"><div class="bl"><span>${esc(x.name)}</span><span>${pc(x.value)}</span></div><div class="bt"><div class="bf" style="width:${w.toFixed(1)}%;background:${x.color || color}"></div></div></div>`;
  }).join("");
  const maxOf = (l) => Math.max(...l.map((x) => x.value), 1);
  const ins = a.insights.map((i) => `<div class="ins"><b>${esc(i.t)}</b><p>${esc(i.b)}</p></div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#f5f7f6;--card:#fff;--fg:#17211c;--mute:#6b7a73;--line:#e3e9e5;--bar:#2f6fdb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1a15;--card:#18271f;--fg:#eaf2ed;--mute:#9bb0a5;--line:#243629}}
*{box-sizing:border-box}body{margin:0;padding:16px;overflow-x:hidden;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,"Apple SD Gothic Neo",sans-serif}
h1{font-size:22px;margin:4px 0 12px}h2{font-size:15px;margin:0 0 10px;color:var(--mute);font-weight:600}
.card{background:var(--card);border-radius:14px;padding:16px;margin-bottom:12px}
.donut{width:200px;height:200px;display:block;margin:0 auto 8px}.dl{fill:var(--mute);font-size:11px}.dv{fill:var(--fg);font-size:20px;font-weight:700}
.lg{display:grid;grid-template-columns:14px 1fr auto;gap:2px 8px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}
.lg i{width:12px;height:12px;border-radius:3px}.lg .r{font-weight:700}.lg small{grid-column:2/4;color:var(--mute)}
.bar{margin:8px 0}.bl{display:flex;justify-content:space-between;font-size:14px}.bt{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:3px}.bf{height:100%;border-radius:4px;background:var(--bar)}
.mute{color:var(--mute);font-size:13px;margin:6px 0}.trend{width:100%;height:auto;display:block}.ax{fill:var(--mute);font-size:9px}h2 small{font-weight:400;font-size:11px}.tr{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:4px;padding:6px 0;border-top:1px solid var(--line);font-size:13px;text-align:right}.tr span:first-child{text-align:left}.th{color:var(--mute);font-size:12px}.up{color:#d32f2f}.dn{color:#1976d2}@media(prefers-color-scheme:dark){.up{color:#ff6b6b}.dn{color:#64b5f6}}
.ins{padding:8px 0;border-top:1px solid var(--line)}.ins:first-of-type{border-top:0}.ins b{font-size:14px}.ins p{margin:2px 0 0;color:var(--fg)}
</style></head><body>
<h1>포트폴리오 분석</h1>
<div class="card"><h2>자산군별 비중</h2>${donut}${legend}</div>
${trendCard(db)}
<div class="card"><h2>주식 지역별 (전체 대비)</h2>${bars(a.regions, maxOf(a.regions), "#12a594")}</div>
<div class="card"><h2>계좌별</h2>${bars(a.accounts, maxOf(a.accounts), "#2f6fdb")}</div>
<div class="card"><h2>절세계좌 / 일반계좌</h2>${bars(a.tax, maxOf(a.tax), "#8f6bd8")}</div>
<div class="card"><h2>상위 보유 종목 (모든 계좌 합산)</h2>${bars(a.holdings.slice(0, 8), maxOf(a.holdings.slice(0, 8)), "#e0a31a")}</div>
<div class="card"><h2>평가</h2>${ins}</div>
</body></html>`;
}

function trendCard(db) {
  const h = (db.history || []).slice(-24);
  if (h.length < 2) {
    return `<div class="card"><h2>월별 자산 추이</h2><p class="mute">${h.length ? "다음 달부터 추이가 표시됩니다." : "아직 기록이 없습니다."} 앱을 열 때마다 이번 달 값이 자동으로 기록되고, 과거 월은 ⋯ 도구 → 월별 기록 추가에서 직접 넣을 수 있습니다.</p></div>`;
  }
  const hide = db.hide;
  const W = 340, H = 170, pl = 8, pr = 8, pt = 12, pb = 24;
  const vals = h.flatMap((x) => [x.total, x.cost || x.total]);
  const lo = Math.min(...vals) * 0.96, hi = Math.max(...vals) * 1.03;
  const X = (i) => pl + (i * (W - pl - pr)) / (h.length - 1);
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const line = (key) => h.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(x[key] || x.total).toFixed(1)}`).join(" ");
  const area = `${line("total")} L${X(h.length - 1).toFixed(1)} ${H - pb} L${X(0).toFixed(1)} ${H - pb} Z`;
  const step = Math.ceil(h.length / 6);
  const labels = h.map((x, i) => (i % step === 0 || i === h.length - 1 ? `<text x="${X(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === h.length - 1 ? "end" : "middle"}" class="ax">${x.m.slice(2).replace("-", ".")}</text>` : "")).join("");
  const dots = h.map((x, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(x.total).toFixed(1)}" r="3" fill="#12a594"/>`).join("");
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="trend"><path d="${area}" fill="#12a594" opacity=".12"/><path d="${line("cost")}" fill="none" stroke="#8a9a94" stroke-width="1.5" stroke-dasharray="4 3"/><path d="${line("total")}" fill="none" stroke="#12a594" stroke-width="2.5"/>${dots}${labels}</svg>`;
  const rows = h.slice(-12).reverse().map((x, i, arr) => {
    const idx = h.length - 1 - i;
    const prev = h[idx - 1];
    const chg = prev ? x.total - prev.total : null;
    const chgPct = prev && prev.total ? (chg / prev.total) * 100 : null;
    const pl = x.cost ? x.total - x.cost : 0;
    const cls = chg == null ? "" : chg > 0 ? "up" : chg < 0 ? "dn" : "";
    return `<div class="tr"><span>${x.m}${x.manual ? " ✎" : ""}</span><span>${hide ? "••••" : shortWon(x.total)}</span><span class="${cls}">${chgPct == null ? "-" : (chgPct >= 0 ? "+" : "") + chgPct.toFixed(1) + "%"}</span><span class="${pl > 0 ? "up" : pl < 0 ? "dn" : ""}">${x.cost ? (pl >= 0 ? "+" : "") + ((pl / x.cost) * 100).toFixed(1) + "%" : "-"}</span></div>`;
  }).join("");
  const first = h[0], last = h[h.length - 1];
  const tot = first.total ? ((last.total / first.total - 1) * 100).toFixed(1) : "0";
  return `<div class="card"><h2>월별 자산 추이 <small>(실선 평가액 · 점선 투자원금)</small></h2>${svg}<p class="mute">${first.m} → ${last.m}: ${hide ? "" : shortWon(first.total) + " → " + shortWon(last.total) + " "}(${Number(tot) >= 0 ? "+" : ""}${tot}%)</p><div class="tr th"><span>월</span><span>평가액</span><span>전월 대비</span><span>수익률</span></div>${rows}</div>`;
}

async function showReport(db) {
  await WebView.loadHTML(reportHTML(db), null, null, true);
}

// ---------- 입력 UI ----------
async function editItem(db, item) {
  const isNew = !item;
  const it = Object.assign({ type: "stock", currency: BASE, qty: 0 }, item);

  if (isNew) {
    const a = new Alert();
    a.title = "자산 종류";
    TYPES.forEach((t) => a.addAction(t.label));
    a.addCancelAction("취소");
    const idx = await a.presentSheet();
    if (idx < 0) return false;
    it.type = TYPES[idx].key;
    it.id = String(Date.now());
  }

  const t = TYPES.find((x) => x.key === it.type);
  const al = new Alert();
  al.title = (isNew ? "추가: " : "수정: ") + t.label;
  al.addTextField("이름 (예: 삼성전자)", it.name || "");
  if (t.live) al.addTextField("심볼 (예: 005930.KS, AAPL, BTC-USD)", it.symbol || "");
  al.addTextField(it.type === "cash" ? "금액" : "수량", it.qty ? String(it.qty) : "");
  if (it.type === "stock" || it.type === "crypto") al.addTextField("평균 매입가 (현지통화 기준)", it.avgCost != null ? String(it.avgCost) : "");
  if (it.type === "manual") al.addTextField("현재 평가액 단가", it.price != null ? String(it.price) : "");
  al.addTextField("통화 (KRW/USD/JPY/EUR)", it.currency || BASE);
  al.addAction("저장");
  al.addCancelAction("취소");
  if ((await al.presentAlert()) < 0) return false;

  let i = 0;
  const f = () => al.textFieldValue(i++).trim();
  const num = (s) => parseFloat(s.replace(/,/g, ""));
  it.name = f();
  if (t.live) it.symbol = f().toUpperCase();
  it.qty = num(f()) || 0;
  if (it.type === "stock" || it.type === "crypto") {
    const v = num(f());
    it.avgCost = isNaN(v) ? undefined : v;
  }
  if (it.type === "manual") {
    const v = num(f());
    it.price = isNaN(v) ? 0 : v;
  }
  it.currency = (f() || BASE).toUpperCase();
  if (!it.name) it.name = it.symbol || t.label;

  if (isNew) db.items.push(it);
  else db.items[db.items.findIndex((x) => x.id === it.id)] = it;
  saveDB(db);
  return true;
}

async function itemMenu(db, row) {
  const a = new Alert();
  a.title = row.it.name;
  a.message = `${row.it.qty.toLocaleString()} × ${money(row.price, row.cur)}  =  ${money(row.value)}`;
  a.addAction("수정");
  a.addDestructiveAction("삭제");
  a.addCancelAction("닫기");
  const r = await a.presentSheet();
  if (r === 0) return editItem(db, row.it);
  if (r === 1) {
    const c = new Alert();
    c.title = "삭제할까요?";
    c.message = row.it.name;
    c.addDestructiveAction("삭제");
    c.addCancelAction("취소");
    if ((await c.presentAlert()) === 0) {
      db.items = db.items.filter((x) => x.id !== row.it.id);
      saveDB(db);
      return true;
    }
  }
  return false;
}

async function checkQuotes(db) {
  await refresh(db);
  while (true) {
    const bad = db.items.filter((i) => TYPES.find((t) => t.key === i.type)?.live && !db.cache[i.symbol]);
    const a = new Alert();
    a.title = "시세 점검";
    if (!bad.length) {
      a.message = "모든 종목의 시세를 정상적으로 가져왔습니다.";
      a.addAction("확인");
      await a.presentAlert();
      return;
    }
    a.message = `시세를 못 가져온 종목 ${bad.length}개\n탭해서 심볼을 고치세요. (입력 즉시 조회해서 확인합니다)`;
    bad.forEach((i) => a.addAction(`${i.account ? i.account + " · " : ""}${i.name}  [${i.symbol || "심볼 없음"}]`));
    a.addCancelAction("닫기");
    const idx = await a.presentSheet();
    if (idx < 0) return;
    const it = bad[idx];

    while (true) {
      const inp = new Alert();
      inp.title = it.name;
      inp.message = "Yahoo 심볼 입력 (예: 005930.KS, 코스닥은 .KQ, 미국주식은 AAPL)";
      inp.addTextField("심볼", it.symbol || "");
      inp.addAction("조회");
      inp.addCancelAction("건너뛰기");
      if ((await inp.presentAlert()) < 0) break;
      const sym = inp.textFieldValue(0).trim().toUpperCase();
      if (!sym) continue;
      let q = null;
      try {
        q = await yahoo(sym);
      } catch (e) {}
      const r = new Alert();
      if (q) {
        r.title = "조회 성공";
        r.message = `${q.name}\n현재가 ${q.price.toLocaleString()} ${q.currency}\n이 심볼로 저장할까요?`;
        r.addAction("저장");
        r.addCancelAction("다시 입력");
        if ((await r.presentAlert()) === 0) {
          it.symbol = sym;
          it.price = q.price;
          db.cache[sym] = q;
          saveDB(db);
          break;
        }
      } else {
        r.title = "조회 실패";
        r.message = `${sym} 의 시세를 가져오지 못했습니다. 심볼을 다시 확인해 주세요.`;
        r.addAction("확인");
        await r.presentAlert();
      }
    }
  }
}

async function toolsMenu(db) {
  const a = new Alert();
  a.title = "도구";
  a.addAction(db.hide ? "금액 표시" : "금액 숨기기");
  a.addAction("JSON 내보내기 (클립보드 복사)");
  a.addAction("JSON 가져오기 (클립보드에서)");
  a.addAction("시세 점검 (시세 없는 종목 고치기)");
  a.addAction("월별 기록 추가/수정");
  a.addCancelAction("닫기");
  const r = await a.presentSheet();
  if (r === 0) {
    db.hide = !db.hide;
    saveDB(db);
  } else if (r === 1) {
    Pasteboard.copy(JSON.stringify({ items: db.items, history: db.history || [] }, null, 2));
    const n = new Notification();
    n.title = "복사 완료";
    n.body = "자산 데이터를 클립보드에 복사했습니다.";
    await n.schedule();
  } else if (r === 3) {
    await checkQuotes(db);
  } else if (r === 4) {
    await editHistory(db);
  } else if (r === 2) {
    try {
      const data = JSON.parse(Pasteboard.paste());
      const hasItems = Array.isArray(data.items);
      const hasHist = Array.isArray(data.history);
      if (!hasItems && !hasHist) throw new Error("items/history 없음");
      if (hasItems) {
        let mode = 0;
        if (db.items.length) {
          const m = new Alert();
          m.title = "가져오기 방식";
          m.message = `클립보드: ${data.items.length}개 항목 / 현재: ${db.items.length}개 항목`;
          m.addAction("기존 목록에 추가 (같은 id는 교체)");
          m.addDestructiveAction("전체 덮어쓰기");
          m.addCancelAction("취소");
          mode = await m.presentSheet();
          if (mode < 0) return;
        }
        if (mode === 0 && db.items.length) {
          const ids = new Set(data.items.map((i) => i.id));
          db.items = db.items.filter((i) => !ids.has(i.id)).concat(data.items);
        } else {
          db.items = data.items;
        }
      }
      if (hasHist) {
        const keep = (db.history || []).filter((h) => !data.history.some((x) => x.m === h.m));
        db.history = keep.concat(data.history).sort((x, y) => (x.m < y.m ? -1 : 1));
      }
      saveDB(db);
    } catch (e) {
      const err = new Alert();
      err.title = "가져오기 실패";
      err.message = "클립보드의 JSON 형식을 확인해 주세요.";
      err.addAction("확인");
      await err.presentAlert();
    }
  }
}

// ---------- 테이블 UI ----------
function cell(text, opts = {}) {
  const c = UITableCell.text(text, opts.sub);
  c.titleColor = opts.color || Color.dynamic(Color.black(), Color.white());
  if (opts.subColor) c.subtitleColor = opts.subColor;
  if (opts.right) c.rightAligned();
  if (opts.weight != null) c.widthWeight = opts.weight;
  c.titleFont = opts.bold ? Font.boldSystemFont(opts.size || 16) : Font.systemFont(opts.size || 16);
  c.subtitleFont = Font.systemFont(12);
  return c;
}

const collapsed = new Set();
function render(table, db) {
  const s = calc(db);
  const h = db.hide;
  table.removeAllRows();

  const head = new UITableRow();
  head.height = 96;
  head.isHeader = true;
  const headCell = cell("총 자산", { sub: money(s.total, BASE, h), size: 14, bold: true, weight: 1 });
  headCell.titleColor = COLORS.mute;
  headCell.subtitleColor = Color.dynamic(Color.black(), Color.white());
  headCell.subtitleFont = Font.boldSystemFont(30);
  head.addCell(headCell);
  table.addRow(head);

  const sub = new UITableRow();
  sub.height = 56;
  sub.addCell(cell("오늘", { sub: `${signed(s.day, h)}  (${pct(s.dayPct)})`, color: COLORS.mute, subColor: colorOf(s.day), weight: 1, size: 12 }));
  sub.addCell(cell("평가손익", { sub: `${signed(s.pl, h)}  (${pct(s.plPct)})`, color: COLORS.mute, subColor: colorOf(s.pl), weight: 1, size: 12 }));
  table.addRow(sub);

  const bar = new UITableRow();
  bar.height = 48;
  const add = UITableCell.button("＋ 추가");
  add.onTap = async () => {
    if (await editItem(db, null)) {
      await refresh(db);
      render(table, db);
      table.reload();
    }
  };
  const ref = UITableCell.button("↻ 새로고침");
  ref.onTap = async () => {
    await refresh(db);
    render(table, db);
    table.reload();
  };
  const tools = UITableCell.button("⋯ 도구");
  tools.onTap = async () => {
    await toolsMenu(db);
    render(table, db);
    table.reload();
  };
  const rep = UITableCell.button("📊 분석");
  rep.onTap = async () => {
    await showReport(db);
  };
  [add, ref, rep, tools].forEach((c) => bar.addCell(c));
  table.addRow(bar);

  const sorted = [...s.rows];
  const rerender = () => {
    render(table, db);
    table.reload();
  };
  for (const a of s.accList) {
    const open = !collapsed.has(a.name);
    const share = s.total ? ((a.value / s.total) * 100).toFixed(1) : "0.0";
    const apl = a.value - a.cost;
    const head2 = new UITableRow();
    head2.height = 60;
    head2.backgroundColor = Color.dynamic(new Color("#e8eeea"), new Color("#1d2f25"));
    head2.dismissOnSelect = false;
    head2.addCell(cell(`${open ? "▾" : "▸"} ${a.name}`, { sub: `비중 ${share}%`, subColor: COLORS.mute, weight: 4, bold: true, size: 16 }));
    head2.addCell(cell(money(a.value, BASE, h), { sub: `손익 ${signed(apl, h)} (${pct(a.cost ? (apl / a.cost) * 100 : 0)})`, subColor: colorOf(apl), right: true, weight: 7, bold: true, size: 16 }));
    head2.onSelect = () => {
      if (collapsed.has(a.name)) collapsed.delete(a.name);
      else collapsed.add(a.name);
      rerender();
    };
    table.addRow(head2);
    if (!open) continue;

    const accRows = s.rows.filter((r) => (r.it.account || "기타") === a.name);
    const split = accRows.some((r) => marketOf(r.it) === "해외주식");
    const addItemRow = (r) => {
      const row = new UITableRow();
      row.height = 60;
      row.dismissOnSelect = false;
      const accShare = a.value ? ((r.value / a.value) * 100).toFixed(1) : "0.0";
      const live = TYPES.find((t) => t.key === r.it.type)?.live;
      const stale = live && !db.cache[r.it.symbol] ? " · ⚠︎시세없음" : "";
      row.addCell(cell(r.it.name, { sub: `${TYPES.find((t) => t.key === r.it.type)?.label} · 계좌 내 ${accShare}%${stale}`, subColor: COLORS.mute, weight: 5, size: 15 }));
      const dayPct = r.value - r.day ? (r.day / (r.value - r.day)) * 100 : 0;
      const plPct = r.cost ? (r.pl / r.cost) * 100 : 0;
      const noPrice = r.it.type === "cash" || r.it.type === "manual";
      // 일간 변동(오늘)은 일간 등락 색, 평가금액/손익은 손익 색으로 따로 표시
      // 외화 종목은 원화 기준(환율 포함) 아래에 현지통화 기준 등락률도 함께 표시
      const foreign = r.cur !== BASE;
      const subText = noPrice ? " " : foreign ? `${r.cur} ${pct(r.localDayPct)}` : "오늘";
      row.addCell(cell(noPrice ? " " : pct(dayPct), { sub: subText, color: colorOf(r.day), subColor: foreign && !noPrice ? colorOf(r.localDayPct) : COLORS.mute, right: true, weight: 3, size: 14 }));
      row.addCell(cell(money(r.value, BASE, h), { sub: noPrice ? " " : `손익 ${pct(plPct)}`, subColor: colorOf(r.pl), right: true, weight: 5, size: 15 }));
      row.onSelect = async () => {
        if (await itemMenu(db, r)) {
          await refresh(db);
          rerender();
        }
      };
      table.addRow(row);
    };
    for (const g of split ? GROUPS : [null]) {
      const rows = accRows.filter((r) => g === null || marketOf(r.it) === g).sort((x, y) => y.value - x.value);
      if (!rows.length) continue;
      if (g) {
        const sub = new UITableRow();
        sub.height = 34;
        sub.addCell(cell(`  ${g}`, { color: COLORS.mute, bold: true, size: 13, weight: 4 }));
        sub.addCell(cell(money(rows.reduce((t, r) => t + r.value, 0), BASE, h), { color: COLORS.mute, size: 13, right: true, weight: 7 }));
        table.addRow(sub);
      }
      rows.forEach(addItemRow);
    }
  }

  if (!sorted.length) {
    const empty = new UITableRow();
    empty.height = 80;
    empty.addCell(cell("보유 자산이 없습니다. ‘＋ 추가’로 시작하세요.", { color: COLORS.mute, size: 14 }));
    table.addRow(empty);
  }

  const foot = new UITableRow();
  foot.height = 40;
  const when = db.updated ? new Date(db.updated).toLocaleString("ko-KR") : "-";
  foot.addCell(cell(`마지막 갱신: ${when}`, { color: COLORS.mute, size: 11 }));
  table.addRow(foot);
}

// ---------- 위젯 ----------
function buildWidget(db) {
  const s = calc(db);
  const h = db.hide;
  const w = new ListWidget();
  w.backgroundColor = Color.dynamic(new Color("#f5f7f6"), new Color("#12201a"));
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  w.url = URLScheme.forRunningScript();

  const title = w.addText("총 자산");
  title.font = Font.mediumSystemFont(12);
  title.textColor = COLORS.mute;
  const total = w.addText(money(s.total, BASE, h));
  total.font = Font.boldSystemFont(config.widgetFamily === "small" ? 22 : 30);
  total.minimumScaleFactor = 0.5;
  w.addSpacer(4);
  const d = w.addText(`오늘 ${signed(s.day, h)} (${pct(s.dayPct)})`);
  d.font = Font.mediumSystemFont(12);
  d.textColor = colorOf(s.day);
  const p = w.addText(`손익 ${signed(s.pl, h)} (${pct(s.plPct)})`);
  p.font = Font.mediumSystemFont(12);
  p.textColor = colorOf(s.pl);

  const addLine = (name, value, color) => {
    const line = w.addStack();
    const n = line.addText(name);
    n.font = Font.systemFont(12);
    n.lineLimit = 1;
    line.addSpacer();
    const v = line.addText(money(value, BASE, h));
    v.font = Font.systemFont(12);
    v.textColor = color;
  };
  if (config.widgetFamily !== "small") {
    w.addSpacer(8);
    s.accList.slice(0, config.widgetFamily === "large" ? 6 : 4).forEach((a) => addLine(a.name, a.value, colorOf(a.day)));
    if (config.widgetFamily === "large") {
      w.addSpacer(8);
      [...s.rows]
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .forEach((r) => addLine(r.it.name, r.value, colorOf(r.day)));
    }
  }
  w.addSpacer();
  const t = w.addText(db.updated ? new Date(db.updated).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) + " 기준" : "");
  t.font = Font.systemFont(9);
  t.textColor = COLORS.mute;
  return w;
}

// ---------- 실행 ----------
const db = await loadDB();
if (config.runsInWidget) {
  await refresh(db);
  Script.setWidget(buildWidget(db));
} else {
  const table = new UITable();
  table.showSeparators = true;
  render(table, db);
  const presented = table.present(false);
  refresh(db).then(() => {
    render(table, db);
    table.reload();
  });
  await presented;
}
Script.complete();
