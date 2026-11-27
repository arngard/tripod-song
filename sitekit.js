/* 사이트 화면 사이의 공용 코드. 브라우저에서는 전역 SiteKit이고, 시험(test_tripod.py)은 node로 불러 쓴다. 이 사이트의 화면(메인 web/main.js,
   현황 web/tripod.js, 테스트와 분석 탭 web/comparison.js, 역사 반복 탭 web/replay.js)이 함께 쓴다. 다른 도구와 함께 쓰는 차트 공통 코드는
   공유 모듈의 chartkit.js다. DOM과 차트 라이브러리를 쓰는 함수도 있지만 부를 때만 쓴다. 파일을 읽는 것만으로는 DOM에 손대지 않는다. */
var SiteKit = (function () {
  "use strict";

  /* 세금을 반영한 평가금 계산. tripod-song-backtest/backtest/simulate.py의 simulate를 연산 순서까지 그대로 옮긴 것이다. 순서를 바꾸면
     백테스트 값과 비트 수준에서 어긋난다 (명세: tripod-flavor-comparison/assumptions/backtest-parity.md).
     i0 종가에 시드를 넣고 i1까지 돈다(금액은 원). 시드는 보유 주식, 예비금(현금), 세무 유보금으로 이루어진다.
     매도로 그해 예상 양도세가 늘면 늘어난 만큼 예비금에서 세무 유보금으로 옮기고, 같은 해 손실로 줄면
     줄어든 만큼 예비금으로 되돌린다. 예상 양도세는 그해 누적 실현 손익에 연 공제(deduct)와 세율(cgt)을
     적용한 값이다. 유보금으로는 사지 못하고 이자도 붙지 않으며, 수익률과 차트에 넣지 않는다. 납부일에
     유보금이 시드를 떠나지만 차트와 수익률에 영향이 없으므로 따로 계산하지 않는다.
     inp는 날마다의 배열 fx(원/달러), rate(단기금리, 소수), yr(세금의 연도), ret({배율: 일간 수익})과 상수 seed, dt, int_tax, cgt,
     deduct, cost다. 배열의 색인은 i0, i1과 같은 날짜 색인이다. wantAt(i)는 그날 들고 있어야 할 배분이고 weights[배분]은 {배율: 비중}이다.
     돌려주는 배열은 i0부터의 날마다 값이다. acct는 보유 주식과 예비금의 원화 평가액(유보금 제외), liq는 그날 보유분까지 전부 팔았을 때
     더 생기는 예상 양도세를 뺀 값, gain은 원화 미실현 손익, swAt과 taxAt은 그날까지의 배분 전환 수와 유보한 양도세 누계다. */
  function simulate(inp, i0, i1, wantAt, weights) {
    var fx = inp.fx, rate = inp.rate, yr = inp.yr, ret = inp.ret, n = i1 - i0 + 1;
    var pos = new Map(), basis = new Map(), cash = inp.seed / fx[i0], cur = null;
    var realized = new Map(), reserveY = new Map();
    var taxReserved = 0, switches = -1;
    var acct = new Array(n), liq = new Array(n), gain = new Array(n), swAt = new Array(n), taxAt = new Array(n);
    for (var i = i0; i <= i1; i++) {
      var y = yr[i], m, v, gross;
      if (i > i0) {
        pos.forEach(function (val, key) { pos.set(key, val * (1 + ret[key][i])); });
        cash += cash * rate[i] * inp.dt * (1 - inp.int_tax);
      }
      var want = wantAt(i);
      if (want !== cur) {                                // 전량 청산, 세무 유보금 조정, 새 배분 매수
        var w = weights[want], sw = 0;
        if (!w) throw new Error("Unknown allocation: " + want + ". 배분의 비중을 모른다.");
        gross = 0; pos.forEach(function (val) { gross += val; });
        pos.forEach(function (val, key) {
          realized.set(y, (realized.get(y) || 0) + val * fx[i] - basis.get(key));
        });
        var due = inp.cgt * Math.max(0, (realized.get(y) || 0) - inp.deduct);
        var delta = due - (reserveY.get(y) || 0);             // 음수면 같은 해 손실로 줄어든 만큼 예비금으로 되돌린다
        reserveY.set(y, due);
        taxReserved += delta;
        var total = cash + gross - delta / fx[i];
        for (m in w) sw += w[m];
        var buy = total * sw;
        total -= (gross + buy) * inp.cost;
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
      var liqTax = inp.cgt * Math.max(0, r + unreal - inp.deduct) - inp.cgt * Math.max(0, r - inp.deduct);
      acct[i - i0] = v;
      liq[i - i0] = v - liqTax;
      gain[i - i0] = unreal;
      swAt[i - i0] = switches;
      taxAt[i - i0] = taxReserved;
    }
    return { acct: acct, liq: liq, gain: gain, taxReserved: taxReserved, switches: switches, swAt: swAt, taxAt: taxAt };
  }

  /* ---- 보는 구간의 끝 ----
     기간 버튼(applyView)과 시간 창 띠 끌기가 잡는 구간의 오른쪽 끝은 화면마다 다르다. 현황(tripod.js)은 끝 봉 다음 빈 칸의 오른쪽
     가장자리(n + 0.5)까지 잡고, 메인(main.js)은 끝 봉의 오른쪽 가장자리(n - 0.5)까지다. 두 조작이 같은 값을 써야 띠를 오른쪽 끝까지
     끈 구간이 기간 버튼의 최신 구간과 같다. 시험(test_tripod.py check_strip_edges)이 아래 셋이 맞물리는지 본다. */
  var EDGE = { status: 0.5, main: -0.5 };
  /* 마지막 len개 봉이 보이는 구간. n은 오른쪽 끝 봉의 번호 + 1이다. */
  function view(n, len, edge) { return { from: Math.max(0, n - len) - 0.5, to: n + edge }; }
  /* 띠의 봉 위치 at을 가운데로 하는 r과 같은 폭의 구간. 왼쪽은 첫 봉의 왼쪽 가장자리, 오른쪽은 view의 끝(n + edge)을 넘지 않는다. */
  function stripRange(at, r, n, edge) {
    var span = r.to - r.from, from = Math.max(-0.5, Math.min(n + edge - span, at - span / 2));
    return { from: from, to: from + span };
  }
  /* 현황이 기억하는 보는 구간(tripod.js trackWindow). 오른쪽 끝이 마지막 봉에 닿아 있으면 최신을 보는 중이다. end는 오른쪽 끝 봉의
     번호다. view는 끝 봉 다음 칸의 오른쪽 가장자리(끝 + 1.5)까지 잡으므로 그 칸을 빼야 되살릴 때마다 하루씩 밀리지 않는다.
     그 빈 칸 없이 마지막 봉을 오른쪽 끝에 붙인 구간(마지막 봉의 가운데 n - 1이 보임)도 최신이다. 과거 구간을 되살린 to(끝 + 1.5)는
     끝이 n - 3 이하라 n - 1.5를 넘지 않아 최신으로 뒤집히지 않는다. */
  function statusWindow(to, n) {
    return { atLatest: to >= n - 1, end: Math.max(0, Math.min(n - 1, Math.floor(to - 1))) };
  }

  /* ---- 시간 창 띠 ----
     차트 아래에 자료 전체를 로그 눈금으로 깔고 지금 보는 구간을 상자로 덮는다. 누르거나 끌면 그 자리로 구간을 옮긴다(명세:
     tripod-song-site/chart-rules.md "시간 창 띠"). 높이와 위아래 여백은 어느 띠나 같다. */
  var STRIP_H = 70, STRIP_M = { l: 0, r: 0, t: 6, b: 20 };
  function stripX(W, n) { var m = STRIP_M; return function (i) { return m.l + i / (n - 1) * (W - m.l - m.r); }; }

  /* 띠의 SVG. 폭 W에 n개 점을 깐다. value(i)가 없거나 유한하지 않거나 0 이하인 날은 선을 끊는다. year(i)는 그날의 연도이고, 해가 바뀌는 첫 날에
     연도를 단다. 앞 라벨과 40픽셀보다 가까우면 건너뛰고 양 끝에서 잘리는 라벨은 뺀다. 값이 하나도 없으면 null이다. */
  function stripSvg(W, n, value, year, ink, line) {
    if (!W || n < 2) return null;
    var m = STRIP_M, H = STRIP_H, lo = Infinity, hi = -Infinity, i, v;
    for (i = 0; i < n; i++) { v = value(i); if (v === null || v === undefined || !isFinite(v) || v <= 0) continue; v = Math.log(v); if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) return null;
    if (hi === lo) hi = lo + 1;
    var X = stripX(W, n);
    var Y = function (v) { return m.t + (1 - (Math.log(v) - lo) / (hi - lo)) * (H - m.t - m.b); };
    var step = Math.max(1, Math.floor(n / Math.max(1, W - m.l - m.r)));
    var p = "", pen = false;
    for (i = 0; i < n; i += step) {
      v = value(i);
      if (v === null || v === undefined || !isFinite(v) || v <= 0) { pen = false; continue; }   /* 빈 날은 선을 끊는다 */
      p += (pen ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1);
      pen = true;
    }
    var s = "<svg viewBox=\"0 0 " + W + " " + H + "\"><path d=\"" + p + "\" fill=\"none\" stroke=\"" + ink + "\" stroke-width=\"1\"/>";
    var cur = year(0), last = -Infinity;
    for (i = 1; i < n; i++) {
      var y = year(i);
      if (y === cur) continue;
      cur = y;
      if (X(i) - last < 40 || X(i) < m.l + 16 || X(i) > W - m.r - 16) continue;
      s += "<text x=\"" + X(i).toFixed(1) + "\" y=\"" + (H - 4) + "\" text-anchor=\"middle\">" + y + "</text>";
      last = X(i);
    }
    return s + "<rect class=\"box\" y=\"" + (m.t - 2) + "\" height=\"" + (H - m.t - m.b + 4) + "\" fill=\"" + line +
      "\" fill-opacity=\".18\" stroke=\"" + ink + "\" stroke-width=\"1.5\" rx=\"2\"/></svg>";
  }

  /* 띠 요소 el에 띠를 그리고 el.geo({W, m, n, X})를 둔다. plot은 위 차트의 그림 영역(세로축 왼쪽) 폭이다. 그리지 못하면 비우고 null이다.
     그림 영역 폭이 아직 0이면(페이지를 막 열어 차트가 크기를 받기 전) 그리지 않는다. 상자 폭으로 대신하면 띠가 세로축 자리까지 넓게
     깔린다. 차트가 크기를 받으면 시간축 크기 변화 신호가 다시 그린다. */
  function strip(el, plot, n, value, year) {
    el.geo = null;
    var svg = el.clientWidth && plot && n >= 2 ? stripSvg(plot, n, value, year, ChartKit.css("--ink-soft"), ChartKit.css("--line")) : null;
    if (!svg) { el.innerHTML = ""; return null; }
    /* 띠 요소의 폭을 차트 그림 영역(세로축 왼쪽)에 맞춘다. 세로축 아래는 띠 밖의 빈자리가 되어 누름과 끌기를 받지 않고,
       모바일에서 그 자리를 잡고 끌면 페이지가 스크롤된다(`@arngard` 2026-11-27). */
    el.style.width = plot + "px";
    el.innerHTML = svg;
    el.geo = { W: plot, m: STRIP_M, n: n, X: stripX(plot, n) };
    return el.geo;
  }

  /* 띠의 상자를 봉 위치 i0 ~ i1에 놓는다. 띠 밖으로 나가는 쪽은 띠 끝에 붙인다. */
  function stripBox(el, i0, i1) {
    var g = el.geo, box = el.querySelector(".box");
    if (!g || !box) return;
    var x0 = g.X(Math.max(0, i0)), x1 = g.X(Math.min(g.n - 1, i1));
    box.setAttribute("x", x0.toFixed(1));
    box.setAttribute("width", Math.max(2, x1 - x0).toFixed(1));
  }

  /* 누른 자리의 봉 위치(0 ~ n - 1, 소수). */
  function stripAt(el, ev) {
    var g = el.geo, rect = el.getBoundingClientRect(), px = (ev.clientX - rect.left) * g.W / rect.width;
    return (px - g.m.l) / (g.W - g.m.l - g.m.r) * (g.n - 1);
  }

  /* 띠를 누르거나 끌면 go(ev)를 부른다. 띠가 그려져 있지 않은 동안(el.geo가 없을 때)은 부르지 않는다. */
  function wireStrip(el, go) {
    var down = false;
    el.addEventListener("pointerdown", function (ev) { if (!el.geo) return; down = true; el.setPointerCapture(ev.pointerId); go(ev); });
    el.addEventListener("pointermove", function (ev) { if (down && el.geo) go(ev); });
    el.addEventListener("pointerup", function () { down = false; });
    el.addEventListener("pointercancel", function () { down = false; });
  }

  /* ---- 차트 위의 그리기 층과 시장 사건 ---- */

  /* 배분의 색(4색). 현금 빨강, QQQ 노랑, 혼합 파랑, TQQQ 녹색. 배분이 바뀐 날의 세로선과 역사 반복의 접합일 점선이 쓴다.
     글자의 색은 prerender.ALLOC_CLASS. */
  var ALLOC_VAR = { "현금 100%": "--a-cash", "QQQ 100%": "--a-qqq", "QQQ 50% + QLD 50%": "--a-mix", "TQQQ 100%": "--a-tqqq" };

  /* 차트 상자 host의 그리기 층을 비워 돌려준다. 없으면 만든다. cls는 공백으로 나눈 클래스 목록이고, 모두 가진 층을 다시 쓴다. */
  function layer(host, cls) {
    var el = host.querySelector("." + cls.split(" ").join("."));
    if (!el) { el = document.createElement("div"); el.className = cls; host.appendChild(el); }
    el.textContent = "";
    return el;
  }

  /* 시장 사건(tripod/events.py). 페이지에 실린 목록이고 없으면 비어 있다. */
  function events() {
    var el = document.getElementById("eventsData");
    try { return el ? JSON.parse(el.textContent) : []; } catch (e) { return []; }
  }

  /* 사건 구간을 옅은 띠로 칠하고 띠 위에 말풍선 태그로 이름을 단다. 띠는 캔버스 밑 층(bands, .evbands), 태그는 맨 위 층(tags, .evtags)이다.
     돌려준 함수에 보이는 띠 부분의 왼쪽, 오른쪽 x(그림 영역 폭 W 안)와 이름(태그를 달지 않으면 null)을 넘긴다. 태그는 보이는 띠 부분의
     가운데에 달고, 앞 태그와 겹치면 한 줄 아래로 내린다. 어떤 사건을 어디에 칠할지는 화면이 정한다. */
  function eventPainter(bands, tags, W) {
    var ends = [];
    return function (x0, x1, name) {
      var band = document.createElement("b");
      band.style.left = x0 + "px";
      band.style.width = Math.max(2, x1 - x0) + "px";
      bands.appendChild(band);
      if (!name) return;
      var tag = document.createElement("span");
      tag.textContent = name;
      tags.appendChild(tag);
      var w = tag.offsetWidth, x = Math.min(Math.max((x0 + x1) / 2, w / 2 + 2), W - w / 2 - 2), row = 0;
      while (ends[row] !== undefined && ends[row] > x - w / 2 - 4) row++;
      ends[row] = x + w / 2;
      tag.style.left = x + "px";
      tag.style.top = 6 + row * 24 + "px";
    };
  }

  /* ---- 배수 구획 ----
     테스트 탭의 진입일 탐색(comparison.js)과 역사 반복 탭의 배수 차트(replay.js)가 같은 모양을 쓴다(명세: tripod-replay.md "반복 구간의
     배수"). 분석 탭의 장세별 선택(comparison.js Choice)도 계열 순서와 범례를 함께 쓴다. */

  /* 범례, 90% 범위 버튼, 표의 순서. 기준인 QQQ와 TQQQ 보유를 앞에 두고 플레이버는 flavor.py의 정의 순서를 따른다.
     서버가 주는 flavors를 읽지 않는 고정 목록이라, 플레이버를 더하면(Demeter 등) 여기, DRAW, 색 토큰을 함께 고친다. */
  var KEYS = ["QQQ", "TQQQ", "persephone", "phrixus", "amphion", "icarus", "song", "omphalos"];
  /* 차트에 선을 얹는 순서. 뒤에 얹은 선이 위에 그려진다. 기준선인 QQQ가 플레이버 선에 가리지 않게 보유 둘을 뒤에 둔다. */
  var DRAW = ["phrixus", "amphion", "icarus", "song", "omphalos", "persephone", "QQQ", "TQQQ"];
  var HOLDS = { QQQ: 1, TQQQ: 1 };
  var FIXED = { QQQ: true };        // 끌 수 없는 계열. 모든 비교의 기준선이다
  var FLOOR = 0.01;                 // 세로축 하한(배)
  /* 키의 화면 표기. 첫 글자만 올리므로 QQQ, TQQQ는 그대로다(tripod/flavor.py의 title과 같다). */
  function title(k) { return k.charAt(0).toUpperCase() + k.slice(1); }
  /* 계열의 색 토큰(site.css의 --e-*). 오르내림의 뜻은 없고 계열끼리의 상대 비교가 목적이다. 플레이버마다 색을 둔다(Phrixus 파랑,
     Icarus 빨강, Amphion 녹색, Song 노랑, Persephone 보라). */
  function color(k) { return "--e-" + k.toLowerCase(); }

  function times(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    if (v >= 100) return v.toFixed(0) + "배";
    if (v >= 10) return v.toFixed(1) + "배";
    if (v >= 0.01) return v.toFixed(2) + "배";
    return v.toPrecision(2) + "배";
  }
  function pct(v, d) { return v === null || v === undefined ? "-" : (v * 100).toFixed(d === undefined ? 1 : d) + "%"; }
  function won(v) { return (v / 1e8).toFixed(2) + "억 원"; }

  /* 계열 선. QQQ는 모든 비교의 기준선이라 흰 실선으로 두고, TQQQ는 회색 점선으로 물러서 둔다. 선은 모두 1픽셀이다. 라이브러리의
     점선(Dotted)은 굵기만큼 끊어 1픽셀에서는 실선처럼 보이므로, 굵기의 두 배로 끊는 Dashed로 2픽셀 점, 2픽셀 빈칸을 낸다. 범례 견본도
     같은 무늬로 그린다(legendToggles). 세로축은 0.01배 아래를 자른다. extra는 옵션을 덮어쓴다. */
  function growLine(chart, key, extra) {
    var LS = window.LightweightCharts.LineStyle;
    var opts = ChartKit.line({
      color: ChartKit.css(color(key)), lineWidth: 1, lineStyle: key === "TQQQ" ? LS.Dashed : LS.Solid,
      priceFormat: { type: "custom", minMove: 0.0001, formatter: times }, lastValueVisible: false,
      autoscaleInfoProvider: function (original) {
        var r = original();
        if (r && r.priceRange) r.priceRange.minValue = Math.max(r.priceRange.minValue, FLOOR);
        return r;
      }
    });
    Object.keys(extra || {}).forEach(function (k) { opts[k] = extra[k]; });
    return chart.addSeries(window.LightweightCharts.LineSeries, opts);
  }

  /* 원금(1배) 기준선. 끌 수 없는 QQQ 계열에 붙여 늘 보이게 하고, 축에 값 라벨을 달아 1배 눈금이 어떤 구간에서도 남게 한다. */
  function baseLine(series) {
    series.createPriceLine({ price: 1, color: ChartKit.css("--e-base"), lineWidth: 1, lineStyle: window.LightweightCharts.LineStyle.Dashed,
                             axisLabelVisible: true, title: "" });
  }

  /* 범례 상자 box의 n번째 항목이 keys[n]이다. 누르면(Enter, 스페이스도) flip(키)를 부른다. 기준선(FIXED)은 끌 수 없다. 견본은
     차트 선의 무늬와 맞추고(TQQQ 점선), 키가 없는 항목(90% 범위)은 칠한 상자다. */
  function legendToggles(box, keys, flip) {
    box.classList.add("toggles");
    Array.prototype.forEach.call(box.querySelectorAll(".item"), function (row, n) {
      var key = keys[n], dot = row.querySelector("i");
      if (!key) { if (dot) dot.classList.add("fill"); return; }
      row.dataset.k = key;
      if (key === "TQQQ" && dot) {
        dot.style.width = "20px";
        dot.style.background = "repeating-linear-gradient(90deg, " + ChartKit.css(color(key)) + " 0 2px, transparent 2px 4px)";
      }
      if (FIXED[key]) { row.classList.add("fixed"); row.title = "기준선이라 끌 수 없다"; return; }
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.addEventListener("click", function () { flip(key); });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(key); }
      });
    });
  }

  /* 켜고 끈 상태(shown[키]가 false면 꺼짐)를 계열과 범례 항목에 반영한다. 꺼진 계열은 세로축 범위 계산에서도 빠진다. */
  function applyShown(box, keys, series, shown) {
    keys.forEach(function (k) {
      var on = shown[k] !== false;
      if (series[k]) series[k].applyOptions({ visible: on });
      box.querySelectorAll(".item[data-k=\"" + k + "\"]").forEach(function (row) {
        row.classList.toggle("off", !on);
        if (!FIXED[k]) row.setAttribute("aria-pressed", on ? "true" : "false");
      });
    });
  }

  /* 결과 표. 구간 끝(j번째 날)에서의 값과 세금이다. 연 수익률과 가장 큰 칸 표시는 평가금을 따른다. 세금은 매도 때 유보한 것과 지금 전부
     팔면 더 생길 것(평가금과 세후 금액의 차이)으로 가른다. 보유 두 계열은 팔기 전까지 유보금이 0이고 세금이 모두 뒤쪽에 쌓인다. 평가금은
     이 미실현분을 빼지 않으므로 세금을 미루는 보유 계열에 유리하게 기운다. 그 크기를 이 열과 세후 열로 보인다. */
  var RESULT_HEAD = "<thead><tr><th>계열</th>" +
    "<th class=\"num\">평가금</th><th class=\"num\">전부 팔았을 때 세후</th>" +
    "<th class=\"num\">연 수익률</th><th class=\"num\">최대 낙폭</th><th class=\"num\">배분 전환</th>" +
    "<th class=\"num\">매도로 생긴 양도세</th><th class=\"num\">지금 팔면 더 낼 세금</th></tr></thead>";
  /* rows는 [{key, label, r}]이고 r은 simulate의 결과(구간 첫날부터), seed는 원금이다. */
  function resultTable(rows, j, seed) {
    var yrs = j / 252;
    /* 지금 팔면 더 낼 세금이 0이면 이유를 붙인다. 원화 기준 미실현 손익이 손실이면 평가손실, 없으면(현금만 들었거나 막 산 경우)
       미실현 손익 없음, 이익이 남은 연 공제 이하면 공제 이내다. 고점 진입에서는 보유 계열이 구간 끝에 원금 아래인 경우가 많아, 이유가
       없으면 계산 누락처럼 보인다. 올해 실현 이익이 있는데 평가손실이면 지금 팔면 올해 유보금 일부가 예비금으로 돌아오므로 음수가 된다. */
    var due = function (r) {
      var v = r.acct[j] - r.liq[j];
      if (v > 0.5) return won(v);
      if (v < -0.5) return "-" + won(-v) + " <span class=\"why\">(올해 세금 감소)</span>";
      var g = r.gain[j], why = g < -0.5 ? "평가손실" : g <= 0.5 ? "미실현 손익 없음" : "공제 이내";
      return won(0) + " <span class=\"why\">(" + why + ")</span>";
    };
    var mdd = function (a) {
      var pk = -Infinity, w = 0;
      for (var q = 0; q <= j; q++) { if (a[q] > pk) pk = a[q]; var d = a[q] / pk - 1; if (d < w) w = d; }
      return w;
    };
    var sel = rows.map(function (x) { return x.r.acct[j] / seed; }), mx = Math.max.apply(null, sel);
    var body = rows.map(function (x, n) {
      var r = x.r;
      return "<tr><td><i class=\"key\" style=\"background:" + ChartKit.css(color(x.key)) + "\"></i>" + x.label + "</td>" +
        "<td class=\"num" + (sel[n] === mx ? " best" : "") + "\">" + times(sel[n]) + "</td>" +
        "<td class=\"num\">" + times(r.liq[j] / seed) + "</td>" +
        "<td class=\"num\">" + (yrs > 0.05 ? pct(Math.pow(Math.max(sel[n], 1e-9), 1 / yrs) - 1) : "-") + "</td>" +
        "<td class=\"num\">" + pct(mdd(r.acct)) + "</td>" +
        "<td class=\"num\">" + (HOLDS[x.key] ? "-" : r.swAt[j] + "회") + "</td>" +
        "<td class=\"num\">" + won(r.taxAt[j]) + "</td>" +
        "<td class=\"num\">" + due(r) + "</td></tr>";
    }).join("");
    return "<table>" + RESULT_HEAD + "<tbody>" + body + "</tbody></table>";
  }

  return { simulate: simulate, EDGE: EDGE, view: view, stripRange: stripRange, statusWindow: statusWindow,
           stripSvg: stripSvg, strip: strip, stripBox: stripBox, stripAt: stripAt, wireStrip: wireStrip,
           ALLOC_VAR: ALLOC_VAR, layer: layer, events: events, eventPainter: eventPainter,
           KEYS: KEYS, DRAW: DRAW, HOLDS: HOLDS, FIXED: FIXED, title: title, color: color, times: times, pct: pct, won: won,
           growLine: growLine, baseLine: baseLine, legendToggles: legendToggles, applyShown: applyShown,
           RESULT_HEAD: RESULT_HEAD, resultTable: resultTable };
})();
if (typeof module !== "undefined") module.exports = SiteKit;
