// Тонкая обёртка над официальным SDK Anthropic.
// Собирается esbuild-ом в extension/vendor/claude-api.js (глобальный объект ClaudeApi)
// с целевой платформой chrome109 — последней версией Chrome для Windows 7.
import Anthropic from "@anthropic-ai/sdk";

// Модели, для которых включаем серверный фолбэк при отказе (stop_reason: "refusal").
// У Claude Haiku 5.5 серверного фолбэка нет.
const FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
]);

function makeClient(apiKey) {
  return new Anthropic({
    apiKey,
    // Расширение работает в браузере; ключ хранится только локально у пользователя.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/**
 * Потоковый запрос к Claude.
 * opts: { apiKey, model, effort, system, messages, onText, onThinking, onFallback }
 * Возвращает { stream, done } — stream.abort() останавливает генерацию,
 * done резолвится итоговым сообщением.
 */
function streamChat(opts) {
  const client = makeClient(opts.apiKey);
  const params = {
    model: opts.model,
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: opts.effort || "medium" },
    messages: opts.messages,
  };
  if (opts.system && opts.system.trim()) params.system = opts.system;
  if (FALLBACK_MODELS.has(opts.model)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const stream = client.beta.messages.stream(params);

  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start" && event.content_block.type === "fallback") {
      if (opts.onFallback) opts.onFallback(event.content_block);
    } else if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta" && opts.onText) opts.onText(event.delta.text);
      else if (event.delta.type === "thinking_delta" && opts.onThinking) opts.onThinking(event.delta.thinking);
    }
  });

  return { stream, done: stream.finalMessage() };
}

/**
 * Готовит содержимое ответа ассистента к повторной отправке в истории.
 * Если внутри ответа был переход на резервную модель (блок "fallback"),
 * то блоки thinking / redacted_thinking / tool_use до последнего такого блока
 * не отправляются обратно, а сам блок fallback остаётся на месте.
 */
function contentForHistory(content) {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  const dropBefore = new Set(["thinking", "redacted_thinking", "tool_use"]);
  return content.filter((b, i) => !(i < lastFallback && dropBefore.has(b.type)));
}

/** Понятное сообщение об ошибке на русском. */
function describeError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return null;
  if (err instanceof Anthropic.AuthenticationError)
    return "Неверный API-ключ. Проверьте его в настройках расширения.";
  if (err instanceof Anthropic.PermissionDeniedError)
    return "Нет доступа к этой модели для вашего ключа.";
  if (err instanceof Anthropic.NotFoundError)
    return "Модель не найдена. Выберите другую модель в настройках.";
  if (err instanceof Anthropic.RateLimitError)
    return "Слишком много запросов. Подождите немного и попробуйте снова.";
  if (err instanceof Anthropic.BadRequestError)
    return "Ошибка запроса: " + (err.message || "");
  if (err instanceof Anthropic.InternalServerError)
    return "Сервер Anthropic временно недоступен (" + err.status + "). Попробуйте позже.";
  if (err instanceof Anthropic.APIConnectionError)
    return "Нет соединения с api.anthropic.com. Проверьте интернет или прокси.";
  if (err instanceof Anthropic.APIError)
    return "Ошибка API (" + err.status + "): " + (err.message || "");
  return "Ошибка: " + (err && err.message ? err.message : String(err));
}

/** Короткий запрос для проверки ключа на странице настроек. */
async function testKey(apiKey, model) {
  const client = makeClient(apiKey);
  const res = await client.messages.create({
    model,
    max_tokens: 256,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "Ответь одним словом: работает?" }],
  });
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

export { streamChat, contentForHistory, describeError, testKey };
