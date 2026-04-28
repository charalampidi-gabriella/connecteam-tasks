const COOKIE_NAME = "__Host-ct_auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function deriveCookieValue(token) {
  const data = new TextEncoder().encode("ct_auth:v1:" + token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export const onRequest = async (ctx) => {
  const { request, env, next } = ctx;
  const expected = env.ACCESS_TOKEN;

  if (!expected) {
    return new Response("Server misconfigured: ACCESS_TOKEN not set", { status: 500 });
  }

  const expectedCookie = await deriveCookieValue(expected);

  const cookieValue = readCookie(request, COOKIE_NAME);
  if (cookieValue && safeEqual(cookieValue, expectedCookie)) {
    return next();
  }

  const url = new URL(request.url);
  const queryToken = url.searchParams.get("key");
  if (queryToken && safeEqual(queryToken, expected)) {
    url.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search + url.hash,
        "Set-Cookie": `${COOKIE_NAME}=${expectedCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
        "Cache-Control": "no-store",
      },
    });
  }

  return new Response("Not Found", { status: 404 });
};
