/* 트라이팟 플레이버 비교 탭. 명세: _docs/_architecture/tripod-flavor-comparison.md.

   서버(또는 공개 사이트의 comparison.json)는 일별 입력만 보낸다. 평가금 경로와 분포는 여기서 계산한다.
   세금 계산은 tripod-song-backtest/after_tax_path.py의 simulate를 연산 순서까지 그대로 옮긴
   것이다. 순서를 바꾸면 백테스트 값과 비트 수준에서 어긋난다. */

(function () {
  "use strict";

  var LC = window.LightweightCharts;
  var root = document.querySelector(".comparison");
  if (!root || !LC || !window.ChartKit) return;
  var css = ChartKit.css;
  var byId = function (id) { return document.getElementById(id); };

  /* 화면의 플레이버 순서는 flavor.py의 정의 순서(phrixus, hestia, icarus, demeter, song)를 따르고 보유 둘을 뒤에 둔다.
     서버가 주는 flavors를 읽지 않는 고정 목록이라, 플레이버를 더하면(demeter 등) 여기와 색 토큰도 고친다. */
  var KEYS = ["phrixus", "hestia", "icarus", "song", "QQQ", "TQQQ"];
  var HOLDS = { QQQ: 1, TQQQ: 1 };
  var Z80 = 1.2815516;              // 표준정규분포의 90% 분위수. 중앙 80% 범위의 반폭
  var GRID = 21;                    // 분포 격자 간격(거래일, 약 1달)
  var HORIZON = 15 * 12;            // 분포를 그리는 마지막 격자(15년)
  var MIN_STARTS = 20;              // 시작점이 이보다 적은 시점은 그리지 않는다
  var FLOOR = 0.01;                 // 세로축 하한(배)
  var ALLOC = ["현금", "혼합", "TQQQ"];
  var SPANS = [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [15, "15년"], [20, "20년"]];

  var T = null;                     // 일별 입력
  var N = 0, YR = null, RET = null, TIMES = null, WEIGHTS = {}, LABEL = {};
  var state = { loading: false, loaded: false, band: "phrixus", i0: 0, i1: 0, span: 10 };

  /* ---- 세금 반영 경로 계산 ---- */

  function prepare(data) {
    T = data;
    N = T.day.length;
    YR = T.day.map(function (d) { return Math.floor(d / 10000); });
    RET = { 1: T.r1, 2: T.r2, 3: T.r3 };
    TIMES = T.day.map(function (d) {
      var s = String(d);
      return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6);
    });
    Object.keys(T.flavors).forEach(function (k) {
      var mix = {};
      Object.keys(T.mixes[k]).forEach(function (m) { mix[m] = T.mixes[k][m]; });
      WEIGHTS[k] = { 0: {}, 1: mix, 2: { 3: 1.0 } };
      LABEL[k] = T.flavors[k];
    });
    WEIGHTS.QQQ = { x: { 1: 1.0 } };
    WEIGHTS.TQQQ = { x: { 3: 1.0 } };
    LABEL.QQQ = "QQQ 보유";
    LABEL.TQQQ = "TQQQ 보유";
  }

  function wantOf(key) {
    if (HOLDS[key]) return function () { return "x"; };
    var h = T.held[key];
    return function (i) { return h[i]; };
  }

  /* i0 종가에 시드를 넣고 i1까지 돈다(금액은 원). 시드는 보유 주식, 예비금(현금), 세무 유보금으로 이루어진다.
     매도로 그해 예상 양도세가 늘면 늘어난 만큼 예비금에서 세무 유보금으로 옮기고, 같은 해 손실로 줄면
     줄어든 만큼 예비금으로 되돌린다. 예상 양도세는 그해 누적 실현 손익에 연 250만 원 공제와 22%를
     적용한 값이다. 유보금으로는 사지 못하고 이자도 붙지 않으며, 수익률과 차트에 넣지 않는다. 납부일에
     유보금이 시드를 떠나지만 차트와 수익률에 영향이 없으므로 따로 계산하지 않는다 (`@arngard` 2026-10-11).
     acct는 보유 주식과 예비금의 원화 평가액(유보금 제외), liq는 그날 보유분까지 전부 팔았을 때 더 생기는
     예상 양도세를 뺀 값, gain은 원화 미실현 손익이다. 화면의 값은 acct이고 liq는 진입일 탐색 표에만 쓴다. */
  function simulate(i0, i1, wantAt, weights) {
    var fx = T.fx, rate = T.rate;
    var pos = new Map(), basis = new Map(), cash = T.seed / fx[i0], cur = null;
    var realized = new Map(), reserveY = new Map();
    var taxReserved = 0, switches = -1;
    var acct = new Float64Array(i1 - i0 + 1), liq = new Float64Array(i1 - i0 + 1), gain = new Float64Array(i1 - i0 + 1);
    var swAt = new Int32Array(i1 - i0 + 1), taxAt = new Float64Array(i1 - i0 + 1);   // 그날까지의 누계
    for (var i = i0; i <= i1; i++) {
      var y = YR[i], m, v, gross;
      if (i > i0) {
        pos.forEach(function (val, key) { pos.set(key, val * (1 + RET[key][i])); });
        cash += cash * rate[i] * T.dt * (1 - T.int_tax);
      }
      var want = wantAt(i);
      if (want !== cur) {                                // 전량 청산, 세무 유보금 조정, 새 배분 매수
        gross = 0; pos.forEach(function (val) { gross += val; });
        pos.forEach(function (val, key) {
          realized.set(y, (realized.get(y) || 0) + val * fx[i] - basis.get(key));
        });
        var due = T.cgt * Math.max(0, (realized.get(y) || 0) - T.deduct);
        var delta = due - (reserveY.get(y) || 0);             // 음수면 같은 해 손실로 줄어든 만큼 예비금으로 되돌린다
        reserveY.set(y, due);
        taxReserved += delta;
        var total = cash + gross - delta / fx[i];
        var w = weights[want], sw = 0;
        for (m in w) sw += w[m];
        var buy = total * sw;
        total -= (gross + buy) * T.cost;
        pos = new Map(); basis = new Map();
        for (m in w) pos.set(+m, total * w[m]);
        pos.forEach(function (val, key) { basis.set(key, val * fx[i]); });
        var spent = 0; pos.forEach(function (val) { spent += val; });
        cash = total - spent;
        cur = want;
        switches++;
      }
      gross = 0; pos.forEach(function (val) { gross += val; });
      v = (cash + gross) * fx[i];
      var unreal = 0;
      pos.forEach(function (val, key) { unreal += val * fx[i] - basis.get(key); });
      var r = realized.get(y) || 0;
      var liqTax = T.cgt * Math.max(0, r + unreal - T.deduct) - T.cgt * Math.max(0, r - T.deduct);
      acct[i - i0] = v;
      liq[i - i0] = v - liqTax;
      gain[i - i0] = unreal;
      swAt[i - i0] = switches;
      taxAt[i - i0] = taxReserved;
    }
    return { acct: acct, liq: liq, gain: gain, taxReserved: taxReserved, switches: switches, swAt: swAt, taxAt: taxAt };
  }

  /* ---- 고점 진입 분포 ---- */

  function athDays() {
    var out = [], run = -Infinity;
    for (var i = 0; i < N; i++) {
      if (T.ndx[i] > run) { if (i >= T.first) out.push(i); run = T.ndx[i]; }
    }
    return out;
  }

  /* 신고가 뒤 다음 신고가 전에 20% 이상 빠진 국면의 고점. 바로 가기 버튼에 쓴다. */
  function bigPeaks() {
    var out = [], hi = -1, hiI = -1, low = 0;
    for (var i = 0; i < N; i++) {
      var v = T.ndx[i];
      if (v > hi) {
        if (hiI >= T.first && low <= hi * 0.8) out.push(hiI);
        hi = v; hiI = i; low = v;
      } else if (v < low) low = v;
    }
    if (hiI >= T.first && low <= hi * 0.8) out.push(hiI);
    return out;
  }

  function erf(x) {                                   // Abramowitz-Stegun 7.1.26. 오차 1.5e-7
    var s = x < 0 ? -1 : 1; x = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * x);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }

  function distribution() {
    var starts = athDays(), cols = HORIZON + 1;
    var logs = {};
    KEYS.forEach(function (k) { logs[k] = []; for (var j = 0; j < cols; j++) logs[k].push([]); });
    starts.forEach(function (i0) {
      var i1 = Math.min(N - 1, i0 + HORIZON * GRID);
      KEYS.forEach(function (k) {
        var r = simulate(i0, i1, wantOf(k), WEIGHTS[k]);
        for (var j = 0; j * GRID <= i1 - i0 && j < cols; j++) logs[k][j].push(Math.log(r.acct[j * GRID] / T.seed));
      });
    });
    var fit = {};
    KEYS.forEach(function (k) {
      fit[k] = { mid: [], lo: [], hi: [], loss: [], n: [] };
      logs[k].forEach(function (xs) {
        var n = xs.length;
        fit[k].n.push(n);
        if (n < MIN_STARTS) { fit[k].mid.push(null); fit[k].lo.push(null); fit[k].hi.push(null); fit[k].loss.push(null); return; }
        var mu = 0; xs.forEach(function (x) { mu += x; }); mu /= n;
        var ss = 0; xs.forEach(function (x) { ss += (x - mu) * (x - mu); });
        var sd = Math.sqrt(ss / (n - 1));
        fit[k].mid.push(Math.exp(mu));
        fit[k].lo.push(Math.exp(mu - Z80 * sd));
        fit[k].hi.push(Math.exp(mu + Z80 * sd));
        fit[k].loss.push(sd > 0 ? 0.5 * (1 + erf(-mu / (sd * Math.SQRT2))) : (mu < 0 ? 1 : 0));
      });
    });
    var years = {};
    starts.forEach(function (i) { years[YR[i]] = (years[YR[i]] || 0) + 1; });
    return { starts: starts, fit: fit, years: years };
  }

  /* ---- 표기 ---- */

  function times(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    if (v >= 100) return v.toFixed(0) + "배";
    if (v >= 10) return v.toFixed(1) + "배";
    if (v >= 0.01) return v.toFixed(2) + "배";
    return v.toPrecision(2) + "배";
  }
  var pct = function (v, d) { return v === null || v === undefined ? "-" : (v * 100).toFixed(d === undefined ? 1 : d) + "%"; };
  var color = function (k) { return "--e-" + k.toLowerCase(); };   // styles.css의 --e-* 토큰
  /* 오르내림의 뜻은 없고 계열끼리의 상대 비교가 목적이다. 플레이버마다 색을 두고(phrixus 파랑,
     icarus 빨강, hestia 녹색, song 노랑), 보유 두 계열은 회색 점선으로 물러서 둔다 (`@arngard` 2026-10-10). */
  /* QQQ는 모든 비교의 기준선이라 흰 실선으로 두고, TQQQ는 회색 점선으로 물러서 둔다
     (`@arngard` 2026-10-11). 선은 모두 1픽셀이다. 라이브러리의 점선(Dotted)은 굵기만큼 끊어
     1픽셀에서는 실선처럼 보이므로, 굵기의 두 배로 끊는 Dashed로 2픽셀 점, 2픽셀 빈칸을 낸다.
     범례 견본도 같은 무늬로 그린다(SWATCH). */
  var LINE = { TQQQ: LC.LineStyle.Dashed };
  var SWATCH = { TQQQ: [2, 2] };                    // 범례 견본의 [칠, 빈칸] 픽셀
  var FIXED = { QQQ: true };        // 끌 수 없는 계열. 모든 비교의 기준선이다 (`@arngard` 2026-10-10)
  var shown = {};                   // 계열별 표시 여부. 두 차트가 함께 따른다
  var FMT = { type: "custom", minMove: 0.0001, formatter: times };

  function floorScale(original) {
    var r = original();
    if (r && r.priceRange) r.priceRange.minValue = Math.max(r.priceRange.minValue, FLOOR);
    return r;
  }

  function addLine(chart, key, extra) {
    var opts = ChartKit.line({
      color: css(color(key)), lineWidth: 1, lineStyle: LINE[key] || LC.LineStyle.Solid,
      priceFormat: FMT, autoscaleInfoProvider: floorScale, lastValueVisible: false
    });
    Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
    return chart.addSeries(LC.LineSeries, opts);
  }

  /* 원금(1배) 기준선. 끌 수 없는 QQQ 계열에 붙여 늘 보이게 하고, 축에 값 라벨을 달아 1배 눈금이
     어떤 구간에서도 남게 한다 (`@arngard` 2026-10-11). */
  function baseLine(series) {
    series.createPriceLine({ price: 1, color: css("--e-base"), lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
                             axisLabelVisible: true, title: "" });
  }

  /* 범례 견본을 차트 선의 무늬와 맞춘다. 80% 범위 견본은 칠한 상자다. */
  function swatches(box) {
    Array.prototype.forEach.call(box.querySelectorAll(".item"), function (row, n) {
      var key = KEYS[n], dot = row.querySelector("i");
      if (!dot) return;
      if (!key) { dot.classList.add("fill"); return; }
      var dash = SWATCH[key];
      if (!dash) return;
      var c = css(color(key));
      dot.style.width = "20px";
      dot.style.background = "repeating-linear-gradient(90deg, " + c + " 0 " + dash[0] + "px, transparent " +
        dash[0] + "px " + (dash[0] + dash[1]) + "px)";
    });
  }

  function alpha(hex, a) {
    var v = hex.replace("#", "");
    if (v.length === 3) v = v.replace(/(.)/g, "$1$1");
    return "rgba(" + parseInt(v.slice(0, 2), 16) + ", " + parseInt(v.slice(2, 4), 16) + ", " +
      parseInt(v.slice(4, 6), 16) + ", " + a + ")";
  }

  /* 80% 범위를 칠하는 그리기 층. 라이브러리에 띠 계열이 없어, 그릴 때마다 위아래 경계를 화면
     좌표로 바꿔 그 사이를 칠한다. 선들 아래에 깔린다(zOrder bottom). 경계 자체는 투명한 선 두
     개(bandSeries)로 두어 세로축 범위 계산에 들어가게 한다. */
  function BandFill() {
    var self = this;
    this.lo = []; this.hi = []; this.fill = ""; this.on = true;
    this._chart = null; this._series = null; this._request = null;
    this._view = {
      zOrder: function () { return "bottom"; },
      renderer: function () { return { draw: function (target) { self.draw(target); } }; }
    };
  }
  BandFill.prototype.attached = function (p) { this._chart = p.chart; this._series = p.series; this._request = p.requestUpdate; };
  BandFill.prototype.detached = function () { this._chart = null; this._series = null; this._request = null; };
  BandFill.prototype.updateAllViews = function () {};
  BandFill.prototype.paneViews = function () { return [this._view]; };
  BandFill.prototype.set = function (lo, hi, fill, on) {
    this.lo = lo; this.hi = hi; this.fill = fill; this.on = on;
    if (this._request) this._request();
  };
  BandFill.prototype.draw = function (target) {
    if (!this.on || !this._chart || !this._series) return;
    var ts = this._chart.timeScale(), s = this._series, top = [], bottom = [];
    for (var j = 0; j < this.lo.length; j++) {
      if (this.lo[j] === null || this.hi[j] === null) continue;
      var x = ts.timeToCoordinate(monthTime(j));
      var yh = s.priceToCoordinate(this.hi[j]), yl = s.priceToCoordinate(this.lo[j]);
      if (x === null || yh === null || yl === null) continue;
      top.push([x, yh]); bottom.push([x, yl]);
    }
    if (top.length < 2) return;
    var fill = this.fill;
    target.useBitmapCoordinateSpace(function (scope) {
      var ctx = scope.context, hr = scope.horizontalPixelRatio, vr = scope.verticalPixelRatio;
      ctx.beginPath();
      top.forEach(function (p, n) { if (n) ctx.lineTo(p[0] * hr, p[1] * vr); else ctx.moveTo(p[0] * hr, p[1] * vr); });
      for (var k = bottom.length - 1; k >= 0; k--) ctx.lineTo(bottom[k][0] * hr, bottom[k][1] * vr);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    });
  };

  /* ---- 분포 구획 ---- */

  var dist = null, distChart = null, distSeries = {}, bandSeries = null, distCells = null, bandFill = null;
  /* 경과 개월 j를 시간축에 얹는 가짜 시각. 2000년 1월부터 j번째 달의 1일에 둔다. 라이브러리는 날짜
     축만 다루고 눈금을 달력 경계(해, 달)에 세우므로, 경과 1년을 달력 1년에 맞춰야 눈금이 정수
     연도에 등간격으로 선다. 한 달을 하루로 얹었을 때는 가짜 날짜의 월 초(31, 60, 91개월)에 눈금이
     서서 2.6년, 7.6년처럼 어긋났다 (2026-10-11 관측). */
  var monthTime = function (j) { return Date.UTC(2000 + Math.floor(j / 12), j % 12, 1) / 1000; };
  var monthOf = function (t) { var d = new Date(t * 1000); return (d.getUTCFullYear() - 2000) * 12 + d.getUTCMonth(); };
  var yearsLabel = function (j) { return j % 12 === 0 ? (j / 12) + "년" : (j / 12).toFixed(1) + "년"; };

  function drawDistribution() {
    var box = byId("eDistChart");
    var opts = ChartKit.options();
    opts.localization = { locale: "ko-KR", timeFormatter: function (t) { return yearsLabel(monthOf(t)) + " 뒤"; } };
    opts.timeScale.tickMarkFormatter = function (t) { return yearsLabel(monthOf(t)); };
    /* 정해진 구간(0 ~ 15년) 전체를 한눈에 보는 그림이라 확대도 이동도 두지 않는다. 크로스헤어로 값을
       읽는 것만 남긴다. 세로 휠은 페이지를 넘긴다 (`@arngard` 2026-10-11, 공유 차트 규율의 예외). */
    opts.handleScroll = false;
    opts.handleScale = false;
    distChart = LC.createChart(box, opts);
    KEYS.forEach(function (k) { distSeries[k] = addLine(distChart, k); });
    baseLine(distSeries.QQQ);
    var clear = { color: "rgba(0, 0, 0, 0)", lineWidth: 1, lineStyle: LC.LineStyle.Solid };
    bandSeries = { lo: addLine(distChart, state.band, clear), hi: addLine(distChart, state.band, clear) };
    bandFill = new BandFill();
    bandSeries.hi.attachPrimitive(bandFill);
    KEYS.forEach(function (k) { distSeries[k].setData(points(dist.fit[k].mid)); });
    distCells = ChartKit.legend(byId("eDistLegend"), KEYS.map(function (k) {
      return { key: k, label: LABEL[k], color: color(k) };
    }).concat([{ key: "band", label: "80% 범위", color: "--ink-soft" }]));
    toggles(byId("eDistLegend"));
    swatches(byId("eDistLegend"));
    distChart.subscribeCrosshairMove(function (p) { paintDistLegend(p && p.time ? monthOf(p.time) : null); });
    setBand(state.band);
    distChart.timeScale().fitContent();
  }

  function points(arr) {
    var out = [];
    arr.forEach(function (v, j) {
      out.push(v === null ? { time: monthTime(j) } : { time: monthTime(j), value: v });
    });
    return out;
  }

  function lastIndex(arr) {
    for (var j = arr.length - 1; j >= 0; j--) if (arr[j] !== null) return j;
    return 0;
  }

  function paintDistLegend(j) {
    if (j === null) j = lastIndex(dist.fit.QQQ.mid);
    KEYS.forEach(function (k) { distCells[k].textContent = times(dist.fit[k].mid[j]); });
    var f = dist.fit[state.band];
    distCells.band.textContent = f.lo[j] === null ? "-" : state.band + " " + times(f.lo[j]) + " ~ " + times(f.hi[j]) +
      " · 시작점 " + f.n[j] + "일";
  }

  /* 범례 항목을 누르면 그 계열을 켜고 끈다. 두 차트의 범례가 같은 상태를 나눠 쓴다. 꺼진 계열은
     세로축 범위 계산에서도 빠지므로, 크게 벗어난 계열을 끄면 나머지가 넓게 펴진다. */
  function toggles(box) {
    box.classList.add("toggles");
    Array.prototype.forEach.call(box.querySelectorAll(".item"), function (row, n) {
      var key = KEYS[n];
      if (!key) return;                               // 80% 범위 항목은 조작 대상이 아니다
      row.dataset.k = key;
      if (FIXED[key]) { row.classList.add("fixed"); row.title = "기준선이라 끌 수 없다"; return; }
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      var flip = function () { shown[key] = shown[key] === false; applyShown(); };
      row.addEventListener("click", flip);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
      });
    });
  }

  function applyShown() {
    KEYS.forEach(function (k) {
      var on = shown[k] !== false;
      if (distSeries[k]) distSeries[k].applyOptions({ visible: on });
      if (exSeries[k]) exSeries[k].applyOptions({ visible: on });
      document.querySelectorAll(".comparison .legend .item[data-k=\"" + k + "\"]").forEach(function (row) {
        row.classList.toggle("off", !on);
        if (!FIXED[k]) row.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
    if (bandSeries) {
      var bandOn = shown[state.band] !== false;
      bandSeries.lo.applyOptions({ visible: bandOn });
      bandSeries.hi.applyOptions({ visible: bandOn });
      var f = dist.fit[state.band];
      bandFill.set(f.lo, f.hi, alpha(css(color(state.band)), 0.2), bandOn);
      var sw = byId("eDistLegend").querySelector("i.fill");
      if (sw) sw.style.background = alpha(css(color(state.band)), bandOn ? 0.45 : 0.15);
    }
  }

  function setBand(key) {
    state.band = key;
    bandSeries.lo.setData(points(dist.fit[key].lo));
    bandSeries.hi.setData(points(dist.fit[key].hi));
    byId("eBand").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.k === key); });
    applyShown();
    paintDistLegend(null);
  }

  function distTable() {
    var rows = [1, 3, 5, 10, 15], f = dist.fit;
    var head = "<thead><tr><th>경과</th><th class=\"num\">시작점</th>" + KEYS.map(function (k) {
      return "<th class=\"num\">" + LABEL[k] + "</th>";
    }).join("") + "</tr></thead>";
    var body = rows.map(function (y) {
      var j = y * 12;
      if (f.QQQ.mid[j] === null || f.QQQ.mid[j] === undefined) return "";
      var mx = Math.max.apply(null, KEYS.map(function (k) { return f[k].mid[j]; }));
      return "<tr><td>" + y + "년</td><td class=\"num\">" + f.QQQ.n[j] + "일</td>" + KEYS.map(function (k) {
        return "<td class=\"num" + (f[k].mid[j] === mx ? " best" : "") + "\">" + times(f[k].mid[j]) +
          "<div class=\"sub\">" + times(f[k].lo[j]) + " ~ " + times(f[k].hi[j]) + "</div>" +
          "<div class=\"sub\">손실 " + pct(f[k].loss[j], 0) + "</div></td>";
      }).join("") + "</tr>";
    }).join("");
    byId("eDistTable").innerHTML = "<table>" + head + "<tbody>" + body + "</tbody></table>";
  }

  function distNotes() {
    var s = dist.starts, ten = 120 * GRID, early = 0, late = 0, cut = N - 1 - ten;
    s.forEach(function (i) { if (i <= cut) { if (YR[i] <= 2000) early++; else late++; } });
    var phrixusTqqq = s.filter(function (i) { return T.held.phrixus[i] === 2; }).length;
    byId("eDistIntro").textContent =
      TIMES[s[0]] + "부터 " + TIMES[s[s.length - 1]] + "까지 나스닥100이 종가 기준 사상 최고가로 마감한 날은 " +
      s.length + "일이다. 이 날들을 모두 시작점으로 삼았다. 경과 시점마다 시작점별 결과 배수의 로그값이 " +
      "정규분포를 따른다고 보고, 선은 그 분포의 중심값을, 칠한 띠는 고른 계열의 결과 80%가 들어가는 범위를 그린다. " +
      "시작일에 phrixus는 " + s.length + "일 중 " + phrixusTqqq + "일 TQQQ를 들고 있었다. 고점에서 레버리지로 " +
      "진입하는 불리한 경우가 그대로 반영되었다.";
    byId("eDistCaveat").textContent =
      "기간이 길어질수록 계산에 쓰이는 시작점이 옛날 것으로 좁혀진다. 10년 뒤 결과가 있으려면 시작일이 " +
      TIMES[cut] + " 이전이어야 하는데, 그 조건을 만족하는 사상 최고가 마감일은 2000년 이전 " + early +
      "일과 그 뒤 " + late + "일이다. 그래서 10년 이상 지점의 값은 대부분 닷컴 버블 정점 부근에 사서 " +
      "2000 ~ 2002년 폭락을 겪은 경우다. 80% 범위는 이 표본의 퍼짐을 요약한 값이지 앞으로의 확률이 아니다. " +
      "시작점이 특정 해에 몰려 있어 서로 독립된 시행이 아니고, TQQQ 보유처럼 크게 불어나거나 거의 사라지는 " +
      "두 갈래로 갈리는 계열은 정규분포와 잘 맞지 않는다.";
  }

  /* ---- 진입일 탐색 구획 ---- */

  var exChart = null, exSeries = {}, exCells = null, exLast = null, applying = false, raf = 0;
  /* 첫 구간을 정하기 전의 구간 변화는 무시한다. 자료를 처음 넣으면 라이브러리가 맨 끝 몇 달을
     기본 구간으로 잡는데, 그것을 진입일 변경으로 받으면 한 프레임 동안 엉뚱한 진입일이 그려진다. */
  var ready = false;

  function clampEntry(i) { return Math.max(T.first, Math.min(N - 22, Math.round(i))); }

  function drawExplorer() {
    var opts = ChartKit.options();
    /* 20년(약 5,000거래일)이 좁은 폭에도 들어가게 봉 간격의 하한을 낮춘다. 기본(0.5픽셀)이면
       폭 900픽셀에 7년 남짓만 들어가, 10년을 요청해도 라이브러리가 왼쪽을 잘라 진입일이 밀린다. */
    opts.timeScale.minBarSpacing = 0.01;
    /* 이 차트는 확대를 두지 않는다. 확대가 왼쪽 끝, 곧 진입일까지 움직여 조작의 뜻이 흐려지기
       때문이다. 가로 스크롤(트랙패드 좌우 쓸기, Shift+휠)과 끌기는 이동이고, 세로 휠은 페이지로
       돌려준다. 보는 기간은 기간 버튼이 정한다 (`@arngard` 2026-10-11, 공유 차트 규율의 예외). */
    opts.handleScroll = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
    opts.handleScale = { mouseWheel: false, pinch: false,
                         axisPressedMouseMove: { time: false, price: true }, axisDoubleClickReset: { time: false, price: true } };
    exChart = LC.createChart(byId("eExChart"), opts);
    /* 아래 여백을 없애 세로축 바닥이 하한(0.01배)과 맞게 한다. 여백이 있으면 그 밑까지 눈금이 선다. */
    exChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    KEYS.forEach(function (k) { exSeries[k] = addLine(exChart, k); });
    baseLine(exSeries.QQQ);
    exCells = ChartKit.legend(byId("eExLegend"), KEYS.map(function (k) {
      return { key: k, label: LABEL[k], color: color(k) };
    }));
    toggles(byId("eExLegend"));
    swatches(byId("eExLegend"));
    applyShown();
    exChart.subscribeCrosshairMove(function (p) {
      paintExLegend(p && p.logical !== undefined && p.time ? Math.round(p.logical) : null);
    });
    /* 보이는 구간의 왼쪽 끝이 진입일이다. 끌거나 스크롤해 구간이 바뀌면 그 자리에서 다시 계산한다. */
    exChart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
      /* 탭이 숨으면 상자 폭이 0이 되며 구간이 흔들린다. 그 동안의 변화는 진입일 변경이 아니다. */
      if (!range || applying || !ready || !byId("eExChart").clientWidth) return;
      if (!raf) raf = requestAnimationFrame(function () { raf = 0; follow(exChart.timeScale().getVisibleLogicalRange()); });
    });
    /* 처음 구간은 상자 배치가 끝난 뒤에 정한다. 크기가 잡히기 전에 정하면 크기가 잡히면서
       왼쪽이 잘려 진입일이 엉뚱하게 바뀐다 (2026-10-10 관측). */
    var start = TIMES.indexOf("2000-03-27");
    state.i0 = start >= 0 ? start : T.first;
    /* 시간축에 날짜가 있어야 구간을 정할 수 있으므로 자료를 먼저 넣는다. */
    compute(state.i0, Math.min(N - 1, state.i0 + Math.round(state.span * 252)));
    restore();
  }

  /* 지금 진입일과 보던 기간으로 구간을 다시 잡는다. 처음 그릴 때와 탭으로 돌아올 때 쓴다. */
  var restoring = 0;
  function restore() {
    /* 요청이 겹치면 하나로 합치고, 실행 시점의 진입일을 쓴다. 창이 숨어 있으면 그리기 콜백이
       밀렸다가 한꺼번에 돌기 때문이다. */
    if (restoring) cancelAnimationFrame(restoring);
    restoring = requestAnimationFrame(function () {
      restoring = requestAnimationFrame(function () { restoring = 0; jump(state.i0, state.span); });
    });
  }

  function follow(range) {
    if (!range) return;
    var i0 = clampEntry(range.from), i1 = Math.min(N - 1, Math.max(i0 + 1, Math.ceil(range.to)));
    state.span = Math.max(0.1, (range.to - range.from) / 252);    // 휠로 바꾼 기간을 기억한다
    markSpan();
    if (i0 === state.i0 && exLast) {
      /* 진입일이 그대로면 경로도 그대로다. 오른쪽 끝(표의 기준)만 옮긴다. */
      if (i1 !== state.i1) { state.i1 = i1; paintExLegend(null); exTable(); drawStripBox(); }
      return;
    }
    compute(i0, i1);
  }

  function jump(i0, years) {
    var from = clampEntry(i0);
    applying = true;
    exChart.timeScale().setVisibleLogicalRange({ from: from, to: from + Math.round(years * 252) });
    applying = false;
    ready = true;
    /* 요청한 구간으로 바로 계산한다. 구간은 라이브러리가 다음 그리기에서 적용하므로 지금 읽으면
       이전 값이 나온다. 라이브러리가 구간을 조정하면 이어지는 구간 변화 신호가 그 값으로 다시 맞춘다. */
    state.i0 = -1;
    follow({ from: from, to: from + Math.round(years * 252) });
  }

  /* 진입일부터 자료 끝까지 계산하고, 모든 계열이 전 구간 길이를 유지한다(진입 전은 빈 점).
     길이가 그대로여야 자료를 바꿔 넣어도 보던 구간이 흔들리지 않는다. 값은 자료 끝까지 채운다 -
     라이브러리가 값이 있는 마지막 날 너머로는 구간을 넓히지 않아, 보이는 끝까지만 채우면 기간을
     늘릴 수 없게 된다 (2026-10-10 관측). i1은 표와 범례가 기준으로 삼는 보이는 구간의 끝이다. */
  function compute(i0, i1) {
    state.i0 = i0; state.i1 = i1;
    var res = {};
    KEYS.forEach(function (k) { res[k] = simulate(i0, N - 1, wantOf(k), WEIGHTS[k]); });
    exLast = res;
    applying = true;
    KEYS.forEach(function (k) {
      var arr = res[k].acct, data = new Array(N);
      for (var i = 0; i < N; i++) {
        data[i] = i < i0 ? { time: TIMES[i] } : { time: TIMES[i], value: arr[i - i0] / T.seed };
      }
      exSeries[k].setData(data);
    });
    applying = false;
    paintExLegend(null);
    exMeta();
    exTable();
    drawStripBox();
  }

  function paintExLegend(i) {
    if (!exLast) return;
    if (i === null || i < state.i0 || i > state.i1) i = state.i1;
    KEYS.forEach(function (k) { exCells[k].textContent = times(exLast[k].acct[i - state.i0] / T.seed); });
  }

  /* ---- 시간 창 ----
     1990년 이후 나스닥100 전체를 로그 눈금으로 깔고, 지금 보는 구간을 상자로 덮는다. 띠를 누르거나
     끌면 그 자리를 가운데로 하는 구간으로 옮기고, 아래 막대는 진입일을 직접 고른다. */
  var stripGeo = null;

  function drawStrip() {
    var el = byId("eStrip");
    if (!el.clientWidth) return;
    var W = el.clientWidth, H = 70, m = { l: 8, r: 8, t: 6, b: 20 };
    var lo = Infinity, hi = -Infinity;
    for (var i = T.first; i < N; i++) { var v = Math.log10(T.ndx[i]); if (v < lo) lo = v; if (v > hi) hi = v; }
    var X = function (i) { return m.l + (i - T.first) / (N - 1 - T.first) * (W - m.l - m.r); };
    var Y = function (v) { return m.t + (1 - (Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b); };
    var p = "";
    for (i = T.first; i < N; i += 3) p += (p ? "L" : "M") + X(i).toFixed(1) + "," + Y(T.ndx[i]).toFixed(1);
    var s = "<svg viewBox=\"0 0 " + W + " " + H + "\"><path d=\"" + p + "\" fill=\"none\" stroke=\"" + css("--ink-soft") +
      "\" stroke-width=\"1\"/>";
    for (var y = 1995; y <= 2025; y += 5) {
      var k = TIMES.findIndex(function (t) { return t >= y + "-01-01"; });
      if (k >= 0) s += "<text x=\"" + X(k) + "\" y=\"" + (H - 4) + "\" text-anchor=\"middle\">" + y + "</text>";
    }
    bigPeaks().forEach(function (k) {
      s += "<line x1=\"" + X(k) + "\" x2=\"" + X(k) + "\" y1=\"" + m.t + "\" y2=\"" + (H - m.b) + "\" stroke=\"" +
        css("--rule") + "\" stroke-dasharray=\"2 2\"/>";
    });
    s += "<rect id=\"eStripBox\" y=\"" + (m.t - 2) + "\" height=\"" + (H - m.t - m.b + 4) + "\" fill=\"" + css("--line") +
      "\" fill-opacity=\".18\" stroke=\"" + css("--ink-soft") + "\" stroke-width=\"1.5\" rx=\"2\"/></svg>";
    el.innerHTML = s;
    stripGeo = { W: W, m: m, X: X };
    drawStripBox();
  }

  function drawStripBox() {
    var box = byId("eStripBox");
    if (!box || !stripGeo) return;
    var x0 = stripGeo.X(state.i0), x1 = stripGeo.X(Math.min(N - 1, state.i0 + Math.round(state.span * 252)));
    box.setAttribute("x", x0);
    box.setAttribute("width", Math.max(2, x1 - x0));
    var range = byId("eEntry");
    range.min = T.first; range.max = N - 22; range.value = state.i0;
  }

  function wireStrip() {
    var el = byId("eStrip"), down = false;
    var at = function (ev) {
      var r = el.getBoundingClientRect(), g = stripGeo, px = (ev.clientX - r.left) * g.W / r.width;
      return T.first + (px - g.m.l) / (g.W - g.m.l - g.m.r) * (N - 1 - T.first);
    };
    var go = function (ev) { if (stripGeo) jump(at(ev) - state.span * 252 / 2, state.span); };
    el.addEventListener("pointerdown", function (ev) { down = true; el.setPointerCapture(ev.pointerId); go(ev); });
    el.addEventListener("pointermove", function (ev) { if (down) go(ev); });
    el.addEventListener("pointerup", function () { down = false; });
    el.addEventListener("pointercancel", function () { down = false; });
    byId("eEntry").addEventListener("input", function () { jump(+byId("eEntry").value, state.span); });
    window.addEventListener("resize", function () { if (state.loaded) drawStrip(); });
  }

  function exMeta() {
    var i0 = state.i0, hi = 0;
    for (var i = 0; i <= i0; i++) if (T.ndx[i] > hi) hi = T.ndx[i];
    var items = [
      ["진입일", TIMES[i0]],
      ["나스닥100 종가", ChartKit.format(T.ndx[i0], 2) + " (사상 최고가 대비 " + pct(T.ndx[i0] / hi - 1) + ")"],
      ["진입 환율", ChartKit.format(T.fx[i0], 1) + "원"]
    ].concat(KEYS.filter(function (k) { return !HOLDS[k]; }).map(function (k) { return [k + " 진입 배분", ALLOC[T.held[k][i0]]]; }));
    byId("eExMeta").innerHTML = items.map(function (it) {
      return "<div><dt>" + it[0] + "</dt><dd>" + it[1] + "</dd></div>";
    }).join("");
  }

  /* 보이는 구간 끝에서의 값과 세금. 연 수익률과 가장 큰 칸 표시는 평가금을 따른다. 세금은 매도 때
     유보한 것과 지금 전부 팔면 더 생길 것(평가금과 세후 금액의 차이)으로 가른다. 보유 두 계열은 팔기
     전까지 유보금이 0이고 세금이 모두 뒤쪽에 쌓인다. 평가금은 이 미실현분을 빼지 않으므로 세금을
     미루는 보유 계열에 유리하게 기운다. 그 크기를 이 열과 세후 열로 보인다 (`@arngard` 2026-10-11). */
  function exTable() {
    var i0 = state.i0, i1 = state.i1, yrs = (i1 - i0) / 252, j = i1 - i0;
    var won = function (v) { return (v / 1e8).toFixed(2) + "억 원"; };
    /* 지금 팔면 더 낼 세금이 0이면 이유를 붙인다. 원화 기준 미실현 손익이 손실이면 평가손실, 없으면(현금만
       들었거나 막 산 경우) 미실현 손익 없음, 이익이 남은 연 공제 이하면 공제 이내다. 고점 진입에서는
       보유 계열이 구간 끝에 원금 아래인 경우가 많아, 이유가 없으면 계산 누락처럼 보인다 (`@arngard` 2026-10-11). 올해 실현 이익이 있는데 평가손실이면
       지금 팔면 올해 유보금 일부가 예비금으로 돌아오므로 음수가 된다. */
    var due = function (r) {
      var v = r.acct[j] - r.liq[j];
      if (v > 0.5) return won(v);
      if (v < -0.5) return "-" + won(-v) + " <span class=\"why\">(올해 유보금 감소)</span>";
      var g = r.gain[j], why = g < -0.5 ? "평가손실" : g <= 0.5 ? "미실현 손익 없음" : "공제 이내";
      return "0원 <span class=\"why\">(" + why + ")</span>";
    };
    var sel = KEYS.map(function (k) { return exLast[k].acct[j] / T.seed; });
    var mx = Math.max.apply(null, sel);
    var mdd = function (a) {
      var pk = -Infinity, w = 0;
      for (var q = 0; q < a.length; q++) { if (a[q] > pk) pk = a[q]; var d = a[q] / pk - 1; if (d < w) w = d; }
      return w;
    };
    var head = "<thead><tr><th>계열</th>" +
      "<th class=\"num\">평가금</th><th class=\"num\">전부 팔았을 때 세후</th>" +
      "<th class=\"num\">연 수익률</th><th class=\"num\">최대 낙폭</th><th class=\"num\">배분 전환</th>" +
      "<th class=\"num\">양도세(유보 포함)</th><th class=\"num\">지금 팔면 더 낼 세금</th></tr></thead>";
    var body = KEYS.map(function (k, n) {
      var r = exLast[k], hold = !!HOLDS[k];
      return "<tr><td><i class=\"key\" style=\"background:" + css(color(k)) + "\"></i>" + LABEL[k] + "</td>" +
        "<td class=\"num" + (sel[n] === mx ? " best" : "") + "\">" + times(sel[n]) + "</td>" +
        "<td class=\"num\">" + times(r.liq[j] / T.seed) + "</td>" +
        "<td class=\"num\">" + (yrs > 0.05 ? pct(Math.pow(Math.max(sel[n], 1e-9), 1 / yrs) - 1) : "-") + "</td>" +
        "<td class=\"num\">" + pct(mdd(r.acct.subarray(0, j + 1))) + "</td>" +
        "<td class=\"num\">" + (hold ? "-" : r.swAt[j] + "회") + "</td>" +
        "<td class=\"num\">" + won(r.taxAt[j]) + "</td>" +
        "<td class=\"num\">" + due(r) + "</td></tr>";
    }).join("");
    byId("eExCaption").textContent = TIMES[i0] + " 진입, " + TIMES[i1] + "까지 " + yrs.toFixed(1) + "년. " +
      "매도로 생긴 양도세는 세무 유보금으로 떼어 평가금에서 뺀다. 연 수익률과 밝은 칸은 평가금을 따른다.";
    byId("eExTable").innerHTML = "<table>" + head + "<tbody>" + body + "</tbody></table>";
  }

  function buttons() {
    byId("eBand").innerHTML = KEYS.map(function (k) {
      return "<button type=\"button\" data-k=\"" + k + "\">" + k + "</button>";
    }).join("");
    byId("eBand").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (b) setBand(b.dataset.k);
    });
    byId("eSpan").innerHTML = SPANS.map(function (s) {
      return "<button type=\"button\" data-n=\"" + s[0] + "\">" + s[1] + "</button>";
    }).join("");
    byId("eSpan").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      state.span = +b.dataset.n;
      markSpan();
      jump(state.i0, state.span);
    });
    byId("eJump").innerHTML = bigPeaks().map(function (i) {
      return "<button type=\"button\" data-i=\"" + i + "\">" + TIMES[i] + "</button>";
    }).join("");
    byId("eJump").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (b) jump(+b.dataset.i, state.span);
    });
    markSpan();
  }

  function markSpan() {
    /* 휠로 바꾼 기간은 버튼과 맞지 않을 수 있다. 그때는 어느 버튼도 켜지 않는다. */
    byId("eSpan").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", Math.abs(+b.dataset.n - state.span) < 0.02); });
  }

  /* ---- 불러오기 ---- */

  function fail(problems) {
    var box = byId("eProblems");
    box.hidden = false;
    box.innerHTML = "<h2>계산하지 못했다</h2>" + problems.map(function (p) {
      return "<p class=\"note err\">" + p.replace(/</g, "&lt;") + "</p>";
    }).join("");
    byId("eStatus").textContent = "";
  }

  function load() {
    if (state.loading || state.loaded) return;
    state.loading = true;
    byId("eStatus").textContent = "자료를 받는 중이다.";
    var src = document.body.dataset.staticComparison;
    fetch(src ? src + "?t=" + Date.now() : "/api/comparison")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { fail(data.problems || ["자료를 받지 못했다."]); return; }
        prepare(data);
        byId("eStamp").innerHTML =
          "<span class=\"seg\">자료 <span class=\"v\">" + TIMES[0] + " ~ " + TIMES[N - 1] + "</span></span>" +
          (data.generated_at ? "<span class=\"seg\">생성 <span class=\"v\">" + data.generated_at + "</span></span>" : "");
        byId("eStatus").textContent = "사상 최고가 마감일마다 여섯 계열을 계산하는 중이다.";
        /* 안내가 먼저 그려지도록 한 박자 쉬고 계산한다. 1초 안팎 걸린다. */
        setTimeout(function () {
          dist = distribution();
          byId("eStatus").textContent = "";
          byId("eBody").hidden = false;
          buttons();
          distNotes();
          drawDistribution();
          distTable();
          drawExplorer();
          wireStrip();
          drawStrip();
          if (data.notes && data.notes.length) byId("eNotes").textContent = data.notes.join(" ");
          state.loaded = true;
        }, 30);
      })
      .catch(function (error) { fail(["자료를 받지 못했다. " + error]); })
      .then(function () { state.loading = false; });
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      if (tab.dataset.view !== "comparison") return;
      if (state.loaded) { restore(); requestAnimationFrame(drawStrip); } else load();
    });
  });
  var on = document.querySelector(".tab.on");
  if (on && on.dataset.view === "comparison") load();

  /* 검산용. 백테스트가 같은 입력으로 낸 값과 견줄 때 쓴다 (tripod-flavor-comparison/assumptions.md). */
  window.FlavorComparison = { simulate: function (i0, key) { return simulate(i0, N - 1, wantOf(key), WEIGHTS[key]); },
                        data: function () { return T; } };
})();
