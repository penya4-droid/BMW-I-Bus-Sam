// Фоновый скрипт: пункты контекстного меню и открытие чата во вкладке.

function setupMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "ask-selection",
      title: "Спросить Claude о «%s»",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "summarize-page",
      title: "Claude: кратко изложить страницу",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "open-chat",
      title: "Открыть чат Claude во вкладке",
      contexts: ["action"]
    });
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  setupMenus();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setupMenus);

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

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId === "open-chat") {
    chrome.tabs.create({ url: chrome.runtime.getURL("chat.html?mode=tab") });
    return;
  }
  if (info.menuItemId === "ask-selection") {
    var src = tab && tab.url ? "\n\nИсточник: " + tab.url : "";
    openChatWithPrompt("Объясни этот фрагмент:\n\n«" + info.selectionText + "»" + src);
    return;
  }
  if (info.menuItemId === "summarize-page" && tab && tab.id != null) {
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, func: grabPageText },
      function (results) {
        if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
          chrome.storage.local.set({ pendingPrompt: {
            error: "Не удалось прочитать страницу " + (tab.url || "") +
              ". Служебные страницы Chrome и магазин расширений закрыты для расширений.",
            at: Date.now() } }, function () {
            chrome.tabs.create({ url: chrome.runtime.getURL("chat.html?mode=tab") });
          });
          return;
        }
        var p = results[0].result;
        openChatWithPrompt("Кратко изложи содержание этой страницы.", p);
      }
    );
  }
});
