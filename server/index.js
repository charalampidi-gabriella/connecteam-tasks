import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const API_KEY = process.env.CONNECTEAM_API_KEY;
const BASE = "https://api.connecteam.com";
const PORT = process.env.PORT || 3001;

if (!API_KEY) {
  console.error("Missing CONNECTEAM_API_KEY in .env");
  process.exit(1);
}

const app = express();

const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

function refresh(key, producer, ttlMs) {
  const pending = producer().then(
    (value) => {
      cache.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    (err) => {
      const existing = cache.get(key);
      if (existing && "value" in existing) {
        cache.set(key, { value: existing.value, expires: existing.expires });
      } else {
        cache.delete(key);
      }
      throw err;
    }
  );
  const existing = cache.get(key);
  cache.set(key, { ...(existing || {}), pending });
  return pending;
}

async function cached(key, producer, ttlMs = CACHE_TTL_MS) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && "value" in hit) {
    if (hit.expires <= now && !hit.pending) {
      refresh(key, producer, ttlMs).catch((e) => console.error(`background refresh ${key}:`, e.message));
    }
    return hit.value;
  }
  if (hit && hit.pending) return hit.pending;
  return refresh(key, producer, ttlMs);
}

async function ct(url) {
  const res = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Connecteam ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

const PAGE_LIMIT = 100;
const PAGE_CONCURRENCY = 5;

async function paginate(urlFn, onPage) {
  const first = await ct(urlFn(0, PAGE_LIMIT));
  const firstPage = Object.values(first.data)[0];
  if (!Array.isArray(firstPage) || firstPage.length === 0) return [];
  if (onPage) onPage(firstPage);
  if (firstPage.length < PAGE_LIMIT) return firstPage;

  const all = [...firstPage];
  let nextOffset = PAGE_LIMIT;
  while (true) {
    const requests = [];
    for (let i = 0; i < PAGE_CONCURRENCY; i++) {
      const offset = nextOffset + i * PAGE_LIMIT;
      requests.push(
        ct(urlFn(offset, PAGE_LIMIT)).then((body) => {
          const page = Object.values(body.data)[0];
          if (onPage && Array.isArray(page) && page.length > 0) onPage(page);
          return page;
        })
      );
    }
    const pages = await Promise.all(requests);
    let done = false;
    for (const page of pages) {
      if (!Array.isArray(page) || page.length === 0) { done = true; continue; }
      all.push(...page);
      if (page.length < PAGE_LIMIT) done = true;
    }
    if (done) return all;
    nextOffset += PAGE_CONCURRENCY * PAGE_LIMIT;
  }
}

function shouldBypass(req) {
  return req.query.refresh === "1";
}

app.get("/api/boards", async (req, res, next) => {
  try {
    if (shouldBypass(req)) cache.delete("boards");
    const boards = await cached("boards", () =>
      paginate((o, l) => `${BASE}/tasks/v1/taskboards?limit=${l}&offset=${o}`)
    );
    res.json(boards);
  } catch (e) { next(e); }
});

app.get("/api/boards/:id/tasks", async (req, res, next) => {
  try {
    const { id } = req.params;
    const status = req.query.includeCompleted === "1" ? "all" : "published";
    const key = `tasks:${id}:${status}`;
    const urlFn = (o, l) =>
      `${BASE}/tasks/v1/taskboards/${id}/tasks?limit=${l}&offset=${o}&status=${status}`;
    if (shouldBypass(req)) cache.delete(key);

    if (req.query.stream !== "1") {
      const tasks = await cached(key, () => paginate(urlFn));
      return res.json(tasks);
    }

    res.setHeader("Content-Type", "application/x-ndjson");

    const hit = cache.get(key);
    if (hit && "value" in hit) {
      res.write(JSON.stringify(hit.value) + "\n");
      res.end();
      if (hit.expires <= Date.now() && !hit.pending) {
        refresh(key, () => paginate(urlFn), CACHE_TTL_MS).catch((e) =>
          console.error(`background refresh ${key}:`, e.message)
        );
      }
      return;
    }
    if (hit && hit.pending) {
      const value = await hit.pending;
      res.write(JSON.stringify(value) + "\n");
      return res.end();
    }

    try {
      await refresh(
        key,
        () => paginate(urlFn, (page) => res.write(JSON.stringify(page) + "\n")),
        CACHE_TTL_MS
      );
    } catch (e) {
      console.error(`stream ${key}:`, e.message);
    }
    res.end();
  } catch (e) { next(e); }
});

app.get("/api/boards/:id/labels", async (req, res, next) => {
  try {
    const { id } = req.params;
    const key = `labels:${id}`;
    if (shouldBypass(req)) cache.delete(key);
    const labels = await cached(key, () =>
      paginate((o, l) => `${BASE}/tasks/v1/taskboards/${id}/labels?limit=${l}&offset=${o}`)
    );
    res.json(labels);
  } catch (e) { next(e); }
});

app.get("/api/users", async (req, res, next) => {
  try {
    if (shouldBypass(req)) cache.delete("users");
    const users = await cached("users", () =>
      paginate((o, l) => `${BASE}/users/v1/users?limit=${l}&offset=${o}`)
    );
    res.json(users);
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => console.log(`server listening on http://localhost:${PORT}`));
