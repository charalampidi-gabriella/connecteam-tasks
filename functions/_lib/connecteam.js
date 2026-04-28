export const BASE = "https://api.connecteam.com";
export const PAGE_LIMIT = 100;
export const PAGE_CONCURRENCY = 5;
export const CACHE_TTL_MS = 10 * 60_000;

async function ctFetch(url, apiKey) {
  const res = await fetch(url, { headers: { "X-API-KEY": apiKey } });
  const body = await res.json();
  if (!res.ok) throw new Error(`Connecteam ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function paginate(apiKey, urlFn, onPage) {
  const first = await ctFetch(urlFn(0, PAGE_LIMIT), apiKey);
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
        ctFetch(urlFn(offset, PAGE_LIMIT), apiKey).then((body) => {
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

function cacheReq(cacheKey) {
  return new Request(`https://cache.local/${encodeURIComponent(cacheKey)}`);
}

export async function getCachedValue(cacheKey) {
  const hit = await caches.default.match(cacheReq(cacheKey));
  if (!hit) return null;
  const expires = Number(hit.headers.get("x-expires") || 0);
  const value = await hit.json();
  return { value, stale: expires <= Date.now() };
}

export async function setCachedValue(cacheKey, value, ttlMs = CACHE_TTL_MS) {
  const res = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${Math.floor(ttlMs / 1000) * 6}`,
      "x-expires": String(Date.now() + ttlMs),
    },
  });
  await caches.default.put(cacheReq(cacheKey), res);
}

export async function cachedJson({ cacheKey, bypass, ttlMs = CACHE_TTL_MS, producer, ctx }) {
  if (!bypass) {
    const hit = await getCachedValue(cacheKey);
    if (hit) {
      if (hit.stale) {
        ctx.waitUntil((async () => {
          try {
            const fresh = await producer();
            await setCachedValue(cacheKey, fresh, ttlMs);
          } catch (e) {
            console.error(`background refresh ${cacheKey}:`, e);
          }
        })());
      }
      return hit.value;
    }
  }
  const fresh = await producer();
  ctx.waitUntil(setCachedValue(cacheKey, fresh, ttlMs));
  return fresh;
}

export function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponse(e) {
  return new Response(JSON.stringify({ error: e.message }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}
