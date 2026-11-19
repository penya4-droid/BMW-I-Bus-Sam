// Фоновый скрипт: режим работы, контекстное меню, открытие чата.
//
// Режимы:
//   free — бесплатно: открывается официальный сайт claude.ai в отдельном окне
//          (бесплатный тариф Claude, нужен аккаунт claude.ai);
//   api  — встроенный чат расширения по API-ключу Anthropic (оплата по факту).

var FREE_URL = "https://claude.ai/new";

function getSettings(cb) {
  chrome.storage.local.get("settings", function (it) {
    var s = (it && it.settings) || {};
    if (s.mode !== "api") s.mode = "free";
    cb(s);
  });
}

// В бесплатном режиме у значка нет всплывающего окна — клик открывает claude.ai.
function applyMode() {
  getSettings(function (s) {
    chrome.action.setPopup({ popup: s.mode === "api" ? "chat.html?mode=popup" : "" });
    chrome.action.setTitle({ title: s.mode === "api" ? "Claude (API)" : "Claude — бесплатно через claude.ai" });
  });
}

function setupMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({ id: "ask-selection", title: "Спросить Claude о «%s»", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "summarize-page", title: "Claude: кратко изложить страницу", contexts: ["page"] });
    chrome.contextMenus.create({ id: "open-free", title: "Открыть бесплатный Claude (claude.ai)", contexts: ["action"] });
    chrome.contextMenus.create({ id: "open-chat", title: "Открыть чат по API-ключу во вкладке", contexts: ["action"] });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  setupMenus();
  applyMode();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(function () { setupMenus(); applyMode(); });
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === "local" && changes.settings) applyMode();
});

// Открывает claude.ai в отдельном окне-«приложении»; повторно использует уже открытое.
function openFree(url) {
  url = url || FREE_URL;
  chrome.storage.session.get("freeWindowId", function (it) {
    var id = it && it.freeWindowId;
    function create() {
      chrome.windows.create({ url: url, type: "popup", width: 520, height: 760, focused: true }, function (w) {
        if (w) chrome.storage.session.set({ freeWindowId: w.id });
      });
    }
    if (id == null) { create(); return; }
    chrome.windows.get(id, { populate: true }, function (w) {
      if (chrome.runtime.lastError || !w) { create(); return; }
      chrome.windows.update(id, { focused: true });
      if (url !== FREE_URL && w.tabs && w.tabs[0]) chrome.tabs.update(w.tabs[0].id, { url: url });
    });
  });
}

// Ссылка на новый чат claude.ai с подставленным текстом запроса.
function freeUrlWithPrompt(prompt) {
  return FREE_URL + "?q=" + encodeURIComponent(prompt.slice(0, 1500));
}

chrome.action.onClicked.addListener(function () { openFree(); });

// Достаёт текст страницы (выполняется внутри вкладки).
function grabPageText() {
  var text = (document.body && document.body.innerText) || "";
  return { title: document.title, url: location.href, text: text.slice(0, 150000) };
}

function openChatWithPrompt(prompt, page) {
  chrome.storage.local.set({ pendingPrompt: { text: prompt, page: page || null, at: Date.now() } }, function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("chat.html?mode=tab") });
  });
}

function openChatWithError(text) {
  chrome.storage.local.set({ pendingPrompt: { error: text, at: Date.now() } }, function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("chat.html?mode=tab") });
  });
}

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "open-free") { openFree(); return; }
  if (info.menuItemId === "open-chat") {
    chrome.tabs.create({ url: chrome.runtime.getURL("chat.html?mode=tab") });
    return;
  }
  getSettings(function (s) {
    var src = tab && tab.url ? "\n\nИсточник: " + tab.url : "";

    if (info.menuItemId === "ask-selection") {
      var q = "Объясни этот фрагмент:\n\n«" + info.selectionText + "»" + src;
      if (s.mode === "free") openFree(freeUrlWithPrompt(q));
      else openChatWithPrompt(q);
      return;
    }

    if (info.menuItemId === "summarize-page" && tab && tab.id != null) {
      if (s.mode === "free") {
        openFree(freeUrlWithPrompt("Кратко изложи содержание страницы «" + (tab.title || "") + "»: " + (tab.url || "")));
        return;
      }
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageText }, function (results) {
        if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
          openChatWithError("Не удалось прочитать страницу " + (tab.url || "") +
            ". Служебные страницы Chrome и магазин расширений закрыты для расширений.");
          return;
        }
        openChatWithPrompt("Кратко изложи содержание этой страницы.", results[0].result);
      });
    }
  });
});
