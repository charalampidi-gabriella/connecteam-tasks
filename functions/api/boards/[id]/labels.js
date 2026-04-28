import { BASE, paginate, cachedJson, jsonResponse, errorResponse } from "../../../_lib/connecteam.js";

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const bypass = url.searchParams.get("refresh") === "1";
  const { id } = ctx.params;
  try {
    const value = await cachedJson({
      cacheKey: `labels:${id}`,
      bypass,
      ctx,
      producer: () =>
        paginate(
          ctx.env.CONNECTEAM_API_KEY,
          (o, l) => `${BASE}/tasks/v1/taskboards/${id}/labels?limit=${l}&offset=${o}`
        ),
    });
    return jsonResponse(value);
  } catch (e) {
    return errorResponse(e);
  }
}
