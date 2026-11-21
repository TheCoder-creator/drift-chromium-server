import express from "express";
import { chromium } from "playwright";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.DRIFT_SERVER_SECRET;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 6);
const MAX_PER_IP = Number(process.env.MAX_SESSIONS_PER_IP || 2);
const SESSION_TTL = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);

if (!SECRET || SECRET.length < 24) {
  throw new Error("Set DRIFT_SERVER_SECRET to a random value at least 24 characters long.");
}

let browser;
const sessions = new Map();

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (version === 6) {
    const s = ip.toLowerCase();
    return s === "::" || s === "::1" || s.startsWith("fc") ||
      s.startsWith("fd") || s.startsWith("fe8") ||
      s.startsWith("fe9") || s.startsWith("fea") ||
      s.startsWith("feb") || s.startsWith("::ffff:");
  }
  return true;
}

async function publicHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    return records.length > 0 && records.every(record => !isPrivateIp(record.address));
  } catch {
    return false;
  }
}

async function safeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Enter a valid website address.");
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid website address."); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS websites are supported.");
  }
  if (url.username || url.password) throw new Error("Website addresses cannot contain login credentials.");
  if (!(await publicHost(url.hostname))) throw new Error("That website address is not allowed.");
  return url.href;
}

async function protectPage(page) {
  await page.route("**/*", async route => {
    try {
      const url = new URL(route.request().url());
      if (["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
      if (!["http:", "https:"].includes(url.protocol)) return route.abort();
      if (!(await publicHost(url.hostname))) return route.abort();
      return route.continue();
    } catch {
      return route.abort();
    }
  });
}

function findSession(req) {
  const session = sessions.get(req.params.id);
  if (!session) throw new Error("Browser session expired. Open a new tab.");
  session.lastUsed = Date.now();
  return session;
}

async function snapshot(session) {
  const png = await session.page.screenshot({
    type: "png",
    animations: "disabled",
    timeout: 15000
  });
  return {
    image: png.toString("base64"),
    url: session.page.url(),
    title: await session.page.title().catch(() => "Drift")
  };
}

app.use("/api", (req, res, next) => {
  if (req.get("authorization") !== `Bearer ${SECRET}`) {
    return res.status(401).json({ error: "Not authorized." });
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, service: "drift-chromium" }));

app.post("/api/session", async (req, res) => {
  let context;
  try {
    const ip = String(req.get("x-client-ip") || "unknown").slice(0, 80);
    const fromIp = [...sessions.values()].filter(s => s.ip === ip).length;
    if (sessions.size >= MAX_SESSIONS) {
      return res.status(429).json({ error: "The browser server is full. Try again shortly." });
    }
    if (fromIp >= MAX_PER_IP) {
      return res.status(429).json({ error: "You already have the maximum number of Drift sessions." });
    }

    const startUrl = await safeUrl(req.body?.url || "https://example.com");
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(25000);
    await protectPage(page);

    const id = crypto.randomBytes(24).toString("hex");
    const session = { id, ip, context, page, lastUsed: Date.now() };
    sessions.set(id, session);
    page.on("close", () => sessions.delete(id));

    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    res.json({ sessionId: id, ...(await snapshot(session)) });
  } catch (error) {
    if (context) await context.close().catch(() => {});
    res.status(400).json({ error: error.message || "Could not start browser." });
  }
});

app.post("/api/:id/navigate", async (req, res) => {
  try {
    const session = findSession(req);
    const url = await safeUrl(req.body?.url);
    await session.page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
    res.json(await snapshot(session));
  } catch (error) {
    res.status(400).json({ error: error.message || "Navigation failed." });
  }
});

app.post("/api/:id/action", async (req, res) => {
  try {
    const session = findSession(req);
    const body = req.body || {};
    if (body.action === "back") {
      await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    } else if (body.action === "forward") {
      await session.page.goForward({ waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
    } else if (body.action === "reload") {
      await session.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
    } else if (body.action === "home") {
      await session.page.goto("https://example.com", { waitUntil: "domcontentloaded" }).catch(() => {});
    } else if (body.action === "click") {
      const x = Number(body.x), y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid click position.");
      await session.page.mouse.click(Math.max(0, Math.min(1280, x)), Math.max(0, Math.min(800, y)));
    } else if (body.action === "type") {
      await session.page.keyboard.insertText(String(body.text || "").slice(0, 2000));
    } else if (body.action === "key") {
      const allowed = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown",
        "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "];
      if (!allowed.includes(body.key)) throw new Error("That key is not supported.");
      await session.page.keyboard.press(body.key);
    } else if (body.action === "scroll") {
      const delta = Math.max(-800, Math.min(800, Number(body.deltaY) || 0));
      await session.page.mouse.wheel(0, delta);
    } else {
      throw new Error("Unknown browser action.");
    }
    res.json(await snapshot(session));
  } catch (error) {
    res.status(400).json({ error: error.message || "Browser action failed." });
  }
});

app.post("/api/:id/close", async (req, res) => {
  try {
    const session = findSession(req);
    sessions.delete(session.id);
    await session.context.close();
  } catch {}
  res.json({ ok: true });
});

const cleanup = setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL) {
      sessions.delete(id);
      await session.context.close().catch(() => {});
    }
  }
}, 30000);
cleanup.unref();

async function shutdown() {
  clearInterval(cleanup);
  for (const session of sessions.values()) await session.context.close().catch(() => {});
  sessions.clear();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Drift Chromium server listening on ${PORT}`);
});
