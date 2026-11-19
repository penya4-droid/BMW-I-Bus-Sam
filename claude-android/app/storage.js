// Хранилище «ключ → значение» на IndexedDB (вмещает чаты с картинками, в отличие от localStorage).
// Тот же интерфейс, что и в расширении: storageGet / storageSet / storageRemove.

var KV = (function () {
  var dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise(function (resolve, reject) {
        var r = indexedDB.open("claude-pwa", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    }
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction("kv", mode);
        var out = fn(t.objectStore("kv"));
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("Хранилище переполнено")); };
      });
    });
  }
  return { tx: tx };
})();

function storageGet(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  var res = {};
  return KV.tx("readonly", function (s) {
    keys.forEach(function (k) {
      var r = s.get(k);
      r.onsuccess = function () { if (r.result !== undefined) res[k] = r.result; };
    });
    return res;
  });
}

function storageSet(items) {
  return KV.tx("readwrite", function (s) {
    Object.keys(items).forEach(function (k) { s.put(items[k], k); });
  });
}

function storageRemove(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  return KV.tx("readwrite", function (s) { keys.forEach(function (k) { s.delete(k); }); });
}

function storageAll() {
  var res = {};
  return KV.tx("readonly", function (s) {
    var r = s.openCursor();
    r.onsuccess = function () {
      var c = r.result;
      if (c) { res[c.key] = c.value; c.continue(); }
    };
    return res;
  });
}

// ---------- настройки ----------

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

function loadSettings() {
  return storageGet("settings").then(function (it) {
    return Object.assign({}, DEFAULT_SETTINGS, it.settings || {});
  });
}

function saveSettings(s) {
  return storageSet({ settings: s });
}

// Бесплатные варианты: официальное приложение Claude и сайт claude.ai.
var FREE_WEB = "https://claude.ai/new";
var FREE_PLAY = "https://play.google.com/store/apps/details?id=com.anthropic.claude";
