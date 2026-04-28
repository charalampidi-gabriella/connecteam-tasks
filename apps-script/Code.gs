const ALLOWED_EMAILS = [
  'manager@rippnertennis.com',
  'hddavino@gmail.com',
];

function doGet() {
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!ALLOWED_EMAILS.map(e => e.toLowerCase()).includes(email)) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px">' +
      '<h3>Not authorized</h3>' +
      '<p>Your account (' + (email || 'unknown') + ') does not have access.</p>' +
      '</div>'
    );
  }
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Team Tasks Calendar')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

const PAGE_LIMIT = 100;
const PAGE_CONCURRENCY = 1;
const MAX_RETRIES = 6;
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;
const PAGE_DELAY_MS = 250;
const CACHE_TTL_SEC = 6 * 60 * 60;
const SOFT_TTL_SEC = 60 * 60;
const CHUNK_MAX_BYTES = 90 * 1024;

function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('CONNECTEAM_API_KEY');
  if (!key) throw new Error('Missing CONNECTEAM_API_KEY script property');
  return key;
}

function isRetryable_(code, text) {
  if (code === 429 || code >= 500) return true;
  if (code >= 400 && text && /bandwidth|quota|rate/i.test(text)) return true;
  return false;
}

function ctFetch_(path) {
  let delay = INITIAL_BACKOFF_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch('https://api.connecteam.com' + path, {
      headers: { 'X-API-KEY': getApiKey_() },
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code < 300) return JSON.parse(text);
    if (attempt < MAX_RETRIES && isRetryable_(code, text)) {
      Utilities.sleep(Math.min(delay, MAX_BACKOFF_MS));
      delay *= 2;
      continue;
    }
    throw new Error('Connecteam ' + code + ' (' + path + '): ' + text);
  }
}

function ctFetchMany_(paths) {
  const key = getApiKey_();
  let pending = paths.slice();
  const results = new Array(paths.length);
  const indexMap = paths.map((_, i) => i);
  let delay = INITIAL_BACKOFF_MS;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const requests = pending.map(p => ({
      url: 'https://api.connecteam.com' + p,
      headers: { 'X-API-KEY': key },
      muteHttpExceptions: true,
    }));
    const responses = UrlFetchApp.fetchAll(requests);
    const retryPaths = [];
    const retryIndexes = [];
    for (let j = 0; j < responses.length; j++) {
      const res = responses[j];
      const code = res.getResponseCode();
      const text = res.getContentText();
      const origIndex = indexMap[j];
      if (code < 300) {
        results[origIndex] = JSON.parse(text);
      } else if (attempt < MAX_RETRIES && isRetryable_(code, text)) {
        retryPaths.push(pending[j]);
        retryIndexes.push(origIndex);
      } else {
        throw new Error('Connecteam ' + code + ' (' + pending[j] + '): ' + text);
      }
    }
    if (retryPaths.length === 0) return results;
    Utilities.sleep(Math.min(delay, MAX_BACKOFF_MS));
    delay *= 2;
    pending = retryPaths;
    for (let j = 0; j < retryIndexes.length; j++) indexMap[j] = retryIndexes[j];
    indexMap.length = retryIndexes.length;
  }
  throw new Error('Connecteam: retries exhausted');
}

function paginate_(pathFn) {
  const first = ctFetch_(pathFn(0, PAGE_LIMIT));
  const firstPage = Object.values(first.data)[0];
  if (!Array.isArray(firstPage) || firstPage.length === 0) return [];
  if (firstPage.length < PAGE_LIMIT) return firstPage;

  const all = firstPage.slice();
  let nextOffset = PAGE_LIMIT;
  while (true) {
    const paths = [];
    for (let i = 0; i < PAGE_CONCURRENCY; i++) {
      paths.push(pathFn(nextOffset + i * PAGE_LIMIT, PAGE_LIMIT));
    }
    const bodies = ctFetchMany_(paths);
    let done = false;
    for (const body of bodies) {
      const page = Object.values(body.data)[0];
      if (!Array.isArray(page) || page.length === 0) { done = true; continue; }
      Array.prototype.push.apply(all, page);
      if (page.length < PAGE_LIMIT) done = true;
    }
    if (done) return all;
    nextOffset += PAGE_CONCURRENCY * PAGE_LIMIT;
    if (PAGE_DELAY_MS > 0) Utilities.sleep(PAGE_DELAY_MS);
  }
}

function cacheGet_(key) {
  const cache = CacheService.getScriptCache();
  const meta = cache.get(key + ':meta');
  if (!meta) return null;
  const chunks = JSON.parse(meta).chunks;
  const keys = [];
  for (let i = 0; i < chunks; i++) keys.push(key + ':' + i);
  const parts = cache.getAll(keys);
  let combined = '';
  for (let i = 0; i < chunks; i++) {
    const part = parts[key + ':' + i];
    if (part == null) return null;
    combined += part;
  }
  try { return JSON.parse(combined); } catch (e) { return null; }
}

function cachePut_(key, value, ttlSec) {
  const cache = CacheService.getScriptCache();
  const wrapped = { cachedAt: Date.now(), value: value };
  const serialized = JSON.stringify(wrapped);
  const entries = {};
  let chunks = 0;
  for (let i = 0; i < serialized.length; i += CHUNK_MAX_BYTES) {
    entries[key + ':' + chunks] = serialized.substring(i, i + CHUNK_MAX_BYTES);
    chunks++;
  }
  if (chunks === 0) {
    entries[key + ':0'] = '';
    chunks = 1;
  }
  entries[key + ':meta'] = JSON.stringify({ chunks: chunks });
  cache.putAll(entries, ttlSec || CACHE_TTL_SEC);
}

function cached_(key, producer, ttlSec) {
  const hit = cacheGet_(key);
  if (hit !== null && hit && typeof hit === 'object' && 'value' in hit) {
    const ageSec = (Date.now() - (hit.cachedAt || 0)) / 1000;
    return { value: hit.value, stale: ageSec > SOFT_TTL_SEC };
  }
  const value = producer();
  try { cachePut_(key, value, ttlSec); } catch (e) { console.warn('cache put failed: ' + e); }
  return { value: value, stale: false };
}

function buildBootstrap_() {
  const boards = paginate_((o, l) => '/tasks/v1/taskboards?limit=' + l + '&offset=' + o);
  const users = paginate_((o, l) => '/users/v1/users?limit=' + l + '&offset=' + o);
  return { boards: boards, users: users };
}

function buildBoardData_(boardId) {
  const tasks = paginate_((o, l) =>
    '/tasks/v1/taskboards/' + boardId + '/tasks?limit=' + l + '&offset=' + o);
  const labels = paginate_((o, l) =>
    '/tasks/v1/taskboards/' + boardId + '/labels?limit=' + l + '&offset=' + o);
  return { tasks: tasks, labels: labels };
}

function getBootstrap() {
  const r = cached_('bootstrap', buildBootstrap_);
  return { boards: r.value.boards, users: r.value.users, stale: r.stale };
}

function getBoardData(boardId) {
  const r = cached_('board:' + boardId, () => buildBoardData_(boardId));
  return { tasks: r.value.tasks, labels: r.value.labels, stale: r.stale };
}

function refreshBootstrap() {
  try { cachePut_('bootstrap', buildBootstrap_(), CACHE_TTL_SEC); } catch (e) { console.warn('refreshBootstrap: ' + e); }
  return true;
}

function refreshBoardData(boardId) {
  try { cachePut_('board:' + boardId, buildBoardData_(boardId), CACHE_TTL_SEC); } catch (e) { console.warn('refreshBoardData: ' + e); }
  return true;
}

function forceRefreshBoardData(boardId) {
  const data = buildBoardData_(boardId);
  try { cachePut_('board:' + boardId, data, CACHE_TTL_SEC); } catch (e) { console.warn('forceRefreshBoardData: ' + e); }
  return { tasks: data.tasks, labels: data.labels };
}

