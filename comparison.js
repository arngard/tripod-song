/* 트라이팟 플레이버 비교의 탭 셋(나스닥 테스트, 닛케이 테스트, 분석). 명세: epistemic-structure/architecture/tripod-flavor-comparison.md.

   테스트 탭의 자료(comparison.json, comparison-nikkei.json)는 일별 입력과, 사이트를 만들 때 미리 계산한 '기간에 따른 추이' 분포(dist)를 담는다.
   화면은 분포를 그리기만 하고, 조작마다 결과가 달라지는 진입일 탐색만 여기서 계산한다. 그 세금 계산은
   tripod-song-backtest/backtest/simulate.py의 simulate를 연산 순서까지 그대로 옮긴 것이다. 순서를 바꾸면
   백테스트 값과 비트 수준에서 어긋난다. */

(function () {
  "use strict";

  var LC = window.LightweightCharts;
  var root = document.querySelector(".comparison");
  if (!root || !LC || !window.ChartKit) return;
  var css = ChartKit.css;

  /* 범례, 90% 범위 버튼, 표의 순서. 기준인 QQQ와 TQQQ 보유를 앞에 두고 플레이버는 flavor.py의 정의 순서를 따른다
     (`@arngard` 2026-10-13). 서버가 주는 flavors를 읽지 않는 고정 목록이라, 플레이버를
     더하면(demeter 등) 여기, DRAW, 색 토큰을 함께 고친다. */
  var KEYS = ["QQQ", "TQQQ", "persephone", "phrixus", "amphion", "icarus", "song"];
  /* 차트에 선을 얹는 순서. 뒤에 얹은 선이 위에 그려진다. 기준선인 QQQ가 플레이버 선에 가리지 않게 보유 둘을 뒤에 둔다. */
  var DRAW = ["phrixus", "amphion", "icarus", "song", "persephone", "QQQ", "TQQQ"];
  var HOLDS = { QQQ: 1, TQQQ: 1 };
  var FLOOR = 0.01;                 // 세로축 하한(배)
  var ALLOC = ["현금 100%", "QQQ 50% + QLD 50%", "TQQQ 100%", "QQQ 100%"];   // 현황 탭과 같은 표기. 번호는 comparison.ALLOC
  var SPANS = [[1, "1년"], [3, "3년"], [5, "5년"], [10, "10년"], [15, "15년"], [20, "20년"]];

  /* 테스트 탭 하나. box는 template을 복제해 채운 그 탭의 상자이고, 구획의 요소는 그 안에서만 찾는다.
     cfg.index는 지수 이름이다. 탭마다 자료, 차트, 조작 상태를 따로 갖는다 (`@arngard` 2026-10-12). */
  /* 시각 표기의 항목 하나(자료, 생성). 탭마다 같은 마크업을 쓴다. */
  function seg(label, value) { return "<span class=\"seg\">" + label + " <span class=\"v\">" + value + "</span></span>"; }
  /* 값이 여럿인 항목. 좁은 화면에서는 값마다 줄을 바꾸고 이름 뒤에 맞춰 들여 쓴다 (`@arngard` 2026-10-22). */
  function segList(label, values) {
    return "<span class=\"seg multi\"><span class=\"k\">" + label + "</span><span class=\"v\">" + values.map(function (v, i) {
      return "<span class=\"p\">" + v + (i < values.length - 1 ? "," : "") + "</span>";
    }).join(" ") + "</span></span>";
  }

  function Panel(box, cfg) {
    var byId = function (id) { return box.querySelector("[data-e=\"" + id + "\"]"); };
    var GRID = 21;                    // 분포 격자 간격(거래일, 약 1달). 구운 분포의 값(dist.grid)으로 덮는다
    var T = null;                     // 일별 입력
    var N = 0, YR = null, RET = null, TIMES = null, WEIGHTS = {}, LABEL = {};
    var state = { loaded: false, base: "seed", band: "QQQ", i0: 0, i1: 0, span: 10, distYears: 10 };

    /* ---- 세금을 반영한 평가금 계산 ---- */

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
        WEIGHTS[k] = { 0: {}, 1: mix, 2: { 3: 1.0 }, 3: { 1: 1.0 } };
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

    /* ---- '기간에 따른 추이' 분포 ---- */

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

    /* 분포는 사이트를 만들 때 미리 계산해 구운 값이다(tripod/distribution.py, `@arngard` 2026-10-12).
       시작점은 매달 첫 거래일(임의의 시점 진입)이고, 시점마다 두 기준(원금 대비, QQQ 대비)의 로그정규 적합을 담는다. */
    function distribution() {
      var starts = T.dist.starts, years = {};
      starts.forEach(function (i) { years[YR[i]] = (years[YR[i]] || 0) + 1; });
      return { starts: starts, fits: T.dist.fits, years: years };
    }

    /* 기준 전환. 원금 대비는 1억 원으로 나눈 배수, QQQ 대비는 같은 날 QQQ 보유 평가금으로 나눈 배수다.
       QQQ 대비에서 QQQ 선은 1에 붙고 1배 기준선이 곧 QQQ다 (`@arngard` 2026-10-11). */
    var baseOf = function (r, j) { return state.base === "qqq" ? exLast.QQQ.acct[j] : T.seed; };
    function setBase(base) {
      state.base = base;
      dist.fit = dist.fits[base];
      box.querySelectorAll(".ranges.base button").forEach(function (b) { b.classList.toggle("on", b.dataset.v === base); });
      KEYS.forEach(function (k) { distSeries[k].setData(points(dist.fit[k].mid)); });
      drawBand();
      distTable();
      if (exLast) compute(state.i0, state.i1);
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
    var color = function (k) { return "--e-" + k.toLowerCase(); };   // site.css의 --e-* 토큰
    /* 오르내림의 뜻은 없고 계열끼리의 상대 비교가 목적이다. 플레이버마다 색을 둔다(phrixus 파랑,
       icarus 빨강, amphion 녹색, song 노랑, persephone 보라) (`@arngard` 2026-10-10). */
    /* QQQ는 모든 비교의 기준선이라 흰 실선으로 두고, TQQQ는 회색 점선으로 물러서 둔다
       (`@arngard` 2026-10-11). 선은 모두 1픽셀이다. 라이브러리의 점선(Dotted)은 굵기만큼 끊어
       1픽셀에서는 실선처럼 보이므로, 굵기의 두 배로 끊는 Dashed로 2픽셀 점, 2픽셀 빈칸을 낸다.
       범례 견본도 같은 무늬로 그린다(SWATCH). */
    var LINE = { TQQQ: LC.LineStyle.Dashed };
    var SWATCH = { TQQQ: [2, 2] };                    // 범례 견본의 [칠, 빈칸] 픽셀
    var FIXED = { QQQ: true };        // 끌 수 없는 계열. 모든 비교의 기준선이다 (`@arngard` 2026-10-10)
    var shown = { TQQQ: false };      // 계열별 표시 여부. 두 차트가 함께 따른다. TQQQ는 꺼 두고 연다 (`@arngard` 2026-10-12)
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

    /* 범례 견본을 차트 선의 무늬와 맞춘다. 90% 범위 견본은 칠한 상자다. */
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

    /* 90% 범위를 칠하는 그리기 층. 라이브러리에 띠 계열이 없어, 그릴 때마다 위아래 경계를 화면
       좌표로 바꿔 그 사이를 칠한다. 경계 자체는 투명한 선 두 개(bandSeries)로 두어 세로축 범위 계산에 들어가게 한다.
       라이브러리의 그리기 층은 가장 낮아도(zOrder bottom) 격자 위라, 차트 캔버스 밑에 깐 캔버스(under)에 칠한다.
       그래서 이 차트는 캔버스 바탕을 투명하게 두고 상자가 바탕을 칠한다. 격자와 1배 선이 띠 위에 그려진다 (`@arngard` 2026-10-22). */
    function BandFill(box) {
      var self = this;
      this.lo = []; this.hi = []; this.fill = ""; this.on = true;
      this.under = document.createElement("canvas");
      this.under.className = "under";
      box.appendChild(this.under);
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
      /* 숨기면 경계 선이 보이지 않아 draw가 불리지 않는다. 밑의 캔버스는 여기서 비운다. */
      if (!on) this.under.width = this.under.width;
      if (this._request) this._request();
    };
    BandFill.prototype.draw = function (target) {
      var cv = this.under, size = null, dpr = window.devicePixelRatio || 1;
      target.useMediaCoordinateSpace(function (scope) { size = scope.mediaSize; });
      cv.width = Math.round(size.width * dpr);
      cv.height = Math.round(size.height * dpr);
      cv.style.width = size.width + "px";
      cv.style.height = size.height + "px";
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
      var ctx = cv.getContext("2d");
      ctx.beginPath();
      top.forEach(function (p, n) { if (n) ctx.lineTo(p[0] * dpr, p[1] * dpr); else ctx.moveTo(p[0] * dpr, p[1] * dpr); });
      for (var k = bottom.length - 1; k >= 0; k--) ctx.lineTo(bottom[k][0] * dpr, bottom[k][1] * dpr);
      ctx.closePath();
      ctx.fillStyle = this.fill;
      ctx.fill();
    };

    /* ---- 분포 구획 ---- */

    var dist = null, distChart = null, distSeries = {}, bandSeries = null, distCells = null, bandFill = null;
    /* 경과 개월 j를 시간축에 얹는 가짜 시각. 2000년 1월부터 j번째 달의 1일에 둔다. 라이브러리는 날짜
       축만 다루고 눈금을 달력 경계(해, 달)에 세우므로, 경과 1년을 달력 1년에 맞춰야 눈금이 정수
       연도에 등간격으로 선다. 한 달을 하루로 얹으면 가짜 날짜의 월 초(31, 60, 91개월)에 눈금이
       서서 2.6년, 7.6년처럼 어긋난다. */
    var monthTime = function (j) { return Date.UTC(2000 + Math.floor(j / 12), j % 12, 1) / 1000; };
    var monthOf = function (t) { var d = new Date(t * 1000); return (d.getUTCFullYear() - 2000) * 12 + d.getUTCMonth(); };
    var yearsLabel = function (j) { return j % 12 === 0 ? (j / 12) + "년" : (j / 12).toFixed(1) + "년"; };

    function drawDistribution() {
      var box = byId("eDistChart");
      var opts = ChartKit.options();
      opts.localization = { locale: "ko-KR", timeFormatter: function (t) { return yearsLabel(monthOf(t)) + " 뒤"; } };
      opts.timeScale.tickMarkFormatter = function (t) { return yearsLabel(monthOf(t)); };
      /* 정해진 구간(0 ~ 20년) 전체를 한눈에 보는 그림이라 확대도 이동도 두지 않는다. 크로스헤어로 값을
         읽는 것만 남긴다. 세로 휠은 페이지를 넘긴다 (`@arngard` 2026-10-11, ref: 사이트 화면 규율). */
      opts.handleScroll = false;
      opts.handleScale = false;
      opts.layout.background = { type: "solid", color: "transparent" };
      distChart = LC.createChart(box, opts);
      DRAW.forEach(function (k) { distSeries[k] = addLine(distChart, k); });
      baseLine(distSeries.QQQ);
      var clear = { color: "rgba(0, 0, 0, 0)", lineWidth: 1, lineStyle: LC.LineStyle.Solid };
      bandSeries = { lo: addLine(distChart, state.band, clear), hi: addLine(distChart, state.band, clear) };
      bandFill = new BandFill(box);
      bandSeries.hi.attachPrimitive(bandFill);
      KEYS.forEach(function (k) { distSeries[k].setData(points(dist.fit[k].mid)); });
      distChart.subscribeCrosshairMove(function (p) { paintDistLegend(p && p.time ? monthOf(p.time) : null); });
      drawBand();
      setDistSpan(state.distYears);
      /* 화면 갱신 예약(requestAnimationFrame)은 숨겨진 탭에서 멈추므로 첫 그리기는 타이머로 한다. */
      distChart.timeScale().subscribeSizeChange(function () { setTimeout(drawWh, 0); });
      setTimeout(drawWh, 0);
    }

    /* 플레이버마다 WnH90(QQQ 보유를 90% 확률로 이기는 데 필요한 보유 연수) 자리에 범례 색의 세로선을 긋는다
       (`@arngard` 2026-10-12). 값은 현황 탭의 백테스트 지표와 같다. 같은 달에 겹치는 선은 2픽셀씩 비켜
       두 색이 모두 보이게 하고, 범례에서 끈 플레이버의 선은 숨긴다. */
    function drawWh() {
      var box = byId("eDistChart");
      if (!distChart || !box || !T.wnh90) return;
      var layer = box.querySelector(".vlines");
      if (!layer) { layer = document.createElement("div"); layer.className = "vlines"; box.appendChild(layer); }
      layer.textContent = "";
      var seen = {};
      KEYS.forEach(function (k) {
        var yrs = T.wnh90[k];
        if (!yrs || shown[k] === false) return;
        var mo = Math.round(yrs * 12);                     // 가장 가까운 달
        var x = distChart.timeScale().timeToCoordinate(monthTime(mo));
        if (x === null) return;
        var dup = seen[mo] || 0;
        seen[mo] = dup + 1;
        var line = document.createElement("i");
        line.style.left = Math.round(x + dup * 2) + "px";
        line.style.borderLeftColor = css(color(k));
        line.title = LABEL[k] + " WnH90 " + yrs.toFixed(1) + "년";
        layer.appendChild(line);
      });
    }

    /* 기간 버튼(1 ~ 20년, `@arngard` 2026-10-16, 20년은 2026-10-27). 경과 0년부터 고른 연수까지를 보인다. 확대와 이동은 여전히 두지 않는다. */
    var DIST_YEARS = [1, 3, 5, 10, 15, 20];
    function setDistSpan(n) {
      state.distYears = n;
      // 경과 j개월이 봉 번호 j다(points). 시각으로 구간을 정하면 가짜 날짜 축에서 어긋나 봉 번호로 정한다.
      distChart.timeScale().setVisibleLogicalRange({ from: 0, to: n * 12 });
      byId("eDistSpan").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", +b.dataset.n === n); });
      paintDistLegend(null);
      setTimeout(drawWh, 0);
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
      if (j === null) j = Math.min(lastIndex(dist.fit.QQQ.mid), state.distYears * 12);   // 커서가 없으면 보이는 구간의 끝
      KEYS.forEach(function (k) { distCells[k].textContent = times(dist.fit[k].mid[j]); });
      var f = bandFit();
      /* 표본 수는 표의 표본 열이 맡아 범례에는 두지 않는다 (`@arngard` 2026-10-23). */
      distCells.band.textContent = f.lo[j] === null ? "-" : state.band + " " + times(f.lo[j]) + " ~ " + times(f.hi[j]);
    }

    /* 범례 항목을 누르면 그 계열을 켜고 끈다. 두 차트의 범례가 같은 상태를 나눠 쓴다. 꺼진 계열은
       세로축 범위 계산에서도 빠지므로, 크게 벗어난 계열을 끄면 나머지가 넓게 펴진다. */
    function toggles(box) {
      box.classList.add("toggles");
      Array.prototype.forEach.call(box.querySelectorAll(".item"), function (row, n) {
        var key = KEYS[n];
        if (!key) return;                               // 90% 범위 항목은 조작 대상이 아니다
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
        setTimeout(drawWh, 0);
        if (exSeries[k]) exSeries[k].applyOptions({ visible: on });
        box.querySelectorAll(".legend .item[data-k=\"" + k + "\"]").forEach(function (row) {
          row.classList.toggle("off", !on);
          if (!FIXED[k]) row.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });
    }

    /* 90% 범위 버튼. 고른 계열(또는 숨김)만 바꾸고 기준과 범례의 켜고 끄기는 건드리지 않는다. 숨겼다가 계열을
       다시 고르면 그 계열의 띠가 돌아온다 (`@arngard` 2026-10-12). */
    function setBand(key) {
      state.bandOff = key === "none";
      if (!state.bandOff) state.band = key;
      drawBand();
    }

    /* 지금의 기준, 띠 계열, 숨김 상태대로 띠를 그린다. 기준을 바꿀 때도 이것만 불러 선택 상태를 바꾸지 않는다.
       띠는 범례에서 그 계열의 선을 꺼도 고른 대로 보인다 - 꺼 둔 채 여는 TQQQ의 띠를 고르면 띠가 나와야 한다
       (`@arngard` 2026-10-12). */
    /* 띠의 상하한. QQQ 대비에서 QQQ는 자기 자신으로 나눈 값이라 모든 시작점에서 1배이고 퍼짐이 없다. 그래서 그때만
       원금 대비 기준의 QQQ 상하한을 같은 시점의 QQQ 중심값으로 나눠 1배 둘레에 그린다 (`@arngard` 2026-10-12).
       이 띠는 QQQ 결과가 중심값에서 얼마나 퍼지는지이고, 다른 계열의 띠(QQQ보다 얼마나 낫거나 못했나)와 뜻이 다르다. */
    function bandFit() {
      if (!(state.base === "qqq" && state.band === "QQQ")) return dist.fit[state.band];
      var q = dist.fits.seed.QQQ, div = function (a) { return a.map(function (v, j) { return v === null ? null : v / q.mid[j]; }); };
      return { lo: div(q.lo), hi: div(q.hi), n: q.n };
    }

    function drawBand() {
      var key = state.band, f = bandFit(), on = !state.bandOff;
      bandSeries.lo.setData(points(f.lo));
      bandSeries.hi.setData(points(f.hi));
      bandSeries.lo.applyOptions({ visible: on });
      bandSeries.hi.applyOptions({ visible: on });
      bandFill.set(f.lo, f.hi, alpha(css(color(key)), 0.2), on);
      byId("eBand").querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("on", state.bandOff ? b.dataset.k === "none" : b.dataset.k === key);
      });
      var sw = byId("eDistLegend").querySelector("i.fill");
      if (sw) {
        sw.style.background = alpha(css(color(key)), 0.45);
        sw.closest(".item").hidden = !on;
      }
      paintDistLegend(null);
    }

    var DIST_ROWS = [1, 3, 5, 10, 15, 20];
    function distHead() {
      return "<thead><tr><th>경과</th><th class=\"num\">표본</th>" + KEYS.map(function (k) {
        return "<th class=\"num\">" + LABEL[k] + "</th>";
      }).join("") + "</tr></thead>";
    }

    function distTable() {
      var f = dist.fit, head = distHead();
      var body = DIST_ROWS.map(function (y) {
        var j = y * 12;
        if (f.QQQ.mid[j] === null || f.QQQ.mid[j] === undefined) return "";
        var mx = Math.max.apply(null, KEYS.map(function (k) { return f[k].mid[j]; }));
        return "<tr><td>" + y + "년</td><td class=\"num\">" + f.QQQ.n[j] + "개</td>" + KEYS.map(function (k) {
          return "<td class=\"num" + (f[k].mid[j] === mx ? " best" : "") + "\">" + times(f[k].mid[j]) +
            "<div class=\"sub\">" + times(f[k].lo[j]) + " ~ " + times(f[k].hi[j]) + "</div>" +
            "<div class=\"sub\">" + (state.base === "qqq" ? "QQQ 미달 " : "손실 ") + pct(f[k].loss[j], 0) + "</div></td>";
        }).join("") + "</tr>";
      }).join("");
      byId("eDistTable").innerHTML = "<table>" + head + "<tbody>" + body + "</tbody></table>";
    }

    /* 세로선(WnH90) 설명. 선이 하나라도 있을 때만 세로선이 무엇인지 말하고, 10년을 넘어 선이 없는 플레이버를 덧붙인다.
       모두 없으면 세로선 이야기는 하지 않고 WnH90이 모두 10년을 넘는다는 결과만 남긴다 (`@arngard` 2026-10-13). */
    function whNote() {
      var none = KEYS.filter(function (k) { return !HOLDS[k] && T.wnh90 && !T.wnh90[k]; }).map(function (k) { return LABEL[k]; });
      if (none.length === KEYS.filter(function (k) { return !HOLDS[k]; }).length) return " 이 자료에서는 모든 플레이버의 WnH90이 10년을 넘는다.";
      var out = " 세로선은 각 플레이버의 WnH90이다.";
      if (none.length) out += " WnH90이 10년을 넘는 플레이버(" + none.join(", ") + ")는 선이 없다.";
      return out;
    }

    function distNotes() {
      var s = dist.starts;
      /* 차트 위에는 읽는 데 꼭 필요한 것만 둔다. WnH90의 뜻은 현황 탭이 맡는다. 시작점의 정의는 가정과 한계로 내린다.
         10년 지점의 시작점 수는 표의 시작점 열이, 확률이 아니라는 경고는 가정과 한계의 마지막 항목이 맡으므로 여기 두지 않는다 (`@arngard` 2026-10-13). */
      /* "매달 샀다"는 적립식으로 읽혀, 진입마다 따로 계산했음을 밝힌다 */
      byId("eDistKey").textContent = "임의의 날짜에 진입했을 때 운용 기간에 따른 결과다. 선은 중심값, 띠는 90% 범위다." + whNote() +
        " 범례를 눌러 선을 켜고 끈다.";
      byId("eDistBasis").textContent = "'기간에 따른 추이'의 임의의 날짜는 " + TIMES[s[0]] + " ~ " + TIMES[s[s.length - 1]] + "의 매달 첫 거래일 " +
        s.length + "번으로 대신했다. 진입일마다 투자금 전부를 한 번에 넣는다.";
    }


    /* ---- 진입일 탐색 구획 ---- */

    var exChart = null, exSeries = {}, exCells = null, exLast = null, applying = false, raf = 0;
    /* 시장 사건(tripod/events.py). 현황 탭 시장 상황 차트와 같이 사건 구간을 옅은 띠로 칠하고 말풍선 태그로 이름을 단다
       (`@arngard` 2026-10-22). 태그가 앞 태그와 겹치면 한 줄 아래로 내린다. */
    var EVENTS = (function () {
      var el = cfg.events && document.getElementById("eventsData");
      try { return el ? JSON.parse(el.textContent) : []; } catch (e) { return []; }
    })();

    function drawExEvents() {
      var host = byId("eExChart");
      if (!exChart || !host || !EVENTS.length) return;
      var layer = host.querySelector(".evbands"), tags = host.querySelector(".evtags");
      if (!layer) { layer = document.createElement("div"); layer.className = "evbands"; host.appendChild(layer); }
      if (!tags) { tags = document.createElement("div"); tags.className = "evtags"; host.appendChild(tags); }
      layer.textContent = "";
      tags.textContent = "";
      var ts = exChart.timeScale(), W = ts.width(), ends = [];
      var at = function (date) { var i = 0; while (i < N && TIMES[i] < date) i++; return i; };
      EVENTS.forEach(function (ev) {
        var i0 = at(ev.from), i1 = Math.min(at(ev.to), N - 1);
        if (i0 >= N) return;
        var x0 = Math.max(0, ts.logicalToCoordinate(i0)), x1 = Math.min(W, ts.logicalToCoordinate(i1));
        if (x1 < 0 || x0 > W) return;
        var band = document.createElement("b");
        band.style.left = x0 + "px";
        band.style.width = Math.max(2, x1 - x0) + "px";
        layer.appendChild(band);
        var tag = document.createElement("span");
        tag.textContent = ev.name;
        tags.appendChild(tag);
        var w = tag.offsetWidth, x = Math.min(Math.max((x0 + x1) / 2, w / 2 + 2), W - w / 2 - 2), row = 0;
        while (ends[row] !== undefined && ends[row] > x - w / 2 - 4) row++;
        ends[row] = x + w / 2;
        tag.style.left = x + "px";
        tag.style.top = 6 + row * 24 + "px";
      });
    }
    /* 첫 구간을 정하기 전의 구간 변화는 무시한다. 자료를 처음 넣으면 라이브러리가 맨 끝 몇 달을
       기본 구간으로 잡는데, 그것을 진입일 변경으로 받으면 한 프레임 동안 엉뚱한 진입일이 그려진다. */
    var ready = false;

    function clampEntry(i) { return Math.max(T.first, Math.min(N - 22, Math.round(i))); }

    function drawExplorer() {
      var opts = ChartKit.options();
      /* 20년(약 5,000거래일)이 좁은 폭에도 들어가게 봉 간격의 하한을 낮춘다. 기본(0.5픽셀)이면
         폭 900픽셀에 7년 남짓만 들어가, 10년을 요청해도 라이브러리가 왼쪽을 잘라 진입일이 밀린다. */
      opts.timeScale.minBarSpacing = 0.01;
      /* 시장 사건 띠를 캔버스 밑에 깔도록 바탕은 상자(CSS)가 칠한다 (`@arngard` 2026-10-22). */
      opts.layout.background = { type: "solid", color: "transparent" };
      /* 이 차트는 확대를 두지 않는다. 확대가 왼쪽 끝, 곧 진입일까지 움직여 조작의 뜻이 흐려지기
         때문이다. 가로 스크롤(트랙패드 좌우 쓸기, Shift+휠)과 끌기는 이동이고, 세로 휠은 페이지로
         돌려준다. 보는 기간은 기간 버튼이 정한다 (`@arngard` 2026-10-11, 공유 차트 규율의 예외). */
      opts.handleScroll = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
      opts.handleScale = { mouseWheel: false, pinch: false,
                           axisPressedMouseMove: { time: false, price: true }, axisDoubleClickReset: { time: false, price: true } };
      exChart = LC.createChart(byId("eExChart"), opts);
      /* 아래 여백을 없애 세로축 바닥이 하한(0.01배)과 맞게 한다. 여백이 있으면 그 밑까지 눈금이 선다. */
      exChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
      DRAW.forEach(function (k) { exSeries[k] = addLine(exChart, k); });
      baseLine(exSeries.QQQ);
      applyShown();
      exChart.subscribeCrosshairMove(function (p) {
        paintExLegend(p && p.logical !== undefined && p.time ? Math.round(p.logical) : null);
      });
      exChart.timeScale().subscribeVisibleLogicalRangeChange(drawExEvents);
      exChart.timeScale().subscribeSizeChange(function () { setTimeout(function () { drawExEvents(); drawStrip(); }, 0); });
      /* 보이는 구간의 왼쪽 끝이 진입일이다. 끌거나 스크롤해 구간이 바뀌면 그 자리에서 다시 계산한다. */
      exChart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
        /* 탭이 숨으면 상자 폭이 0이 되며 구간이 흔들린다. 그 동안의 변화는 진입일 변경이 아니다. */
        if (!range || applying || !ready || !byId("eExChart").clientWidth) return;
        if (!raf) raf = requestAnimationFrame(function () { raf = 0; follow(exChart.timeScale().getVisibleLogicalRange()); });
      });
      /* 처음 구간은 상자 배치가 끝난 뒤에 정한다. 크기가 잡히기 전에 정하면 크기가 잡히면서
         왼쪽이 잘려 진입일이 엉뚱하게 바뀐다. */
      /* 처음에는 최근 기간을 보인다. 진입일은 자료 끝에서 기간(기본 10년)만큼 앞이다 (`@arngard` 2026-10-22). */
      state.i0 = clampEntry(N - 1 - Math.round(state.span * 252));
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
        /* 진입일이 그대로면 평가금 추이도 그대로다. 오른쪽 끝(표의 기준)만 옮긴다. */
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
       늘릴 수 없게 된다. i1은 표와 범례가 기준으로 삼는 보이는 구간의 끝이다. */
    function compute(i0, i1) {
      state.i0 = i0; state.i1 = i1;
      var res = {};
      KEYS.forEach(function (k) { res[k] = simulate(i0, N - 1, wantOf(k), WEIGHTS[k]); });
      exLast = res;
      applying = true;
      KEYS.forEach(function (k) {
        var arr = res[k].acct, q = res.QQQ.acct, rel = state.base === "qqq", data = new Array(N);
        for (var i = 0; i < N; i++) {
          data[i] = i < i0 ? { time: TIMES[i] } : { time: TIMES[i], value: arr[i - i0] / (rel ? q[i - i0] : T.seed) };
        }
        exSeries[k].setData(data);
      });
      applying = false;
      drawExEvents();
      paintExLegend(null);
      exMeta();
      exTable();
      drawStripBox();
    }

    function paintExLegend(i) {
      if (!exLast) return;
      if (i === null || i < state.i0 || i > state.i1) i = state.i1;
      KEYS.forEach(function (k) { exCells[k].textContent = times(exLast[k].acct[i - state.i0] / baseOf(null, i - state.i0)); });
    }

    /* ---- 시간 창 ----
       탭 자료의 지수(나스닥100 또는 닛케이 가상) 전체를 로그 눈금으로 깔고, 지금 보는 구간을 상자로 덮는다. 띠를 누르거나
       끌면 그 자리를 가운데로 하는 구간으로 옮긴다. 진입일을 고르던 아래 막대는 띠와 하는 일이 겹쳐 뺐다 (`@arngard` 2026-10-22). */
    var stripGeo = null;

    function drawStrip() {
      var el = byId("eStrip");
      /* 시장 상황의 띠와 같이 차트의 그림 영역(세로축 왼쪽)에 맞춘다. 그림 영역 폭이 아직 0이면(탭을 막 열어 차트가 크기를
         받기 전) 그리지 않는다. 그때 상자 폭으로 그리면 좌표가 그 폭에 묶여 남는다. 차트가 크기를 받으면 시간축 크기 변화
         신호가 다시 그린다 (`@arngard` 2026-10-23). */
      var plot = exChart ? exChart.timeScale().width() : 0;
      if (!el.clientWidth || !plot) return;
      var W = el.clientWidth, H = 70, m = { l: 0, r: Math.max(0, W - plot), t: 6, b: 20 };
      var lo = Infinity, hi = -Infinity;
      for (var i = T.first; i < N; i++) { var v = Math.log10(T.ndx[i]); if (v < lo) lo = v; if (v > hi) hi = v; }
      var X = function (i) { return m.l + (i - T.first) / (N - 1 - T.first) * (W - m.l - m.r); };
      var Y = function (v) { return m.t + (1 - (Math.log10(v) - lo) / (hi - lo)) * (H - m.t - m.b); };
      var p = "";
      for (i = T.first; i < N; i += 3) p += (p ? "L" : "M") + X(i).toFixed(1) + "," + Y(T.ndx[i]).toFixed(1);
      var s = "<svg viewBox=\"0 0 " + W + " " + H + "\"><path d=\"" + p + "\" fill=\"none\" stroke=\"" + css("--ink-soft") +
        "\" stroke-width=\"1\"/>";
      /* 연도 눈금은 5년마다 두되, 양 끝에 붙어 잘리는 해는 뺀다. */
      var y0 = YR[T.first] + 1, y1 = YR[N - 1] - 1;
      for (var y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) {
        var k = TIMES.findIndex(function (t) { return t >= y + "-01-01"; });
        if (k < 0 || X(k) < m.l + 16 || X(k) > W - m.r - 16) continue;      /* 양 끝에서 잘리는 라벨은 뺀다 */
        s += "<text x=\"" + X(k) + "\" y=\"" + (H - 4) + "\" text-anchor=\"middle\">" + y + "</text>";
      }
      bigPeaks().forEach(function (k) {
        s += "<line x1=\"" + X(k) + "\" x2=\"" + X(k) + "\" y1=\"" + m.t + "\" y2=\"" + (H - m.b) + "\" stroke=\"" +
          css("--rule") + "\" stroke-dasharray=\"2 2\"/>";
      });
      s += "<rect data-e=\"eStripBox\" y=\"" + (m.t - 2) + "\" height=\"" + (H - m.t - m.b + 4) + "\" fill=\"" + css("--line") +
        "\" fill-opacity=\".18\" stroke=\"" + css("--ink-soft") + "\" stroke-width=\"1.5\" rx=\"2\"/></svg>";
      el.innerHTML = s;
      stripGeo = { W: W, m: m, X: X };
      drawStripBox();
    }

    function drawStripBox() {
      var rect = byId("eStripBox");
      if (!rect || !stripGeo) return;
      var x0 = stripGeo.X(state.i0), x1 = stripGeo.X(Math.min(N - 1, state.i0 + Math.round(state.span * 252)));
      rect.setAttribute("x", x0);
      rect.setAttribute("width", Math.max(2, x1 - x0));
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
      window.addEventListener("resize", function () { if (state.loaded && !box.hidden) drawStrip(); });
    }

    function exMeta() {
      var i0 = state.i0, hi = 0;
      for (var i = 0; i <= i0; i++) if (T.ndx[i] > hi) hi = T.ndx[i];
      /* 첫 줄은 진입 시점이다. 진입 배분은 플레이버마다 한 줄씩, 이름과 배분을 열로 맞춰 내려쓴다. 배분 이름의 길이가
         달라 가로로 이으면 차트를 끄는 동안 자리가 흔들려 읽기 어렵다 (`@arngard` 2026-10-13). */
      var items = [
        ["진입일", TIMES[i0]],
        [cfg.index + " 종가", ChartKit.format(T.ndx[i0], 2) + " (사상 최고가 대비 " + pct(T.ndx[i0] / hi - 1) + ")"],
        ["진입 환율", ChartKit.format(T.fx[i0], 1) + "원"]
      ];
      var alloc = KEYS.filter(function (k) { return !HOLDS[k]; }).map(function (k) {
        return "<span class=\"k\">" + k + "</span><span class=\"v\">" + ALLOC[T.held[k][i0]] + "</span>";
      }).join("");
      byId("eExMeta").innerHTML = items.map(function (it) {
        return "<div><dt>" + it[0] + "</dt><dd>" + it[1] + "</dd></div>";
      }).join("") + "<div class=\"row\"><dt>진입 배분</dt><dd class=\"alloc\">" + alloc + "</dd></div>";
    }

    /* 보이는 구간 끝에서의 값과 세금. 연 수익률과 가장 큰 칸 표시는 평가금을 따른다. 세금은 매도 때
       유보한 것과 지금 전부 팔면 더 생길 것(평가금과 세후 금액의 차이)으로 가른다. 보유 두 계열은 팔기
       전까지 유보금이 0이고 세금이 모두 뒤쪽에 쌓인다. 평가금은 이 미실현분을 빼지 않으므로 세금을
       미루는 보유 계열에 유리하게 기운다. 그 크기를 이 열과 세후 열로 보인다 (`@arngard` 2026-10-11). */
    var EX_HEAD = "<thead><tr><th>계열</th>" +
      "<th class=\"num\">평가금</th><th class=\"num\">전부 팔았을 때 세후</th>" +
      "<th class=\"num\">연 수익률</th><th class=\"num\">최대 낙폭</th><th class=\"num\">배분 전환</th>" +
      "<th class=\"num\">매도로 생긴 양도세</th><th class=\"num\">지금 팔면 더 낼 세금</th></tr></thead>";
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
        if (v < -0.5) return "-" + won(-v) + " <span class=\"why\">(올해 세금 감소)</span>";
        var g = r.gain[j], why = g < -0.5 ? "평가손실" : g <= 0.5 ? "미실현 손익 없음" : "공제 이내";
        return won(0) + " <span class=\"why\">(" + why + ")</span>";
      };
      var sel = KEYS.map(function (k) { return exLast[k].acct[j] / T.seed; });
      var mx = Math.max.apply(null, sel);
      var mdd = function (a) {
        var pk = -Infinity, w = 0;
        for (var q = 0; q < a.length; q++) { if (a[q] > pk) pk = a[q]; var d = a[q] / pk - 1; if (d < w) w = d; }
        return w;
      };
      var head = EX_HEAD;
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
        "평가금은 낸 양도세를 뺀 금액, '전부 팔았을 때 세후'는 지금 팔 때의 세금까지 뺀 금액이다.";
      byId("eExTable").innerHTML = "<table>" + head + "<tbody>" + body + "</tbody></table>";
    }

    /* 조작 줄과 범례는 자료 없이 정해지므로 처음부터 그린다. 자료가 오기 전의 누름은 받지 않는다 (`@arngard` 2026-10-23). */
    function controls() {
      /* 기준 버튼은 두 구획에 하나씩 있고 늘 같은 값으로 움직인다. */
      box.querySelectorAll(".ranges.base").forEach(function (box) {
        box.addEventListener("click", function (e) {
          var b = e.target.closest("button"); if (b && state.loaded && b.dataset.v !== state.base) setBase(b.dataset.v);
        });
      });
      byId("eDistSpan").innerHTML = DIST_YEARS.map(function (n) {
        return "<button type=\"button\" data-n=\"" + n + "\"" + (n === state.distYears ? " class=\"on\"" : "") + ">" + n + "년</button>";
      }).join("");
      byId("eDistSpan").addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (b && distChart) setDistSpan(+b.dataset.n);
      });
      byId("eBand").innerHTML = KEYS.map(function (k) {
        return "<button type=\"button\" data-k=\"" + k + "\"" + (k === state.band ? " class=\"on\"" : "") + ">" + k + "</button>";
      }).join("") + "<button type=\"button\" data-k=\"none\">숨김</button>";
      byId("eBand").addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (b && state.loaded) setBand(b.dataset.k);
      });
      byId("eSpan").innerHTML = SPANS.map(function (s) {
        return "<button type=\"button\" data-n=\"" + s[0] + "\">" + s[1] + "</button>";
      }).join("");
      byId("eSpan").addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (!b || !state.loaded) return;
        state.span = +b.dataset.n;
        markSpan();
        jump(state.i0, state.span);
      });
      byId("eJump").addEventListener("click", function (e) {
        var b = e.target.closest("button"); if (b && state.loaded) jump(+b.dataset.i, state.span);
      });
      markSpan();
      distCells = ChartKit.legend(byId("eDistLegend"), KEYS.map(function (k) {
        return { key: k, label: LABEL[k], color: color(k) };
      }).concat([{ key: "band", label: "90% 범위", color: "--ink-soft" }]));
      toggles(byId("eDistLegend"));
      swatches(byId("eDistLegend"));
      exCells = ChartKit.legend(byId("eExLegend"), KEYS.map(function (k) {
        return { key: k, label: LABEL[k], color: color(k) };
      }));
      toggles(byId("eExLegend"));
      swatches(byId("eExLegend"));
      applyShown();
    }

    function jumps() {
      byId("eJump").innerHTML = bigPeaks().map(function (i) {
        return "<button type=\"button\" data-i=\"" + i + "\">" + TIMES[i] + "</button>";
      }).join("");
    }

    function markSpan() {
      /* 휠로 바꾼 기간은 버튼과 맞지 않을 수 있다. 그때는 어느 버튼도 켜지 않는다. */
      byId("eSpan").querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", Math.abs(+b.dataset.n - state.span) < 0.02); });
    }

    /* ---- 불러오기 ---- */

    /* 자료를 받기 전이나 받지 못했을 때의 틀. 본문은 처음부터 보이고, 차트 자리에는 자리 표시를 둔다 (`@arngard` 2026-10-23).
       자료로 정해지는 글과 분포 표는 빌드가 미리 그려 상자의 data-pre에 넣어 두었다(prerender.test_parts). 처음 화면 상태 그대로라
       자료가 와서 다시 그려도 같은 내용이고 자리가 밀리지 않는다. 진입일 탐색 표와 그 범례 값은 세금을 반영한 평가금을 계산해야 하므로
       같은 행과 열의 대시로 둔다. 빌드가 자료를 만들지 못했으면 data-pre가 없고, 그 자리도 모두 대시다.
       플레이버 이름은 빌드가 상자에 붙인 data-labels에서 온다. */
    var preLabels = JSON.parse(box.dataset.labels || "{}"), PRE = JSON.parse(box.dataset.pre || "null");
    Object.keys(preLabels).forEach(function (k) { LABEL[k] = preLabels[k]; });
    LABEL.QQQ = "QQQ 보유";
    LABEL.TQQQ = "TQQQ 보유";
    function placeholder(msg) {
      ["eDistChart", "eExChart"].forEach(function (id) { var el = byId(id); el.classList.add("unavailable"); el.dataset.msg = msg; });
      var dash = function (n) { return new Array(n + 1).join("<td class=\"num\">-</td>"); };
      byId("eDistTable").innerHTML = PRE ? PRE.distTable : "<table>" + distHead() + "<tbody>" + DIST_ROWS.map(function (y) {
        return "<tr><td>" + y + "년</td><td class=\"num\">-</td>" + KEYS.map(function () {
          return "<td class=\"num\">-<div class=\"sub\">-</div><div class=\"sub\">-</div></td>";
        }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
      byId("eExTable").innerHTML = "<table>" + EX_HEAD + "<tbody>" + KEYS.map(function (k) {
        return "<tr><td><i class=\"key\" style=\"background:" + css(color(k)) + "\"></i>" + LABEL[k] + "</td>" + dash(7) + "</tr>";
      }).join("") + "</tbody></table>";
      byId("eExMeta").innerHTML = PRE ? PRE.meta : ["진입일", cfg.index + " 종가", "진입 환율", "진입 배분"].map(function (k) {
        return "<div><dt>" + k + "</dt><dd>-</dd></div>";
      }).join("");
      byId("eDistKey").textContent = PRE ? PRE.distKey : "";
      byId("eDistBasis").textContent = PRE ? PRE.distBasis : "";
      byId("eExCaption").textContent = PRE ? PRE.caption : "";
      byId("eNotes").textContent = PRE ? PRE.notes : "";
      byId("eJump").innerHTML = PRE ? PRE.jump : "";
      Object.keys(distCells).forEach(function (k) { distCells[k].textContent = PRE ? PRE.distLegend[k] : "-"; });
      Object.keys(exCells).forEach(function (k) { exCells[k].textContent = "-"; });
      var sw = byId("eDistLegend").querySelector("i.fill");
      if (sw) sw.style.background = alpha(css(color(state.band)), 0.45);
    }
    controls();
    placeholder("자료를 받는 중이다.");

    function fail(problems) {
      var box = byId("eProblems");
      box.hidden = false;
      box.innerHTML = "<h2>계산하지 못했다</h2>" + problems.map(function (p) {
        return "<p class=\"note err\">" + p.replace(/</g, "&lt;") + "</p>";
      }).join("");
      placeholder("정보를 얻지 못했다.");
    }

    /* 자료를 받는다. 페이지를 열 때 미리 불러(아래 prefetch) 두므로, 탭을 열 때는 네트워크를 기다리지 않는다 (`@arngard` 2026-10-23).
       여러 번 불러도 한 번만 받는다. 차트와 계산은 탭이 보일 때 그린다(render). */
    var fetching = null;
    function load() {
      if (fetching) return fetching;
      var src = box.dataset.src;
      fetching = fetch(src + "?t=" + Date.now())
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (data) {
          if (!data.ok) { fail(data.problems || ["자료를 받지 못했다."]); return; }
          if (!data.dist) { fail(["'기간에 따른 추이' 자료가 없다."]); return; }
          prepare(data);
          GRID = data.dist.grid;
          /* 생성 시각을 맨 앞에, 자료 기간을 뒤에 둔다 (`@arngard` 2026-10-22). 현황 탭과 같은 차례다. */
          stamp(data.generated_at, TIMES[0] + " ~ " + TIMES[N - 1]);
          dist = distribution();
          dist.fit = dist.fits[state.base];
          if (data.notes && data.notes.length) byId("eNotes").textContent = data.notes.join(" ");
          render();
        })
        .catch(function (error) { fail(["자료를 받지 못했다. " + (error && error.message || error)]); });
      return fetching;
    }

    /* 받아 둔 자료로 차트와 표를 그린다. 탭이 숨어 있으면(상자 폭 0) 그리지 않고 탭을 열 때(show) 그린다. 폭이 0인 차트는
       보이는 구간을 제멋대로 조정해, 진입일이 자료 맨 앞으로 밀리고 '기간에 따른 추이'의 보이는 기간이 어긋난 채 남는다
       (`@arngard` 2026-10-23, 미리 받은 자료를 숨은 탭에서 그렸을 때). 자리는 미리 그린 틀이 같은 크기로 잡고 있어 밀리지 않는다. */
    function render() {
      if (state.loaded || !dist || !box.offsetWidth) return;
      ["eDistChart", "eExChart"].forEach(function (id) { byId(id).classList.remove("unavailable"); });
      jumps();
      distNotes();
      drawDistribution();
      distTable();
      drawExplorer();
      wireStrip();
      drawStrip();
      state.loaded = true;
    }

    /* 자료 기간은 탭마다 다르므로 탭 안의 자리에 쓴다. */
    function stamp(gen, span) {
      byId("eStamp").innerHTML =
        (gen ? "<span class=\"seg\">생성 <span class=\"v gen\">" + gen + "</span></span>" : "") +
        "<span class=\"seg\">자료 <span class=\"v\">" + span + "</span></span>";
      /* 테스트 탭은 시의성이 중요하지 않아 생성 시각이 낡아도 칠하지 않는다 (`@arngard` 2026-10-25). */
    }
    /* 생성이 탭 묶음의 속성에 넣어 둔 값으로 자료를 받기 전에 먼저 적는다. 자료가 와도 같은 값이라 그 아래 줄이 밀리지 않는다
       (`@arngard` 2026-10-23). 자료가 오면 자료의 값으로 다시 적는다. */
    if (box.dataset.span) stamp(box.dataset.gen, box.dataset.span);

    /* 탭이 보일 때 부른다. 처음이면 자료를 받고, 이미 그렸으면 숨어 있는 동안 흔들린 구간과 띠를 다시 맞춘다. */
    function show() {
      /* 탭 전환에서 상자가 드러난 뒤에 그리도록 한 차례 미룬다. */
      if (!state.loaded) { load().then(function () { setTimeout(render, 0); }); return; }
      restore();
      setTimeout(function () { drawStrip(); drawWh(); }, 0);
    }

    return { show: show, load: load,
             simulate: function (i0, key) { return simulate(i0, N - 1, wantOf(key), WEIGHTS[key]); },
             data: function () { return T; } };
  }

  /* 분석 탭 앞쪽의 장세별 선택 구획들 (`@arngard` 2026-10-14, 2026-10-27에 분석 탭으로 옮김). 앞으로의 장세가 상승장(나스닥)과 침체장(현실 침체장: 닛케이 가상과 코스피 가상의 평균, 2026-10-18) 사이에
     있다고 보고, 침체장일 확률 q에 대해 기대 로그 성장률 (1 - q) * g_N + q * g_K가 가장 큰 계열을 고른다.
     g는 사이트를 만들 때 페이지에 넣은 고정값(tripod/choice.py)이다. 구간 경계는 여기서 g로 계산해 표와 그래프가 같은 값을 쓴다.
     우위 구간은 범례에서 켜 둔 계열만으로 다시 계산한다 (`@arngard` 2026-10-14). 끈 계열을 빼고 무엇을 고를지 보기 위해서다.
     그래프는 가로축이 시간이 아니라 확률이라 차트 라이브러리를 쓰지 않고 SVG로 그린다. 왼쪽 끝이 나스닥(q = 0),
     오른쪽 끝이 현실 침체장(q = 1)이다. 세로축은 고른 기간 뒤 원금의 배수이고 로그 눈금이라 선이 곧다.
     세로선은 누르거나 끌어 옮기고, 키보드는 좌우 화살표(Shift는 큰 걸음)로 옮긴다. */
  function Choice(box) {
    var byId = function (id) { return box.querySelector("[data-c=\"" + id + "\"]"); };
    var src = document.getElementById("choiceData");
    var D = src ? JSON.parse(src.textContent) : null;
    /* 세로선의 처음 자리는 상승 경향 62%(q = 0.38)다. NtG62와 같은 자리다 (`@arngard` 2026-10-15). */
    var S = {}, LABEL = {}, q = 0.38, years = 10, built = false;
    var YEARS = [1, 3, 5, 10, 15, 20];                 // 기간 버튼. 기본은 10년 (`@arngard` 2026-10-14)
    var shown = { TQQQ: false };                       // 테스트 탭처럼 TQQQ는 꺼 두고 연다
    var FIXED = { QQQ: true };
    var DASH = { TQQQ: "2 2" };
    var SVGNS = "http://www.w3.org/2000/svg";
    var colorOf = function (k) { return css("--e-" + k.toLowerCase()); };
    var pct = function (v, d) { return (v * 100).toFixed(d === undefined ? 1 : d) + "%"; };
    var times = function (v) {
      return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v >= 1 ? v.toFixed(2).replace(/\.?0+$/, "") :
              String(+v.toPrecision(2))) + "배";
    };
    if (D) D.series.forEach(function (x) { S[x.key] = x; LABEL[x.key] = x.label; });
    var keys = KEYS.filter(function (k) { return S[k]; });
    var on = function () { return keys.filter(function (k) { return shown[k] !== false; }); };

    var logAt = function (k, x) { return (1 - x) * S[k].g_nasdaq + x * S[k].g_down; };
    var rateAt = function (k, x) { return Math.exp(logAt(k, x)) - 1; };
    var multAt = function (k, x) { return Math.exp(years * logAt(k, x)); };
    var bestAt = function (ks, x) {
      return ks.reduce(function (b, k) { return logAt(k, x) > logAt(b, x) ? k : b; }, ks[0]);
    };

    /* 직선들의 위 껍질. 왼쪽(q = 0)부터 지금 1등보다 오른쪽으로 덜 떨어지는 선과 처음 만나는 점을 차례로 찾는다. */
    function envelope(ks) {
      var out = [], x = 0, cur = ks.reduce(function (b, k) {
        var d = logAt(k, 0) - logAt(b, 0);
        return d > 1e-12 || (Math.abs(d) <= 1e-12 && S[k].g_down > S[b].g_down) ? k : b;
      }, ks[0]);
      for (;;) {
        var next = null, cross = 1;
        ks.forEach(function (k) {
          var ds = (S[k].g_down - S[k].g_nasdaq) - (S[cur].g_down - S[cur].g_nasdaq);
          if (ds <= 0) return;
          var c = (S[cur].g_nasdaq - S[k].g_nasdaq) / ds;
          if (c >= x - 1e-12 && c < cross) { next = k; cross = c; }
        });
        if (!next || cross >= 1) { out.push([x, 1, cur]); return out; }
        out.push([x, cross, cur]);
        x = cross; cur = next;
      }
    }

    function pickTable(env) {
      /* 구간은 상승 경향(`@arngard` 2026-10-15) 하나로 적는다. 침체장 쪽은 그 나머지라 따로 두지 않는다. */
      var head = "<thead><tr><th>상승 경향</th><th>고를 계열</th>" +
        "<th class=\"num\">" + years + "년 뒤 기대 배수</th><th class=\"num\">기대 연 성장률</th></tr></thead>";
      var body = env.map(function (e) {
        var here = q >= e[0] && (q < e[1] || e[1] === 1);
        return "<tr" + (here ? " class=\"here\"" : "") + "><td class=\"num\">" + pct(1 - e[0]) + " ~ " + pct(1 - e[1]) + "</td>" +
          "<td><i class=\"key\" style=\"background:" + colorOf(e[2]) + "\"></i>" + LABEL[e[2]] + "</td>" +
          "<td class=\"num\">" + times(multAt(e[2], e[0])) + " ~ " + times(multAt(e[2], e[1])) + "</td>" +
          "<td class=\"num\">" + pct(rateAt(e[2], e[0])) + " ~ " + pct(rateAt(e[2], e[1])) + "</td></tr>";
      }).join("");
      byId("cPick").innerHTML = "<table class=\"narrow\">" + head + "<tbody>" + body + "</tbody></table>";
    }

    var cells = null;
    function legend() {
      var el = byId("cLegend");
      cells = ChartKit.legend(el, keys.map(function (k) { return { key: k, label: LABEL[k], color: "--e-" + k.toLowerCase() }; }));
      el.classList.add("toggles");
      Array.prototype.forEach.call(el.querySelectorAll(".item"), function (row, n) {
        var k = keys[n], dot = row.querySelector("i");
        row.dataset.k = k;
        if (DASH[k]) {
          dot.style.width = "20px";
          dot.style.background = "repeating-linear-gradient(90deg, " + colorOf(k) + " 0 2px, transparent 2px 4px)";
        }
        if (FIXED[k]) { row.classList.add("fixed"); row.title = "기준선이라 끌 수 없다"; return; }
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        var flip = function () { shown[k] = shown[k] === false; paint(); };
        row.addEventListener("click", flip);
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); }
        });
      });
    }

    function spans() {
      var el = byId("cYears");
      el.innerHTML = YEARS.map(function (n) {
        return "<button type=\"button\" data-v=\"" + n + "\"" + (n === years ? " class=\"on\"" : "") + ">" + n + "년</button>";
      }).join("");
      el.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b || +b.dataset.v === years) return;
        years = +b.dataset.v;
        el.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        paint();
      });
    }

    function el(name, attrs, text) {
      var n = document.createElementNS(SVGNS, name);
      Object.keys(attrs).forEach(function (a) { n.setAttribute(a, attrs[a]); });
      if (text !== undefined) n.textContent = text;
      return n;
    }

    var geo = null;
    function draw(ks, env) {
      var host = byId("cChart"), W = host.clientWidth, H = host.clientHeight;
      if (!W || !H) return;
      /* 모양은 `@arngard`의 스케치(2026-10-14)를 따른다. 양 끝에 굵은 세로축(나스닥, 현실 침체장)을 두고, 1-2-5 배수 눈금을
         양쪽 축 바깥에 모두 적는다. 원금(1배)은 다른 차트처럼 마젠타 점선이다. */
      var M = { l: 50, r: 50, t: 26, b: 46 };
      var lo = 0, hi = 0;                              // ln(배수). 원금(0)은 늘 범위 안에 둔다
      ks.forEach(function (k) { [0, 1].forEach(function (x) { var v = logAt(k, x) * years; lo = Math.min(lo, v); hi = Math.max(hi, v); }); });
      var pad = Math.max((hi - lo) * 0.05, 0.02); lo -= pad; hi += pad;
      var X = function (x) { return M.l + x * (W - M.l - M.r); };
      var Y = function (lv) { return M.t + (hi - lv) / (hi - lo) * (H - M.t - M.b); };
      geo = { M: M, W: W };
      var svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H });
      var ink = css("--ink-label"), rule = css("--rule-soft");
      var ticks = [];
      for (var e10 = -4; e10 <= 6; e10++) [1, 2, 5].forEach(function (m) { ticks.push(m * Math.pow(10, e10)); });
      ticks = ticks.filter(function (t) { return Math.log(t) >= lo && Math.log(t) <= hi; });
      if (ticks.length > 9) ticks = ticks.filter(function (t) { return Math.abs(Math.log10(t) - Math.round(Math.log10(t))) < 1e-9; });
      if (ticks.length < 3) {                          // 짧은 기간은 범위가 좁아 1-2-5 눈금이 모자라다. 배수를 고른 간격으로 나눈다
        var a0 = Math.exp(lo), a1 = Math.exp(hi);
        var step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1].filter(function (s) { return (a1 - a0) / s <= 8; })[0] || 1;
        ticks = [];
        for (var t = Math.ceil(a0 / step) * step; t <= a1 + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
      }
      ticks.forEach(function (t) {
        var y = Y(Math.log(t));
        svg.appendChild(el("line", { x1: M.l, x2: W - M.r, y1: y, y2: y, stroke: rule, "stroke-width": 1 }));
        svg.appendChild(el("text", { x: M.l - 7, y: y + 4, fill: ink, "text-anchor": "end", "class": "ax" }, times(t)));
        svg.appendChild(el("text", { x: W - M.r + 7, y: y + 4, fill: ink, "class": "ax" }, times(t)));
      });
      svg.appendChild(el("line", { x1: M.l, x2: W - M.r, y1: Y(0), y2: Y(0), stroke: css("--e-base"), "stroke-width": 1, "stroke-dasharray": "4 4" }));
      /* 위 띠: 켜 둔 계열 가운데 확률 구간마다 1등 계열의 이름. 구간 경계에 점선을 내린다. */
      env.forEach(function (e, n) {
        var a = X(e[0]), b = X(e[1]);
        if (n > 0) svg.appendChild(el("line", { x1: a, x2: a, y1: M.t - 18, y2: H - M.b, stroke: css("--rule"), "stroke-dasharray": "3 3" }));
        if (b - a > 40) svg.appendChild(el("text", { x: (a + b) / 2, y: M.t - 8, fill: colorOf(e[2]), "text-anchor": "middle", "class": "seg" },
                                         LABEL[e[2]].split(" ")[0]));
      });
      [0, 1].forEach(function (x) {
        svg.appendChild(el("line", { x1: X(x), x2: X(x), y1: M.t - 18, y2: H - M.b + 4, stroke: css("--ink-soft"), "stroke-width": 2 }));
      });
      svg.appendChild(el("text", { x: X(0), y: H - M.b + 36, fill: ink, "text-anchor": "middle", "class": "end" }, "나스닥"));
      svg.appendChild(el("text", { x: X(1), y: H - M.b + 36, fill: ink, "text-anchor": "middle", "class": "end" }, "현실 침체장"));
      /* 기준선이 플레이버 선에 가리지 않게 보유 둘을 뒤에 그린다(DRAW 순서). */
      DRAW.filter(function (k) { return S[k] && shown[k] !== false; }).forEach(function (k) {
        var attrs = { x1: X(0), y1: Y(logAt(k, 0) * years), x2: X(1), y2: Y(logAt(k, 1) * years),
                      stroke: colorOf(k), "stroke-width": 1.5 };
        if (DASH[k]) attrs["stroke-dasharray"] = DASH[k];
        svg.appendChild(el("line", attrs));
      });
      var cx = X(q);
      svg.appendChild(el("line", { x1: cx, x2: cx, y1: M.t - 2, y2: H - M.b, stroke: css("--line"), "stroke-width": 1.5 }));
      /* 세로선 아래에 그 자리의 상승 경향을 적는다 (`@arngard` 2026-10-15). 축 근처에서는 그래프 밖으로 나가지 않게 붙인다. */
      var lx = Math.min(W - 40, Math.max(40, cx));
      svg.appendChild(el("text", { x: lx, y: H - M.b + 18, fill: css("--ink"), "text-anchor": "middle", "class": "ax" }, "상승 경향 " + pct(1 - q, 0)));
      ks.forEach(function (k) {
        svg.appendChild(el("circle", { cx: cx, cy: Y(logAt(k, q) * years), r: 4, fill: colorOf(k), stroke: css("--paper"), "stroke-width": 2 }));
      });
      host.textContent = "";
      host.appendChild(svg);
    }

    function paint() {
      var ks = on(), env = envelope(ks), best = bestAt(ks, q);
      keys.forEach(function (k) {
        cells[k].textContent = times(multAt(k, q));
        var row = cells[k].parentNode;
        row.classList.toggle("off", shown[k] === false);
        row.classList.toggle("best", k === best);
        if (!FIXED[k]) row.setAttribute("aria-pressed", shown[k] === false ? "false" : "true");
      });
      byId("cAt").textContent = "상승 경향 " + pct(1 - q) + ". 켜 둔 계열 가운데 " + years + "년 뒤 기대 배수가 가장 큰 계열은 " +
        LABEL[best] + "(" + times(multAt(best, q)) + ", 연 " + pct(rateAt(best, q)) + ")이다.";
      byId("cPickYears").textContent = years;
      var host = byId("cChart");
      host.setAttribute("aria-valuenow", (q * 100).toFixed(1));
      host.setAttribute("aria-valuetext", byId("cAt").textContent);
      pickTable(env);
      draw(ks, env);
    }

    function setFromX(clientX) {
      if (!geo) return;
      var r = byId("cChart").getBoundingClientRect();
      var x = (clientX - r.left - geo.M.l) / (geo.W - geo.M.l - geo.M.r);
      q = Math.min(1, Math.max(0, x));
      paint();
    }

    function build() {
      built = true;
      if (!D) { byId("cAt").textContent = "자료가 없다."; return; }
      /* 테스트 탭과 같은 시각 표기(생성, 자료. 차례는 `@arngard` 2026-10-22)로 시작한다 (`@arngard` 2026-10-14). 고정값이라 생성은 값을 계산한 시각이고,
         날마다 갱신되는 값이 아니므로 23시간 경과 표시(markGenerated)는 하지 않는다. */
      /* 자료마다 이름과 기간을 풀어 쓴다. 현실 침체장으로 묶지 않는다 (`@arngard` 2026-10-22). */
      byId("cStamp").innerHTML = seg("생성", D.measured) + segList("자료", ["나스닥 " + D.span.nasdaq].concat(D.span.down.split(", ")));
      legend();
      spans();
      var host = byId("cChart"), dragging = false;
      host.addEventListener("pointerdown", function (e) {
        dragging = true; host.setPointerCapture(e.pointerId); setFromX(e.clientX);
      });
      host.addEventListener("pointermove", function (e) { if (dragging) setFromX(e.clientX); });
      var stop = function () { dragging = false; };
      host.addEventListener("pointerup", stop);
      host.addEventListener("pointercancel", stop);
      host.addEventListener("keydown", function (e) {
        var d = { ArrowLeft: -1, ArrowRight: 1, Home: -1000, End: 1000 }[e.key];
        if (!d) return;
        e.preventDefault();
        q = Math.min(1, Math.max(0, Math.round((q + d * (e.shiftKey ? 0.05 : 0.01)) * 1000) / 1000));
        paint();
      });
      /* 높이가 폭을 따르므로 상자 크기가 바뀔 때마다 다시 그린다. 창 크기 이벤트만으로는 폭이 바뀐 것을 놓칠 수 있다. */
      var lastW = 0;
      /* 다시 그린 높이 때문에 세로 스크롤바가 생기고 사라지며 폭이 두 값 사이를 오가면 끝없이 다시 그린다. 직전 폭으로
         곧바로 돌아오는 변화(1초 안)는 그리지 않는다. */
      var prevW = 0, lastAt = 0;
      var redraw = function () {
        var w = host.clientWidth;
        if (box.hidden || w === lastW) return;
        var now = Date.now();
        if (w === prevW && now - lastAt < 1000) return;
        prevW = lastW; lastW = w; lastAt = now;
        paint();
      };
      if (window.ResizeObserver) new ResizeObserver(redraw).observe(host);
      else window.addEventListener("resize", redraw);
    }

    /* 숨은 탭은 폭이 0이라 보일 때 그린다. */
    function show() {
      if (!built) build();
      if (D) setTimeout(paint, 0);
    }
    return { show: show };
  }

  /* 분석 탭의 장세별 지표 구획 (`@arngard` 2026-10-14, 2026-10-27에 분석 탭으로 옮김). 생성기가 페이지에 넣은 고정값(metricsData)으로
     장세 단추가 고른 묶음의 표 하나를 그린다. 묶음마다 표를 쌓으면 같은 꼴의 표가 길게 반복되기 때문이다 (`@arngard` 2026-10-27).
     열마다 값들의 평균과 표준편차로 정규분포를 잡고, 좋은 쪽으로의 누적 확률이 80% 이상인 칸을 밝게 표시한다
     (`@arngard` 2026-10-14). 1등 하나가 아니라 뚜렷하게 앞선 값만 표시하려는 것이다. 좋은 쪽은 지표마다 다르다
     (낙폭과 DsG는 0에 가까울수록, 울서와 WnH90은 작을수록). */
  function Metrics(box) {
    var byId = function (id) { return box.querySelector("[data-m=\"" + id + "\"]"); };
    var src = document.getElementById("metricsData");
    var D = src ? JSON.parse(src.textContent) : null;
    var built = false;
    var num = function (d, unit) { return function (v) { return v === null || v === undefined ? "-" : v.toFixed(d) + (unit || ""); }; };
    var COL = {
      growth: ["성장률", num(2, "%"), 1, "세후 연 성장률. 기간 전체의 추세로 재어 시작과 끝 시점의 우연에 덜 흔들린다."],
      mdd: ["최대낙폭", num(1, "%"), 1, "평가금이 직전 고점보다 가장 크게 떨어졌던 비율."],
      sharpe: ["샤프", num(2), 1, "현금보다 더 번 수익이 변동성에 비해 얼마나 큰지. 높을수록 좋다."],
      sortino: ["소르티노", num(2), 1, "샤프와 같되 하락 쪽 변동성만 따진 값. 높을수록 좋다."],
      calmar: ["칼마", num(2), 1, "가장 큰 하락에 비해 수익이 얼마나 큰지. 높을수록 좋다."],
      ulcer: ["울서", num(1), -1, "고점 아래로 깊고 오래 빠져 있을수록 커지는 값(%). 작을수록 좋다."],
      wnh90: ["WnH90", function (v) { return v === null ? "10년 초과" : v.toFixed(1) + "년"; }, -1, "QQQ 보유와 원금을 90% 확률로 모두 이기려면 몇 년을 보유해야 하는지. 짧을수록 좋다."],
      ntg: ["NtG62", num(2, "%"), 1, "중립 성장률. 나스닥과 현실 침체장 사이, 상승 경향 62%에서의 연 성장률. 분석 탭의 기대에 따른 선택 참고."],
      dsg: ["DsG", num(2, "%"), 1, "하방 성장률. 원금을 잃는 장세 구간 한가운데의 연 성장률. 0에 가까울수록 좋다."]
    };
    /* 수익은 성장률 하나로 낸다. CAGR은 실제 결과를 말하는 진입일 탐색에만 쓴다 (`@arngard` 2026-10-14). */
    var NASDAQ = ["growth", "mdd", "sharpe", "sortino", "calmar", "ulcer", "wnh90", "ntg", "dsg"];
    var REGIME = ["growth", "mdd", "sharpe", "sortino", "calmar", "ulcer"];

    /* 표준정규분포의 누적 확률. erf는 Abramowitz-Stegun 7.1.26 근사(오차 1.5e-7). */
    function phi(z) {
      var x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
      var erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
      return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
    }
    var LEVEL = 0.8;

    function table(rows, cols) {
      var good = {};                                   // good[c][k]: 그 칸이 밝은가
      cols.forEach(function (c) {
        var dir = COL[c][2];
        var ks = D.series.filter(function (k) {
          var v = rows[k][c];
          return v !== null && v !== undefined && !(c === "wnh90" && !(k in D.labels_flavor));
        });
        var xs = ks.map(function (k) { return rows[k][c]; });
        var mu = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
        var sd = Math.sqrt(xs.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / (xs.length - 1));
        good[c] = {};
        ks.forEach(function (k) { good[c][k] = sd > 0 && phi(dir * (rows[k][c] - mu) / sd) >= LEVEL; });
      });
      /* 색 아이콘은 이름과 다른 칸에 두고 그 칸만 왼쪽에 붙인다. 가로로 스크롤하면 이름은 밀려나고 아이콘은 남는다. */
      var head = "<thead><tr><th class=\"ki\"></th><th class=\"name\">계열</th>" + cols.map(function (c) {
        return "<th class=\"num\" title=\"" + COL[c][3] + "\">" + COL[c][0] + "</th>";
      }).join("") + "</tr></thead>";
      var body = D.series.map(function (k) {
        return "<tr><td class=\"ki\"><i class=\"key\" style=\"background:" + css("--e-" + k.toLowerCase()) + "\"></i></td>" +
          "<td class=\"name\"" + (D.notes && D.notes[k] ? " title=\"" + D.notes[k] + "\"" : "") + ">" + D.labels[k] + "</td>" +
          cols.map(function (c) {
            var v = rows[k][c];
            var text = (c === "wnh90" && !(k in D.labels_flavor)) ? "-" : COL[c][1](v);
            return "<td class=\"num" + (good[c][k] ? " best" : "") + "\">" + text + "</td>";
          }).join("") + "</tr>";
      }).join("");
      return "<table>" + head + "<tbody>" + body + "</tbody></table>";
    }

    /* 장세 단추. 차례는 판단의 무게 순이 아니라 현실에 가까운 정도와 포함 관계를 따른다(미국장은 현실 상승장에 든다). */
    function regimes() {
      /* 비현실장에서 손실이 나는 까닭을 함께 밝힌다 (`@arngard` 2026-10-23). */
      return [
        { k: "nasdaq", name: "나스닥", cols: NASDAQ, lead: "나스닥100 1990 ~을 한 번 운용한 값이다. 현황 탭의 백테스트 지표를 모두 보인 것이다. " +
          "각 플레이버는 이 주가 자료를 큰 비중으로 고려하여 설정했기 때문에 과적합되었을 수 있다. 다른 장세의 값도 함께 참고하는 것이 좋다." },
        { k: "us", name: "미국장 2종", cols: REGIME, lead: D.us_paths.join(", ") + "의 평균이다." },
        { k: "up", name: "현실 상승장 5종", cols: REGIME, lead: D.up_paths.join(", ") + "의 평균이다." },
        { k: "down", name: "현실 침체장 2종", cols: REGIME, lead: D.down_paths.join(", ") + "의 평균이다." },
        { k: "unreal", name: "비현실장 5종", cols: REGIME, lead: D.unreal_paths.join(", ") + "의 평균이다. 가상의 합성 장세라서 기업 이익 " +
          "성장이라는 실체적 추세가 없다. 거기에 세금과 변동성 손실이 더해진다. 따라서 기본적으로 손실이 나온다." }
      ];
    }

    function build() {
      built = true;
      if (!D) { byId("mStamp").textContent = "자료가 없다."; return; }
      byId("mStamp").innerHTML = seg("생성", D.measured);       // 다른 탭과 같은 시각 표기 (`@arngard` 2026-10-14)
      var R = regimes(), el = byId("mRegimes");
      function paint(r) {
        byId("mLead").textContent = r.lead;
        byId("mTable").innerHTML = table(D[r.k], r.cols);
      }
      el.innerHTML = R.map(function (r, i) {
        return "<button type=\"button\" data-v=\"" + r.k + "\"" + (i === 0 ? " class=\"on\"" : "") + ">" + r.name + "</button>";
      }).join("");
      el.addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b || b.classList.contains("on")) return;
        el.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
        paint(R.filter(function (r) { return r.k === b.dataset.v; })[0]);
      });
      paint(R[0]);
    }

    return { show: function () { if (!built) build(); } };
  }

  /* 분석 탭의 과적합 시험 표 (`@arngard` 2026-10-30). 값은 페이지의 고정 글이고, 값마다 기준 단추가 고른 행과의 차이를 괄호로
     덧붙인다. 기준 행 자신은 괄호를 비운다. 괄호 자리는 칸 안의 고정폭 상자라, 값은 그 상자 왼쪽에서 오른쪽 선이 맞고 괄호는 왼쪽이
     맞는다. 머리글에도 같은 상자를 넣어 열 이름의 오른쪽 끝을 값에 맞춘다. */
  function Overfit(box) {
    var el = box.querySelector("[data-o=\"oBase\"]"), table = box.querySelector("[data-o=\"oTable\"]");
    var rows = [];
    Array.prototype.forEach.call(table.querySelectorAll("tbody tr"), function (tr) {
      var cells = [];
      tr.querySelectorAll("td.num").forEach(function (td) {
        var diff = document.createElement("span");
        diff.className = "diff";
        cells.push({ v: parseFloat(td.textContent), diff: diff });
        td.appendChild(diff);
      });
      rows.push({ k: tr.dataset.v, cells: cells });
    });
    table.querySelectorAll("th.num").forEach(function (th) { th.insertAdjacentHTML("beforeend", "<span class=\"diff\"></span>"); });

    function paint(base) {
      var ref = rows.filter(function (r) { return r.k === base; })[0].cells;
      rows.forEach(function (r) {
        r.cells.forEach(function (c, i) {
          var d = c.v - ref[i].v;
          c.diff.innerHTML = c === ref[i] ? "" : "(<span class=\"" + (d > 0 ? "up" : d < 0 ? "down" : "") + "\">" +
            (d > 0 ? "+" : "") + d.toFixed(2) + "%p</span>)";
        });
      });
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b || b.classList.contains("on")) return;
      el.querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
      paint(b.dataset.v);
    });
    paint(el.querySelector("button.on").dataset.v);
  }

  /* 테스트 탭마다 template을 복제해 채우고, 그 탭에 해당하지 않는 data-only 요소를 걷어 낸다. */
  /* events: 진입일 탐색 차트에 시장 사건 표식을 붙이는지. 닛케이 테스트는 가상 주가라 붙이지 않는다 (`@arngard` 2026-10-22). */
  var SETS = { nasdaq: { index: "나스닥100", events: true }, nikkei: { index: "닛케이 가상" } };
  var tpl = document.getElementById("eSet"), panels = {}, current = "nasdaq";
  root.querySelectorAll(".cset").forEach(function (box) {
    var name = box.dataset.set;
    /* 분석 탭은 장세별 선택 구획들과 장세별 지표 구획이 한 묶음을 함께 쓴다 (`@arngard` 2026-10-27). */
    if (name === "perf") {
      var choice = Choice(box), metrics = Metrics(box);
      Overfit(box);
      panels.perf = { show: function () { choice.show(); metrics.show(); } };
      return;
    }
    box.appendChild(tpl.content.cloneNode(true));
    box.querySelectorAll("[data-only]").forEach(function (el) { if (el.dataset.only !== name) el.remove(); });
    panels[name] = Panel(box, SETS[name]);
  });

  /* 탭 줄의 플레이버 비교의 탭 셋(나스닥 테스트, 닛케이 테스트, 분석)이 묶음 하나씩을 연다 (`@arngard` 2026-10-15, 2026-10-27). 화면 전환은 tripod.js가 맡는다. */
  function showSet(name) {
    current = name;
    root.querySelectorAll(".cset").forEach(function (box) { box.hidden = box.dataset.set !== name; });
    panels[name].show();
  }
  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { if (tab.dataset.view === "comparison") showSet(tab.dataset.set); });
  });
  var on = document.querySelector(".tab.on");
  if (on && on.dataset.view === "comparison") showSet(on.dataset.set);

  /* 페이지가 다 열리면 테스트 탭 둘의 자료를 차례로 미리 받아 둔다 (`@arngard` 2026-10-23). 탭을 열 때 받으면 그때마다
     기다려야 하기 때문이다. 탭을 열지 않는 방문자도 두 자료(압축 전송 약 0.8MB)를 받는다. */
  function prefetch() { panels.nasdaq.load().then(function () { return panels.nikkei.load(); }); }
  if (document.readyState === "complete") setTimeout(prefetch, 0);
  else window.addEventListener("load", function () { setTimeout(prefetch, 0); });

  /* 검산용. 백테스트가 같은 입력으로 낸 값과 비교할 때 쓴다 (tripod-flavor-comparison/assumptions.md).
     기본은 나스닥 테스트 탭이고, 닛케이 테스트는 FlavorComparison.nikkei로 부른다. */
  window.FlavorComparison = { simulate: panels.nasdaq.simulate, data: panels.nasdaq.data, nikkei: panels.nikkei };
})();
