const fs = require("fs");
const http = require("http");
const path = require("path");
const { PredictionBot } = require("./bot");

const PUBLIC_DIR = path.join(__dirname, "public");

function contentType(fileName) {
  if (fileName.endsWith(".html")) return "text/html; charset=utf-8";
  if (fileName.endsWith(".css")) return "text/css; charset=utf-8";
  if (fileName.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1_000_000) {
        reject(new Error("Payload too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    request.on("error", reject);
  });
}

function createServer(defaultConfig = {}) {
  const bot = new PredictionBot(defaultConfig);
  const state = {
    lastError: null,
  };

  bot.on("log", () => {
    state.lastError = null;
  });

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const pathname = requestUrl.pathname;

    if (pathname === "/api/status" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          ok: true,
          ...bot.getStatus(),
          lastError: state.lastError,
        }),
      );
      return;
    }

    if (pathname === "/api/scan" && request.method === "POST") {
      try {
        const body = await readBody(request);
        bot.updateConfig(body);
        const winners = await bot.scanWinners();
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ ok: true, winners }));
      } catch (error) {
        state.lastError = error.message;
        response.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (pathname === "/api/start" && request.method === "POST") {
      try {
        const body = await readBody(request);
        state.lastError = null;

        if (bot.running) {
          await bot.stop();
          await new Promise((resolve) => setTimeout(resolve, 300));
        }

        bot.start(body).catch((error) => {
          state.lastError = error.message;
          bot.log("error", "Bot start gagal.", { error: error.message });
        });

        response.writeHead(202, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        state.lastError = error.message;
        response.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }

    if (pathname === "/api/stop" && request.method === "POST") {
      await bot.stop();
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    const assetPath = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(PUBLIC_DIR, assetPath);

    if (
      !filePath.startsWith(PUBLIC_DIR) ||
      !fs.existsSync(filePath) ||
      fs.statSync(filePath).isDirectory()
    ) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(response);
  });

  return { server, bot };
}

module.exports = { createServer };
