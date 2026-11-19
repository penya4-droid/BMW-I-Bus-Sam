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

  function currentMode() {
    return $("modeApi").checked ? "api" : "free";
  }

  function showMode() {
    var m = currentMode();
    $("modeFreeCard").classList.toggle("selected", m === "free");
    $("modeApiCard").classList.toggle("selected", m === "api");
    $("apiSection").classList.toggle("disabled", m !== "api");
  }

  function collect(base) {
    return Object.assign({}, base, {
      mode: currentMode(),
      apiKey: $("apiKey").value.trim(),
      model: $("model").value,
      effort: $("effort").value,
      system: $("system").value,
      showThinking: $("showThinking").checked
    });
  }

  // ---------- проверка ----------

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("нет ответа за " + ms / 1000 + " с")); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function addCheck(name) {
    var li = document.createElement("li");
    li.className = "wait";
    li.innerHTML = '<span class="ic">…</span><span><div class="name"></div><div class="detail">Проверяю…</div></span>';
    li.querySelector(".name").textContent = name;
    $("checks").appendChild(li);
    return function (state, detail) {
      li.className = state;
      li.querySelector(".ic").textContent = state === "ok" ? "✓" : state === "bad" ? "✗" : "!";
      li.querySelector(".detail").textContent = detail;
    };
  }

  function checkBrowser() {
    var set = addCheck("Браузер");
    var ua = navigator.userAgent;
    var m = ua.match(/Chrome\/(\d+)/);
    var ver = m ? parseInt(m[1], 10) : 0;
    var win7 = /Windows NT 6\.1/.test(ua);
    var os = win7 ? "Windows 7" : /Windows NT 6\.[23]/.test(ua) ? "Windows 8" : /Windows NT 10/.test(ua) ? "Windows 10/11" :
      /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "другая ОС";
    if (!ver) set("warn", "Не удалось определить версию Chrome (" + os + ").");
    else if (ver < 102) set("bad", "Chrome " + ver + " — слишком старый, нужен 102 или новее. Обновите Chrome (на Windows 7 — до 109).");
    else set("ok", "Chrome " + ver + ", " + os + (win7 && ver === 109 ? " — последняя версия для Windows 7, всё в порядке." : "."));
  }

  async function checkStorage() {
    var set = addCheck("Хранилище расширения");
    try {
      var v = String(Date.now());
      await storageSet({ __selftest: v });
      var it = await storageGet("__selftest");
      await storageRemove("__selftest");
      if (it.__selftest === v) set("ok", "Настройки и чаты сохраняются.");
      else set("bad", "Запись не читается обратно.");
    } catch (e) {
      set("bad", "Ошибка хранилища: " + e.message);
    }
  }

  async function checkClaudeAi() {
    var set = addCheck("Связь с claude.ai (бесплатный режим)");
    function ping() {
      return withTimeout(fetch("https://claude.ai/favicon.ico", { mode: "no-cors", cache: "no-store" }), 12000);
    }
    try {
      // Вторая попытка — на случай разового сбоя сети.
      await ping().catch(function () { return ping(); });
      set("ok", "Сайт доступен. Если он не открывается или пишет об ошибке — смотрите подсказки в README.");
    } catch (e) {
      set("bad", "Сайт недоступен (" + e.message + "). Проверьте интернет, прокси, антивирус и дату/время в Windows.");
    }
  }

  async function checkApiHost() {
    var set = addCheck("Связь с api.anthropic.com (режим API)");
    function ping() {
      return withTimeout(fetch("https://api.anthropic.com/v1/models", { cache: "no-store" }), 12000);
    }
    try {
      var r = await ping().catch(function () { return ping(); });
      // Без ключа сервер отвечает 401 — значит, он доступен.
      set("ok", "Сервер доступен (код ответа " + r.status + ").");
    } catch (e) {
      set("bad", "Сервер недоступен (" + e.message + "). Проверьте интернет, прокси и антивирус.");
    }
  }

  async function checkKey() {
    var set = addCheck("API-ключ");
    var key = $("apiKey").value.trim();
    if (!key) {
      if (currentMode() === "api") set("bad", "Ключ не указан, а выбран режим «По API-ключу». Укажите ключ или выберите бесплатный режим.");
      else set("ok", "Не нужен: выбран бесплатный режим.");
      return;
    }
    try {
      var name = await withTimeout(ClaudeApi.testKey(key, $("model").value), 20000);
      set("ok", "Ключ рабочий, модель «" + name + "» доступна.");
    } catch (e) {
      set("bad", ClaudeApi.describeError(e) || e.message);
    }
  }

  async function runChecks() {
    $("runChecks").disabled = true;
    $("checks").innerHTML = "";
    checkBrowser();
    await checkStorage();
    await Promise.all([checkClaudeAi(), checkApiHost()]);
    await checkKey();
    $("runChecks").disabled = false;
  }

  // ---------- старт ----------

  async function init() {
    fillSelect($("model"), MODELS);
    fillSelect($("effort"), EFFORTS);
    var s = await loadSettings();
    (s.mode === "api" ? $("modeApi") : $("modeFree")).checked = true;
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("effort").value = s.effort;
    $("system").value = s.system;
    $("showThinking").checked = !!s.showThinking;
    showMode();

    $("modeFree").addEventListener("change", showMode);
    $("modeApi").addEventListener("change", showMode);
    $("openFree").addEventListener("click", openFreeClaude);
    $("runChecks").addEventListener("click", runChecks);

    $("toggleKey").addEventListener("click", function () {
      var k = $("apiKey");
      k.type = k.type === "password" ? "text" : "password";
      $("toggleKey").textContent = k.type === "password" ? "Показать" : "Скрыть";
    });

    $("save").addEventListener("click", async function () {
      s = collect(s);
      await saveSettings(s);
      status("saveStatus", s.mode === "free"
        ? "Сохранено ✓ Теперь значок расширения открывает бесплатный claude.ai."
        : "Сохранено ✓ Значок расширения открывает встроенный чат.", true);
      setTimeout(function () { status("saveStatus", ""); }, 4000);
    });

    $("testKey").addEventListener("click", async function () {
      var key = $("apiKey").value.trim();
      if (!key) { status("keyStatus", "Введите ключ.", false); return; }
      status("keyStatus", "Проверяю…");
      $("testKey").disabled = true;
      try {
        var name = await ClaudeApi.testKey(key, $("model").value);
        s = collect(s);
        await saveSettings(s);
        status("keyStatus", "Ключ работает и сохранён. Модель «" + name + "» доступна.", true);
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

    if (location.hash === "#check") runChecks();
  }

  init();
})();
