// Общие настройки и доступ к хранилищу (chrome.storage.local).

var MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2" }
];

var EFFORTS = [
  { id: "low", name: "Низкий — быстро и дёшево" },
  { id: "medium", name: "Средний (по умолчанию)" },
  { id: "high", name: "Высокий" },
  { id: "xhigh", name: "Очень высокий" },
  { id: "max", name: "Максимальный" }
];

var DEFAULT_SETTINGS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  system: "Ты — Claude, полезный ассистент. Отвечай на языке пользователя.",
  showThinking: true
};

function storageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (items) { resolve(items || {}); });
  });
}

function storageSet(items) {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.set(items, function () {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise(function (resolve) { chrome.storage.local.remove(keys, resolve); });
}

async function loadSettings() {
  var items = await storageGet("settings");
  var s = Object.assign({}, DEFAULT_SETTINGS, items.settings || {});
  return s;
}

function saveSettings(s) {
  return storageSet({ settings: s });
}
