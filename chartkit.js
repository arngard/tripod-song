/* 두 탭이 같이 쓰는 차트 모양.
   명세: _docs/_architecture/investment-support-tool.md "두 탭이 공유하는 화면 규율".
   차트 옵션과 범례를 한 곳에서 정해 탭마다 모양이 갈리지 않게 한다. */

window.ChartKit = (function () {
  "use strict";

  var LC = window.LightweightCharts;

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function options() {
    return {
      /* 크기는 상자를 따른다. 높이는 CSS가 화면 폭에 맞춰 정하고, 탭이 숨겨진
         동안 창 크기가 바뀌어도 다시 보일 때 상자 크기로 돌아온다. */
      autoSize: true,
      layout: {
        background: { type: "solid", color: css("--panel") },
        textColor: css("--ink-soft"),
        /* 축과 크로스헤어 라벨은 단독으로 내는 값이라 고정폭으로 쓴다. */
        fontFamily: css("--mono"),
        fontSize: 12,
        attributionLogo: false
      },
      grid: {
        vertLines: { color: css("--rule-soft") },
        horzLines: { color: css("--rule-soft") }
      },
      /* 세로축은 모든 차트에서 로그 눈금이 기본이다 (`@arngard` 2026-10-04). 밸류에이션
         탭은 "세로축 로그" 체크박스가 이 값을 덮어쓴다. */
      rightPriceScale: { borderColor: css("--rule"), mode: LC.PriceScaleMode.Logarithmic },
      timeScale: {
        borderColor: css("--rule"),
        /* 최근 값이 축 끝에 붙는다. 양 끝 고정 옵션은 쓰지 않는다 - 함께 켜면
           시간축이 잠겨 수평 이동이 통째로 막힌다. */
        rightOffset: 0,
        /* 폭이 바뀌어도 보던 기간을 지킨다. 끄면 봉 간격이 유지되어, 세로축 폭
           맞춤이나 화면 회전으로 그림 영역이 좁아질 때마다 보이는 기간이 줄어든다. */
        lockVisibleTimeRangeOnResize: true
      },
      /* 크로스헤어의 날짜를 ISO 표기로 낸다. 축의 연, 월 눈금은 라이브러리 기본을 둔다. */
      localization: { dateFormat: "yyyy-MM-dd", locale: "ko-KR" },
      /* 가로로 끌면 이동, 휠과 두 손가락은 확대와 축소다. 세로로 끌면 차트가 아니라
         페이지가 움직인다. */
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        /* 시간축을 끌어 늘이는 동작을 막는다. 세로축 드래그는 범위 조작이라 남긴다. */
        axisPressedMouseMove: { time: false, price: true },
        axisDoubleClickReset: { time: true, price: true }
      },
      crosshair: { mode: LC.CrosshairMode.Normal }
    };
  }

  /* 선 계열의 공통 옵션. 크로스헤어가 선 위에 찍는 점은 그리지 않는다 - 선을
     가리고, 범례 값이 이미 그 시점의 값을 알려준다. 선은 모든 탭에서 1픽셀이다. 탭이
     굵기를 따로 주어도 여기서 덮는다 - 굵은 선은 쓰지 않는다 (`@arngard` 2026-10-11). */
  function line(extra) {
    var base = { priceLineVisible: false, crosshairMarkerVisible: false };
    Object.keys(extra || {}).forEach(function (key) { base[key] = extra[key]; });
    base.lineWidth = 1;
    return base;
  }

  function format(value, digits) {
    if (value === null || value === undefined) return "";
    return value.toLocaleString("ko-KR", {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
    });
  }

  /* 범례는 축이 아니라 차트 왼쪽 위에 둔다. 축에 이름을 붙이면 가장 중요한
     마지막 값 라벨을 가린다. items는 { key, label, color(CSS 변수 이름) }의 목록이고,
     key마다 값을 적을 칸을 돌려준다. */
  function legend(box, items) {
    box.textContent = "";
    var cells = {};
    items.forEach(function (it) {
      var row = document.createElement("span");
      row.className = "item";
      var dot = document.createElement("i");
      dot.style.background = css(it.color);
      var name = document.createElement("span");
      name.textContent = it.label;
      /* 값은 굵게 하지 않는다. 이름과는 색으로 이미 갈린다. */
      var value = document.createElement("span");
      value.className = "v";
      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(value);
      box.appendChild(row);
      cells[it.key] = value;
    });
    return cells;
  }

  return { css: css, options: options, line: line, format: format, legend: legend };
})();
