// Логика разбора заявки без HTTP: проверка ввода, вызов модели с таймаутом и проверка её ответа.

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });
export const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

/**
 * Проверяет сырое тело запроса.
 * Возвращает текст заявки или null, если ввод некорректен
 * (битый JSON, не объект, `text` отсутствует, не строка или состоит из одних пробелов).
 */
export function parseInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Проверяет ответ модели. Ответу AI не доверяем: это должен быть JSON-объект
 * с темой из белого списка и непустым строковым черновиком.
 * Лишние поля отбрасываются.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "not_object" };
  }
  const { topic, draft } = data;
  if (typeof topic !== "string" || !TOPICS.has(topic)) return { ok: false, reason: "bad_topic" };
  if (typeof draft !== "string" || draft.trim() === "") return { ok: false, reason: "empty_draft" };
  return { ok: true, topic, draft: draft.trim() };
}

class ModelTimeoutError extends Error {
  constructor(ms) {
    super(`Model did not respond within ${ms} ms`);
    this.name = "ModelTimeoutError";
  }
}

/**
 * Вызывает модель и ждёт не дольше timeoutMs.
 * По таймауту отменяет вызов через AbortSignal. Promise.race дополнительно
 * страхует от модели, которая игнорирует signal.
 */
async function callModelWithTimeout(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Разбирает уже проверенный текст заявки.
 * Любой сбой модели превращается в manual_review. Причина пишется только
 * в серверный лог и клиенту не отдаётся.
 */
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  let raw;
  try {
    raw = await callModelWithTimeout(classify, text, timeoutMs);
  } catch (error) {
    const reason = error instanceof ModelTimeoutError ? "timeout" : "model_error";
    log(`[triage] manual_review: ${reason}`);
    return MANUAL_REVIEW;
  }
  const parsed = parseModelOutput(raw);
  if (!parsed.ok) {
    log(`[triage] manual_review: ${parsed.reason}`);
    return MANUAL_REVIEW;
  }
  return { status: "ready", topic: parsed.topic, draft: parsed.draft };
}
