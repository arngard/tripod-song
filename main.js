/* 트라이팟 송 공개 사이트의 메인 페이지. 명세: epistemic-structure/architecture/tripod-main-page.md
   신호등과 지표 목록은 생성(tripod/prerender.lights, web/tripod-site.html)이 그려 두었다. 이 코드는 세 가지만 한다.
   - 신호등의 플레이버 이름을 누르면 그 플레이버를 세션 기억에 두고 현황 페이지로 간다(현황이 그 플레이버로 열린다).
   - 생성 시각이 새 종가를 반영하지 못했으면 현황과 같이 빨갛게 칠하고, 더 새 배포가 있으면 새로고침한다.
   - 저가 판단 차트(VIX / VIX3M, HYG / IEF 5일 지수이동평균). 하이일드 차트는 구매에 유리했던 구간(신용 회복)을 파란 띠로 깔고,
     VIX 차트는 VIX / VIX3M이 1.1, 1.2, 1.3을 넘어간 날에 배분 노랑, 배분 파랑, 배분 녹색 세로선을 긋는다. 차트마다 아래에 시간 창 띠를 둔다. */
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }
  var root = document.querySelector(".tripod.main");
  if (!root) return;

  /* ---- 신호등 -> 현황 ---- */
  root.addEventListener("click", function (ev) {
    var a = ev.target.closest && ev.target.closest("a[data-flavor]");
    if (!a) return;
    try { sessionStorage.setItem("tripod-flavor", a.dataset.flavor); } catch (e) { /* 기억하지 못하면 현황이 기본 플레이버로 열린다 */ }
  });

  /* ---- 생성 시각의 신선도와 새 버전 ----
     현황(tripod.js "생성 시각의 신선도", "새 버전 확인")과 같은 규칙이다. 확인 주기도 같고, 타이머는 페이지마다 따로 돈다. 신호등도 오늘의 판정이라 낡은 것을
     최신으로 읽지 않게 한다. */
  var box = root.querySelector(".vixterm");
  var staleAt = box ? Date.parse(box.dataset.stale || "") : NaN;
  var gen = byId("tGenerated"), staleTimer = null, isStale = false;
  function markStale() {
    if (!gen || isNaN(staleAt)) return;
    var left = staleAt - Date.now();
    var was = isStale;
    isStale = left <= 0;
    gen.classList.toggle("stale-time", isStale);
    gen.title = left <= 0 ? "생성 뒤에 나온 종가를 아직 반영하지 못했다" : "";
    clearTimeout(staleTimer);
    if (left > 0) staleTimer = setTimeout(markStale, Math.min(left + 1000, 86400000));
    else if (!was) checkBuild();   /* 낡는 순간 새 버전이 나와 있는지 본다 */
  }
  var BUILD = document.body.dataset.build, HOUR = 3600 * 1000, checkedAt = 0;
  function checkBuild() {
    if (!BUILD || BUILD.indexOf("__") === 0 || document.hidden || Date.now() - checkedAt < 60000) return;
    checkedAt = Date.now();
    fetch((document.body.dataset.root || "") + "version.json?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (!v || !v.build || v.build <= BUILD) return;
        /* 같은 빌드로 새로고침했는데도 옛 페이지면(캐시) 30분 안에는 되풀이하지 않는다. 기록은 현황과 따로 둔다.
           같이 두면 현황이 먼저 새로고침한 빌드를 메인이 캐시로 옛 페이지를 받았을 때 30분 동안 바로잡지 못한다. */
        var KEY = "tripod-main-reload-for";
        try {
          var last = JSON.parse(sessionStorage.getItem(KEY) || "null");
          if (last && last.build === v.build && Date.now() - last.at < 30 * 60000) return;
          sessionStorage.setItem(KEY, JSON.stringify({ build: v.build, at: Date.now() }));
        } catch (e) { return; }
        location.reload();
      })
      .catch(function () { /* 확인에 실패하면 지금 페이지를 그대로 쓴다 */ });
  }
  /* 현황과 같이 30분마다 깨어, 생성 시각이 낡았으면(배포가 곧 올 때) 바로, 아니면 마지막 확인 뒤 3시간이 지났을 때 본다. */
  setInterval(function () { if (isStale || Date.now() - checkedAt >= 3 * HOUR) checkBuild(); }, 30 * 60000);
  document.addEventListener("visibilitychange", checkBuild);
  markStale();
  checkBuild();

  /* ---- 저가 판단 차트 ----
     VIX / VIX3M 비율과 HYG / IEF 5일 지수이동평균 두 차트가 같은 구간을 본다. 구매에 유리했던 구간을 파란 띠(판정 긍정색 --j-pos)로
     캔버스 밑에 깐다. 띠는 하이일드 차트의 신용 회복 구간뿐이다. VIX 차트는 띠 대신 문턱선을 긋는다(`@arngard` 2026-11-25). */
  if (!box) return;
  var LC = window.LightweightCharts, css = window.ChartKit && ChartKit.css;
  var ratioBox = byId("mChartRatio"), hyBox = byId("mChartHy");
  var RANGE_KEY = "tripod-main-range";

  function notice(msg) {
    [ratioBox, hyBox].forEach(function (el) {
      el.classList.toggle("unavailable", !!msg);
      el.dataset.msg = msg || "";
    });
  }
  if (!LC || !css || !window.SiteKit) { notice("차트 코드를 받지 못했다."); return; }
  if (!box.dataset.src) { notice(box.dataset.problems || "자료가 없다."); return; }

  function pct(v) { return v === null || v === undefined ? "-" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; }

  /* 한 줄 설명. 수치는 생성 때 다시 계산한 값이다. */
  function paintStats(d) {
    var a = d.stats.all["63"], x = d.stats.cross || {};
    var m = function (k) { return x[k] ? pct(x[k]["63"].mean) : "-"; };
    root.querySelector('[data-e="mStats"]').textContent =
      "30일 내재변동성(VIX)을 3개월 내재변동성(VIX3M)으로 나눈 비율이 1.1을 넘은 날(노란 선)에 나스닥100을 사면 63거래일 뒤 평균 " +
      m("1.1") + ", 1.2를 넘은 날(파란 선)은 " + m("1.2") + ", 1.3을 넘은 날(녹색 선)은 " + m("1.3") + "로, 모든 날(" + pct(a.mean) + ")보다 유리했다.";
    var g = d.relief_stats, el = root.querySelector('[data-e="mHyStats"]');
    el.textContent = !g ? "" :
      "하이일드 회사채 ETF와 중기 국채 ETF의 가격 비율이 크게 내렸다가 반등하기 시작한 구간(파란 띠)에 나스닥100을 사면 63거래일 뒤 평균 " +
      pct(g.relief["63"].mean) + "로, 모든 날(" + pct(g.all["63"].mean) + ")보다 유리했다.";
  }

  function opts() {
    var o = ChartKit.options();
    o.timeScale.minBarSpacing = 0.01;
    o.layout.background = { type: "solid", color: "transparent" };   /* 띠를 캔버스 밑에 깐다(차트 규율) */
    o.handleScroll = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false };
    o.handleScale = false;
    o.rightPriceScale.mode = LC.PriceScaleMode.Normal;
    return o;
  }

  /* 세로선을 긋는 문턱과 색(`@arngard` 2026-11-25). 키는 bottoms.json "cross"의 키이고, 색은 배분 노랑, 배분 파랑, 배분 녹색(1.3, `@arngard` 2026-11-27)이다.
     뒤의 문턱이 위에 그려진다. */
  var CROSS = [{ key: "1.1", color: "--a-qqq" }, { key: "1.2", color: "--a-mix" }, { key: "1.3", color: "--a-tqqq" }];
  var CROSS_LEGEND = CROSS.map(function (c) { return { key: "x" + c.key, label: "VIX / VIX3M " + c.key + " 넘은 날", color: c.color }; });

  var data = null, charts = null, view = 756;
  /* 기억한 기간이 지금 버튼에 있을 때만 쓴다. 없는 값(바뀐 버튼의 옛 값)은 버리고 기본 기간으로 연다. */
  try { var saved = parseInt(sessionStorage.getItem(RANGE_KEY), 10); if (byId("mRange").querySelector("button[data-n=\"" + saved + "\"]")) view = saved; } catch (e) { /* 처음 상태 */ }

  function drawMarks() {
    if (!charts || !data) return;
    var pos = css("--j-pos");
    var rel = (data.relief || []).map(function (b) { return [b[0], b[1], b[0] + " ~ " + b[1] + " 신용 회복"]; });
    [[ratioBox, charts.ratio, [], CROSS], [hyBox, charts.hy, rel, []]].forEach(function (pane) {
      var host = pane[0], ts = pane[1].timeScale(), W = ts.width();
      var bands = SiteKit.layer(host, "evbands goodbands");
      if (!W) return;
      pane[2].forEach(function (b) {
        var x0 = ts.timeToCoordinate(b[0]), x1 = ts.timeToCoordinate(b[1]);
        if (x0 === null || x1 === null || x1 < 0 || x0 > W) return;
        var el = document.createElement("b");
        el.style.left = Math.max(0, x0 - 1) + "px";
        el.style.width = Math.max(2, Math.min(W, x1 + 1) - Math.max(0, x0 - 1)) + "px";
        el.style.background = pos;
        el.title = b[2];
        bands.appendChild(el);
      });
      /* VIX / VIX3M이 문턱을 넘어간 날의 세로선. VIX 차트에만 긋는다 - 두 차트는 서로의 표시를 넘보지 않는다(`@arngard` 2026-11-25). */
      var lines = SiteKit.layer(host, "vlines");
      if (host.classList.contains("unavailable")) return;   /* 자료가 없는 패널은 사유만 보인다 */
      pane[3].forEach(function (c) {
        ((data.cross || {})[c.key] || []).forEach(function (t) {
          var x = ts.timeToCoordinate(t);
          if (x === null || x < 0 || Math.round(x) >= W) return;   /* 그은 자리(반올림)가 그림 영역 밖이면 거른다 */
          var el = document.createElement("i");
          el.style.left = Math.round(x) + "px";
          el.style.borderLeftColor = css(c.color);
          el.title = t + " VIX / VIX3M " + c.key + " 넘음";
          lines.appendChild(el);
        });
      });
    });
  }

  /* ---- 시간 창 띠 ----
     차트마다 아래에 자료 전체를 로그 눈금으로 깔고, 지금 보이는 구간을 상자로 덮는다(SiteKit.strip). 누르거나 끌면 그 자리를 가운데로 하는
     같은 폭의 구간으로 옮긴다. 두 차트는 같은 구간을 보므로 두 띠의 상자도 함께 움직인다. 모양과 조작은 현황의 시간 창 띠와 같다. */
  var STRIPS = [["mStripRatio", "ratio", "ratio"], ["mStripHy", "hy", "hy"]];

  function drawStrips() {
    if (!charts) return;
    STRIPS.forEach(function (st) {
      var vals = data[st[1]] || [];
      SiteKit.strip(byId(st[0]), charts[st[2]].timeScale().width(), vals.length,
                    function (i) { return vals[i]; }, function (i) { return data.time[i].slice(0, 4); });
    });
    drawStripBoxes();
  }

  function drawStripBoxes() {
    if (!charts) return;
    var r = charts.ratio.timeScale().getVisibleLogicalRange();
    if (r) STRIPS.forEach(function (st) { SiteKit.stripBox(byId(st[0]), r.from + 0.5, r.to - 0.5); });
  }

  function wireStrips() {
    STRIPS.forEach(function (st) {
      var el = byId(st[0]);
      SiteKit.wireStrip(el, function (ev) {
        var r = charts && charts.ratio.timeScale().getVisibleLogicalRange();
        if (!r) return;
        /* 오른쪽 끝은 applyView의 구간(끝 봉까지)과 같다. */
        charts.ratio.timeScale().setVisibleLogicalRange(SiteKit.stripRange(SiteKit.stripAt(el, ev), r, el.geo.n, SiteKit.EDGE.main));
      });
    });
  }

  function applyView() {
    if (!charts || !charts.ratio.timeScale().width()) { requestAnimationFrame(applyView); return; }
    var n = data.time.length;
    charts.ratio.timeScale().setVisibleLogicalRange(SiteKit.view(n, view, SiteKit.EDGE.main));
    Array.prototype.forEach.call(byId("mRange").querySelectorAll("button"), function (b) {
      b.classList.toggle("on", parseInt(b.dataset.n, 10) === view);
    });
  }

  /* 값이 없는 날은 빈 봉으로 둔다. 두 차트는 봉 번호로 동기하므로 봉 수가 같아야 한다. */
  function points(vals) {
    return data.time.map(function (t, i) { var v = vals ? vals[i] : null; return v === null || v === undefined ? { time: t } : { time: t, value: v }; });
  }
  function lastOf(vals) {
    for (var i = (vals || []).length - 1; i >= 0; i--) if (vals[i] !== null && vals[i] !== undefined) return vals[i];
    return null;
  }

  function build() {
    var ratio = LC.createChart(ratioBox, opts()), hyc = LC.createChart(hyBox, opts());
    var r = ratio.addSeries(LC.LineSeries, ChartKit.line({ color: css("--ink") }));
    /* 하이일드 대리 지표의 세로축은 소수 넷째 자리까지 보인다(비율이 0.5 ~ 0.9다). */
    var hy = hyc.addSeries(LC.LineSeries, ChartKit.line({ color: css("--ink"), priceFormat: { type: "price", precision: 4, minMove: 0.0001 } }));
    /* 기준선 1.0. 넘으면 역전이다. */
    r.createPriceLine({ price: 1, color: css("--ink-soft"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    r.setData(points(data.ratio));
    hy.setData(points(data.hy));
    if (lastOf(data.hy) === null) { hyBox.classList.add("unavailable"); hyBox.dataset.msg = data.hy_problem || "하이일드 자료가 없다."; }
    charts = { ratio: ratio, hy: hyc };

    var cells = {
      ratio: ChartKit.legend(byId("mLegendRatio"), [{ key: "r", label: "VIX / VIX3M", color: "--ink" }].concat(CROSS_LEGEND)),
      hy: ChartKit.legend(byId("mLegendHy"), [{ key: "hy", label: "HYG / IEF 5일 지수이동평균", color: "--ink" },
                                               { key: "band", label: "구매에 유리했던 구간", color: "--j-pos" }])
    };
    function value(p, series, vals, digits) {
      var d = p && p.seriesData ? p.seriesData.get(series) : null;
      var v = d && typeof d.value === "number" ? d.value : (p ? null : lastOf(vals));
      return v === null ? "" : ChartKit.format(v, digits);
    }
    function legend(p) {
      p = p && p.time ? p : null;
      cells.ratio.r.textContent = value(p, r, data.ratio, 2);
      cells.hy.hy.textContent = value(p, hy, data.hy, 4);
    }
    [ratio, hyc].forEach(function (c) { c.subscribeCrosshairMove(legend); });
    legend(null);

    /* 두 차트가 같은 구간을 본다. 한 차트를 끌면 다른 차트가 따라온다. 하이일드 자료가 없는 날(패널에 사유만 보임)은 묶지
       않는다. 값이 하나도 없는 차트는 받은 구간을 자료 맨 앞으로 되당겨 VIX 차트까지 끌고 간다(tripod.js vixHidden과 같다). */
    var syncing = false, all = [ratio, hyc];
    all.forEach(function (from) {
      from.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
        if (!syncing && range && !hyBox.classList.contains("unavailable")) {
          syncing = true;
          all.forEach(function (to) { if (to !== from) to.timeScale().setVisibleLogicalRange(range); });
          syncing = false;
        }
        requestAnimationFrame(drawMarks);
        drawStripBoxes();
      });
    });
    ratio.timeScale().subscribeSizeChange(function () { requestAnimationFrame(function () { drawMarks(); drawStrips(); }); });
    window.addEventListener("resize", function () { requestAnimationFrame(drawStrips); });
    wireStrips();
    /* 두 차트의 세로축 폭을 맞춰 같은 날이 같은 가로 자리에 놓이게 한다. */
    requestAnimationFrame(function () {
      var w = Math.max.apply(null, all.map(function (c) { return c.priceScale("right").width(); }));
      if (w) all.forEach(function (c) { c.applyOptions({ rightPriceScale: { minimumWidth: w } }); });
      requestAnimationFrame(function () { drawMarks(); drawStrips(); });
    });

    byId("mRange").addEventListener("click", function (ev) {
      var b = ev.target.closest("button");
      if (!b) return;
      view = parseInt(b.dataset.n, 10);
      try { sessionStorage.setItem(RANGE_KEY, String(view)); } catch (e) { /* 기억하지 못해도 지금 페이지는 바뀐다 */ }
      applyView();
    });
    applyView();
  }

  notice("자료를 받는 중이다.");
  fetch(box.dataset.src).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (d) {
    if (!d.ok) throw new Error((d.problems || []).join("; ") || "자료 없음");
    data = d;
    notice("");
    paintStats(d);
    build();
  }).catch(function (error) {
    notice("정보를 얻지 못했다(" + (error && error.message || error) + ").");
  });
})();
