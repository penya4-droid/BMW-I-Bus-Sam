// Экран настроек, установка приложения (PWA) и проверка.

var Settings = (function () {
  var $ = function (id) { return document.getElementById(id); };
  var s = null;
  var deferredPrompt = null;   // событие beforeinstallprompt от Chrome

  // ---------- установка ----------

  function isInstalled() {
    return window.matchMedia("(display-mode: standalone)").matches ||
      window.matchMedia("(display-mode: minimal-ui)").matches ||
      navigator.standalone === true;
  }

  function renderInstall() {
    var installed = isInstalled();
    $("installBtn").hidden = installed || !deferredPrompt;
    $("installCta").hidden = installed || !deferredPrompt;
    $("installSteps").hidden = installed || !!deferredPrompt;
    $("installState").textContent = installed
      ? "✓ Приложение установлено и открыто с главного экрана."
      : deferredPrompt
        ? "Chrome готов установить Claude как приложение — нажмите кнопку."
        : "Если кнопки установки нет, установите через меню Chrome:";
  }

  async function install() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    var choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice && choice.outcome === "accepted") $("installState").textContent = "Устанавливается…";
    renderInstall();
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    deferredPrompt = e;
    renderInstall();
  });
  window.addEventListener("appinstalled", function () {
    deferredPrompt = null;
    renderInstall();
    $("installState").textContent = "✓ Установлено! Значок Claude появился на главном экране.";
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  // ---------- экран настроек ----------

  function fillSelect(sel, list) {
    list.forEach(function (x) {
      var o = document.createElement("option");
      o.value = x.id; o.textContent = x.name;
      sel.appendChild(o);
    });
  }

  function status(id, text, ok) {
    var el = $(id);
    el.textContent = text;
    el.className = "status " + (ok === true ? "ok" : ok === false ? "bad" : "");
  }

  function collect() {
    return Object.assign({}, s, {
      apiKey: $("apiKey").value.trim(),
      model: $("model").value,
      effort: $("effort").value,
      system: $("system").value,
      showThinking: $("showThinking").checked
    });
  }

  async function open(section) {
    s = await loadSettings();
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("effort").value = s.effort;
    $("system").value = s.system;
    $("showThinking").checked = !!s.showThinking;
    renderInstall();
    $("sheet").hidden = false;
    history.pushState({ sheet: true }, "");
    var target = section === "free" ? $("freeCard") : null;
    $("sheet").querySelector(".sheet-body").scrollTop = target ? target.offsetTop - 12 : 0;
  }

  function close(fromPop) {
    if ($("sheet").hidden) return;
    $("sheet").hidden = true;
    if (!fromPop && history.state && history.state.sheet) history.back();
  }

  // Кнопка «Назад» на Android закрывает настройки, а не приложение.
  window.addEventListener("popstate", function () { close(true); });

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
    var chrome = ua.match(/Chrome\/(\d+)/);
    var android = ua.match(/Android (\d+(\.\d+)?)/);
    var os = android ? "Android " + android[1] : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "другая ОС";
    var other = /SamsungBrowser|YaBrowser|OPR|Firefox|EdgA/.test(ua);
    if (!chrome) set("warn", "Это не Chrome (" + os + "). Установка может работать иначе — лучше открыть в Chrome.");
    else if (other) set("warn", "Браузер на основе Chrome (" + os + "). Если нет пункта установки — откройте страницу в Google Chrome.");
    else if (parseInt(chrome[1], 10) < 90) set("warn", "Chrome " + chrome[1] + " устарел. Обновите Chrome в Google Play.");
    else set("ok", "Chrome " + chrome[1] + ", " + os + ".");
  }

  async function checkInstall() {
    var set = addCheck("Установка");
    if (!window.isSecureContext) { set("bad", "Страница открыта не по HTTPS — Chrome не разрешит установку."); return; }
    var sw = false;
    try { sw = !!(await navigator.serviceWorker.getRegistration()); } catch (e) {}
    if (isInstalled()) set("ok", "Установлено, работает как приложение" + (sw ? ", доступно без сети." : "."));
    else if (deferredPrompt) set("ok", "Можно установить: кнопка «Установить приложение» выше.");
    else set("warn", "Открыто во вкладке браузера. Установите через меню Chrome ⋮ → «Установить приложение».");
  }

  async function checkStorage() {
    var set = addCheck("Хранилище");
    try {
      var v = String(Date.now());
      await storageSet({ __selftest: v });
      var it = await storageGet("__selftest");
      await storageRemove("__selftest");
      if (it.__selftest !== v) { set("bad", "Запись не читается обратно."); return; }
      var persisted = false;
      if (navigator.storage && navigator.storage.persist) {
        try { persisted = await navigator.storage.persist(); } catch (e) {}
      }
      set("ok", "Чаты и настройки сохраняются" + (persisted ? " и защищены от автоочистки." : "."));
    } catch (e) {
      set("bad", "Ошибка хранилища: " + e.message + ". Не открыто ли в режиме инкогнито?");
    }
  }

  async function checkHost(name, url) {
    var set = addCheck(name);
    function ping() { return withTimeout(fetch(url, { mode: "no-cors", cache: "no-store" }), 12000); }
    try {
      await ping().catch(function () { return ping(); });
      set("ok", "Сервер доступен.");
    } catch (e) {
      set("bad", "Недоступен (" + e.message + "). Проверьте интернет, VPN/прокси, дату и время на телефоне.");
    }
  }

  async function checkKey() {
    var set = addCheck("API-ключ");
    var key = $("apiKey").value.trim();
    if (!key) { set("warn", "Не указан. Без ключа работает только бесплатный Claude (приложение или claude.ai)."); return; }
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
    await checkInstall();
    await checkStorage();
    await Promise.all([
      checkHost("Связь с claude.ai (бесплатно)", "https://claude.ai/favicon.ico"),
      checkHost("Связь с api.anthropic.com (чат по ключу)", "https://api.anthropic.com/")
    ]);
    await checkKey();
    $("runChecks").disabled = false;
  }

  // ---------- старт ----------

  function init() {
    fillSelect($("model"), MODELS);
    fillSelect($("effort"), EFFORTS);
    $("freePlay").href = FREE_PLAY;
    $("freeWeb").href = FREE_WEB;

    $("settingsBtn").addEventListener("click", function () { open(); });
    $("sheetClose").addEventListener("click", function () { close(); });
    $("installBtn").addEventListener("click", install);
    $("installCta").addEventListener("click", install);
    $("runChecks").addEventListener("click", runChecks);

    $("toggleKey").addEventListener("click", function () {
      var k = $("apiKey");
      k.type = k.type === "password" ? "text" : "password";
      $("toggleKey").textContent = k.type === "password" ? "Показать" : "Скрыть";
    });

    $("save").addEventListener("click", async function () {
      s = collect();
      await saveSettings(s);
      if (window.App) App.onSettingsChanged(s);
      status("saveStatus", "Сохранено ✓", true);
      setTimeout(function () { status("saveStatus", ""); }, 2500);
    });

    $("testKey").addEventListener("click", async function () {
      var key = $("apiKey").value.trim();
      if (!key) { status("keyStatus", "Введите ключ.", false); return; }
      status("keyStatus", "Проверяю…");
      $("testKey").disabled = true;
      try {
        var name = await ClaudeApi.testKey(key, $("model").value);
        s = collect();
        await saveSettings(s);
        if (window.App) App.onSettingsChanged(s);
        status("keyStatus", "Ключ работает и сохранён. Модель «" + name + "» доступна.", true);
      } catch (e) {
        status("keyStatus", ClaudeApi.describeError(e) || "Проверка прервана.", false);
      } finally {
        $("testKey").disabled = false;
      }
    });

    $("exportChats").addEventListener("click", async function () {
      var chats = await App.exportChats();
      var json = JSON.stringify(chats, null, 2);
      var name = "claude-chats-" + new Date().toISOString().slice(0, 10) + ".json";
      var file = new File([json], name, { type: "application/json" });
      // На телефоне удобнее «Поделиться» (в Диск, Telegram и т. п.); иначе — скачать.
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
      }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });

    $("clearChats").addEventListener("click", async function () {
      if (!confirm("Удалить все чаты без возможности восстановления?")) return;
      await App.clearChats();
      status("saveStatus", "Все чаты удалены.", true);
    });

    renderInstall();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  return { open: open, close: close };
})();
