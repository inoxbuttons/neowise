import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import { parseInput, triage, INVALID_INPUT } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

// Заявка — короткий текст. Лимит защищает от бесконечного тела запроса.
export const MAX_BODY_BYTES = 16 * 1024;

class PayloadTooLargeError extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleTriage(request, response, options) {
  const text = parseInput(await readBody(request));
  if (text === null) return json(response, 400, INVALID_INPUT);
  return json(response, 200, await triage(text, options));
}

/** Создаёт сервер. Модель передаётся снаружи, чтобы тесты могли подставить свою. */
export function createApp({ classify = mockClassify, timeoutMs, log } = {}) {
  return createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || pathname !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, { classify, timeoutMs, log });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        response.setHeader("Connection", "close");
        return json(response, 413, { status: "payload_too_large" });
      }
      console.error("[server] unexpected error", error);
      if (!response.headersSent) json(response, 500, { status: "server_error" });
    }
  });
}

// Слушаем порт только при запуске `node server.mjs`. При импорте из тестов сервер не стартует.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
