// Небольшой безопасный рендер Markdown → DOM-фрагмент.
// Сначала весь текст экранируется, затем добавляется ограниченный набор разметки.

var Md = (function () {
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inline(s) {
    // s уже экранирована
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push("<code>" + c + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, t, u) {
      return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return codes[+i]; });
    return s;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }

  function splitRow(line) {
    var t = line.trim();
    if (t.charAt(0) === "|") t = t.slice(1);
    if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
    return t.split("|").map(function (c) { return c.trim(); });
  }

  function toHtml(src) {
    var lines = src.replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    var para = [];

    function flushPara() {
      if (para.length) {
        out.push("<p>" + para.map(function (l) { return inline(esc(l)); }).join("<br>") + "</p>");
        para = [];
      }
    }

    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flushPara();
        var lang = fence[1] || "";
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<div class="code-wrap"><div class="code-head"><span>' + esc(lang || "код") +
          '</span><button class="copy-code" type="button">Копировать</button></div><pre><code>' +
          esc(buf.join("\n")) + "</code></pre></div>");
        continue;
      }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        var lvl = Math.min(h[1].length + 1, 6);
        out.push("<h" + lvl + ">" + inline(esc(h[2])) + "</h" + lvl + ">");
        i++;
        continue;
      }
      if (/^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { flushPara(); out.push("<hr>"); i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        flushPara();
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push("<blockquote>" + toHtml(q.join("\n")) + "</blockquote>");
        continue;
      }
      if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara();
        var head = splitRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
        var t = "<div class=\"table-wrap\"><table><thead><tr>" +
          head.map(function (c) { return "<th>" + inline(esc(c)) + "</th>"; }).join("") + "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>" + r.map(function (c) { return "<td>" + inline(esc(c)) + "</td>"; }).join("") + "</tr>";
        });
        out.push(t + "</tbody></table></div>");
        continue;
      }
      var li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        var ordered = /\d/.test(li[1]);
        var items = [];
        while (i < lines.length) {
          var m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; }
          else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) { items[items.length - 1] += "\n" + lines[i].trim(); i++; }
          else break;
        }
        var tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.map(function (it) {
          return "<li>" + it.split("\n").map(function (l) { return inline(esc(l)); }).join("<br>") + "</li>";
        }).join("") + "</" + tag + ">");
        continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      para.push(line);
      i++;
    }
    flushPara();
    return out.join("");
  }

  function render(target, src) {
    target.innerHTML = toHtml(src || "");
  }

  return { render: render, toHtml: toHtml };
})();
