import { BASE, paginate, cachedJson, jsonResponse, errorResponse } from "../_lib/connecteam.js";

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const bypass = url.searchParams.get("refresh") === "1";
  try {
    const value = await cachedJson({
      cacheKey: "users",
      bypass,
      ctx,
      producer: () =>
        paginate(ctx.env.CONNECTEAM_API_KEY, (o, l) => `${BASE}/users/v1/users?limit=${l}&offset=${o}`),
    });
    return jsonResponse(value);
  } catch (e) {
    return errorResponse(e);
  }
}
