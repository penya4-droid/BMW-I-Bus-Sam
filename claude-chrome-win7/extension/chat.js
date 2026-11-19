// Логика окна чата (используется и во всплывающем окне, и во вкладке).

(function () {
  var params = new URLSearchParams(location.search);
  var MODE = params.get("mode") === "popup" ? "popup" : "tab";
  document.body.classList.add("mode-" + MODE);

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    sidebar: $("sidebar"), chatList: $("chatList"), newChat: $("newChat"),
    openOptions: $("openOptions"), toggleSidebar: $("toggleSidebar"),
    chatTitle: $("chatTitle"), modelSelect: $("modelSelect"), pageBtn: $("pageBtn"),
    openTab: $("openTab"), messages: $("messages"), empty: $("empty"), notice: $("notice"),
    attachments: $("attachments"), fileInput: $("fileInput"), input: $("input"),
    sendBtn: $("sendBtn"), stopBtn: $("stopBtn")
  };

  var settings = null;
  var index = [];          // [{id, title, updated}]
  var current = null;      // {id, title, messages: [{role, content, ui}]}
  var pending = [];        // вложения к следующему сообщению
  var active = null;       // текущий поток { stream }

  // ---------- хранилище чатов ----------

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function loadIndex() {
    var it = await storageGet("chatIndex");
    index = it.chatIndex || [];
  }

  async function saveCurrent() {
    if (!current || !current.messages.length) return;
    var o = {};
    o["chat_" + current.id] = current;
    var entry = index.filter(function (c) { return c.id === current.id; })[0];
    if (!entry) { entry = { id: current.id }; index.unshift(entry); }
    entry.title = current.title;
    entry.updated = Date.now();
    index.sort(function (a, b) { return b.updated - a.updated; });
    o.chatIndex = index;
    o.lastChatId = current.id;
    await storageSet(o);
    renderChatList();
  }

  async function openChat(id) {
    var key = "chat_" + id;
    var it = await storageGet(key);
    current = it[key] || { id: id, title: "Новый чат", messages: [] };
    await storageSet({ lastChatId: id });
    renderAll();
  }

  function startNewChat() {
    if (active) return;
    current = { id: newId(), title: "Новый чат", messages: [] };
    clearPending();
    renderAll();
    el.input.focus();
    if (MODE === "popup") el.sidebar.classList.remove("open");
  }

  async function deleteChat(id) {
    if (!confirm("Удалить этот чат?")) return;
    index = index.filter(function (c) { return c.id !== id; });
    await storageRemove("chat_" + id);
    await storageSet({ chatIndex: index });
    if (current && current.id === id) startNewChat();
    renderChatList();
  }

  // ---------- отрисовка ----------

  function renderChatList() {
    el.chatList.innerHTML = "";
    if (!index.length) {
      var e = document.createElement("div");
      e.className = "chat-list-empty";
      e.textContent = "Пока нет чатов";
      el.chatList.appendChild(e);
      return;
    }
    index.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "chat-item" + (current && current.id === c.id ? " active" : "");
      var t = document.createElement("span");
      t.className = "chat-item-title";
      t.textContent = c.title || "Без названия";
      var del = document.createElement("button");
      del.className = "chat-item-del";
      del.title = "Удалить";
      del.textContent = "×";
      del.addEventListener("click", function (ev) { ev.stopPropagation(); deleteChat(c.id); });
      row.appendChild(t);
      row.appendChild(del);
      row.addEventListener("click", function () {
        if (active) return;
        openChat(c.id);
        if (MODE === "popup") el.sidebar.classList.remove("open");
      });
      el.chatList.appendChild(row);
    });
  }

  function textOf(content, type) {
    if (typeof content === "string") return type === "text" ? content : "";
    return content.filter(function (b) { return b.type === type; })
      .map(function (b) { return type === "thinking" ? (b.thinking || "") : b.text; })
      .join(type === "text" ? "" : "\n\n");
  }

  function addCopyHandlers(root) {
    root.querySelectorAll(".copy-code").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var code = btn.closest(".code-wrap").querySelector("code").textContent;
        copyText(code, btn);
      });
    });
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var old = btn.textContent;
      btn.textContent = "Скопировано";
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  }

  function buildUserBubble(msg) {
    var wrap = document.createElement("div");
    wrap.className = "msg user";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    var blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
    var imgs = blocks.filter(function (b) { return b.type === "image"; });
    if (imgs.length) {
      var row = document.createElement("div");
      row.className = "msg-images";
      imgs.forEach(function (b) {
        var im = document.createElement("img");
        im.src = "data:" + b.source.media_type + ";base64," + b.source.data;
        row.appendChild(im);
      });
      bubble.appendChild(row);
    }
    var pages = (msg.ui && msg.ui.pages) || [];
    pages.forEach(function (p) {
      var chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = "📄 " + p.title;
      chip.title = p.url;
      bubble.appendChild(chip);
    });
    var text = (msg.ui && msg.ui.text != null) ? msg.ui.text : textOf(blocks, "text");
    if (text) {
      var t = document.createElement("div");
      t.className = "user-text";
      t.textContent = text;
      bubble.appendChild(t);
    }
    wrap.appendChild(bubble);
    return wrap;
  }

  function buildAssistantBubble() {
    var wrap = document.createElement("div");
    wrap.className = "msg assistant";
    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "✳";
    var body = document.createElement("div");
    body.className = "assistant-body";
    var info = document.createElement("div");
    info.className = "fallback-info";
    info.hidden = true;
    var think = document.createElement("details");
    think.className = "thinking";
    think.hidden = true;
    var sum = document.createElement("summary");
    sum.textContent = "Размышления";
    var thinkText = document.createElement("div");
    thinkText.className = "thinking-text";
    think.appendChild(sum);
    think.appendChild(thinkText);
    var md = document.createElement("div");
    md.className = "md";
    var tools = document.createElement("div");
    tools.className = "msg-tools";
    var copy = document.createElement("button");
    copy.className = "link-btn";
    copy.textContent = "Копировать";
    tools.appendChild(copy);
    body.appendChild(info);
    body.appendChild(think);
    body.appendChild(md);
    body.appendChild(tools);
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    var view = { wrap: wrap, info: info, think: think, thinkText: thinkText, md: md, tools: tools, copy: copy, text: "" };
    copy.addEventListener("click", function () { copyText(view.text, copy); });
    return view;
  }

  function fillAssistant(view, msg) {
    view.text = textOf(msg.content, "text");
    Md.render(view.md, view.text);
    addCopyHandlers(view.md);
    var th = textOf(msg.content, "thinking");
    if (settings.showThinking && th.trim()) {
      view.think.hidden = false;
      view.thinkText.textContent = th;
    }
    if (msg.ui && msg.ui.note) {
      view.info.hidden = false;
      view.info.textContent = msg.ui.note;
    }
  }

  function renderMessages() {
    Array.prototype.slice.call(el.messages.querySelectorAll(".msg")).forEach(function (n) { n.remove(); });
    var msgs = current ? current.messages : [];
    el.empty.hidden = msgs.length > 0;
    msgs.forEach(function (m) {
      if (m.role === "user") el.messages.appendChild(buildUserBubble(m));
      else {
        var v = buildAssistantBubble();
        fillAssistant(v, m);
        el.messages.appendChild(v.wrap);
      }
    });
    scrollToBottom(true);
  }

  function renderAll() {
    el.chatTitle.textContent = current ? current.title : "Claude";
    renderMessages();
    renderChatList();
  }

  function nearBottom() {
    var m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  function scrollToBottom(force) {
    if (force || nearBottom()) el.messages.scrollTop = el.messages.scrollHeight;
  }

  function showNotice(text, kind) {
    if (!text) { el.notice.hidden = true; return; }
    el.notice.hidden = false;
    el.notice.className = "notice " + (kind || "error");
    el.notice.innerHTML = "";
    var span = document.createElement("span");
    span.textContent = text;
    el.notice.appendChild(span);
    if (/ключ/i.test(text)) {
      var btns = document.createElement("span");
      btns.className = "notice-actions";
      var f = document.createElement("button");
      f.className = "btn btn-primary btn-small";
      f.textContent = "Бесплатный Claude";
      f.title = "Открыть claude.ai — бесплатный тариф, нужен аккаунт";
      f.addEventListener("click", function () { openFreeClaude(); if (MODE === "popup") window.close(); });
      var b = document.createElement("button");
      b.className = "link-btn";
      b.textContent = "Настройки";
      b.addEventListener("click", function () { chrome.runtime.openOptionsPage(); });
      btns.appendChild(f);
      btns.appendChild(b);
      el.notice.appendChild(btns);
    }
  }

  // ---------- вложения ----------

  function clearPending() {
    pending = [];
    renderPending();
  }

  function renderPending() {
    el.attachments.innerHTML = "";
    pending.forEach(function (a, i) {
      var chip = document.createElement("div");
      chip.className = "attach";
      if (a.kind === "image") {
        var im = document.createElement("img");
        im.src = "data:" + a.mediaType + ";base64," + a.data;
        chip.appendChild(im);
      } else {
        var s = document.createElement("span");
        s.textContent = "📄 " + a.title;
        s.title = a.url;
        chip.appendChild(s);
      }
      var x = document.createElement("button");
      x.textContent = "×";
      x.title = "Убрать";
      x.addEventListener("click", function () { pending.splice(i, 1); renderPending(); });
      chip.appendChild(x);
      el.attachments.appendChild(chip);
    });
  }

  // Уменьшает картинку, чтобы большая сторона была не больше 1568 px.
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Не удалось прочитать файл")); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error("Файл не похож на изображение")); };
        img.onload = function () {
          var max = 1568;
          var w = img.naturalWidth, h = img.naturalHeight;
          var dataUrl = reader.result;
          var type = file.type;
          if (Math.max(w, h) > max || file.size > 4 * 1024 * 1024) {
            var k = Math.min(1, max / Math.max(w, h));
            var c = document.createElement("canvas");
            c.width = Math.round(w * k); c.height = Math.round(h * k);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            dataUrl = c.toDataURL("image/jpeg", 0.88);
            type = "image/jpeg";
          }
          resolve({ kind: "image", mediaType: type, data: dataUrl.split(",")[1] });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    for (var i = 0; i < files.length; i++) {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(files[i].type)) {
        showNotice("Поддерживаются изображения PNG, JPEG, GIF и WebP.");
        continue;
      }
      try { pending.push(await readImage(files[i])); }
      catch (e) { showNotice(e.message); }
    }
    renderPending();
  }

  function grabPageText() {
    var text = (document.body && document.body.innerText) || "";
    return { title: document.title, url: location.href, text: text.slice(0, 150000) };
  }

  function attachActivePage() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || tab.id == null) { showNotice("Не найдена активная вкладка."); return; }
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: grabPageText }, function (res) {
        if (chrome.runtime.lastError || !res || !res[0] || !res[0].result) {
          showNotice("Эту страницу прочитать нельзя (служебные страницы Chrome и магазин расширений закрыты для расширений).");
          return;
        }
        var p = res[0].result;
        if (!p.text.trim()) { showNotice("На странице нет текста."); return; }
        pending.push({ kind: "page", title: p.title || p.url, url: p.url, text: p.text });
        renderPending();
        showNotice("");
        el.input.focus();
      });
    });
  }

  // ---------- отправка ----------

  function setBusy(busy) {
    el.sendBtn.hidden = busy;
    el.stopBtn.hidden = !busy;
    el.newChat.disabled = busy;
    el.modelSelect.disabled = busy;
  }

  function apiMessages() {
    return current.messages.map(function (m) { return { role: m.role, content: m.content }; });
  }

  function modelName(id) {
    var m = MODELS.filter(function (x) { return x.id === id; })[0];
    return m ? m.name : id;
  }

  async function send(textOverride) {
    if (active) return;
    var text = textOverride != null ? textOverride : el.input.value.trim();
    if (!text && !pending.length) return;
    if (!settings.apiKey) {
      showNotice("Для встроенного чата нужен платный API-ключ. Бесплатно — через claude.ai.");
      return;
    }
    showNotice("");
    if (!current) current = { id: newId(), title: "Новый чат", messages: [] };

    var blocks = [];
    var pages = [];
    pending.forEach(function (a) {
      if (a.kind === "image") {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: a.data } });
      } else {
        pages.push({ title: a.title, url: a.url });
        blocks.push({ type: "text", text: "<page title=\"" + a.title.replace(/"/g, "'") + "\" url=\"" + a.url + "\">\n" + a.text + "\n</page>" });
      }
    });
    var shownText = text;
    if (!text) text = pages.length ? "Кратко изложи содержание этой страницы." : "Что на этом изображении?";
    blocks.push({ type: "text", text: text });

    var userMsg = { role: "user", content: blocks, ui: { text: shownText || text, pages: pages } };
    if (current.messages.length === 0) {
      var base = shownText || (pages[0] && pages[0].title) || "Изображение";
      current.title = base.replace(/\s+/g, " ").slice(0, 48);
      el.chatTitle.textContent = current.title;
    }
    current.messages.push(userMsg);
    var savedPending = pending;
    clearPending();
    el.input.value = "";
    autoGrow();
    el.empty.hidden = true;
    el.messages.appendChild(buildUserBubble(userMsg));

    var view = buildAssistantBubble();
    view.md.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    el.messages.appendChild(view.wrap);
    scrollToBottom(true);
    setBusy(true);

    var textBuf = "", thinkBuf = "", scheduled = false, fallbackNote = "";
    function paint() {
      scheduled = false;
      var stick = nearBottom();
      if (textBuf) Md.render(view.md, textBuf);
      if (settings.showThinking && thinkBuf.trim()) {
        view.think.hidden = false;
        view.thinkText.textContent = thinkBuf;
      }
      if (stick) scrollToBottom(true);
    }
    function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(paint); } }

    var call;
    try {
      call = ClaudeApi.streamChat({
        apiKey: settings.apiKey,
        model: settings.model,
        effort: settings.effort,
        system: settings.system,
        messages: apiMessages(),
        onText: function (t) { textBuf += t; schedule(); },
        onThinking: function (t) { thinkBuf += t; schedule(); },
        onFallback: function (b) {
          fallbackNote = modelName(b.from && b.from.model) + " отказалась отвечать — ответ продолжила " + modelName(b.to && b.to.model) + ".";
          view.info.hidden = false;
          view.info.textContent = fallbackNote;
        }
      });
      active = call;
      var final = await call.done;
      active = null;

      if (final.stop_reason === "refusal") {
        current.messages.pop();
        view.wrap.remove();
        restoreInput(userMsg, savedPending);
        var det = final.stop_details && final.stop_details.explanation ? " (" + final.stop_details.explanation + ")" : "";
        showNotice("Claude отказался отвечать на этот запрос" + det + ". Попробуйте переформулировать.");
      } else {
        var asst = { role: "assistant", content: ClaudeApi.contentForHistory(final.content), ui: {} };
        if (fallbackNote) asst.ui.note = fallbackNote;
        if (final.stop_reason === "max_tokens") showNotice("Ответ обрезан: достигнут лимит длины.", "warn");
        current.messages.push(asst);
        fillAssistant(view, asst);
        await saveCurrent();
      }
    } catch (err) {
      active = null;
      var msg = ClaudeApi.describeError(err);
      if (msg === null && textBuf.trim()) {
        // Остановлено пользователем: сохраняем то, что успело прийти.
        var partial = { role: "assistant", content: [{ type: "text", text: textBuf.replace(/\s+$/, "") }], ui: { note: "Ответ остановлен." } };
        current.messages.push(partial);
        fillAssistant(view, partial);
        await saveCurrent();
      } else {
        current.messages.pop();
        view.wrap.remove();
        restoreInput(userMsg, savedPending);
        if (msg) showNotice(msg);
      }
    } finally {
      setBusy(false);
      if (!current.messages.length) renderAll();
      el.input.focus();
    }
  }

  function restoreInput(userMsg, savedPending) {
    var last = el.messages.querySelectorAll(".msg.user");
    if (last.length) last[last.length - 1].remove();
    el.input.value = userMsg.ui.text || "";
    pending = savedPending;
    renderPending();
    autoGrow();
    if (!current.messages.length) el.empty.hidden = false;
  }

  function stop() {
    if (active) active.stream.abort();
  }

  // ---------- ввод ----------

  function autoGrow() {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  }

  el.input.addEventListener("input", autoGrow);
  el.input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  el.input.addEventListener("paste", function (e) {
    var files = [];
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  el.messages.addEventListener("dragover", function (e) { e.preventDefault(); });
  el.messages.addEventListener("drop", function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
  el.fileInput.addEventListener("change", function () {
    addFiles(el.fileInput.files);
    el.fileInput.value = "";
  });
  el.sendBtn.addEventListener("click", function () { send(); });
  el.stopBtn.addEventListener("click", stop);
  el.newChat.addEventListener("click", startNewChat);
  el.openOptions.addEventListener("click", function () { chrome.runtime.openOptionsPage(); });
  el.toggleSidebar.addEventListener("click", function () { el.sidebar.classList.toggle("open"); });
  el.pageBtn.addEventListener("click", attachActivePage);
  el.openTab.addEventListener("click", function () {
    var url = chrome.runtime.getURL("chat.html?mode=tab");
    chrome.tabs.create({ url: url });
    if (MODE === "popup") window.close();
  });
  el.modelSelect.addEventListener("change", async function () {
    settings.model = el.modelSelect.value;
    await saveSettings(settings);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes.settings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
      el.modelSelect.value = settings.model;
    }
    if (changes.chatIndex && !active) {
      index = changes.chatIndex.newValue || [];
      renderChatList();
    }
  });

  // ---------- старт ----------

  async function init() {
    settings = await loadSettings();
    MODELS.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id; o.textContent = m.name;
      el.modelSelect.appendChild(o);
    });
    el.modelSelect.value = settings.model;
    if (MODE === "tab") { el.pageBtn.hidden = true; el.openTab.hidden = true; }

    await loadIndex();
    var it = await storageGet(["lastChatId", "pendingPrompt"]);
    var pp = it.pendingPrompt;
    if (pp && Date.now() - pp.at < 60000) {
      await storageRemove("pendingPrompt");
      startNewChat();
      if (pp.error) { showNotice(pp.error); el.sidebar.classList.add("open"); return; }
      if (pp.page) {
        pending.push({ kind: "page", title: pp.page.title || pp.page.url, url: pp.page.url, text: pp.page.text });
        renderPending();
      }
      if (settings.apiKey) send(pp.text);
      else { el.input.value = pp.text; autoGrow(); showNotice("Для встроенного чата нужен платный API-ключ. Бесплатно — через claude.ai."); }
    } else if (it.lastChatId && index.some(function (c) { return c.id === it.lastChatId; })) {
      await openChat(it.lastChatId);
    } else {
      startNewChat();
    }
    if (!settings.apiKey) showNotice("Для встроенного чата нужен платный API-ключ. Бесплатно — через claude.ai.");
    if (MODE === "tab") el.sidebar.classList.add("open");
    el.input.focus();
  }

  init();
})();
