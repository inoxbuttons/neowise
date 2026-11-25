import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { classify as mockClassify } from "./mock-ai.mjs";
import { parseInput, parseModelOutput, triage, MANUAL_REVIEW } from "./triage.mjs";
import { createApp, MAX_BODY_BYTES } from "./server.mjs";

const silent = () => {};
const run = (text, options = {}) => triage(text, { classify: mockClassify, log: silent, ...options });

describe("сбои модели дают manual_review (выданный имитатор)", () => {
  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(marker, async () => {
      assert.deepEqual(await run(`Где мой заказ? ${marker}`), MANUAL_REVIEW);
    });
  }

  test("несколько меток сразу", async () => {
    assert.deepEqual(await run("[bad-topic] [empty-draft]"), MANUAL_REVIEW);
  });

  test("таймаут срабатывает примерно за 300 мс, а не за 1200", async () => {
    const started = performance.now();
    const result = await run("[timeout]");
    const elapsed = performance.now() - started;
    assert.deepEqual(result, MANUAL_REVIEW);
    assert.ok(elapsed < 700, `ответ занял ${Math.round(elapsed)} мс`);
  });
});

describe("таймаут и недоверенный ответ (подставная модель)", () => {
  test("по таймауту вызов модели отменяется через signal", async () => {
    let receivedSignal;
    const hanging = (_text, { signal }) => {
      receivedSignal = signal;
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    };
    assert.deepEqual(await run("текст", { classify: hanging, timeoutMs: 50 }), MANUAL_REVIEW);
    assert.equal(receivedSignal.aborted, true);
  });

  test("модель, которая игнорирует signal, не подвешивает ответ", async () => {
    const neverResolves = () => new Promise(() => {});
    const started = performance.now();
    assert.deepEqual(await run("текст", { classify: neverResolves, timeoutMs: 50 }), MANUAL_REVIEW);
    assert.ok(performance.now() - started < 500);
  });

  test("синхронное исключение модели тоже даёт manual_review", async () => {
    const throwsSync = () => { throw new Error("boom"); };
    assert.deepEqual(await run("текст", { classify: throwsSync }), MANUAL_REVIEW);
  });

  test("лишние поля модели (в том числе status) не попадают в ответ", async () => {
    const sneaky = async () => JSON.stringify({ topic: "pricing", draft: "Ок", status: "hacked", extra: 1 });
    assert.deepEqual(await run("текст", { classify: sneaky }), { status: "ready", topic: "pricing", draft: "Ок" });
  });

  test("причина сбоя пишется в лог", async () => {
    const lines = [];
    await triage("[bad-json]", { classify: mockClassify, log: (line) => lines.push(line) });
    assert.match(lines.join("\n"), /bad_json/);
  });
});

describe("parseModelOutput", () => {
  const bad = {
    "не JSON": "oops",
    "null": "null",
    "число": "42",
    "массив": '[{"topic":"other","draft":"x"}]',
    "тема не из списка": '{"topic":"refund","draft":"x"}',
    "тема в другом регистре": '{"topic":"Delivery","draft":"x"}',
    "тема — свойство прототипа": '{"topic":"constructor","draft":"x"}',
    "тема __proto__": '{"topic":"__proto__","draft":"x"}',
    "черновик из пробелов": '{"topic":"other","draft":"  "}',
    "черновик не строка": '{"topic":"other","draft":123}',
    "нет черновика": '{"topic":"other"}',
  };
  for (const [name, raw] of Object.entries(bad)) {
    test(`отклоняет: ${name}`, () => assert.equal(parseModelOutput(raw).ok, false));
  }
  test("не строка на входе", () => assert.equal(parseModelOutput(undefined).ok, false));
  test("принимает корректный ответ", () => {
    assert.deepEqual(parseModelOutput('{"topic":"delivery","draft":" Привет "}'), { ok: true, topic: "delivery", draft: "Привет" });
  });
});

describe("parseInput", () => {
  for (const raw of ["", "not json", "null", "123", '"текст"', "[]", "{}", '{"text":5}', '{"text":null}', '{"text":["a"]}', '{"text":""}', '{"text":"  \\n "}']) {
    test(`отклоняет ${JSON.stringify(raw)}`, () => assert.equal(parseInput(raw), null));
  }
  test("принимает текст и обрезает пробелы", () => assert.equal(parseInput('{"text":"  Привет "}'), "Привет"));
});

describe("HTTP POST /api/triage", () => {
  let server;
  let url;
  before(async () => {
    server = createApp({ log: silent });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}/api/triage`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });

  for (const body of ["not json", "null", "{}", '{"text":5}', '{"text":"   "}']) {
    test(`400 invalid_input для ${body}`, async () => {
      const response = await post(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { status: "invalid_input" });
    });
  }

  test("200 manual_review при ошибке модели", async () => {
    const response = await post(JSON.stringify({ text: "Привет [error]" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "manual_review", topic: null, draft: null });
  });

  test("200 ready при успехе", async () => {
    const response = await post(JSON.stringify({ text: "Какая стоимость?" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ready",
      topic: "pricing",
      draft: "Спасибо за обращение. Уточним детали заявки.",
    });
  });

  test("413 при слишком большом теле", async () => {
    const response = await post(JSON.stringify({ text: "а".repeat(MAX_BODY_BYTES) }));
    assert.equal(response.status, 413);
  });
});
