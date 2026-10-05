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
  if (!fm.fileExists(path)) return { items: [], cache: {}, fx: {}, hide: false, updated: null };
  if (fm.isFileStoredIniCloud(path) && !fm.isFileDownloaded(path)) await fm.downloadFileFromiCloud(path);
  try {
    const db = JSON.parse(fm.readString(path));
    return Object.assign({ items: [], cache: {}, fx: {}, hide: false, updated: null }, db);
  } catch (e) {
    return { items: [], cache: {}, fx: {}, hide: false, updated: null };
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
  for (const s of syms) {
    jobs.push(yahoo(s).then((q) => (db.cache[s] = q)).catch(() => {}));
  }
  for (const c of curs) {
    jobs.push(yahoo(`${c}${BASE}=X`).then((q) => (db.fx[c] = { rate: q.price, prev: q.prev })).catch(() => {}));
  }
  await Promise.all(jobs);
  db.updated = new Date().toISOString();
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
    return { it, price, cur, value, cost, day: value - prevValue, pl: value - cost };
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
  a.addCancelAction("닫기");
  const r = await a.presentSheet();
  if (r === 0) {
    db.hide = !db.hide;
    saveDB(db);
  } else if (r === 1) {
    Pasteboard.copy(JSON.stringify({ items: db.items }, null, 2));
    const n = new Notification();
    n.title = "복사 완료";
    n.body = "자산 데이터를 클립보드에 복사했습니다.";
    await n.schedule();
  } else if (r === 3) {
    await checkQuotes(db);
  } else if (r === 2) {
    try {
      const data = JSON.parse(Pasteboard.paste());
      if (!Array.isArray(data.items)) throw new Error("items 없음");
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
  [add, ref, tools].forEach((c) => bar.addCell(c));
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
      row.addCell(cell(money(r.value, BASE, h), { sub: r.it.type === "cash" || r.it.type === "manual" ? " " : `${pct(dayPct)} · 손익 ${pct(r.cost ? (r.pl / r.cost) * 100 : 0)}`, subColor: colorOf(r.pl), right: true, weight: 6, size: 15 }));
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
