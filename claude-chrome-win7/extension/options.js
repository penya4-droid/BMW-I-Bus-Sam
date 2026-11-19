(function () {
  var $ = function (id) { return document.getElementById(id); };

  function fillSelect(sel, list) {
    list.forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.id; o.textContent = x.name;
      sel.appendChild(o);
    });
  }

  function status(id, text, ok) {
    var s = $(id);
    s.textContent = text;
    s.className = "status " + (ok === true ? "ok" : ok === false ? "bad" : "");
  }

  function collect(base) {
    return Object.assign({}, base, {
      apiKey: $("apiKey").value.trim(),
      model: $("model").value,
      effort: $("effort").value,
      system: $("system").value,
      showThinking: $("showThinking").checked
    });
  }

  async function init() {
    fillSelect($("model"), MODELS);
    fillSelect($("effort"), EFFORTS);
    var s = await loadSettings();
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("effort").value = s.effort;
    $("system").value = s.system;
    $("showThinking").checked = !!s.showThinking;

    $("toggleKey").addEventListener("click", function () {
      var k = $("apiKey");
      k.type = k.type === "password" ? "text" : "password";
      $("toggleKey").textContent = k.type === "password" ? "Показать" : "Скрыть";
    });

    $("save").addEventListener("click", async function () {
      s = collect(s);
      await saveSettings(s);
      status("saveStatus", "Сохранено ✓", true);
      setTimeout(function () { status("saveStatus", ""); }, 2000);
    });

    $("testKey").addEventListener("click", async function () {
      var key = $("apiKey").value.trim();
      if (!key) { status("keyStatus", "Введите ключ.", false); return; }
      status("keyStatus", "Проверяю…");
      $("testKey").disabled = true;
      try {
        var answer = await ClaudeApi.testKey(key, $("model").value);
        s = collect(s);
        await saveSettings(s);
        status("keyStatus", "Ключ работает и сохранён. Ответ модели: " + answer.trim().slice(0, 80), true);
      } catch (e) {
        status("keyStatus", ClaudeApi.describeError(e) || "Проверка прервана.", false);
      } finally {
        $("testKey").disabled = false;
      }
    });

    $("exportChats").addEventListener("click", function () {
      chrome.storage.local.get(null, function (all) {
        var index = all.chatIndex || [];
        var chats = index.map(function (c) { return all["chat_" + c.id]; }).filter(Boolean);
        var blob = new Blob([JSON.stringify(chats, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "claude-chats-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      });
    });

    $("clearChats").addEventListener("click", function () {
      if (!confirm("Удалить все чаты без возможности восстановления?")) return;
      chrome.storage.local.get(null, function (all) {
        var keys = Object.keys(all).filter(function (k) { return k.indexOf("chat_") === 0; });
        keys.push("chatIndex", "lastChatId");
        chrome.storage.local.remove(keys, function () {
          status("saveStatus", "Все чаты удалены.", true);
        });
      });
    });
  }

  init();
})();
