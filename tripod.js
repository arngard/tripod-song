/* 트라이팟 송 판정 화면.
   명세: _docs/_architecture/tripod-song-signal-tool/output-spec.md
   오류는 팝업이 아니라 페이지 안에 낸다. */

(function () {
  "use strict";

  var byId = function (id) { return document.getElementById(id); };
  /* 차트 데이터는 처음부터 10년치를 받는다. 기간 버튼은 보이는 구간만 옮기고
     데이터를 다시 받지 않는다 - 기간을 어떻게 잡든 데이터는 갱신 때만 바뀐다
     (`@arngard` 2026-09-09). */
  var CHART_DAYS = 2520;
  /* 전환은 최근 24개를 늘 보인다. 처음 보이는 차트 구간은 1년, 좁은 화면은
     6달이다 (`@arngard` 2026-10-04). 경계 폭은 styles.css와 같은 값이다. */
  var NARROW = window.matchMedia("(max-width: 759.98px)");
  /* 새로고침과 첫 로드는 모든 플레이버의 판정을 한 번에 받아 views에 둔다. 플레이버 드롭다운은
     다시 받지 않고 views 사이에서 보기만 바꾼다 (`@arngard` 2026-10-04). strategy가 null이면
     서버의 기본 플레이버다. seq는 늦게 도착한 이전 응답을 버리는 데 쓴다. labels는 보고 있는
     플레이버의 이동평균 기간과 VIX 평균 창에 맞춘 표기다. */
  var state = {
    switches: 24, view: NARROW.matches ? 126 : 252, loaded: false,
    strategy: null, views: null, seq: 0, labels: { ma: "이동평균", vix: "VIX 평균" }
  };

  /* ---- 탭 ---- */

  function show(view) {
    document.querySelectorAll("[data-view]").forEach(function (node) {
      if (node.classList.contains("tab")) {
        node.classList.toggle("on", node.dataset.view === view);
      } else {
        node.hidden = node.dataset.view !== view;
      }
    });
    if (view === "tripod" && !state.loaded) load(false);
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () { show(tab.dataset.view); });
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

  var RANK = { "현금 100%": 0, "QQQ 50% + QLD 50%": 1, "TQQQ 100%": 2 };
  /* 배분의 색. 현금 빨강, 혼합 노랑, TQQQ 파랑. */
  var ALLOC_CLASS = { "현금 100%": "a-cash", "QQQ 50% + QLD 50%": "a-mix", "TQQQ 100%": "a-tqqq" };
  var ALLOC_VAR = { "현금 100%": "--a-cash", "QQQ 50% + QLD 50%": "--a-mix", "TQQQ 100%": "--a-tqqq" };
  /* 판정 낱말의 색. 상승과 안정 파랑, 유지와 보류 노랑, 하락과 불안정 빨강.
     판정 값으로 내는 자리에만 쓴다. */
  var JUDGE_CLASS = {
    "상승": "j-rise", "유지": "j-hold", "하락": "j-fall",
    "안정": "j-stable", "불안정": "j-unstable", "보류": "j-defer"
  };
  function judge(node, word) {
    node.classList.remove("j-rise", "j-hold", "j-fall", "j-stable", "j-unstable", "j-defer");
    if (word && JUDGE_CLASS[word]) node.classList.add(JUDGE_CLASS[word]);
  }

  /* 유지는 안정성을 판정하지 않는다. 화면은 그 빈자리를 "보류"로 적는다.
     계산 계층의 값은 비어 있는 그대로다. */
  function stabWord(state, stability) {
    if (stability) return stability;
    return state === "유지" ? "보류" : null;
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
      /* 한 줄은 확정에 대한 기록이다. 판정, 수치, 해설 모두 확정일 종가의 것이다.
         유지면 안정성은 보류로 적는다. */
      var st = cell("st", w.state || "-", "추세");
      judge(st, w.state);
      row.appendChild(st);
      var sw = stabWord(w.state, w.stability);
      var stab = cell("stab", sw || "-", "안정성");
      judge(stab, sw);
      row.appendChild(stab);
      row.appendChild(cell("num rel", signed(w.rel), state.labels.ma + " 대비"));
      row.appendChild(cell("num vix", w.vix10 === null ? "-" : w.vix10.toFixed(2), state.labels.vix));
      row.appendChild(cell("num dd", signed(w.dd52), "52주 낙폭"));
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
    var price = LC.createChart(priceBox, ChartKit.options());
    var vix = LC.createChart(vixBox, ChartKit.options());

    var dashed = 2;  /* LineStyle.Dashed */
    charts = {
      price: price,
      vix: vix,
      series: {
        ndx: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--ink"), lineWidth: 1
        })),
        /* 판정선의 색은 그 선을 넘을 때 들어가는 상태의 색이다. 글자 팔레트와 같다
           (`@arngard` 2026-10-05). 상승 전환선은 상승(파랑), 하락 전환선은 하락(빨강),
           낙폭 한도선은 TQQQ에서 혼합으로 내려가는 선(노랑)이다. */
        up: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--a-tqqq"), lineWidth: 1, lineStyle: dashed
        })),
        down: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--a-cash"), lineWidth: 1, lineStyle: dashed
        })),
        dd: price.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--a-mix"), lineWidth: 1, lineStyle: dashed
        })),
        /* 판정 대상인 값은 NDX처럼 흰색이다. 파랑을 쓰면 긍정으로 읽힌다. */
        vix10: vix.addSeries(LC.LineSeries, ChartKit.line({
          color: css("--ink"), lineWidth: 1
        }))
      }
    };

    /* 범례는 크로스헤어를 올리면 그 시점의 값을, 아니면 마지막 값을 낸다. */
    var LEGEND = {
      price: [
        ["ndx", "NDX", "--ink", 0],
        ["up", "상승 전환선", "--a-tqqq", 0],
        ["down", "하락 전환선", "--a-cash", 0],
        ["dd", "낙폭 한도선", "--a-mix", 0]
      ],
      vix: [
        ["vix10", "VIX 평균", "--ink", 2],
        /* 상한과 하한은 고정값이다. 축 라벨 대신 범례에 둔다. 상한은 넘으면 TQQQ에서
           혼합(노랑), 하한은 넘으면 혼합에서 현금(빨강)이다. */
        ["vix_cap", "상한", "--a-mix", 2, "fixed"],
        ["vix_floor", "하한", "--a-cash", 2, "fixed"]
      ]
    };
    charts.fixed = {};
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
        if (it[4] === "fixed") {
          v = charts.fixed[key] === undefined ? null : charts.fixed[key];
        } else if (param && param.seriesData) {
          var d = param.seriesData.get(charts.series[key]);
          if (d && typeof d.value === "number") v = d.value;
        } else {
          var arr = charts.legendData[key];
          if (arr && arr.length) v = arr[arr.length - 1].value;
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
    return charts;
  }


  function paintChart(data) {
    var c = buildCharts();
    if (!c) return;
    /* 차트 자료가 없는 판정(자료 조달 실패)이면 비운다. 다른 플레이버나 직전 조회의 선을 남기지 않는다. */
    if (!data) {
      ["ndx", "up", "down", "dd", "vix10"].forEach(function (key) {
        c.series[key].setData([]);
        c.legendData[key] = [];
      });
      if (c.vixLines) c.vixLines.forEach(function (line) { c.series.vix10.removePriceLine(line); });
      c.vixLines = null;
      c.marks = [];
      c.bars = 0;
      drawSwitchLines();
      c.paintLegend("price", null);
      c.paintLegend("vix", null);
      return;
    }
    ["ndx", "up", "down", "dd", "vix10"].forEach(function (key) {
      var src = key === "ndx" ? data.price : data[key];
      c.series[key].setData(src || []);
      c.legendData[key] = src || [];
    });
    /* 고정값은 범례를 그리기 전에 넣어야 한다. */
    c.fixed.vix_cap = data.vix_cap;
    c.fixed.vix_floor = data.vix_floor;
    /* 범례 이름도 플레이버를 따른다. 값 칸 바로 앞이 이름 칸이다. */
    c.legend.vix.vix10.previousSibling.textContent = state.labels.vix;
    c.paintLegend("price", null);
    c.paintLegend("vix", null);

    /* VIX 상한과 하한은 고정값이라 수평선으로 둔다. */
    if (c.vixLines) {
      c.vixLines.forEach(function (line) { c.series.vix10.removePriceLine(line); });
    }
    /* 축에 라벨을 붙이지 않는다. 마지막 값 라벨을 가린다. 값은 범례가 낸다. */
    c.vixLines = [
      c.series.vix10.createPriceLine({
        price: data.vix_cap, color: css("--a-mix"), lineWidth: 1, lineStyle: 2,
        axisLabelVisible: false, title: ""
      }),
      c.series.vix10.createPriceLine({
        price: data.vix_floor, color: css("--a-cash"), lineWidth: 1, lineStyle: 2,
        axisLabelVisible: false, title: ""
      })
    ];


    var RANKM = { "현금 100%": 0, "QQQ 50% + QLD 50%": 1, "TQQQ 100%": 2 };
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
    var tripod = document.querySelector(".tripod");
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
        line.style.borderLeftColor =
          getComputedStyle(tripod).getPropertyValue(ALLOC_VAR[mk.after] || "--ink").trim();
        line.title = mk.time + "  " + mk.before + " -> " + mk.after;
        layer.appendChild(line);
      });
    });
  }

  function syncPriceScaleWidth() {
    /* 두 패널의 세로축 폭을 넓은 쪽에 맞춘다. 지수는 다섯 자리이고
       VIX10은 두 자리라 축 폭이 갈리고, 그만큼 시계열 영역이 밀려
       같은 날짜가 두 패널에서 다른 가로 위치에 놓인다. 밸류에이션 탭과
       같은 처리다. */
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
    });
  }

  /* ---- 전략 선택 ---- */

  /* 비율. 정수면 소수점 없이, 아니면 한 자리까지. 밴드는 부호를 붙인다. */
  function ratio(v, sign) {
    if (v === null || v === undefined) return "-";
    var x = Math.round(v * 1000) / 10;
    var text = (Math.round(x) === x ? x.toFixed(0) : x.toFixed(1)) + "%";
    return sign && x > 0 ? "+" + text : text;
  }

  /* 줄 머리는 왼쪽 열에 고정하고, 항목은 오른쪽 칸 안에서만 접힌다. */
  function descList(node, head, items) {
    node.textContent = "";
    var h = document.createElement("div");
    h.className = "head";
    h.textContent = head;
    node.appendChild(h);
    var box = document.createElement("div");
    box.className = "items";
    node.appendChild(box);
    items.forEach(function (it) {
      var div = document.createElement("div");
      var dt = document.createElement("dt");
      dt.textContent = it[0];
      var dd = document.createElement("dd");
      dd.className = "mono";
      dd.textContent = it[1];
      div.appendChild(dt);
      div.appendChild(dd);
      box.appendChild(div);
    });
  }

  /* 플레이버마다 지금 들고 있어야 할 배분(확정 배분)을 항목 맨 앞의 색 원으로 보인다.
     파란색 TQQQ, 노란색 혼합, 빨간색 현금으로 페이지의 배분 글자색과 같다 (`@arngard` 2026-10-04).
     판정이 서지 않은 플레이버는 붙이지 않는다. */
  var ALLOC_DOT = { "TQQQ 100%": "🔵", "QQQ 50% + QLD 50%": "🟡", "현금 100%": "🔴" };

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
  }

  /* 경고, 파라미터, 백테스트 지표. */
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

    var p = st.params, m = st.metrics;
    state.labels = { ma: p.ma_label, vix: p.vix_label };
    descList(byId("tStratParams"), "파라미터", [
      ["이동평균", p.ma + "일"],
      ["상승 밴드", ratio(p.band_up, true)],
      ["하락 밴드", ratio(p.band_down, true)],
      ["VIX 평균 창", p.vwin + "일"],
      [p.vix_label + " 상한", String(p.vix_cap)],
      [p.vix_label + " 하한", String(p.vix_floor)],
      ["52주 낙폭 한도", ratio(p.dd_limit)],
      ["확인", p.confirm + "거래일 + 익일 체결"]
    ]);
    descList(byId("tStratMetrics"), "백테스트", [
      ["평활 CAGR", (m.cagr * 100).toFixed(2) + "%"],
      ["평활 최대낙폭", (m.mdd * 100).toFixed(1) + "%"],
      ["평활 샤프", m.sharpe.toFixed(2)],
      ["평활 소르티노", m.sortino.toFixed(2)],
      ["평활 칼마", m.calmar.toFixed(2)],
      ["평활 울서", m.ulcer.toFixed(1)]
    ]);

    /* 페이지 곳곳의 고정 표기(이동평균 기간, VIX 평균 창)를 플레이버에 맞춘다. */
    document.querySelectorAll(".tripod [data-lbl]").forEach(function (node) {
      var k = node.dataset.lbl;
      node.textContent = k === "ma" ? p.ma_label : k === "vix" ? p.vix_label : String(p.vwin);
    });
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

  function paintNow(data) {
    var now = data.now;
    var ok = data.ok;
    var dash = function (v) { return v === null || v === undefined ? "-" : v; };

    byId("tSettledState").textContent = now ? dash(now.settled_state) : "-";
    var settledStab = now ? stabWord(now.settled_state, now.settled_stability) : null;
    byId("tSettledStab").textContent = now ? dash(settledStab) : "-";
    judge(byId("tSettledState"), now && now.settled_state);
    judge(byId("tSettledStab"), settledStab);
    byId("tSettled").textContent = now ? now.settled : "-";
    byId("tSettled").className = now ? (ALLOC_CLASS[now.settled] || "") : "";

    byId("tState").textContent = now
      ? dash(now.state) + (now.inherited ? " (물려받음)" : "") : "-";
    var stab = now ? stabWord(now.state, now.stability) : null;
    byId("tStab").textContent = now ? dash(stab) : "-";
    judge(byId("tState"), now && now.state);
    judge(byId("tStab"), stab);
    byId("tTarget").textContent = now ? now.target : "-";
    byId("tTarget").className = now ? (ALLOC_CLASS[now.target] || "") : "";
    byId("tStreak").textContent = now ? streakText(now) : "-";

    byId("bNdx").textContent = now ? num(now.ndx, 0) : "-";
    byId("bRel").textContent = now ? signed(now.rel) : "-";
    byId("bVix10").textContent = now && now.vix10 !== null ? now.vix10.toFixed(2) : "-";
    byId("bDd").textContent = now ? signed(now.dd52) : "-";
    byId("bReason").textContent = data.reason || "";

    var act = byId("tAction");
    if (!ok) {
      act.textContent = "판정 없음";
      act.className = "warn";
    } else if (now && now.trade) {
      /* 직전 종가가 확정일이다. 손에 든 것과 확정 배분이 다르므로 다음 종가에 갈아탄다. */
      act.textContent = "정규장 후반에 체결: " + now.trade[0] + " -> " + now.trade[1];
      act.className = "hot";
    } else if (now && now.action) {
      act.textContent = "전환 진행 중";
      act.className = "hot";
    } else {
      act.textContent = "확정 배분 보유";
      act.className = "";
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

  /* ---- 조회 ---- */

  /* 플레이버 하나의 판정을 페이지 전체에 그린다. */
  function paintView(data) {
    paintStrategy(data);
    byId("tGenerated").textContent = data.generated_at || "없음";
    /* 종가가 언제인지를 시각까지. VIX의 마지막 거래일이 갈리면 그것도 적는다. */
    var basis = closePieces(data.last_close);
    if (data.vix_last && data.vix_last !== data.ndx_last) basis.push("VIX는 " + data.vix_last + "까지");
    fillPieces(byId("tBasis"), basis);
    fillPieces(byId("tNext"), closePieces(data.next_close));
    layoutStamp();
    paintProblems(data.problems);
    paintNotes(data.notes);
    paintNow(data);
    paintSwitches(data.switches);
    paintChart(data.chart);
    byId("tTree").innerHTML = data.tree_html || "";
  }

  /* 정적 사이트(tripod/site.py)는 body의 data-static에 함께 배포한 판정 파일 경로를 둔다.
     그때는 서버 대신 그 파일을 읽고, 새로고침은 하루 한 번의 배포가 맡는다. */
  var STATIC = document.body.dataset.static || "";

  /* 모든 플레이버를 받는다. 보고 있던 플레이버는 그대로 둔다. */
  function load(refresh) {
    var url = STATIC ? STATIC + "?t=" + Date.now()
      : "/api/tripod?all=1&days=1&switches=" + state.switches
        + "&chart=" + CHART_DAYS + (refresh ? "&refresh=1" : "");
    var seq = ++state.seq;
    byId("tGenerated").textContent = "불러오는 중...";
    fetch(url).then(function (r) { return r.json(); }).then(function (all) {
      if (seq !== state.seq) return;   /* 그 사이 새로고침을 다시 눌렀다 */
      state.loaded = true;
      state.views = all.views || {};
      buildOptions(all.flavors || [], state.views);
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
      paintSwitches([]);
      paintChart(null);
      byId("tTree").innerHTML = "";
    });
  }

  if (STATIC) byId("tRefresh").hidden = true;
  byId("tRefresh").addEventListener("click", function () { load(true); });

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
    layoutStamp();
  });

  /* 첫 탭이라 화면을 열면 바로 받는다. 탭이 없는 페이지(정적 사이트)는 그대로 받는다. */
  var first = document.querySelector(".tab.on");
  if (first) show(first.dataset.view);
  else load(false);

})();
