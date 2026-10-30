/* 트라이팟 송 판정 화면.
   명세: epistemic-structure/architecture/tripod-song-signal-tool/output-spec.md
   오류는 팝업이 아니라 페이지 안에 낸다. */

(function () {
  "use strict";

  var byId = function (id) { return document.getElementById(id); };
  /* 전환은 최근 24개를 늘 보인다. 처음 보이는 차트 구간은 화면 폭과 상관없이 3년이다 (`@arngard` 2026-10-04, 3년은 2026-10-22). */
  /* 첫 로드에 모든 플레이버의 판정을 한 번에 받아 views에 둔다. 플레이버 드롭다운은
     다시 받지 않고 views 사이에서 보기만 바꾼다 (`@arngard` 2026-10-04). 차트 자료는 사이트 생성이
     1990년부터 구워 두고, 기간 버튼은 보이는 구간만 옮긴다. strategy가 null이면 자료의 기본 플레이버다. seq는 늦게 도착한 이전 응답을 버리는 데 쓴다. labels는 보고 있는
     플레이버의 이동평균 기간과 VIX 평균 창에 맞춘 표기다. */
  var state = {
    view: 756, loaded: false,
    strategy: null, views: null, seq: 0, labels: { ma: "이동평균", vix: "VIX 평균" }
  };

  /* 새 버전으로 자동 새로고침할 때 보던 탭과 플레이버를 넘겨받는다(아래 "새 버전 확인"). 한 번 쓰고 지운다. */
  var RESTORE = (function () {
    try {
      var x = sessionStorage.getItem("tripod-restore");
      sessionStorage.removeItem("tripod-restore");
      return x ? JSON.parse(x) : null;
    } catch (e) { return null; }
  })();
  if (RESTORE && RESTORE.flavor) state.strategy = RESTORE.flavor;

  /* ---- 탭 ---- */

  /* 탭은 한 단계다 (`@arngard` 2026-10-15). 플레이버 비교의 탭 셋은 같은 화면(data-view="comparison")의 묶음
     (data-set) 하나씩을 연다. 그래서 밝히는 탭은 화면 이름이 아니라 누른 탭 자체로 정하고, 묶음은 comparison.js가 연다. */
  function show(view, tab) {
    document.querySelectorAll("[data-view]").forEach(function (node) {
      if (node.classList.contains("tab")) {
        node.classList.toggle("on", node === tab);
      } else {
        node.hidden = node.dataset.view !== view;
      }
    });
    if (view === "tripod") checkBuild();   /* 낡은 현황을 보지 않게 새 버전을 확인한다(아래 "새 버전 확인") */
    if (view === "tripod" && !state.loaded) { presetLegend(state.strategy); load(); }
    if (view === "tripod") requestAnimationFrame(function () {    /* 숨겨진 동안은 폭이 0이라 띠와 보는 구간을 못 정한다 */
      if (state.pendingView) applyView();
      drawStrips();
    });
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { show(tab.dataset.view, tab); });
  });

  /* ---- 미리 그린 구획 ----
     현황 탭의 텍스트 구획(시각 표기, 백테스트 지표, 현재 상태, 다음 종가 판정, 배분 변경 내역)과 논리 탭은
     생성(tripod/prerender.py)이 플레이버마다 HTML로 그려 페이지에 넣는다 (`@arngard` 2026-10-23). 기본 플레이버의 것은 이미 자리에
     있고, 플레이버를 바꾸면 같은 data-pre 표시의 요소를 그 플레이버의 HTML로 바꿔 끼운다. 차트만 자료(tripod.json)를 늦게 받아 그린다. */
  var PRE = (function () {
    var el = byId("preData");
    try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; }
  })();

  /* 배분의 노출 순서. 현금, QQQ 1배, 혼합 1.5배, TQQQ 3배. */
  var RANK = { "현금 100%": 0, "QQQ 100%": 1, "QQQ 50% + QLD 50%": 2, "TQQQ 100%": 3 };
  /* 배분의 색(4색). 현금 빨강, QQQ 노랑, 혼합 파랑, TQQQ 녹색 (`@arngard` 2026-10-15). 세로선이 쓴다. 글자의 색은 prerender.ALLOC_CLASS. */
  var ALLOC_VAR = { "현금 100%": "--a-cash", "QQQ 100%": "--a-qqq", "QQQ 50% + QLD 50%": "--a-mix", "TQQQ 100%": "--a-tqqq" };

  /* 차트 자료를 받기 전에 차트와 범례를 먼저 만들고, 범례 값을 생성이 계산해 둔 마지막 값(prerender.legend)으로 채운다.
     차트 상자는 CSS가 높이를 정하고 범례도 처음부터 최종 모양으로 자리를 잡아, 자료가 늦게 와도 아래 구획이 밀리지 않는다
     (`@arngard` 2026-10-23). 자료가 오면 paintLegend가 같은 값을 다시 적는다. */
  function presetLegend(key) {
    var c = buildCharts(), f = PRE && PRE.flavors[key];
    if (!c || !f) return;
    ["price", "vix"].forEach(function (w) {
      c.legendSpec[w].forEach(function (it) { c.legend[w][it[0]].textContent = (f.legend || {})[it[0]] || ""; });
    });
    c.legend.vix.vix10.previousSibling.textContent = state.labels.vix;
  }

  /* 플레이버 하나의 구획을 바꿔 끼운다. 생성 시각의 신선도와 시각 표기의 줄 배치는 방문자의 시계와 화면 폭으로 다시 정한다. */
  function applyFlavor(key) {
    var f = PRE && PRE.flavors[key];
    if (!f) return;
    state.strategy = key;
    byId("tStrategy").value = key;
    Object.keys(f.html).forEach(function (name) {
      var el = document.querySelector("[data-pre=\"" + name + "\"]");
      if (el) el.outerHTML = f.html[name];
    });
    state.labels = f.labels;
    markGenerated(byId("tGenerated"), PRE.stale_after);
    layoutStamp();
    if (state.views && state.views[key]) paintChart(state.views[key].chart);
    else if (charts) presetLegend(key);
  }

  /* ---- 차트 ---- */

  var LC = window.LightweightCharts;
  var charts = null;

  var css = ChartKit.css;

  function buildCharts() {
    if (charts || !LC) return charts;
    var priceBox = byId("tChartPrice");
    var vixBox = byId("tChartVix");
    /* 이 차트는 확대를 두지 않는다. 테스트 탭의 진입일 탐색과 같이 가로 스크롤(트랙패드 좌우 쓸기, Shift+휠)과
       끌기는 이동이고, 세로 휠은 페이지로 돌려준다. 보는 기간은 기간 버튼이 정한다 (`@arngard` 2026-10-12,
       공유 차트 규율의 예외). 기간 버튼이 유일한 기간 조작이므로 가장 긴 20년(5,040거래일)이 좁은 폭에도 다 들어가게
       봉 간격의 하한을 낮춘다. 기본(0.5픽셀)이면 그림 영역 850픽셀에 7년 남짓만 들어간다. */
    function opts() {
      var o = ChartKit.options();
      o.timeScale.minBarSpacing = 0.01;
      /* 시장 사건 띠를 캔버스 밑에 깔도록 바탕은 상자(CSS)가 칠한다 (`@arngard` 2026-10-22). */
      o.layout.background = { type: "solid", color: "transparent" };
      o.handleScroll = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
      o.handleScale = { mouseWheel: false, pinch: false,
                        axisPressedMouseMove: { time: false, price: true }, axisDoubleClickReset: { time: false, price: true } };
      return o;
    }
    var price = LC.createChart(priceBox, opts());
    var vix = LC.createChart(vixBox, opts());

    var dashed = 2;  /* LineStyle.Dashed */
    charts = {
      price: price,
      vix: vix,
      series: {
        ndx: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--ink"), lineWidth: 1
        })),
        /* 판정선의 색은 판정 3색이다 (`@arngard` 2026-10-05, 2026-10-15). 상승 전환선은 긍정(파랑),
           하락 전환선은 부정(빨강), 낙폭 한도선은 안정에서 불안정으로 내려가는 선이라 중립(노랑)이다.
           배분이 4색이 되어도 판정선은 3색 그대로 둔다. */
        up: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--j-pos"), lineWidth: 1, lineStyle: dashed
        })),
        down: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--j-neg"), lineWidth: 1, lineStyle: dashed
        })),
        dd: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--j-neu"), lineWidth: 1, lineStyle: dashed
        })),
        /* 판정 대상인 값은 NDX처럼 흰색이다. 파랑을 쓰면 긍정으로 읽힌다. */
        vix10: vix.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--ink"), lineWidth: 1
        })),
        /* VIX 평균의 조심선(파라미터 vix_cap)과 부활선(vix_floor)은 그날 파라미터의 값이다 (`@arngard` 2026-10-15). 단일 플레이버는 수평선이고, 결합 플레이버는
           계절이 바뀌는 날 계단으로 바뀐다. 세로축 범위는 VIX 평균과 두 선을 함께 담는다 (`@arngard` 2026-10-16).
           축 라벨은 붙이지 않는다. 마지막 값 라벨을 가린다. 값은 범례가 낸다. */
        vix_cap: vix.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--j-neu"), lineStyle: dashed, lastValueVisible: false
        })),
        vix_floor: vix.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--j-pos"), lineStyle: dashed, lastValueVisible: false
        }))
      }
    };

    /* 범례는 크로스헤어를 올리면 그 시점의 값을, 아니면 마지막 값을 낸다. */
    var LEGEND = {
      price: [
        ["ndx", "NDX", "--ink", 0],
        ["up", "상승 전환선", "--j-pos", 0],
        ["down", "하락 전환선", "--j-neg", 0],
        ["dd", "낙폭 한도선", "--j-neu", 0]
      ],
      vix: [
        ["vix10", "VIX 평균", "--ink", 2],
        /* 위의 조심선은 넘으면 상승에서 조심이 되는 선이라 노랑, 아래의 부활선은 그 아래로 내려가면 하락에서 부활이 되는
           선이라 파랑이다 (`@arngard` 2026-10-15). */
        ["vix_cap", "조심선", "--j-neu", 2],
        ["vix_floor", "부활선", "--j-pos", 2]
      ]
    };
    charts.legendData = {};

    function buildLegend(boxId, items) {
      return ChartKit.legend(byId(boxId), items.map(function (it) {
        return { key: it[0], label: it[1], color: it[2] };
      }));
    }
    charts.legend = {
      price: buildLegend("tLegendPrice", LEGEND.price),
      vix: buildLegend("tLegendVix", LEGEND.vix)
    };
    charts.legendSpec = LEGEND;

    function paintLegend(which, param) {
      var items = LEGEND[which];
      items.forEach(function (it) {
        var key = it[0], cell = charts.legend[which][key];
        var v = null;
        if (param && param.seriesData) {
          var d = param.seriesData.get(charts.series[key]);
          if (d && typeof d.value === "number") v = d.value;
        } else {
          var arr = charts.legendData[key];
          if (arr && arr.length && typeof arr[arr.length - 1].value === "number") v = arr[arr.length - 1].value;
        }
        cell.textContent = v === null ? "" : ChartKit.format(v, it[3]);
      });
    }
    charts.paintLegend = paintLegend;
    price.subscribeCrosshairMove(function (p) { paintLegend("price", p && p.time ? p : null); });
    vix.subscribeCrosshairMove(function (p) { paintLegend("vix", p && p.time ? p : null); });

    /* 두 패널이 같은 구간을 보게 묶는다. 하나를 끌면 다른 하나가 따라온다. */
    var syncing = false;
    function link(from, to) {
      from.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
        if (syncing || !range) return;
        syncing = true;
        to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
        drawSwitchLines();
      });
    }
    link(price, vix);
    link(vix, price);
    price.timeScale().subscribeVisibleLogicalRangeChange(drawStripBoxes);
    /* 탭을 열거나 창 폭이 바뀌어 그림 영역 폭이 바뀌면 띠와 세로선을 새 폭으로 다시 그린다. */
    price.timeScale().subscribeSizeChange(function () { requestAnimationFrame(function () { drawSwitchLines(); drawStrips(); }); });
    return charts;
  }


  var SERIES = ["ndx", "up", "down", "dd", "vix10", "vix_cap", "vix_floor"];

  /* 서버는 차트를 열 배열로 보낸다 (`@arngard` 2026-10-16, service._chart). 날짜와 NDX 종가는 플레이버 공통이라 최상위에
     한 번만 오고(state.common), 플레이버는 그 시작 위치(from)와 선의 값 배열만 갖는다. 여기서 차트 라이브러리의 꼴로 편다.
     VIX 쪽 계열은 NDX 날짜에 맞추고 값이 없는 날은 빈 봉으로 둔다 - 두 패널은 봉 번호로 동기하므로 봉 수가 다르면 같은 자리에
     다른 날짜가 놓인다. 전환선과 낙폭 한도선은 값이 없는 날을 건너뛴다. */
  function expandChart(c) {
    var own = !!c.time, from = own ? 0 : (c.from || 0), base = own ? c : (state.common || { time: [], ndx: [] });
    var time = base.time.slice(from), ndx = base.ndx.slice(from);
    function pts(vals, gaps) {
      var out = [];
      for (var i = 0; i < time.length; i++) {
        var v = vals ? vals[i] : null;
        if (v === null || v === undefined) { if (gaps) out.push({ time: time[i] }); }
        else out.push({ time: time[i], value: v });
      }
      return out;
    }
    return {
      price: time.map(function (t, i) { return { time: t, value: ndx[i] }; }),
      up: pts(c.up), down: pts(c.down), dd: pts(c.dd),
      vix10: pts(c.vix10, true), vix_cap: pts(c.vix_cap, true), vix_floor: pts(c.vix_floor, true),
      marks: c.marks
    };
  }

  /* 시장 사건(tripod/events.py). 사건 구간을 옅은 띠로 칠하고 띠 위에 말풍선 태그로 이름을 단다 (`@arngard` 2026-10-22).
     색은 회색이다. 배분이 바뀐 날의 세로선과는 다른 쓰임이다. 날짜가 거래일이 아니면 그 뒤 첫 거래일로 잡는다. */
  var EVENTS = (function () {
    var el = byId("eventsData");
    try { return el ? JSON.parse(el.textContent) : []; } catch (e) { return []; }
  })();

  /* 차트를 끌 때마다 세로선과 함께 다시 그린다. 띠는 두 패널에 같이 칠하고, 태그는 NDX 패널에만 단다.
     띠는 캔버스 밑 층(.evbands), 태그는 맨 위 층(.evtags)이다. 태그가 앞 태그와 겹치면 한 줄 아래로 내린다. */
  function overlay(host, cls) {
    var el = host.querySelector("." + cls);
    if (!el) {
      el = document.createElement("div");
      el.className = cls;
      host.appendChild(el);
    }
    el.textContent = "";
    return el;
  }
  function drawEvents() {
    var arr = (charts && charts.legendData.ndx) || [], n = arr.length;
    var at = function (date) { var i = 0; while (i < n && arr[i].time < date) i++; return i; };
    [["tChartPrice", charts.price, true], ["tChartVix", charts.vix, false]].forEach(function (pane) {
      var host = byId(pane[0]), layer = overlay(host, "evbands"), tags = overlay(host, "evtags");
      if (!n) return;
      var ts = pane[1].timeScale(), W = ts.width(), ends = [];
      EVENTS.forEach(function (ev) {
        var i0 = at(ev.from), i1 = Math.min(at(ev.to), n - 1);
        if (i0 >= n) return;
        var x0 = Math.max(0, ts.timeToCoordinate(arr[i0].time)), x1 = Math.min(W, ts.timeToCoordinate(arr[i1].time));
        if (x1 < 0 || x0 > W) return;
        var band = document.createElement("b");
        band.style.left = x0 + "px";
        band.style.width = Math.max(2, x1 - x0) + "px";
        layer.appendChild(band);
        if (!pane[2]) return;
        var tag = document.createElement("span");
        tag.textContent = ev.name;
        tags.appendChild(tag);
        var w = tag.offsetWidth, x = Math.min(Math.max((x0 + x1) / 2, w / 2 + 2), W - w / 2 - 2), row = 0;
        while (ends[row] !== undefined && ends[row] > x - w / 2 - 4) row++;
        ends[row] = x + w / 2;
        tag.style.left = x + "px";
        tag.style.top = 6 + row * 24 + "px";
      });
    });
  }

  function paintChart(data) {
    var c = buildCharts();
    if (!c) return;
    /* 차트 자료가 없는 판정(자료 조달 실패)이면 비운다. 다른 플레이버나 직전 조회의 선을 남기지 않는다. */
    if (!data) {
      SERIES.forEach(function (key) {
        c.series[key].setData([]);
        c.legendData[key] = [];
      });
      c.marks = [];
      c.bars = 0;
      drawSwitchLines();
      drawStrips();
      c.paintLegend("price", null);
      c.paintLegend("vix", null);
      return;
    }
    data = expandChart(data);
    SERIES.forEach(function (key) {
      var src = key === "ndx" ? data.price : data[key];
      c.series[key].setData(src || []);
      c.legendData[key] = src || [];
    });
    /* 범례 이름도 플레이버를 따른다. 값 칸 바로 앞이 이름 칸이다. */
    c.legend.vix.vix10.previousSibling.textContent = state.labels.vix;
    c.paintLegend("price", null);
    c.paintLegend("vix", null);

    var RANKM = RANK;
    /* 배분이 바뀐 날은 삼각형 마커가 아니라 색 있는 세로선으로 그린다.
       마커는 선을 가리고 글자가 겹친다. 선은 두 패널에 같이 놓여 같은 날을
       가리키고, 색은 바뀐 뒤의 배분을 따른다. */
    c.marks = data.marks || [];
    c.bars = (data.price || []).length;
    drawSwitchLines();
    applyView();
    syncPriceScaleWidth();
  }

  /* 마지막 state.view개 봉이 보이게 한다. 두 패널은 논리 범위를 동기하므로
     주 패널에만 놓으면 된다. 왼쪽으로 끌면 그 앞의 데이터가 그대로 나온다. */
  function applyView() {
    if (!charts || !charts.bars) return;
    /* 차트가 아직 폭을 받기 전이면 범위를 정해도 반영되지 않는다. 현황 탭이 보이는 중이면 한 프레임 뒤에 다시 오고,
       숨겨져 있으면 탭을 열 때(show) 한 번만 다시 온다. 숨은 동안 매 프레임 다시 예약하면 탭을 열 때까지 끝없이 돈다. */
    if (!charts.price.timeScale().width()) {
      if (byId("tChartPrice").offsetParent === null) { state.pendingView = true; return; }
      requestAnimationFrame(applyView);
      return;
    }
    state.pendingView = false;
    var n = charts.bars;
    charts.price.timeScale().setVisibleLogicalRange({
      from: Math.max(0, n - state.view) - 0.5, to: n + 0.5
    });
    drawSwitchLines();
  }

  function drawSwitchLines() {
    if (!charts || !charts.marks) return;
    /* 배분의 색은 한 번만 읽는다. 차트를 끌 때마다 불리는 함수라 선마다 스타일을 다시 계산하지 않는다. */
    var style = getComputedStyle(document.querySelector(".tripod")), color = {};
    Object.keys(ALLOC_VAR).forEach(function (k) { color[k] = style.getPropertyValue(ALLOC_VAR[k]).trim(); });
    var ink = style.getPropertyValue("--ink").trim();
    [["tChartPrice", charts.price], ["tChartVix", charts.vix]].forEach(function (pair) {
      var host = byId(pair[0]);
      var layer = host.querySelector(".vlines");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "vlines";
        host.appendChild(layer);
      }
      layer.textContent = "";
      charts.marks.forEach(function (mk) {
        var x = pair[1].timeScale().timeToCoordinate(mk.time);
        if (x == null) return;
        var line = document.createElement("i");
        line.style.left = Math.round(x) + "px";
        line.style.borderLeftColor = color[mk.after] || ink;
        line.title = mk.time + "  " + mk.before + " -> " + mk.after;
        layer.appendChild(line);
      });
    });
    drawEvents();
  }

  function syncPriceScaleWidth() {
    /* 두 패널의 세로축 폭을 넓은 쪽에 맞춘다. 지수는 다섯 자리이고
       VIX10은 두 자리라 축 폭이 갈리고, 그만큼 시계열 영역이 밀려
       같은 날짜가 두 패널에서 다른 가로 위치에 놓인다. 투자 지원 도구의
       밸류에이션 탭과 같은 처리다. */
    if (!charts) return;
    charts.price.applyOptions({ rightPriceScale: { minimumWidth: 0 } });
    charts.vix.applyOptions({ rightPriceScale: { minimumWidth: 0 } });
    requestAnimationFrame(function () {
      var widest = Math.max(
        charts.price.priceScale("right").width(),
        charts.vix.priceScale("right").width()
      );
      if (!widest) return;
      charts.price.applyOptions({ rightPriceScale: { minimumWidth: widest } });
      charts.vix.applyOptions({ rightPriceScale: { minimumWidth: widest } });
      /* 축 폭을 바꾼 차트는 다음 프레임에 새 폭으로 다시 배치된다. 그 전에 선을 그리면 옛 폭의 좌표로 그려져
         두 패널의 같은 날 세로선이 축 폭 차이만큼 어긋난 채 남는다(첫 로딩에 VIX 쪽이 21픽셀 밀림, 2026-10-19 확인). */
      requestAnimationFrame(function () { drawSwitchLines(); drawStrips(); });
    });
  }

  /* ---- 시간 창 ----
     차트마다 아래에 받은 차트 자료 전체(10년)를 로그 눈금으로 깔고, 지금 보이는 구간을 상자로 덮는다.
     띠를 누르거나 끌면 그 자리를 가운데로 하는 같은 폭의 구간으로 옮긴다 (`@arngard` 2026-10-12). 두 차트는
     같은 구간을 보므로 두 띠의 상자도 함께 움직인다. 띠의 가로 범위는 차트의 그림 영역(세로축 왼쪽)에 맞춘다. */
  var STRIPS = [["tStripPrice", "ndx", "price"], ["tStripVix", "vix10", "vix"]];

  function drawStrips() {
    if (!charts) return;
    STRIPS.forEach(function (st) {
      var el = byId(st[0]), arr = charts.legendData[st[1]] || [];
      el.geo = null;
      if (!el.clientWidth || arr.length < 2) { el.innerHTML = ""; return; }
      /* 높이와 위아래 여백은 진입일 탐색의 시간 창과 같다 (`@arngard` 2026-10-22). */
      var W = el.clientWidth, H = 70;
      /* 그림 영역 폭이 아직 0이면(탭을 막 열어 차트가 크기를 받기 전) 그리지 않는다. 상자 폭으로 대신하면 띠가 세로축
         자리까지 넓게 깔린다. 차트가 크기를 받으면 시간축 크기 변화 신호가 다시 그린다 (`@arngard` 2026-10-23). */
      var plot = charts[st[2]].timeScale().width();
      if (!plot) return;
      var m = { l: 0, r: Math.max(0, W - plot), t: 6, b: 20 };
      var n = arr.length, lo = Infinity, hi = -Infinity;
      arr.forEach(function (d) { if (d.value === undefined) return; var v = Math.log(d.value); if (v < lo) lo = v; if (v > hi) hi = v; });
      if (hi === lo) hi = lo + 1;
      var X = function (i) { return m.l + i / (n - 1) * (W - m.l - m.r); };
      var Y = function (v) { return m.t + (1 - (Math.log(v) - lo) / (hi - lo)) * (H - m.t - m.b); };
      var step = Math.max(1, Math.floor(n / Math.max(1, W - m.l - m.r)));
      var p = "";
      for (var i = 0; i < n; i += step) {
        if (arr[i].value === undefined) continue;                     /* 빈 봉은 건너뛴다 */
        p += (p ? "L" : "M") + X(i).toFixed(1) + "," + Y(arr[i].value).toFixed(1);
      }
      var s = "<svg viewBox=\"0 0 " + W + " " + H + "\"><path d=\"" + p + "\" fill=\"none\" stroke=\"" + css("--ink-soft") +
        "\" stroke-width=\"1\"/>";
      /* 해가 바뀌는 첫 거래일에 연도를 단다. 앞 라벨과 40픽셀보다 가까우면 건너뛴다. */
      var year = String(arr[0].time).slice(0, 4), last = -Infinity;
      for (i = 1; i < n; i++) {
        var y = String(arr[i].time).slice(0, 4);
        if (y === year) continue;
        year = y;
        if (X(i) - last < 40 || X(i) < m.l + 16 || X(i) > W - m.r - 16) continue;   /* 양 끝에서 잘리는 라벨은 뺀다 */
        s += "<text x=\"" + X(i).toFixed(1) + "\" y=\"" + (H - 4) + "\" text-anchor=\"middle\">" + y + "</text>";
        last = X(i);
      }
      s += "<rect class=\"box\" y=\"" + (m.t - 2) + "\" height=\"" + (H - m.t - m.b + 4) + "\" fill=\"" + css("--line") +
        "\" fill-opacity=\".18\" stroke=\"" + css("--ink-soft") + "\" stroke-width=\"1.5\" rx=\"2\"/></svg>";
      el.innerHTML = s;
      el.geo = { W: W, m: m, n: n, X: X };
    });
    drawStripBoxes();
  }

  function drawStripBoxes() {
    if (!charts) return;
    var r = charts.price.timeScale().getVisibleLogicalRange();
    STRIPS.forEach(function (st) {
      var el = byId(st[0]), g = el.geo, box = el.querySelector(".box");
      if (!g || !box || !r) return;
      var x0 = g.X(Math.max(0, r.from + 0.5)), x1 = g.X(Math.min(g.n - 1, r.to - 0.5));
      box.setAttribute("x", x0.toFixed(1));
      box.setAttribute("width", Math.max(2, x1 - x0).toFixed(1));
    });
  }

  STRIPS.forEach(function (st) {
    var el = byId(st[0]), down = false;
    var go = function (ev) {
      var g = el.geo, r = charts && charts.price.timeScale().getVisibleLogicalRange();
      if (!g || !r) return;
      var rect = el.getBoundingClientRect(), px = (ev.clientX - rect.left) * g.W / rect.width;
      var at = (px - g.m.l) / (g.W - g.m.l - g.m.r) * (g.n - 1);
      var span = r.to - r.from;
      var from = Math.max(-0.5, Math.min(g.n - 0.5 - span, at - span / 2));
      charts.price.timeScale().setVisibleLogicalRange({ from: from, to: from + span });
    };
    el.addEventListener("pointerdown", function (ev) { down = true; el.setPointerCapture(ev.pointerId); go(ev); });
    el.addEventListener("pointermove", function (ev) { if (down) go(ev); });
    el.addEventListener("pointerup", function () { down = false; });
    el.addEventListener("pointercancel", function () { down = false; });
  });

  /* ---- 전략 선택 ---- */

  /* 드롭다운 폭을 가장 긴 항목에 맞춘다 (`@arngard` 2026-10-14). 글꼴은 기기마다 달라 고정 최소 폭(site.css)으로는 글자가
     잘릴 수 있다. 항목을 같은 글꼴로 실제로 그려 재고, 좌우 여백(오른쪽은 화살표 자리)과 테두리를 더한다. 화면 폭을 넘으면
     site.css의 max-width가 줄인다. 웹 글꼴이 늦게 오면 한 번 더 잰다. */
  function fitSelect(select) {
    var cs = getComputedStyle(select), probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    ["fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing"].forEach(function (k) { probe.style[k] = cs[k]; });
    document.body.appendChild(probe);
    var wide = 0;
    Array.prototype.forEach.call(select.options, function (o) {
      probe.textContent = o.textContent;
      wide = Math.max(wide, probe.getBoundingClientRect().width);
    });
    probe.remove();
    var extra = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"]
      .reduce(function (sum, k) { return sum + parseFloat(cs[k]) || sum; }, 0);
    select.style.minWidth = "max(23.1em, " + Math.ceil(wide + extra + 6) + "px)";
  }
  fitSelect(byId("tStrategy"));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitSelect(byId("tStrategy")); });

  /* 보기만 바꾼다. 다시 받지 않는다. */
  byId("tStrategy").addEventListener("change", function (event) { applyFlavor(event.target.value); });

  /* 시각 표기가 한 줄에 다 들어가는지 재서, 아니면 항목마다 한 줄로 쌓는다. 한 줄
     폭은 내용(조기 폐장, VIX 날짜)에 따라 달라 고정된 기준 폭으로는 정할 수 없다. */
  function layoutStamp() {
    var stamp = document.querySelector(".tripod .stamp");
    if (!stamp) return;
    stamp.classList.remove("stacked");
    var segs = stamp.querySelectorAll(".seg");
    if (segs.length < 2) return;
    var first = segs[0].offsetTop, last = segs[segs.length - 1].offsetTop;
    stamp.classList.toggle("stacked", last !== first);
  }

  /* ---- 생성 시각의 신선도 ----
     현황 탭의 생성 시각은 그 뒤로 새 종가가 나왔는데 아직 반영하지 못했으면 빨갛게 깜빡인다 (`@arngard` 2026-10-13,
     장 달력 기준은 2026-10-25). 낡은 현황을 보고 판단하지 않게 하려는 것이다. 낡는 시각은 생성(market_calendar.stale_after)이
     장 달력으로 정해 넘긴다 - 반영한 종가의 다음 거래일 폐장 뒤 확정 유예가 지난 때라, 주말과 휴장일에는 낡지 않는다.
     화면은 방문자의 시계로 그 시각이 지났는지만 보고, 페이지를 오래 열어 둘 수 있어 그 시각에 맞춰 다시 칠한다.
     테스트 탭은 시의성이 중요하지 않아 칠하지 않는다. */
  var staleTimer = null, isStale = false;
  function markGenerated(node, staleAt) {
    if (!node) return;
    var t = staleAt ? Date.parse(staleAt) : NaN;
    var left = isNaN(t) ? Infinity : t - Date.now();
    var was = isStale;
    isStale = left <= 0;
    node.classList.toggle("stale-time", isStale);
    if (isStale && !was && typeof checkBuild === "function") checkBuild();   /* 낡는 순간 새 버전이 나와 있는지 본다 */
    node.title = left <= 0 ? "생성 뒤에 나온 종가를 아직 반영하지 못했다" : "";
    clearTimeout(staleTimer);
    /* setTimeout은 약 24.8일을 넘는 지연을 받지 못한다. 그보다 멀면 하루 뒤에 다시 잰다. */
    if (left > 0 && left < Infinity) staleTimer = setTimeout(function () { markGenerated(node, staleAt); }, Math.min(left + 1000, 86400000));
  }

  /* ---- 새 버전 확인 ----
     GitHub Pages는 페이지를 10분 캐시하고 이 값은 바꿀 수 없다. 그래서 페이지가 자기 빌드 시각(body의 data-build, UTC)을
     version.json의 시각과 비교해, 그쪽이 더 늦으면 새로고침한다 (`@arngard` 2026-10-15). 낡은 현황을 보고 판단하지 않게
     하려는 것이라 현황 탭이 보일 때만 본다 (`@arngard` 2026-10-25) - 현황 탭으로 열거나 옮겨 올 때, 현황 탭인 채로 브라우저에
     돌아올 때, 현황 탭을 띄워 둔 동안 3시간마다. 생성 시각이 낡은 뒤(위 "생성 시각의 신선도")에는 배포가 곧 올 때라 30분마다
     본다. 스스로 거는 확인은 30분보다 잦게 하지 않는다 (`@arngard` 2026-10-25). 테스트 탭과 논리 탭은 시의성이 중요하지 않아 보지 않는다. 시각이 같으면
     새로고침하지 않는다(자료는 배포 때만 바뀐다). 탭을 잇달아 오가도 1분 안에는 다시 받지 않는다.
     보던 탭과 플레이버는 sessionStorage로 넘긴다. 같은 시각으로 새로고침했는데도 옛 페이지면(캐시) 30분 안에는 되풀이하지
     않고 그 뒤에 다시 한다. 저장소를 쓸 수 없으면 되풀이를 막을 수 없으니 새로고침하지 않는다. */
  var BUILD = document.body.dataset.build, HOUR = 3600 * 1000, checkedAt = 0;
  function reloadFor(next) {
    try {
      var last = null;
      try { last = JSON.parse(sessionStorage.getItem("tripod-reload-for") || "null"); } catch (e) { /* 옛 형식(시각 문자열)은 기록 없음으로 본다 */ }
      if (last && last.build === next && Date.now() - last.at < 30 * 60000) return;
      sessionStorage.setItem("tripod-reload-for", JSON.stringify({ build: next, at: Date.now() }));
      sessionStorage.setItem("tripod-restore", JSON.stringify({
        tab: Array.prototype.indexOf.call(document.querySelectorAll(".tab"), document.querySelector(".tab.on")),
        flavor: state.strategy
      }));
    } catch (e) { return; }
    location.reload();
  }
  function onStatusTab() {
    var tab = document.querySelector(".tab.on");
    return !document.hidden && !!tab && tab.dataset.view === "tripod";
  }
  function checkBuild() {
    if (!BUILD || BUILD.indexOf("__") === 0) return;   /* 생성기를 거치지 않은 틀 */
    if (!onStatusTab() || Date.now() - checkedAt < 60000) return;
    checkedAt = Date.now();
    fetch("version.json?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) { if (v && v.build && v.build > BUILD && onStatusTab()) reloadFor(v.build); })
      .catch(function () { /* 확인에 실패하면 지금 페이지를 그대로 쓴다 */ });
  }
  /* 열 때와 현황 탭으로 옮겨 올 때는 탭 전환(show)이 부른다. */
  setInterval(function () { if (isStale || Date.now() - checkedAt >= 3 * HOUR) checkBuild(); }, 30 * 60000);
  document.addEventListener("visibilitychange", checkBuild);

  /* ---- 조회 ---- */

  /* 공개 사이트(tripod/site.py)는 body의 data-static에 함께 배포한 판정 파일 경로를 둔다. 텍스트는 이미 그려져 있으므로
     화면은 그 파일을 차트에만 쓰고, 현황 탭을 처음 열 때 받는다. 새로고침은 정기 배포가 맡는다. */
  var STATIC = document.body.dataset.static;

  /* 차트 자리 표시. 자료를 받기 전과 받지 못했을 때 차트 상자 안에 문구를 둔다(테스트 탭과 같다, `@arngard` 2026-10-23). */
  function chartNotice(msg) {
    ["tChartPrice", "tChartVix"].forEach(function (id) {
      byId(id).classList.toggle("unavailable", !!msg);
      byId(id).dataset.msg = msg || "";
    });
  }

  function load() {
    var seq = ++state.seq;
    chartNotice("자료를 받는 중이다.");
    fetch(STATIC + "?t=" + Date.now()).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (all) {
      if (seq !== state.seq) return;
      state.loaded = true;
      state.views = all.views || {};
      state.common = all.chart || null;   /* 플레이버 공통의 차트 날짜와 NDX 종가 */
      var v = state.views[state.strategy];
      chartNotice("");
      paintChart(v ? v.chart : null);
    }).catch(function (error) {
      if (seq !== state.seq) return;
      state.loaded = true;
      /* 판정의 글은 이미 그려져 있으므로 차트만 비우고 차트 자리에 자리 표시를 둔다. */
      state.views = null;
      paintChart(null);
      chartNotice("정보를 얻지 못했다(" + (error && error.message || error) + ").");
    });
  }

  /* 기본 플레이버는 생성이 이미 그려 두었다. 새로고침 전에 보던 플레이버가 다르면 그것으로 바꾼다. */
  if (PRE) {
    var start = state.strategy && PRE.flavors[state.strategy] ? state.strategy : PRE.default;
    if (start !== PRE.default) applyFlavor(start);
    else {
      state.strategy = start;
      state.labels = PRE.flavors[start].labels;
      markGenerated(byId("tGenerated"), PRE.stale_after);
      layoutStamp();
    }
  }

  byId("tChartRange").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    state.view = parseInt(button.dataset.n, 10);
    byId("tChartRange").querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("on", b === button);
    });
    applyView();
  });

  byId("tChartRange").querySelectorAll("button").forEach(function (b) {
    b.classList.toggle("on", parseInt(b.dataset.n, 10) === state.view);
  });

  /* 세로선은 차트 위에 얹은 층이라 창 크기가 바뀌면 다시 놓는다. */
  window.addEventListener("resize", function () {
    requestAnimationFrame(drawSwitchLines);
    requestAnimationFrame(drawStrips);
    layoutStamp();
  });

  /* 첫 탭이라 화면을 열면 바로 받는다. */
  var first = (RESTORE && document.querySelectorAll(".tab")[RESTORE.tab]) || document.querySelector(".tab.on");
  if (first) show(first.dataset.view, first);
  else load();

})();
