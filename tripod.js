/* 트라이팟 송 판정 화면.
   명세: _docs/_architecture/tripod-song-signal-tool/output-spec.md
   오류는 팝업이 아니라 페이지 안에 낸다. */

(function () {
  "use strict";

  var byId = function (id) { return document.getElementById(id); };
  /* 전환은 최근 24개를 늘 보인다. 처음 보이는 차트 구간은 1년, 좁은 화면은
     6달이다 (`@arngard` 2026-10-04). 경계 폭은 site.css와 같은 값이다. */
  var NARROW = window.matchMedia("(max-width: 759.98px)");
  /* 첫 로드에 모든 플레이버의 판정을 한 번에 받아 views에 둔다. 플레이버 드롭다운은
     다시 받지 않고 views 사이에서 보기만 바꾼다 (`@arngard` 2026-10-04). 차트 자료는 사이트 생성이
     1990년부터 구워 두고, 기간 버튼은 보이는 구간만 옮긴다. strategy가 null이면 자료의 기본 플레이버다. seq는 늦게 도착한 이전 응답을 버리는 데 쓴다. labels는 보고 있는
     플레이버의 이동평균 기간과 VIX 평균 창에 맞춘 표기다. */
  var state = {
    view: NARROW.matches ? 126 : 252, loaded: false,
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

  /* 탭은 한 단계다 (`@arngard` 2026-10-15). 플레이버 비교의 탭 넷은 같은 화면(data-view="comparison")의 묶음
     (data-set) 하나씩을 연다. 그래서 밝히는 탭은 화면 이름이 아니라 누른 탭 자체로 정하고, 묶음은 comparison.js가 연다. */
  function show(view, tab) {
    document.querySelectorAll("[data-view]").forEach(function (node) {
      if (node.classList.contains("tab")) {
        node.classList.toggle("on", node === tab);
      } else {
        node.hidden = node.dataset.view !== view;
      }
    });
    if ((view === "tripod" || view === "detail") && !state.loaded) load();
    if (view === "tripod") requestAnimationFrame(drawStrips);   /* 숨겨진 동안은 폭이 0이라 띠를 못 그린다 */
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { show(tab.dataset.view, tab); });
  });

  /* ---- 그리기 ---- */

  var pct = function (v, digits) {
    if (v === null || v === undefined) return "-";
    return (v * 100).toFixed(digits === undefined ? 2 : digits) + "%";
  };
  var signed = function (v) {
    if (v === null || v === undefined) return "-";
    return (v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%";
  };
  var num = function (v, digits) {
    if (v === null || v === undefined) return "-";
    return v.toLocaleString("ko-KR", {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
    });
  };

  /* 배분의 노출 순서. 현금, QQQ 1배, 혼합 1.5배, TQQQ 3배. */
  var RANK = { "현금 100%": 0, "QQQ 100%": 1, "QQQ 50% + QLD 50%": 2, "TQQQ 100%": 3 };
  /* 배분의 색(4색). 현금 빨강, QQQ 노랑, 혼합 파랑, TQQQ 녹색 (`@arngard` 2026-10-15). */
  var ALLOC_CLASS = { "현금 100%": "a-cash", "QQQ 100%": "a-qqq", "QQQ 50% + QLD 50%": "a-mix", "TQQQ 100%": "a-tqqq" };
  var ALLOC_VAR = { "현금 100%": "--a-cash", "QQQ 100%": "--a-qqq", "QQQ 50% + QLD 50%": "--a-mix", "TQQQ 100%": "--a-tqqq" };
  /* 판정 낱말의 색. 추세는 상승 파랑, 하락 빨강이고 유지는 순백색이다 (`@arngard` 2026-10-15). 안정성 낱말은 낱말마다
     고정 색이다(아래 stabPaint, `@arngard` 2026-10-16). 판정 값으로 내는 자리에만 쓴다. */
  /* 계절의 색. 봄 파랑, 가을 노랑, 겨울 빨강 (`@arngard` 2026-10-16). */
  var SEASON_CLASS = { "봄": "j-rise", "가을": "j-autumn", "겨울": "j-fall" };
  var JUDGE_CLASS = { "상승": "j-rise", "유지": "j-hold", "하락": "j-fall", "보류": "j-defer" };
  function judge(node, word) {
    node.classList.remove("j-rise", "j-hold", "j-fall", "j-defer");
    if (word && JUDGE_CLASS[word]) node.classList.add(JUDGE_CLASS[word]);
  }
  /* 안정성 낱말을 칠한다. 낱말마다 고정 색이다 - 안정 녹색, 조심 노랑, 부활 파랑, 불안정 빨강, 보류 순백색
     (`@arngard` 2026-10-16, tree.STAB_CLASS와 같다). 배분의 색을 따르지 않는다. */
  var STAB_CLASS = { "안정": "s-stable", "조심": "s-caution", "부활": "s-revival", "불안정": "s-unstable", "보류": "j-defer" };
  function stabPaint(node, word) {
    node.classList.remove("j-defer", "s-stable", "s-caution", "s-revival", "s-unstable");
    if (STAB_CLASS[word]) node.classList.add(STAB_CLASS[word]);
  }

  /* 안정성의 화면 낱말. 계산 계층의 안정성(안정, 불안정)을 추세와 함께 읽는다 (`@arngard` 2026-10-15, tree.stab_word와 같다).
     상승-안정 안정, 상승-불안정 조심, 하락-안정 부활, 하락-불안정 불안정. 유지는 안정성을 판정하지 않아 "보류"로 적는다. */
  function stabWord(state, stability) {
    if (state === "유지") return "보류";
    if (!stability) return null;
    if (state === "상승") return stability === "안정" ? "안정" : "조심";
    if (state === "하락") return stability === "안정" ? "부활" : "불안정";
    return stability;
  }

  function allocSpan(name) {
    var sp = document.createElement("span");
    sp.className = ALLOC_CLASS[name] || "";
    sp.textContent = name;
    return sp;
  }

  /* 전환 하나가 한 덩어리인 줄 목록이다. 칸 배치(넓으면 표의 가로줄, 좁으면
     접힌 여러 줄)는 CSS가 맡고, 여기서는 칸과 칸 이름(data-k)만 만든다. */
  function paintSwitches(rows) {
    var body = byId("tSw");
    body.textContent = "";
    /* 결합 플레이버(persephone)면 추세 앞에 계절 열을 둔다. 계절이 그날 바뀌었으면 "겨울 전환"처럼 적는다
       (`@arngard` 2026-10-13). 해설에는 계절을 넣지 않는다. */
    var stance = (rows || []).some(function (w) { return !!w.stance; });
    body.parentNode.classList.toggle("has-stance", stance);
    byId("tSwCount").textContent = (rows || []).length;
    var cell = function (cls, text, label) {
      var node = document.createElement("span");
      node.className = "c " + cls;
      if (label) node.dataset.k = label;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    (rows || []).slice().reverse().forEach(function (w) {
      var row = document.createElement("div");
      row.className = "swrow";
      row.appendChild(cell("conf", w.day, "확정"));
      var to = cell("to");
      to.appendChild(allocSpan(w.before));
      var ar = document.createElement("span");
      ar.className = "arrow";
      ar.textContent = "->";
      to.appendChild(ar);
      to.appendChild(allocSpan(w.after));
      row.appendChild(to);
      if (stance) {
        var word = !w.stance ? "-" : w.stance_changed ? w.stance + " 전환" : w.stance;
        var sc = cell("stance", word, "계절");
        if (SEASON_CLASS[w.stance]) sc.classList.add(SEASON_CLASS[w.stance]);
        row.appendChild(sc);
      }
      /* 한 줄은 확정에 대한 기록이다. 판정, 수치, 해설 모두 확정일 종가의 것이다.
         유지면 안정성은 보류로 적는다. */
      var st = cell("st", w.state || "-", "추세");
      judge(st, w.state);
      row.appendChild(st);
      var sw = stabWord(w.state, w.stability);
      var stab = cell("stab", sw || "-", "안정성");
      stabPaint(stab, sw);
      row.appendChild(stab);
      /* 지표 수치(이동평균 대비, VIX 평균, 52주 낙폭) 열은 두지 않는다 (`@arngard` 2026-10-15). 해설이 근거를 말한다. */
      row.appendChild(cell("why", w.reason));
      body.appendChild(row);
    });
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
    /* 차트가 아직 폭을 받기 전이면 범위를 정해도 반영되지 않는다. 한 프레임 뒤에 다시 온다. */
    if (!charts.price.timeScale().width()) {
      requestAnimationFrame(applyView);
      return;
    }
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
      drawSwitchLines();
      requestAnimationFrame(drawStrips);
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
      var W = el.clientWidth, H = 56;
      var plot = charts[st[2]].timeScale().width() || W;
      var m = { l: 0, r: Math.max(0, W - plot), t: 4, b: 18 };
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

  /* 비율. 정수면 소수점 없이, 아니면 한 자리까지. 밴드는 부호를 붙인다. */
  function ratio(v, sign) {
    if (v === null || v === undefined) return "-";
    var x = Math.round(v * 1000) / 10;
    var text = (Math.round(x) === x ? x.toFixed(0) : x.toFixed(1)) + "%";
    return sign && x > 0 ? "+" + text : text;
  }

  /* 줄 머리는 왼쪽 열에 고정하고, 항목은 오른쪽 칸 안에서만 접힌다. */
  /* lead가 있으면 항목 앞에 안내 한 번을 둔다(예: 평활 기준). 항목 이름마다 반복하지 않는다. */
  function descList(node, head, items, lead) {
    node.textContent = "";
    var h = document.createElement("div");
    h.className = "head";
    h.textContent = head;
    node.appendChild(h);
    var box = document.createElement("div");
    box.className = "items";
    node.appendChild(box);
    if (lead) {
      var note = document.createElement("div");
      note.className = "lead";
      note.textContent = lead[0];
      if (lead[1]) note.title = lead[1];
      box.appendChild(note);
    }
    items.forEach(function (it) {
      var div = document.createElement("div");
      var dt = document.createElement("dt");
      dt.textContent = it[0];
      if (it[2]) dt.title = it[2];                  // 마우스를 올리면 뜻을 보인다
      var dd = document.createElement("dd");
      dd.className = "mono";
      dd.textContent = it[1];
      div.appendChild(dt);
      div.appendChild(dd);
      box.appendChild(div);
    });
  }

  /* 플레이버마다 지금 들고 있어야 할 배분(확정 배분)을 항목 맨 앞의 색 원으로 보인다. 녹색 TQQQ, 파란색 혼합,
     노란색 QQQ, 빨간색 현금으로 페이지의 배분 글자색과 같다 (`@arngard` 2026-10-04, 4색은 2026-10-15).
     판정이 서지 않은 플레이버는 붙이지 않는다. */
  var ALLOC_DOT = { "TQQQ 100%": "🟢", "QQQ 50% + QLD 50%": "🔵", "QQQ 100%": "🟡", "현금 100%": "🔴" };

  /* 드롭다운 목록. 항목 자체에 배분 표시와 한 줄 평가를 붙인다. 목록과 순서는 서버가 정한다. */
  function buildOptions(flavors, views) {
    var select = byId("tStrategy");
    var keep = select.value;
    select.textContent = "";
    flavors.forEach(function (x) {
      var v = views && views[x.key];
      var dot = v && v.ok && v.now ? ALLOC_DOT[v.now.settled] : "";
      var opt = document.createElement("option");
      opt.value = x.key;
      opt.textContent = (dot ? dot + " " : "") + (x.summary ? x.name + " - " + x.summary : x.name);
      select.appendChild(opt);
    });
    if (keep) select.value = keep;
    fitSelect(select);
  }

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
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { fitSelect(byId("tStrategy")); });

  /* 경고, 파라미터, 백테스트 지표. */
  /* 전략 상세 탭. 플레이버를 모두 나열한다. 파라미터는 한 표에 플레이버를 열로 두고(persephone은 봄과 겨울 두 열), 계절과 계절 보정은
     persephone 아래에 따로 풀어 쓴다 (`@arngard` 2026-10-16). */
  function paintDetail(list, views) {
    var cols = [];
    list.forEach(function (f) {
      var st = views[f.key] && views[f.key].strategy;
      if (!st) return;
      if (st.composite) {
        cols.push({ head: st.name + " 봄", q: st.composite.up });
        cols.push({ head: st.name + " 겨울", q: st.composite.down });
      } else {
        cols.push({ head: st.name, q: st.params });
      }
    });
    var rows = [
      ["이동평균", function (q) { return q.ma + "일"; }],
      ["상승 밴드", function (q) { return ratio(q.band_up, true); }],
      ["하락 밴드", function (q) { return ratio(q.band_down, true); }],
      ["VIX 평균 창", function (q) { return q.vwin + "일"; }],
      ["VIX 조심선", function (q) { return String(q.vix_cap); }],
      ["VIX 부활선", function (q) { return String(q.vix_floor); }],
      ["52주 낙폭 한도", function (q) { return ratio(q.dd_limit); }],
      ["확인일수", function (q) { return q.confirm + "거래일"; }],
      ["조심 배분", function (q) { return q.up_unstable; }, true]
    ];
    var t = byId("dParams");
    t.textContent = "";
    var thead = document.createElement("thead"), hr = document.createElement("tr");
    [""].concat(cols.map(function (c) { return c.head; })).forEach(function (h) {
      var th = document.createElement("th"); th.textContent = h; hr.appendChild(th);
    });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = document.createElement("tbody");
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      var th = document.createElement("th"); th.textContent = r[0]; tr.appendChild(th);
      cols.forEach(function (c) {
        var td = document.createElement("td"), v = r[1](c.q);
        if (r[2]) { var sp = document.createElement("span"); sp.className = ALLOC_CLASS[v] || ""; sp.textContent = v; td.appendChild(sp); }
        else td.textContent = v;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);

    var box = byId("dComposite");
    box.textContent = "";
    var table = function (rows) {
      var wrap = document.createElement("div"); wrap.className = "dscroll";
      var t = document.createElement("table"); t.className = "dtable";
      var tb = document.createElement("tbody");
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        var th = document.createElement("th"); th.textContent = r[0]; tr.appendChild(th);
        var td = document.createElement("td"); td.textContent = r[1]; tr.appendChild(td);
        tb.appendChild(tr);
      });
      t.appendChild(tb); wrap.appendChild(t);
      return wrap;
    };
    var steps = function (items) {
      var ol = document.createElement("ol"); ol.className = "steps";
      items.forEach(function (it) {
        var li = document.createElement("li"), b = document.createElement("b");
        b.textContent = it[0]; li.appendChild(b); li.appendChild(document.createTextNode(" " + it[1])); ol.appendChild(li);
      });
      return ol;
    };
    list.forEach(function (f) {
      var st = views[f.key] && views[f.key].strategy;
      if (!st || !st.composite) return;
      var c = st.composite, a = c.autumn;
      var h = document.createElement("h2"); h.textContent = st.name.split(" ")[0] + "의 계절"; box.appendChild(h);
      /* 파라미터를 먼저 나열하고 논리를 뒤에 둔다 (`@arngard` 2026-10-16). */
      var rows = [["계절 이동평균", c.ma + "일"], ["계절 비교 간격", c.lookback + "거래일"]];
      if (a) rows = rows.concat([
        ["장력 기준", a.stress_z + " 표준편차"],
        ["장력 추세선 시작", a.anchor || "-"],
        ["장력 추세선 최소 기간", a.min_days + "거래일"],
        ["금리 비교 간격", a.span + "거래일"],
        ["방아쇠 금리 상승", "+" + a.trig_rate + "%p"],
        ["방아쇠 52주 낙폭", "-" + Math.round(a.dd * 100) + "%"],
        ["금리 충격", "+" + a.shock + "%p"],
        ["가을 보정 확인일수", a.confirm + "거래일"],
        ["가을 배분", "TQQQ 100% 대신 QQQ 100%"]
      ]);
      box.appendChild(table(rows));
      var items = [["계절 판정", "NDX의 계절 이동평균이 계절 비교 간격 전보다 높으면 봄, 아니면 겨울이다. 계절 판정이 봄이면 봄 파라미터로, " +
        "겨울이면 겨울 파라미터로 판정한다. 계절 판정에는 확인일수가 없어 그날 바로 바뀐다." + (a ? " 계절은 아래 가을 보정을 거쳐 정해진다." : "")]];
      if (a) items = items.concat([
        ["장력", "주식이 채권에 비해 평소보다 얼마나 비싼지를 나타낸다. 10년 국채 금리와 주식의 이익 수익률(NDX 대비 미국 기업 세후 " +
          "이익)의 비율이 장력 추세선 시작 이후의 장기 추세보다 표준편차의 몇 배만큼 높은지로 잰다. 장력 기준 " +
          "이상이면 장력이 높다고 본다. 자료가 장력 추세선 최소 기간보다 짧으면 재지 않는다."],
        ["방아쇠", "10년 국채 금리가 금리 비교 간격 동안 방아쇠 금리 상승 이상 올랐거나, 52주 낙폭이 방아쇠 52주 낙폭보다 깊으면 " +
          "방아쇠가 당겨진다."],
        ["금리 충격", "10년 국채 금리가 금리 비교 간격 동안 금리 충격 이상 오른 경우다."],
        ["낙엽", "금리 충격이 있거나, 장력이 높은 가운데 방아쇠가 당겨진 날을 낙엽이라 한다. 날마다 다시 판정한다."],
        ["가을 보정", "낙엽이 가을 보정 확인일수만큼 이어지면 켜지고, 낙엽이 없는 날이 가을 보정 확인일수만큼 이어지면 꺼진다. " +
          "켜져 있는 동안 계절 판정이 봄이면 계절을 가을로 보정한다. 계절 판정이 겨울이면 보정하지 않는다."],
        ["가을", "가을에는 봄 파라미터로 판정한다. 추세와 안정성은 봄 파라미터의 판정 그대로이고, 배분이 TQQQ 100%일 때만 " +
          "QQQ 100%를 든다(가을 배분). 가을이 시작되거나 끝나는 날에는 확정 배분이 그날 바뀐다. 가을 보정 확인일수로 이미 " +
          "확인했으므로 신호의 확인일수를 다시 세지 않는다."]
      ]);
      box.appendChild(steps(items));
    });
  }

  function paintStrategy(data) {
    var st = data.strategy;
    var select = byId("tStrategy");
    if (data.flavors && select.options.length !== data.flavors.length) buildOptions(data.flavors, null);
    select.disabled = false;
    if (!st) return;
    select.value = st.key;
    state.strategy = st.key;

    var warn = byId("tStratWarn");
    warn.textContent = st.warning || "";
    warn.hidden = !st.warning;

    var p = st.params, m = st.metrics, c = st.composite;
    /* 결합 플레이버는 그날 계절의 파라미터가 바뀌므로 지표 이름표에 창 길이를 붙이지 않는다 (`@arngard` 2026-10-13).
       판정 구조와 파라미터는 전략 상세 탭(paintDetail)이 풀어 쓴다. */
    state.labels = c ? { ma: "이동평균", vix: "VIX 평균" } : { ma: p.ma_label, vix: p.vix_label };
    /* 값은 모두 세후, 이웃 가우스 평활 값이다(flavor.py). 평활은 안내 한 번으로 알린다 (`@arngard` 2026-10-11). */
    descList(byId("tStratMetrics"), "백테스트", [
      ["성장률", (m.growth * 100).toFixed(2) + "%",
       "1990년부터 지금까지 운용했을 때의 세후 연 성장률이다. 기간 전체의 추세로 재므로 시작과 끝 시점의 우연에 덜 흔들린다."],
      ["최대낙폭", (m.mdd * 100).toFixed(1) + "%",
       "평가금이 직전 고점보다 가장 크게 떨어졌던 비율이다."],
      ["샤프", m.sharpe.toFixed(2),
       "현금(미국 13주 국채)보다 더 번 수익이 변동성에 비해 얼마나 큰지를 나타낸다. 높을수록 좋다."],
      ["소르티노", m.sortino.toFixed(2),
       "샤프와 같되 하락 쪽 변동성만 따진다. 손실 위험에 비해 수익이 얼마나 큰지를 나타낸다."],
      ["칼마", m.calmar.toFixed(2),
       "가장 큰 하락에 비해 수익이 얼마나 큰지를 나타낸다."],
      ["울서", m.ulcer.toFixed(1),
       "고점 아래로 얼마나 깊이, 얼마나 오래 빠져 있었는지를 함께 나타낸 값(%)이다. 낮을수록 좋다."],
      ["WnH90", m.wnh90 == null ? "10년 초과" : m.wnh90.toFixed(1) + "년",
       "Winning Horizon 90. 임의의 날짜에 진입해 이 기간 이상 보유하면 90% 이상의 확률로 세후 금액이 QQQ 보유보다 많았다는 뜻이다. 10년 안에 그렇게 되지 않으면 \"10년 초과\"로 쓴다. 짧을수록 좋다."],
      /* 중립 성장률(NtG62)과 하방 성장률, 연율 (`@arngard` 2026-10-14, NtG62는 2026-10-15). 정의는 tripod-song-backtest/flavor_metrics.py 머리. */
      ["NtG62", (m.ntg * 100).toFixed(2) + "%",
       "Neutral Growth 62(중립 성장률). 앞으로의 장세가 나스닥 같은 상승장일 확률을 62%, 오랜 침체장(침체장 테스트 탭의 경로)일 확률을 38%로 볼 때의 연 성장률이다. 클수록 좋다. 장세별 선택 탭에서 자세히 볼 수 있다."],
      ["DsG", (m.dsg * 100).toFixed(2) + "%",
       "Downside Growth(하방 성장률). 침체장 쪽으로 기울어 원금을 잃는 장세 구간 한가운데에서의 연 성장률이다. 손실 구간이 없으면 0이고, 0에 가까울수록 좋다."]
    ], ["(가우시안 스무딩 적용)", c
        /* 결합 플레이버는 두 파라미터를 같은 폭으로 함께 흔들고 계절 판정은 흔들지 않는다(flavor_metrics.persephone_held). */
        ? "모든 지표는 이 설정 하나의 값이 아니라, 봄 파라미터와 겨울 파라미터를 함께 조금씩 바꾼 주변 설정들의 값을 가까운 설정일수록 무겁게 평균한 것이다. 설정이 조금 달라져도 기대할 수 있는 수준을 보여 준다. 세금은 한국 거주자 기준으로 뺐다."
        : "모든 지표는 이 설정 하나의 값이 아니라, 파라미터를 조금씩 바꾼 주변 설정들의 값을 가까운 설정일수록 무겁게 평균한 것이다. 설정이 조금 달라져도 기대할 수 있는 수준을 보여 준다. 세금은 한국 거주자 기준으로 뺐다."]);

    /* 페이지 곳곳의 고정 표기(이동평균 기간, VIX 평균 창)를 플레이버에 맞춘다. 결합 플레이버는 창 길이를 붙이지 않는다. */
    document.querySelectorAll(".tripod [data-lbl]").forEach(function (node) {
      var k = node.dataset.lbl;
      node.textContent = k === "ma" ? state.labels.ma : k === "vix" ? state.labels.vix : (c ? "" : String(p.vwin));
    });
    /* 결합 플레이버는 차트의 선이 그날 계절의 파라미터의 것이다. 가격 차트 안내는 그 차트 앞 문단에, VIX 평균의
       정의는 VIX 차트 앞 문단에 둔다 다른 플레이버로 돌아오면 원래 문장으로 되돌린다. */
    var md = data.mode;
    var vn = document.querySelector(".tripod .vixnote"), cn = byId("tChartNote");
    [vn, cn].forEach(function (n) { if (n && !n.dataset.plain) n.dataset.plain = n.innerHTML; });
    if (c && md) {
      cn.innerHTML = cn.dataset.plain;
      vn.textContent = "판정에는 당일 종가가 아니라 VIX 평균(봄 " + md.up_vwin + "일, 겨울 " + md.down_vwin + "일)을 쓴다.";
    } else {
      cn.innerHTML = cn.dataset.plain;
      vn.innerHTML = vn.dataset.plain;
      vn.querySelectorAll("[data-lbl]").forEach(function (node) { node.textContent = String(p.vwin); });
    }
    byId("tTreeNote").hidden = !!c;
  }

  /* 보기만 바꾼다. 다시 받지 않는다. */
  byId("tStrategy").addEventListener("change", function (event) {
    state.strategy = event.target.value;
    if (state.views && state.views[state.strategy]) paintView(state.views[state.strategy]);
  });

  /* 판정을 막지 않는 알림. FRED로 결측을 채운 사실 같은 것이다. */
  function paintNotes(list) {
    var box = byId("tNotes");
    box.textContent = (list || []).join(" ");
    box.hidden = !(list && list.length);
  }

  function paintProblems(list) {
    var box = byId("tProblems");
    var ul = byId("tProblemList");
    ul.textContent = "";
    (list || []).forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      ul.appendChild(li);
    });
    box.hidden = !(list && list.length);
  }

  /* 시장 상황 아래의 판정 입력. 항목, 직전 값, 지금의 위치 (`@arngard` 2026-10-17). 값은 직전 종가 기준이다.
     결합 플레이버는 지금 계절 판정의 파라미터와 계절, 낙엽, 가을 보정의 입력을 더한다. */
  function paintInputs(data) {
    var t = byId("tInputs");
    t.textContent = "";
    var now = data.now, p = data.params, md = data.mode;
    if (!now || !p) { byId("tInputsPanel").hidden = true; return; }
    byId("tInputsPanel").hidden = false;
    var pp = function (v) { return (v >= 0 ? "+" : "") + v.toFixed(2) + "%p"; };
    var rows = [];
    if (md) rows.push([md.ma + "일선 " + md.lookback + "거래일 변화", signed(md.slope), "계절 판정 " + md.label]);
    rows.push(["직전 NDX 종가", num(now.ndx, 2), ""]);
    var rel = now.rel;
    rows.push([(p.ma_label || p.ma + "일선") + " 대비", signed(rel),
      rel > p.band_up ? "상승 밴드 " + ratio(p.band_up, true) + " 위" :
      rel < p.band_down ? "하락 밴드 " + ratio(p.band_down, true) + " 아래" :
      "상승 밴드 " + ratio(p.band_up, true) + "와 하락 밴드 " + ratio(p.band_down, true) + " 사이"]);
    var v = now.vix10;
    rows.push([p.vix_label || "VIX 평균", num(v, 2),
      v === null ? "" : v < p.vix_floor ? "부활선 " + p.vix_floor + " 아래" :
      v < p.vix_cap ? "부활선 " + p.vix_floor + " 이상, 조심선 " + p.vix_cap + " 아래" : "조심선 " + p.vix_cap + " 이상"]);
    rows.push(["52주 낙폭", signed(now.dd52),
      now.dd52 >= p.dd_limit ? "낙폭 한도 " + ratio(p.dd_limit) + " 안" : "낙폭 한도 " + ratio(p.dd_limit) + " 밖"]);
    var a = md && md.autumn;
    if (a) {
      var sp = a.spec;
      rows.push(["장력", a.z === null ? "재지 못함" : a.z.toFixed(2),
        a.z === null ? "" : (a.stressed ? "높음. 기준 " + sp.stress_z + " 이상" : "높지 않음. 기준 " + sp.stress_z + " 아래")]);
      rows.push(["10년 국채 금리", a.rate === null ? "-" : a.rate.toFixed(2) + "%", ""]);
      var rc = a.rate_change;
      rows.push(["10년 금리 " + sp.span + "거래일 변화", rc === null ? "-" : pp(rc),
        rc === null ? "" : (rc >= sp.shock ? "금리 충격 +" + sp.shock + "%p 이상" :
          rc >= sp.trig_rate ? "방아쇠 +" + sp.trig_rate + "%p 이상, 금리 충격 +" + sp.shock + "%p 아래" :
          "방아쇠 +" + sp.trig_rate + "%p 아래")]);
      rows.push(["방아쇠", a.trigger ? "당겨짐" : "당겨지지 않음", ""]);
      rows.push(["금리 충격", a.shock ? "있음" : "없음", ""]);
      rows.push(["낙엽", a.cond ? "있음" : "없음", ""]);
      rows.push(["가을 보정", a.on ? "켜짐" : "꺼짐", ""]);
    }
    /* 위치 칸 끝에 지금 위치에 이어서 머문 거래일 수를 붙인다 (`@arngard` 2026-10-17). 키는 rows의 순서와 같다. */
    var R = now.runs || {};
    var keys = (md ? ["mode"] : []).concat([null, "rel", "vix", "dd"], a ? ["stress", null, "rate", "trigger", "shock", "leaf", "autumn"] : []);
    rows.forEach(function (r, i) {
      var n = keys[i] ? R[keys[i]] : null;
      if (n) r[2] = (r[2] ? r[2] + ", " : "") + n + "거래일째";
    });
    var head = document.createElement("thead"), hr = document.createElement("tr");
    ["항목", "직전 값", "위치"].forEach(function (h) { var th = document.createElement("th"); th.textContent = h; hr.appendChild(th); });
    head.appendChild(hr); t.appendChild(head);
    var tb = document.createElement("tbody");
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      r.forEach(function (c, i) { var td = document.createElement("td"); td.textContent = c; if (i === 1) td.className = "mono"; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  }

  function paintNow(data) {
    var now = data.now;
    var ok = data.ok;
    var dash = function (v) { return v === null || v === undefined ? "-" : v; };

    /* 결합 플레이버의 계절. 판정이 서지 않으면 흐리게 둔다(아래 tNow.stale). */
    var md = data.mode;
    byId("tModeItem").hidden = byId("tSettledModeItem").hidden = !md;
    /* 가을 보정(persephone)은 따로 적지 않고 계절 칸이 보정한 계절(봄, 가을, 겨울)로 낸다 (`@arngard` 2026-10-16). */
    if (md) {
      byId("tMode").textContent = byId("tSettledMode").textContent = md.stance;
      byId("tMode").className = byId("tSettledMode").className = SEASON_CLASS[md.stance] || "";
    }

    byId("tSettledState").textContent = now ? dash(now.settled_state) : "-";
    var settledStab = now ? stabWord(now.settled_state, now.settled_stability) : null;
    byId("tSettledStab").textContent = now ? dash(settledStab) : "-";
    judge(byId("tSettledState"), now && now.settled_state);
    stabPaint(byId("tSettledStab"), settledStab);
    byId("tSettled").textContent = now ? now.settled : "-";
    byId("tSettled").className = now ? (ALLOC_CLASS[now.settled] || "") : "";

    byId("tState").textContent = now ? dash(now.state) : "-";
    var stab = now ? stabWord(now.state, now.stability) : null;
    byId("tStab").textContent = now ? dash(stab) : "-";
    judge(byId("tState"), now && now.state);
    stabPaint(byId("tStab"), stab);
    byId("tTarget").textContent = now ? now.target : "-";
    byId("tTarget").className = now ? (ALLOC_CLASS[now.target] || "") : "";
    byId("tStreak").textContent = now ? streakText(now) : "-";

    byId("bReason").textContent = data.reason || "";

    var act = byId("tAction");
    if (!ok) {
      act.textContent = "판정 없음";
      act.className = "warn";
    } else if (now && now.trade) {
      /* 직전 종가가 확정일이다. 손에 든 것과 확정 배분이 다르므로 다음 종가에 갈아탄다. */
      act.textContent = "정규장 후반에 체결: " + now.trade[0] + " -> " + now.trade[1];
      act.className = "act";                  /* 사용자가 매매해야 하는 유일한 줄이라 행동 색(순수 빨강)으로 쓴다 */
    } else if (now && now.action) {
      act.textContent = "전환 진행 중";
      act.className = "";                     /* 확인 일수를 세는 중이라 할 일이 없다 */
    } else {
      act.textContent = "확정 배분 보유";
      act.className = "";
    }
    /* 결합 플레이버의 신호 잎이 신규 진입 추천 잎이면 행동 문구 뒤에 한 문장으로 잇는다(tree.ENTRY). 예: "확정 배분 보유.
       신규 진입 추천." (`@arngard` 2026-10-16). 덧붙인 문장은 행동 색을 따르지 않고 본문 글자색이다. */
    if (ok && now && now.entry) {
      var rec = document.createElement("span");
      rec.className = "entry-rec";
      rec.textContent = now.entry + ".";
      act.append(". ", rec);
    }
    /* 판정이 서지 않으면 값 자체를 흐리게 두어 직전 종가의 것으로 오인되지 않게 한다. */
    byId("tNow").classList.toggle("stale", !ok);
  }

  /* 신호 일수. 직전 종가까지 같은 신호 배분이 이어진 날수를 확인 일수(4) 위에
     얹는다. 3/4는 다가오는 종가에 확정될 수 있는 날이다. 확정된 뒤로는 4/4에
     머문다 - 집행이 필요한지는 행동 칸이 말하므로 여기서 다시 적지 않는다. */
  function streakText(now) {
    var cap = now.streak_cap;
    if (now.target !== now.settled) return Math.min(now.streak, cap - 1) + "/" + cap;
    return cap + "/" + cap;
  }

  /* 종가 시각의 토막들. 동부 시각과 한국 시각 환산을 함께 낸다. 토막 안에서는
     줄을 바꾸지 않고, 항목이 화면 폭보다 길 때만 토막 사이에서 바꾼다. */
  function closePieces(c) {
    if (!c) return ["없음"];
    var out = [c.et + " ET", "(KST " + c.kst + ")"];
    if (c.early) out.push("조기 폐장");
    return out;
  }

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

  function fillPieces(node, pieces) {
    node.textContent = "";
    pieces.forEach(function (text, i) {
      if (i) node.appendChild(document.createTextNode(i >= 2 ? ", " : " "));
      var span = document.createElement("span");
      span.className = "nw";
      span.textContent = text;
      node.appendChild(span);
    });
  }

  /* ---- 생성 시각의 신선도 ----
     생성 시각이 지금(방문자 기기의 시각)보다 23시간 넘게 지났으면 빨갛게 칠한다 (`@arngard` 2026-10-13). 정기 생성이
     하루를 건너뛰었거나 배포가 멈춘 것을 한눈에 알게 하려는 것이다. 생성 시각은 한국 시각(정기 실행의 TZ=Asia/Seoul)으로
     찍히므로 +09:00으로 읽는다. 페이지를 오래 열어 둘 수 있어 1분마다 다시 본다. 테스트 탭(comparison.js)도 같은 함수를 쓴다. */
  var STALE_MS = 23 * 3600 * 1000;
  function markGenerated(node, stamp) {
    if (!node) return;
    node.dataset.gen = stamp || "";
    var t = stamp ? Date.parse(stamp.replace(" ", "T") + "+09:00") : NaN;
    var old = !isNaN(t) && Date.now() - t > STALE_MS;
    node.classList.toggle("stale-time", old);
    node.title = old ? "생성된 지 23시간이 넘었다" : "";
  }
  window.markGenerated = markGenerated;
  setInterval(function () {
    document.querySelectorAll("[data-gen]").forEach(function (n) { markGenerated(n, n.dataset.gen); });
  }, 60000);

  /* ---- 새 버전 확인 ----
     GitHub Pages는 페이지를 10분 캐시하고 이 값은 바꿀 수 없다. 그래서 페이지가 자기 빌드 시각(body의 data-build, UTC)을
     version.json의 시각과 비교해, 그쪽이 더 늦으면 새로고침한다 (`@arngard` 2026-10-15). 열 때 한 번 본다. 그 뒤에는
     연 시각(마지막 새로고침)부터 3시간마다 보고, 연 지 1시간이 넘은 뒤 탭으로 돌아올 때 본다. 오래 생각하며 보는 화면이라
     읽는 도중에 새로고침되는 일을 줄이려는 것이다. 3시간 동안 화면을 지켜보고만 있지는 않을 것으로 본다. 시각이 같으면 새로고침하지 않는다(자료는 배포 때만 바뀐다).
     보던 탭과 플레이버는 sessionStorage로 넘긴다. 같은 시각으로 이미 한 번 새로고침했는데도 옛 페이지면 되풀이하지
     않고, 저장소를 쓸 수 없으면 되풀이를 막을 수 없으니 새로고침하지 않는다. */
  var BUILD = document.body.dataset.build, OPENED = Date.now(), HOUR = 3600 * 1000;
  function reloadFor(next) {
    try {
      if (sessionStorage.getItem("tripod-reload-for") === next) return;
      sessionStorage.setItem("tripod-reload-for", next);
      sessionStorage.setItem("tripod-restore", JSON.stringify({
        tab: Array.prototype.indexOf.call(document.querySelectorAll(".tab"), document.querySelector(".tab.on")),
        flavor: state.strategy
      }));
    } catch (e) { return; }
    location.reload();
  }
  function checkBuild() {
    if (!BUILD || BUILD.indexOf("__") === 0) return;   /* 생성기를 거치지 않은 틀 */
    fetch("version.json?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) { if (v && v.build && v.build > BUILD) reloadFor(v.build); })
      .catch(function () { /* 확인에 실패하면 지금 페이지를 그대로 쓴다 */ });
  }
  checkBuild();
  setInterval(checkBuild, 3 * HOUR);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && Date.now() - OPENED > HOUR) checkBuild();
  });

  /* ---- 조회 ---- */

  /* 플레이버 하나의 판정을 페이지 전체에 그린다. */
  function paintView(data) {
    paintStrategy(data);
    byId("tGenerated").textContent = data.generated_at || "없음";
    markGenerated(byId("tGenerated"), data.generated_at);
    /* 종가가 언제인지를 시각까지. VIX의 마지막 거래일이 갈리면 그것도 적는다. */
    var basis = closePieces(data.last_close);
    if (data.vix_last && data.vix_last !== data.ndx_last) basis.push("VIX는 " + data.vix_last + "까지");
    fillPieces(byId("tBasis"), basis);
    fillPieces(byId("tNext"), closePieces(data.next_close));
    layoutStamp();
    paintProblems(data.problems);
    paintNotes(data.notes);
    paintNow(data);
    paintInputs(data);
    paintSwitches(data.switches);
    paintChart(data.chart);
    byId("tTree").innerHTML = data.tree_html || "";
    byId("tFix").innerHTML = data.fix_html || "";
    byId("tFixPanel").hidden = !data.fix_html;
  }

  /* 공개 사이트(tripod/site.py)는 body의 data-static에 함께 배포한 판정 파일 경로를 둔다.
     화면은 그 파일만 읽고, 새로고침은 정기 배포가 맡는다. */
  var STATIC = document.body.dataset.static;

  /* 모든 플레이버를 받는다. 보고 있던 플레이버는 그대로 둔다. */
  function load() {
    var url = STATIC + "?t=" + Date.now();
    var seq = ++state.seq;
    byId("tGenerated").textContent = "불러오는 중...";
    fetch(url).then(function (r) { return r.json(); }).then(function (all) {
      if (seq !== state.seq) return;   /* 그 사이 새로고침을 다시 눌렀다 */
      state.loaded = true;
      state.views = all.views || {};
      state.common = all.chart || null;   /* 플레이버 공통의 차트 날짜와 NDX 종가 */
      buildOptions(all.flavors || [], state.views);
      paintDetail(all.flavors || [], state.views);
      var key = state.strategy && state.views[state.strategy] ? state.strategy : all.default;
      paintView(state.views[key]);
    }).catch(function (error) {
      if (seq !== state.seq) return;
      state.loaded = true;
      /* 직전 조회의 판정을 남기면 지금 것으로 오인한다. 모두 비우고 플레이버 전환도 막는다. */
      state.views = null;
      byId("tStrategy").disabled = true;
      byId("tGenerated").textContent = "실패";
      fillPieces(byId("tBasis"), ["-"]);
      fillPieces(byId("tNext"), ["-"]);
      paintProblems(["판정을 불러오지 못했다. " + error]);
      paintNotes([]);
      paintNow({ ok: false, now: null });
      paintInputs({ now: null });
      paintSwitches([]);
      paintChart(null);
      byId("tTree").innerHTML = "";
    });
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
