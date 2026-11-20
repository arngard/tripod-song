/* 역사 반복 탭.
   명세: epistemic-structure/architecture/tripod-replay.md.
   판정은 생성(tripod/replay.py)이 원천 기준일 후보마다 미리 계산해 replay.json에 바뀐 지점만 담는다. 이 화면은 고른 후보의
   판정을 날마다로 펼치고, 판정선(이동평균과 밴드, 52주 고점, VIX 평균)을 종가와 그날 파라미터로 다시 계산해 그린다.
   판정선의 계산은 tripod/rules.py evaluate와 service._chart의 정의를 따른다. */
/* 판정선과 판정의 날마다 값. DOM과 떨어진 순수 계산이라 시험(test_tripod.py check_replay_lines)이 node로 불러 파이썬 값과 대조한다. */
var ReplayCore = (function () {
  "use strict";
  var HIGH_WINDOW = 252;           /* rules.HIGH_WINDOW */
  var REAL_SHARE = 0.1;            /* 결과 차트에서 직전 종가까지의 실제 구간이 차지하는 가로폭 비율 */
  var iso = function (d) { var s = String(d); return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8); };

  /* [[시작 위치, 부호], ...]를 날마다의 값으로 편다. */
  function expand(runs, len, dict) {
    var out = new Array(len);
    for (var m = 0; m < runs.length; m++) {
      var stop = m + 1 < runs.length ? Math.min(len, runs[m + 1][0]) : len;
      for (var k = runs[m][0]; k < stop; k++) out[k] = dict[runs[m][1]];
    }
    return out;
  }

  /* 고른 플레이버와 후보의 날마다 값. 실제 자료 전체 뒤에 반복 len일을 붙인다. */
  function series(D, key, j, n) {
    var f = D.flavors[key], a = D.anchors[j], run = D.runs[key][j];
    var N = D.day.length, len = Math.min(n, a.len), T = N + len;
    var close = D.ndx.slice(), vixv = D.vix.slice(), time = D.day.map(iso), srcDay = new Array(N).fill(null);
    for (var k = 0; k < len; k++) {
      close.push(close[close.length - 1] * D.ndx[a.i + 1 + k] / D.ndx[a.i + k]);
      vixv.push(D.vix[a.i + 1 + k]);
      time.push(iso(D.future[k]));
      srcDay.push(iso(D.day[a.i + 1 + k]));
    }
    var allocs = expand(D.real[key].alloc, N, D.allocs).concat(run.alloc ? expand(run.alloc, len, D.allocs) : new Array(len).fill(null));
    var seasons = expand(D.real[key].season, N, D.seasons).concat(run.season ? expand(run.season, len, D.seasons) : new Array(len).fill(null));
    var P = f.params;
    var paramsAt = function (i) { return P.one || (seasons[i] === "겨울" || !seasons[i] ? P.down : P.up); };
    var acc = [0], vnull = [0], vacc = [0];
    for (var i = 0; i < T; i++) {
      acc.push(acc[i] + close[i]);
      vacc.push(vacc[i] + (vixv[i] == null ? 0 : vixv[i]));
      vnull.push(vnull[i] + (vixv[i] == null ? 1 : 0));
    }
    var real = Math.max(1, Math.round(len * REAL_SHARE / (1 - REAL_SHARE)));
    var view = Math.max(0, N - real), out = { up: [], down: [], dd: [], vix10: [], vix_cap: [], vix_floor: [] };
    for (i = view; i < T; i++) {
      var p = paramsAt(i), sma = i + 1 >= p.ma ? (acc[i + 1] - acc[i + 1 - p.ma]) / p.ma : null;
      out.up.push(sma == null ? null : sma * (1 + p.band_up));
      out.down.push(sma == null ? null : sma * (1 + p.band_down));
      var hi = null;
      if (i + 1 >= HIGH_WINDOW) { hi = -Infinity; for (var j = i + 1 - HIGH_WINDOW; j <= i; j++) if (close[j] > hi) hi = close[j]; }
      /* 없는 조건(null)의 선은 그리지 않는다. VIX를 판정에 쓰지 않으면(vwin null) VIX 평균도 내지 않는다. */
      out.dd.push(hi == null || p.dd_limit == null ? null : hi * (1 + p.dd_limit));
      var w = p.vwin, ok = w != null && i + 1 >= w && vnull[i + 1] - vnull[i + 1 - w] === 0;
      var v10 = ok ? (vacc[i + 1] - vacc[i + 1 - w]) / w : null;
      out.vix10.push(v10);
      out.vix_cap.push(v10 == null || p.vix_cap == null ? null : p.vix_cap);
      out.vix_floor.push(v10 == null || p.vix_floor == null ? null : p.vix_floor);
    }
    return { f: f, a: a, run: run, N: N, len: len, view: view, time: time.slice(view), close: close.slice(view),
             allocs: allocs.slice(view), seasons: seasons.slice(view), srcDay: srcDay.slice(view), lines: out,
             composite: !P.one, splice: N - view };
  }

  /* 배수 차트의 환율. 직전 종가까지 n거래일(기간 버튼의 길이) 실제 원/달러 환율의 평균 하나다. 환율의 미래 경로가 없어 반복 구간 내내
     이 값으로 원화 손익과 양도세를 정한다. 자료가 n일보다 짧으면 있는 만큼으로 낸다. 돌려주는 것은 {rate, days}다. */
  function fxAvg(D, n) {
    var N = D.day.length, sum = 0, cnt = 0;
    if (!D.fx) return null;
    for (var i = Math.max(0, N - n); i < N; i++) if (D.fx[i] != null) { sum += D.fx[i]; cnt++; }
    return cnt ? { rate: sum / cnt, days: cnt } : null;
  }

  /* 반복 구간의 배수. 직전 종가(N-1)에 원화 시드(1억 원)를 넣고 반복 구간 끝까지 돈다. 테스트 탭(comparison.js simulate)과 같은 순서와
     세금이다 - 날마다 보유분이 그날 합성 수익률만큼 자라고 현금에 원천징수 뒤 이자가 붙은 뒤, 들고 있어야 할 배분이 바뀌었으면 전량
     팔아 그해 실현 손익의 양도세 유보금을 맞추고 새 배분을 산다. 사고판 금액에 편도 거래비용을 뗀다. 다른 점은 환율 하나(fxAvg)를
     내내 쓰는 것과 세금의 연도가 가상 날짜의 연도라는 것이다. 들고 있어야 할 배분은 확정 다음 거래일 종가에 체결하므로 전날의 확정
     배분이다(comparison._held). 합성 수익률은 comparison._assemble과 같은 식이고, 반복 구간의 13주 국채 금리는 원천의 변화폭을 직전
     값에 더하고 0 아래로 내리지 않는다. 돌려주는 것은 {time, fx, fxDays, seed, keys: {계열: {acct, liq, gain, swAt, taxAt}}}이고 배열은
     simulate의 같은 이름 값(원화 평가금, 전부 팔았을 때 세후, 원화 미실현 손익, 그날까지의 배분 전환 수와 양도세 누계)이다. */
  function grow(D, j, n) {
    var a = D.anchors[j], N = D.day.length, len = Math.min(n, a.len), P = D.product, dt = 1 / P.year;
    var fx = fxAvg(D, n);
    if (!D.irx || !fx || !len) return null;
    var close = [D.ndx[N - 1]], rate = [D.irx[N - 1] / 100], time = [iso(D.day[N - 1])];
    for (var k = 0; k < len; k++) {
      close.push(close[k] * D.ndx[a.i + 1 + k] / D.ndx[a.i + k]);
      rate.push(Math.max(0, D.irx[N - 1] + D.irx[a.i + 1 + k] - D.irx[a.i]) / 100);
      time.push(iso(D.future[k]));
    }
    var yr = time.map(function (t) { return +t.slice(0, 4); }), X = fx.rate;
    var div = P.div_yield * dt, ret = {};
    [1, 2, 3].forEach(function (m) {
      var r = [0];
      for (var i = 1; i <= len; i++) {
        var x = m * (close[i] / close[i - 1] - 1 + div) - (m - 1) * (rate[i] + (P.spread_s0 + P.spread_k * rate[i])) * dt - P.fee[m] * dt;
        r.push(x - m * P.div_yield * dt * P.div_wht);
      }
      ret[m] = r;
    });
    var MIX = {}, ALLOCW = {};
    Object.keys(P.mix).forEach(function (m) { MIX[+m] = P.mix[m]; });
    ALLOCW["현금 100%"] = {}; ALLOCW["QQQ 50% + QLD 50%"] = MIX; ALLOCW["TQQQ 100%"] = { 3: 1 }; ALLOCW["QQQ 100%"] = { 1: 1 };
    function run(wantAt) {
      var pos = {}, basis = {}, cash = P.seed / X, cur = null, realized = {}, reserveY = {}, taxReserved = 0, switches = -1;
      var acct = new Array(len + 1), liq = new Array(len + 1), gain = new Array(len + 1), swAt = new Array(len + 1), taxAt = new Array(len + 1);
      for (var i = 0; i <= len; i++) {
        var y = yr[i], gross;
        if (i > 0) {
          Object.keys(pos).forEach(function (m) { pos[m] *= 1 + ret[m][i]; });
          cash += cash * rate[i] * dt * (1 - P.int_tax);
        }
        var want = wantAt(i);
        if (want !== cur) {                                  /* 전량 청산, 세무 유보금 조정, 새 배분 매수 */
          gross = 0;
          Object.keys(pos).forEach(function (m) {
            gross += pos[m];
            realized[y] = (realized[y] || 0) + pos[m] * X - basis[m];
          });
          var due = P.cgt * Math.max(0, (realized[y] || 0) - P.deduct);
          var delta = due - (reserveY[y] || 0);               /* 음수면 같은 해 손실로 줄어든 만큼 예비금으로 되돌린다 */
          reserveY[y] = due;
          taxReserved += delta;
          var total = cash + gross - delta / X, w = ALLOCW[want] || want, sw = 0;
          Object.keys(w).forEach(function (m) { sw += w[m]; });
          total -= (gross + total * sw) * P.cost;
          pos = {}; basis = {};
          var spent = 0;
          Object.keys(w).forEach(function (m) { pos[m] = total * w[m]; basis[m] = pos[m] * X; spent += pos[m]; });
          cash = total - spent;
          cur = want;
          switches++;
        }
        gross = 0;
        var unreal = 0;
        Object.keys(pos).forEach(function (m) { gross += pos[m]; unreal += pos[m] * X - basis[m]; });
        var v = (cash + gross) * X, r = realized[y] || 0;
        var liqTax = P.cgt * Math.max(0, r + unreal - P.deduct) - P.cgt * Math.max(0, r - P.deduct);
        acct[i] = v; liq[i] = v - liqTax; gain[i] = unreal; swAt[i] = switches; taxAt[i] = taxReserved;
      }
      return { acct: acct, liq: liq, gain: gain, swAt: swAt, taxAt: taxAt };
    }
    var keys = {};
    Object.keys(D.flavors).forEach(function (k) {
      var real = expand(D.real[k].alloc, N, D.allocs), run_ = D.runs[k][j];
      var fut = run_.alloc ? expand(run_.alloc, len, D.allocs) : null;
      if (!fut) return;
      /* i일(0은 직전 종가)에 들고 있어야 할 배분 = 전날의 확정 배분 */
      keys[k] = run(function (i) { return i === 0 ? real[N - 2] : i === 1 ? real[N - 1] : fut[i - 2]; });
    });
    keys.QQQ = run(function () { return "QQQ 100%"; });
    keys.TQQQ = run(function () { return "TQQQ 100%"; });
    return { time: time, fx: X, fxDays: fx.days, seed: P.seed, keys: keys };
  }

  return { expand: expand, series: series, grow: grow, iso: iso };
})();
if (typeof module !== "undefined") module.exports = ReplayCore;

(function () {
  "use strict";
  if (typeof document === "undefined") return;

  var byId = function (id) { return document.getElementById(id); };
  var root = document.querySelector(".replay");
  var LC = window.LightweightCharts;
  if (!root || !LC || !window.ChartKit) return;
  var css = ChartKit.css;

  var FLAVOR_KEY = "tripod-flavor", STATE_KEY = "tripod-replay";
  var ALLOC_VAR = { "현금 100%": "--a-cash", "QQQ 100%": "--a-qqq", "QQQ 50% + QLD 50%": "--a-mix", "TQQQ 100%": "--a-tqqq" };

  var D = null, state = { flavor: null, n: 756, anchor: null, base: "seed" };
  try { state.flavor = sessionStorage.getItem(FLAVOR_KEY) || null; } catch (e) { /* 기본 플레이버 */ }
  try {
    var saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || "null");
    if (saved) { state.n = saved.n || state.n; state.anchorDay = saved.anchor || null; if (saved.base === "qqq") state.base = "qqq"; if (saved.shown && typeof saved.shown === "object") state.shown = saved.shown; }
  } catch (e) { /* 처음 상태 */ }
  function save() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({ n: state.n, anchor: D ? D.day[D.anchors[state.anchor].i] : null, base: state.base, shown: gshown }));
    } catch (e) { /* 기억하지 못해도 지금 페이지에서는 바뀐다 */ }
  }

  var iso = ReplayCore.iso, expand = ReplayCore.expand;
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  /* ---- 역사 반복 차트 ----
     시장 상황 차트와 같은 두 패널이다. 왼쪽 가로폭 10%는 직전 종가까지의 실제 자료이고 나머지가 반복 구간이다. 경계는 직전 종가의 확정
     배분 색으로 2px 점선을 긋는다. 차트를 끌거나 가로로 스크롤하면 실제 구간은 그대로 두고 원천 기준일을 옮겨 반복 구간만 바뀐다.
     판정은 원천 기준일 후보에서만 미리 계산돼 있으므로 기준일은 후보 사이를 끊어서 옮긴다. 오른쪽으로 끌면 더 이른 원천이다. */

  var res = null;
  var LEGEND = {
    price: [["ndx", "NDX", "--ink", 0], ["up", "상승 전환선", "--j-pos", 0], ["down", "하락 전환선", "--j-neg", 0], ["dd", "낙폭 한도선", "--j-neu", 0]],
    vix: [["vix10", "VIX 평균", "--ink", 2], ["vix_cap", "조심선", "--j-neu", 2], ["vix_floor", "부활선", "--j-pos", 2]]
  };

  function chartOpts() {
    var o = ChartKit.options();
    o.timeScale.minBarSpacing = 0.01;
    /* 시장 사건 띠를 캔버스 밑에 깔도록 바탕은 상자(CSS)가 칠한다. */
    o.layout.background = { type: "solid", color: "transparent" };
    /* 끌기와 가로 스크롤은 라이브러리가 아니라 아래 drag가 받아 원천 기준일을 옮긴다. */
    o.handleScroll = false;
    o.handleScale = false;
    return o;
  }

  function buildResult() {
    var price = LC.createChart(byId("rChartPrice"), chartOpts());
    var vix = LC.createChart(byId("rChartVix"), chartOpts());
    var dashed = 2, series = {};
    LEGEND.price.forEach(function (it) {
      series[it[0]] = price.addSeries(LC.LineSeries, ChartKit.line(it[0] === "ndx" ? { color: css(it[2]) } :
        { color: css(it[2]), lineStyle: dashed, lastValueVisible: false }));
    });
    LEGEND.vix.forEach(function (it) {
      series[it[0]] = vix.addSeries(LC.LineSeries, ChartKit.line(it[0] === "vix10" ? { color: css(it[2]) } :
        { color: css(it[2]), lineStyle: dashed, lastValueVisible: false }));
    });
    var mk = function (box, items) { return ChartKit.legend(byId(box), items.map(function (it) { return { key: it[0], label: it[1], color: it[2] }; })); };
    res = { price: price, vix: vix, series: series, legend: { price: mk("rLegendPrice", LEGEND.price), vix: mk("rLegendVix", LEGEND.vix) } };
    var hover = function (p) { paintAt(p && p.logical != null ? Math.round(p.logical) : null); };
    price.subscribeCrosshairMove(hover);
    vix.subscribeCrosshairMove(hover);
    price.timeScale().subscribeSizeChange(function () { requestAnimationFrame(function () { drawOverlays(); drawStrip(); }); });
    /* 자료를 넣고 구간을 정한 뒤 좌표가 확정되면 다시 그린다. 그 전에 그리면 좌표가 비어 선이 빠진다. */
    price.timeScale().subscribeVisibleLogicalRangeChange(function () { requestAnimationFrame(drawOverlays); });
    ["rChartPrice", "rChartVix"].forEach(drag);
  }

  /* 원천 위치(D.day의 번호) target에서 가장 가까운 후보로 기준일을 옮긴다. 같은 후보면 다시 그리지 않는다. */
  function snapTo(target) {
    var best = 0, gap = Infinity;
    D.anchors.forEach(function (a, j) {
      var g = Math.abs(a.i - target);
      if (g < gap) { gap = g; best = j; }
    });
    if (best !== state.anchor) setAnchor(best);
  }

  /* 봉 하나의 가로 픽셀. 끈 거리를 원천의 거래일 수로 바꾸는 데 쓴다. */
  function barWidth() {
    var n = cur ? cur.time.length : 0, w = res.price.timeScale().width();
    return n && w ? w / n : 1;
  }

  /* 끌기와 가로 스크롤. 몸짓 하나 동안 처음 기준일에서 움직인 거리를 쌓아 두고, 그 자리에서 가장 가까운 후보로 맞춘다. 거리를
     쌓지 않고 매번 지금 기준일에서 재면 후보 간격보다 작은 움직임이 늘 제자리로 돌아와 기준일이 옮겨지지 않는다. */
  function drag(id) {
    var host = byId(id), from = null, x0 = 0, wheel = null, wheelAt = 0;
    host.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || !cur) return;
      from = D.anchors[state.anchor].i; x0 = ev.clientX;
      host.setPointerCapture(ev.pointerId);
    });
    host.addEventListener("pointermove", function (ev) {
      if (from === null) return;
      snapTo(from - (ev.clientX - x0) / barWidth());
    });
    var end = function () { from = null; };
    host.addEventListener("pointerup", end);
    host.addEventListener("pointercancel", end);
    host.addEventListener("wheel", function (ev) {
      var dx = ev.deltaX || (ev.shiftKey ? ev.deltaY : 0);
      if (!dx || !cur) return;                      /* 세로 휠은 페이지를 넘긴다 */
      ev.preventDefault();
      if (wheel === null || Date.now() - wheelAt > 400) wheel = D.anchors[state.anchor].i;
      wheelAt = Date.now();
      wheel += dx / barWidth();
      snapTo(wheel);
    }, { passive: false });
  }

  var cur = null;
  function paintResult() {
    var s = ReplayCore.series(D, state.flavor, state.anchor, state.n);
    cur = s;
    var pts = function (vals) {
      return s.time.map(function (t, i) { var v = vals[i]; return v == null ? { time: t } : { time: t, value: v }; });
    };
    res.series.ndx.setData(pts(s.close));
    ["up", "down", "dd", "vix10", "vix_cap", "vix_floor"].forEach(function (k) { res.series[k].setData(pts(s.lines[k])); });
    /* 판정에 쓰지 않는 지표의 자리를 숨긴다(현황 탭 tripod.js showPanes와 같다). 단일 플레이버의 VIX 평균 창이 없으면 VIX 패널을,
       52주 낙폭 한도가 없으면 낙폭 한도선 범례를 숨긴다. */
    var one = (D.flavors[state.flavor].params || {}).one;
    byId("rChartVix").parentNode.hidden = !!one && one.vwin == null;
    res.legend.price.dd.parentNode.hidden = !!one && one.dd_limit == null;
    /* 조심선과 부활선은 결합 플레이버에서 계절이 바뀌는 날 계단으로 바뀐다. */
    res.series.vix_cap.applyOptions({ lineType: 1 });
    res.series.vix_floor.applyOptions({ lineType: 1 });
    [res.price, res.vix].forEach(function (c) { c.timeScale().setVisibleLogicalRange({ from: -0.5, to: s.time.length - 0.5 }); });
    syncWidth();
    paintAt(null);
    paintProblems(s);
    paintGrowth();
  }

  function syncWidth() {
    res.price.applyOptions({ rightPriceScale: { minimumWidth: 0 } });
    res.vix.applyOptions({ rightPriceScale: { minimumWidth: 0 } });
    requestAnimationFrame(function () {
      var w = Math.max(res.price.priceScale("right").width(), res.vix.priceScale("right").width());
      if (w) {
        res.price.applyOptions({ rightPriceScale: { minimumWidth: w } });
        res.vix.applyOptions({ rightPriceScale: { minimumWidth: w } });
      }
      requestAnimationFrame(function () { drawOverlays(); drawStrip(); });
    });
  }

  function layer(host, cls) {
    var el = host.querySelector("." + cls);
    if (!el) { el = document.createElement("div"); el.className = cls; host.appendChild(el); }
    el.textContent = "";
    return el;
  }

  /* 시장 사건(tripod/events.py). 현황 시장 상황 차트(tripod.js drawEvents)와 같은 모양이다 - 사건 구간을 옅은 띠로 칠하고 NDX 패널의
     띠 위에 말풍선 태그로 이름을 단다. 실제 구간은 그날 날짜로, 반복 구간은 그날이 옮겨 온 원천 날짜로 사건에 든 날을 고른다. 그래서
     반복 구간에는 지금 되풀이되는 과거 사건이 걸린다. */
  var EVENTS = (function () {
    var el = byId("eventsData");
    try { return el ? JSON.parse(el.textContent) : []; } catch (e) { return []; }
  })();

  /* 접합일 점선, 배분 전환 세로선, 시장 사건. 결과 차트는 라이브러리가 움직이지 않으므로 자료, 크기, 구간이 바뀔 때만 다시 그린다. */
  function drawOverlays() {
    if (!cur) return;
    var s = cur, n = s.time.length, color = {};
    Object.keys(ALLOC_VAR).forEach(function (k) { color[k] = css(ALLOC_VAR[k]); });
    /* 봉 i의 왼쪽 경계. 라이브러리의 logicalToCoordinate는 정수가 아닌 위치에 0을 돌려주므로 이웃 봉 좌표의 중간점으로 잡는다. */
    var edge = function (chart, i) {
      var ts = chart.timeScale(), at = function (k) { return ts.logicalToCoordinate(k); };
      if (n < 2) return at(0);
      if (i <= 0) return at(0) - (at(1) - at(0)) / 2;
      if (i >= n) return at(n - 1) + (at(n - 1) - at(n - 2)) / 2;
      return (at(i - 1) + at(i)) / 2;
    };
    var dayOf = function (i) { return i < s.splice ? s.time[i] : s.srcDay[i]; };
    [["rChartPrice", res.price, true], ["rChartVix", res.vix, false]].forEach(function (pane) {
      var host = byId(pane[0]), chart = pane[1], W = chart.timeScale().width();
      /* 접합일: 직전 종가의 확정 배분 색, 2px 점선 */
      var sim = layer(host, "rsim"), x0 = edge(chart, s.splice);
      if (x0 != null && x0 >= 0 && x0 <= W) {
        var b = document.createElement("b");
        b.style.left = Math.round(x0 - 1) + "px";
        b.style.borderLeftColor = color[s.allocs[s.splice - 1]] || css("--ink-soft");
        sim.appendChild(b);
      }
      var lines = layer(host, "vlines");
      for (var i = 1; i < n; i++) {
        if (s.allocs[i] === s.allocs[i - 1] || !s.allocs[i]) continue;
        var x = chart.timeScale().logicalToCoordinate(i);
        if (x == null || x < 0 || x > W) continue;
        var ln = document.createElement("i");
        ln.style.left = Math.round(x) + "px";
        ln.style.borderLeftColor = color[s.allocs[i]] || css("--ink");
        ln.title = s.time[i] + "  " + s.allocs[i - 1] + " -> " + s.allocs[i];
        lines.appendChild(ln);
      }
      var bands = layer(host, "evbands"), tags = layer(host, "evtags"), ends = [];
      EVENTS.forEach(function (ev) {
        /* 실제 구간과 반복 구간은 날짜가 이어지지 않으므로 사건에 든 날의 연속 구간마다 띠 하나를 둔다. */
        var k = 0;
        while (k < n) {
          var d = dayOf(k);
          if (!(d && d >= ev.from && d <= ev.to)) { k++; continue; }
          var j = k;
          while (j + 1 < n && (j + 1 !== s.splice) && dayOf(j + 1) && dayOf(j + 1) <= ev.to) j++;
          var a = Math.max(0, edge(chart, k)), z = Math.min(W, edge(chart, j + 1));
          if (z > a) {
            var band = document.createElement("b");
            band.style.left = a + "px";
            band.style.width = Math.max(2, z - a) + "px";
            bands.appendChild(band);
            if (pane[2]) {
              var tag = document.createElement("span");
              tag.textContent = ev.name;
              tags.appendChild(tag);
              var w = tag.offsetWidth, x = Math.min(Math.max((a + z) / 2, w / 2 + 2), W - w / 2 - 2), row = 0;
              while (ends[row] !== undefined && ends[row] > x - w / 2 - 4) row++;
              ends[row] = x + w / 2;
              tag.style.left = x + "px";
              tag.style.top = 6 + row * 24 + "px";
            }
          }
          k = j + 1;
        }
      });
    });
  }

  function paintAt(i) {
    var s = cur;
    if (!s) return;
    if (i == null || i < 0 || i >= s.time.length) i = s.time.length - 1;
    LEGEND.price.forEach(function (it) {
      var v = it[0] === "ndx" ? s.close[i] : s.lines[it[0]][i];
      res.legend.price[it[0]].textContent = v == null ? "" : ChartKit.format(v, it[3]);
    });
    LEGEND.vix.forEach(function (it) {
      var v = s.lines[it[0]][i];
      res.legend.vix[it[0]].textContent = v == null ? "" : ChartKit.format(v, it[3]);
    });
  }

  /* ---- 시간 창 띠 ----
     1990년 이후 실제 나스닥100을 로그 눈금으로 깔고, 이어붙일 원천 구간을 상자로 덮는다. 누르거나 끌면 그 자리를 가운데로 하는 구간의
     기준일을 가장 가까운 후보로 맞춘다. 모양은 현황 차트의 시간 창 띠(tripod.js drawStrips)와 같고, 가로 범위는 결과 차트의 그림
     영역에 맞춘다. */
  var strip = byId("rStrip");
  function drawStrip() {
    if (!D || !res) return;
    var first = D.anchors[0].i, n = D.day.length - first;
    var W = strip.clientWidth, H = 70, plot = res.price.timeScale().width();
    strip.geo = null;
    if (!W || !plot || n < 2) return;
    var m = { l: 0, r: Math.max(0, W - plot), t: 6, b: 20 }, lo = Infinity, hi = -Infinity;
    for (var i = 0; i < n; i++) { var v = Math.log(D.ndx[first + i]); if (v < lo) lo = v; if (v > hi) hi = v; }
    var X = function (i) { return m.l + i / (n - 1) * (W - m.l - m.r); };
    var Y = function (v) { return m.t + (1 - (Math.log(v) - lo) / (hi - lo)) * (H - m.t - m.b); };
    var step = Math.max(1, Math.floor(n / Math.max(1, W - m.l - m.r))), p = "";
    for (i = 0; i < n; i += step) p += (p ? "L" : "M") + X(i).toFixed(1) + "," + Y(D.ndx[first + i]).toFixed(1);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '"><path d="' + p + '" fill="none" stroke="' + css("--ink-soft") + '" stroke-width="1"/>';
    var year = Math.floor(D.day[first] / 10000), last = -Infinity;
    for (i = 1; i < n; i++) {
      var y = Math.floor(D.day[first + i] / 10000);
      if (y === year) continue;
      year = y;
      if (X(i) - last < 40 || X(i) < m.l + 16 || X(i) > W - m.r - 16) continue;
      s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + y + "</text>";
      last = X(i);
    }
    s += '<rect class="box" y="' + (m.t - 2) + '" height="' + (H - m.t - m.b + 4) + '" fill="' + css("--line") +
      '" fill-opacity=".18" stroke="' + css("--ink-soft") + '" stroke-width="1.5" rx="2"/></svg>';
    strip.innerHTML = s;
    strip.geo = { W: W, m: m, n: n, X: X, first: first };
    drawStripBox();
  }
  function drawStripBox() {
    var g = strip.geo, box = strip.querySelector(".box");
    if (!g || !box || state.anchor == null) return;
    var a = D.anchors[state.anchor], len = Math.min(state.n, a.len);
    var x0 = g.X(a.i - g.first), x1 = g.X(Math.min(g.n - 1, a.i + len - g.first));
    box.setAttribute("x", x0.toFixed(1));
    box.setAttribute("width", Math.max(2, x1 - x0).toFixed(1));
  }
  (function () {
    var down = false;
    var at = function (ev) {
      var g = strip.geo, rect = strip.getBoundingClientRect();
      if (!g) return null;
      var px = (ev.clientX - rect.left) * g.W / rect.width;
      return { px: px, i: g.first + (px - g.m.l) / (g.W - g.m.l - g.m.r) * (g.n - 1), g: g };
    };
    var go = function (ev) {
      var h = at(ev);
      if (h) snapTo(h.i - Math.min(state.n, D.day.length - h.i) / 2);
    };
    strip.addEventListener("pointerdown", function (ev) {
      var h = at(ev);
      if (!h || h.px > h.g.W - h.g.m.r) return;
      down = true; strip.setPointerCapture(ev.pointerId); go(ev);
    });
    strip.addEventListener("pointermove", function (ev) { if (down) go(ev); });
    var up = function () { down = false; };
    strip.addEventListener("pointerup", up);
    strip.addEventListener("pointercancel", up);
  })();

  function paintSourceMeta() {
    var a = D.anchors[state.anchor], len = Math.min(state.n, a.len), end = a.i + len;
    var kind = a.kind === "peak" ? "큰 하락 직전 고점" : "분기 첫 거래일";
    var rows = [
      ["원천 기준일", iso(D.day[a.i]) + " (" + kind + ")"],
      ["이어붙인 구간", iso(D.day[a.i + 1]) + " ~ " + iso(D.day[end]) + ", " + ChartKit.format(len, 0) + "거래일"]
    ];
    if (len < state.n) rows.push(["알림", "기준일 뒤 자료가 기간보다 짧아 자료 끝까지만 잇는다."]);
    byId("rSrcMeta").innerHTML = rows.map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("");
  }

  /* 이 기준일에서 판정하지 못했으면 그 사유를 알린다. */
  function paintProblems(s) {
    var run = s.run, probs = byId("rProblems");
    probs.hidden = !run.problems;
    probs.textContent = run.problems ? "이 기준일에서는 판정하지 못했다: " + run.problems.join("; ") : "";
  }

  /* ---- 반복 구간의 배수 ----
     나스닥 테스트 탭 진입일 탐색(comparison.js)과 같은 모양이다: 기준 버튼(원금 대비, QQQ 대비), 진입 정보, 범례 순서(GKEYS), 선을 얹는
     순서(GDRAW), 플레이버마다의 색, QQQ 흰 실선(기준이라 끌 수 없음), TQQQ 회색 점선(처음엔 꺼 둠), 1배 기준선, 0.01배 아래 자름, 범례를
     눌러 켜고 끄기, 시장 사건, 결과 표. 기간 버튼과 시간 창 띠는 없다 - 구간은 위에서 고른 반복 구간 그대로다. 시장 사건은 위 차트와 같이
     반복 구간의 날이 옮겨 온 원천 날짜로 단다. */
  var GKEYS = ["QQQ", "TQQQ", "persephone", "phrixus", "amphion", "icarus", "song", "omphalos"];      /* 범례와 표의 순서(comparison.js KEYS) */
  var GDRAW = ["phrixus", "amphion", "icarus", "song", "omphalos", "persephone", "QQQ", "TQQQ"];      /* 선을 얹는 순서(comparison.js DRAW) */
  var GHOLDS = { QQQ: 1, TQQQ: 1 }, GFIXED = { QQQ: true }, GLABEL = { QQQ: "QQQ 보유", TQQQ: "TQQQ 보유" };
  /* 범례의 켜고 끄기. 진입일 탐색과 같이 세션 동안 기억한다(save). 기준선 QQQ는 늘 켠다. */
  var gshown = state.shown || { TQQQ: false }, grow = null;
  delete gshown.QQQ;
  var gcolor = function (k) { return "--e-" + k.toLowerCase(); };
  function times(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    if (v >= 100) return v.toFixed(0) + "배";
    if (v >= 10) return v.toFixed(1) + "배";
    if (v >= 0.01) return v.toFixed(2) + "배";
    return v.toPrecision(2) + "배";
  }
  var pct = function (v) { return v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%"; };
  var won = function (v) { return (v / 1e8).toFixed(2) + "억 원"; };
  function buildGrowth() {
    var chart = LC.createChart(byId("rGrowChart"), chartOpts());
    /* 아래 여백을 없애 세로축 바닥이 하한(0.01배)과 맞게 한다(진입일 탐색과 같다). */
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    var floor = function (original) { var r = original(); if (r && r.priceRange) r.priceRange.minValue = Math.max(r.priceRange.minValue, 0.01); return r; };
    var keys = GKEYS.filter(function (k) { return k in D.flavors || GHOLDS[k]; }), series = {};
    GDRAW.filter(function (k) { return keys.indexOf(k) >= 0; }).forEach(function (k) {
      series[k] = chart.addSeries(LC.LineSeries, ChartKit.line({
        color: css(gcolor(k)), lineStyle: k === "TQQQ" ? LC.LineStyle.Dashed : LC.LineStyle.Solid, lastValueVisible: false,
        priceFormat: { type: "custom", minMove: 0.0001, formatter: times }, autoscaleInfoProvider: floor
      }));
    });
    series.QQQ.createPriceLine({ price: 1, color: css("--e-base"), lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: "" });
    var box = byId("rGrowLegend");
    var cells = ChartKit.legend(box, keys.map(function (k) {
      return { key: k, label: GLABEL[k] || D.flavors[k].name, color: gcolor(k) };
    }));
    box.classList.add("toggles");
    Array.prototype.forEach.call(box.querySelectorAll(".item"), function (row, n) {
      var k = keys[n];
      row.dataset.k = k;
      if (k === "TQQQ") {
        var dot = row.querySelector("i"), c = css(gcolor(k));
        dot.style.width = "20px";
        dot.style.background = "repeating-linear-gradient(90deg, " + c + " 0 2px, transparent 2px 4px)";
      }
      if (GFIXED[k]) { row.classList.add("fixed"); row.title = "기준선이라 끌 수 없다"; return; }
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      var flip = function () { gshown[k] = gshown[k] === false; applyShown(); save(); };
      row.addEventListener("click", flip);
      row.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
    });
    byId("rGrowBase").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { state.base = b.dataset.v; markBase(); paintGrowth(); save(); });
    });
    markBase();
    grow = { chart: chart, series: series, cells: cells, keys: keys, data: null };
    chart.subscribeCrosshairMove(function (p) { paintGrowLegend(p && p.logical != null ? Math.round(p.logical) : null); });
    /* 위 차트와 같이 크기나 구간이 바뀌어 좌표가 확정된 뒤 시장 사건을 다시 그린다. 그 전에 그리면 좌표가 비어 띠가 빠진다. */
    chart.timeScale().subscribeSizeChange(function () { requestAnimationFrame(drawGrowEvents); });
    chart.timeScale().subscribeVisibleLogicalRangeChange(function () { requestAnimationFrame(drawGrowEvents); });
    applyShown();
  }
  function markBase() {
    byId("rGrowBase").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === state.base); });
  }
  function applyShown() {
    grow.keys.forEach(function (k) {
      var on = gshown[k] !== false;
      grow.series[k].applyOptions({ visible: on });
      var row = byId("rGrowLegend").querySelector('.item[data-k="' + k + '"]');
      if (row) { row.classList.toggle("off", !on); if (!GFIXED[k]) row.setAttribute("aria-pressed", on ? "true" : "false"); }
    });
  }
  /* 기준. 원금 대비는 1억 원으로 나눈 배수, QQQ 대비는 같은 날 QQQ 보유 평가금으로 나눈 배수다. */
  function baseAt(g, i) { return state.base === "qqq" ? g.keys.QQQ.acct[i] : g.seed; }
  function paintGrowLegend(i) {
    var g = grow.data;
    if (!g) { grow.keys.forEach(function (k) { grow.cells[k].textContent = "-"; }); return; }
    if (i == null || i < 0 || i >= g.time.length) i = g.time.length - 1;
    grow.keys.forEach(function (k) { grow.cells[k].textContent = g.keys[k] ? times(g.keys[k].acct[i] / baseAt(g, i)) : "-"; });
  }
  function paintGrowth() {
    var g = ReplayCore.grow(D, state.anchor, state.n);
    grow.data = g;
    grow.keys.forEach(function (k) {
      var r = g && g.keys[k];
      grow.series[k].setData(r ? g.time.map(function (t, i) { return { time: t, value: r.acct[i] / baseAt(g, i) }; }) : []);
    });
    if (g) grow.chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: g.time.length - 0.5 });
    paintGrowLegend(null);
    paintGrowMeta(g);
    paintGrowTable(g);
    requestAnimationFrame(drawGrowEvents);
  }
  /* 진입 정보. 진입일 탐색과 같이 첫 줄은 진입 시점이고, 진입 배분은 플레이버마다 한 줄씩 이름과 배분을 열로 맞춰 내려쓴다. 진입 환율
     자리는 반복 구간 내내 쓰는 적용 환율이다. 진입 배분은 직전 종가에 들고 있는 배분, 곧 그 전날의 확정 배분이다. */
  function paintGrowMeta(g) {
    var N = D.day.length, hi = 0;
    for (var i = 0; i < N; i++) if (D.ndx[i] > hi) hi = D.ndx[i];
    var items = [
      ["진입일", iso(D.day[N - 1])],
      ["나스닥100 종가", ChartKit.format(D.ndx[N - 1], 2) + " (사상 최고가 대비 " + pct(D.ndx[N - 1] / hi - 1) + ")"],
      ["적용 환율", g ? ChartKit.format(g.fx, 1) + "원 (직전 " + ChartKit.format(g.fxDays, 0) + "거래일 평균)" : "-"]
    ];
    var alloc = GKEYS.filter(function (k) { return !GHOLDS[k] && D.flavors[k]; }).map(function (k) {
      var real = expand(D.real[k].alloc, N, D.allocs);
      return '<span class="k">' + k.charAt(0).toUpperCase() + k.slice(1) + '</span><span class="v">' + esc(real[N - 2] || "-") + "</span>";
    }).join("");
    byId("rGrowMeta").innerHTML = items.map(function (it) {
      return "<div><dt>" + it[0] + "</dt><dd>" + esc(it[1]) + "</dd></div>";
    }).join("") + '<div class="row"><dt>진입 배분</dt><dd class="alloc">' + alloc + "</dd></div>";
  }
  /* 반복 구간 끝에서의 값과 세금. 열과 그 뜻은 진입일 탐색 표(comparison.js exTable)와 같다. */
  var GROW_HEAD = "<thead><tr><th>계열</th>" +
    '<th class="num">평가금</th><th class="num">전부 팔았을 때 세후</th>' +
    '<th class="num">연 수익률</th><th class="num">최대 낙폭</th><th class="num">배분 전환</th>' +
    '<th class="num">매도로 생긴 양도세</th><th class="num">지금 팔면 더 낼 세금</th></tr></thead>';
  function paintGrowTable(g) {
    if (!g) { byId("rGrowCaption").textContent = ""; byId("rGrowTable").innerHTML = ""; return; }
    var j = g.time.length - 1, yrs = j / 252, keys = grow.keys.filter(function (k) { return g.keys[k]; });
    var due = function (r) {
      var v = r.acct[j] - r.liq[j];
      if (v > 0.5) return won(v);
      if (v < -0.5) return "-" + won(-v) + ' <span class="why">(올해 세금 감소)</span>';
      var gn = r.gain[j], why = gn < -0.5 ? "평가손실" : gn <= 0.5 ? "미실현 손익 없음" : "공제 이내";
      return won(0) + ' <span class="why">(' + why + ")</span>";
    };
    var mdd = function (a) {
      var pk = -Infinity, w = 0;
      for (var q = 0; q <= j; q++) { if (a[q] > pk) pk = a[q]; var d = a[q] / pk - 1; if (d < w) w = d; }
      return w;
    };
    var sel = keys.map(function (k) { return g.keys[k].acct[j] / g.seed; }), mx = Math.max.apply(null, sel);
    var body = keys.map(function (k, n) {
      var r = g.keys[k];
      return '<tr><td><i class="key" style="background:' + css(gcolor(k)) + '"></i>' + (GLABEL[k] || D.flavors[k].name) + "</td>" +
        '<td class="num' + (sel[n] === mx ? " best" : "") + '">' + times(sel[n]) + "</td>" +
        '<td class="num">' + times(r.liq[j] / g.seed) + "</td>" +
        '<td class="num">' + (yrs > 0.05 ? pct(Math.pow(Math.max(sel[n], 1e-9), 1 / yrs) - 1) : "-") + "</td>" +
        '<td class="num">' + pct(mdd(r.acct)) + "</td>" +
        '<td class="num">' + (GHOLDS[k] ? "-" : r.swAt[j] + "회") + "</td>" +
        '<td class="num">' + won(r.taxAt[j]) + "</td>" +
        '<td class="num">' + due(r) + "</td></tr>";
    }).join("");
    byId("rGrowCaption").textContent = g.time[0] + " 진입, " + g.time[j] + "까지 " + yrs.toFixed(1) + "년. " +
      "평가금은 그동안 낸 양도세를 뺀 금액이고, '전부 팔았을 때 세후'는 구간 끝에 모두 팔 때 낼 세금까지 뺀 금액이다.";
    byId("rGrowTable").innerHTML = "<table>" + GROW_HEAD + "<tbody>" + body + "</tbody></table>";
  }
  /* 시장 사건. 위 차트(drawOverlays)와 같은 띠와 말풍선 태그다. 배수 차트의 0번 봉은 직전 종가이고 그 뒤는 반복 구간이므로, 위 차트
     자료(cur)를 접합일 앞 봉부터 같은 순서로 읽어 그날이 옮겨 온 원천 날짜를 고른다. 0번 봉과 1번 봉은 날짜가 이어지지 않으므로 띠를
     나눈다. */
  function drawGrowEvents() {
    var g = grow && grow.data, s = cur;
    if (!g || !s) return;
    var host = byId("rGrowChart"), ts = grow.chart.timeScale(), W = ts.width(), n = g.time.length, ends = [];
    var dayOf = function (i) { var k = s.splice - 1 + i; return k < s.splice ? s.time[k] : s.srcDay[k]; };
    var at = function (k) { return ts.logicalToCoordinate(k); };
    var edge = function (i) {
      if (n < 2) return at(0);
      if (i <= 0) return at(0) - (at(1) - at(0)) / 2;
      if (i >= n) return at(n - 1) + (at(n - 1) - at(n - 2)) / 2;
      return (at(i - 1) + at(i)) / 2;
    };
    var bands = layer(host, "evbands"), tags = layer(host, "evtags");
    EVENTS.forEach(function (ev) {
      var k = 0;
      while (k < n) {
        var d = dayOf(k);
        if (!(d && d >= ev.from && d <= ev.to)) { k++; continue; }
        var e = k;
        while (e + 1 < n && e + 1 !== 1 && dayOf(e + 1) && dayOf(e + 1) <= ev.to) e++;
        var a0 = Math.max(0, edge(k)), z = Math.min(W, edge(e + 1));
        if (z > a0) {
          var band = document.createElement("b");
          band.style.left = a0 + "px";
          band.style.width = Math.max(2, z - a0) + "px";
          bands.appendChild(band);
          var tag = document.createElement("span");
          tag.textContent = ev.name;
          tags.appendChild(tag);
          var w = tag.offsetWidth, x = Math.min(Math.max((a0 + z) / 2, w / 2 + 2), W - w / 2 - 2), row = 0;
          while (ends[row] !== undefined && ends[row] > x - w / 2 - 4) row++;
          ends[row] = x + w / 2;
          tag.style.left = x + "px";
          tag.style.top = 6 + row * 24 + "px";
        }
        k = e + 1;
      }
    });
  }

  /* ---- 조작 ---- */

  function setAnchor(j) {
    state.anchor = j;
    markButtons();
    paintSourceMeta();
    paintResult();
    drawStripBox();
    save();
  }

  function markButtons() {
    byId("rSpan").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", +b.dataset.n === state.n); });
    byId("rJump").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", +b.dataset.j === state.anchor); });
  }

  function defaultAnchor() {
    var pick = null;
    D.anchors.forEach(function (a, j) { if (a.kind === "peak" && a.len >= state.n) pick = j; });
    if (pick == null) D.anchors.forEach(function (a, j) { if (a.len >= state.n) pick = j; });
    return pick == null ? D.anchors.length - 1 : pick;
  }

  function start(data) {
    D = data;
    if (!D.flavors[state.flavor]) state.flavor = Object.keys(D.flavors)[0];
    var sel = byId("rStrategy");
    if (sel.querySelector('option[value="' + state.flavor + '"]')) sel.value = state.flavor;
    else state.flavor = sel.value in D.flavors ? sel.value : state.flavor;
    sel.addEventListener("change", function () {
      if (!D.flavors[sel.value]) return;
      state.flavor = sel.value;
      try { sessionStorage.setItem(FLAVOR_KEY, state.flavor); } catch (e) { /* 지금 페이지에서는 바뀐다 */ }
      paintResult();
    });
    if (!byId("rSpan").querySelector('button[data-n="' + state.n + '"]')) state.n = 756;
    byId("rSpan").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { state.n = +b.dataset.n; setAnchor(state.anchor); });
    });
    byId("rJump").innerHTML = D.anchors.map(function (a, j) {
      return a.kind === "peak" ? '<button type="button" data-j="' + j + '">' + iso(D.day[a.i]) + "</button>" : "";
    }).join("");
    byId("rJump").querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { setAnchor(+b.dataset.j); });
    });
    var found = -1;
    if (state.anchorDay) D.anchors.forEach(function (a, j) { if (D.day[a.i] === state.anchorDay) found = j; });
    buildResult();
    buildGrowth();
    requestAnimationFrame(function () {
      setAnchor(found >= 0 ? found : defaultAnchor());
      drawStrip();
    });
    window.addEventListener("resize", function () { requestAnimationFrame(function () { drawStrip(); drawOverlays(); }); });
  }

  function fail(msg) {
    var p = byId("rProblems");
    p.hidden = false;
    p.textContent = msg;
  }

  if (root.dataset.problems) { fail(root.dataset.problems); return; }
  fetch(root.dataset.src)
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (data) { if (!data.ok) throw new Error((data.problems || []).join("; ")); start(data); })
    .catch(function (e) { fail("역사 반복 자료를 받지 못했다: " + e.message); });
})();
