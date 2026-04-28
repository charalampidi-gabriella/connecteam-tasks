import {
  BASE,
  CACHE_TTL_MS,
  paginate,
  cachedJson,
  getCachedValue,
  setCachedValue,
  jsonResponse,
  errorResponse,
} from "../../../_lib/connecteam.js";

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const { id } = ctx.params;
  const status = url.searchParams.get("includeCompleted") === "1" ? "all" : "published";
  const bypass = url.searchParams.get("refresh") === "1";
  const stream = url.searchParams.get("stream") === "1";
  const cacheKey = `tasks:${id}:${status}`;
  const apiKey = ctx.env.CONNECTEAM_API_KEY;
  const urlFn = (o, l) =>
    `${BASE}/tasks/v1/taskboards/${id}/tasks?limit=${l}&offset=${o}&status=${status}`;

  if (!stream) {
    try {
      const value = await cachedJson({
        cacheKey,
        bypass,
        ctx,
        producer: () => paginate(apiKey, urlFn),
      });
      return jsonResponse(value);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (!bypass) {
    const hit = await getCachedValue(cacheKey);
    if (hit) {
      if (hit.stale) {
        ctx.waitUntil((async () => {
          try {
            const fresh = await paginate(apiKey, urlFn);
            await setCachedValue(cacheKey, fresh, CACHE_TTL_MS);
          } catch (e) {
            console.error(`background refresh ${cacheKey}:`, e);
          }
        })());
      }
      return new Response(JSON.stringify(hit.value) + "\n", {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  ctx.waitUntil((async () => {
    try {
      const all = await paginate(apiKey, urlFn, (page) => {
        writer.write(encoder.encode(JSON.stringify(page) + "\n"));
      });
      await setCachedValue(cacheKey, all, CACHE_TTL_MS);
    } catch (e) {
      console.error(`stream ${cacheKey}:`, e);
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })());

  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
