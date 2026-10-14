const FOOTBALL_API = 'https://api.football-data.org/v4';
const MAX_M3U_BYTES = 5 * 1024 * 1024;

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function fromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function signSession(expiry, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiry)));
  return `${expiry}.${base64url(new Uint8Array(signature))}`;
}
async function hasSession(request, env) {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return false;
  const cookie = request.headers.get('Cookie') || '';
  const token = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('vionza_session='))?.slice('vionza_session='.length);
  if (!token) return false;
  const [expiryText, signature] = token.split('.');
  const expiry = Number(expiryText);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000) || !signature) return false;
  try {
    const expected = await signSession(expiry, env.SESSION_SECRET);
    return expected === token;
  } catch { return false; }
}
function cookieHeader(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `vionza_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function formatMatch(m) {
  return {
    id: String(m.id),
    home: m.homeTeam?.shortName || m.homeTeam?.name || 'Time da casa',
    away: m.awayTeam?.shortName || m.awayTeam?.name || 'Time visitante',
    competition: m.competition?.name || 'Competição',
    utcDate: m.utcDate || null,
    status: m.status || 'SCHEDULED',
    homeCrest: m.homeTeam?.crest || null,
    awayCrest: m.awayTeam?.crest || null,
    source: 'football-data.org',
  };
}

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const group = line.match(/group-title\s*=\s*["']([^"']*)["']/i)?.[1]?.trim() || 'Sem categoria';
      const comma = line.lastIndexOf(',');
      const name = (comma >= 0 ? line.slice(comma + 1) : '').trim();
      if (name) pending = { name: name.slice(0, 120), category: group.slice(0, 80) };
      else pending = null;
    } else if (line && !line.startsWith('#') && pending) {
      // The URL is intentionally discarded; only the channel label/category are returned.
      channels.push(pending);
      pending = null;
    }
  }
  const unique = new Map();
  for (const c of channels) {
    const key = `${c.category.toLowerCase()}::${c.name.toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, { id: `ch-${unique.size + 1}`, ...c });
  }
  return [...unique.values()].slice(0, 2000);
}

async function getChannels(env, ctx) {
  if (!env.M3U_URL) return json({ error: 'A fonte M3U ainda não foi configurada como segredo no Cloudflare.' }, 503);
  let url;
  try { url = new URL(env.M3U_URL); } catch { return json({ error: 'M3U_URL não é uma URL válida.' }, 500); }
  if (!['https:', 'http:'].includes(url.protocol)) return json({ error: 'A URL da lista precisa usar HTTP ou HTTPS.' }, 500);
  try {
    const response = await fetch(url.toString(), { headers: { 'User-Agent': 'VionzaStudio/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return json({ error: `A fonte M3U respondeu HTTP ${response.status}. Confere o link e a autorização de acesso.` }, 502);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_M3U_BYTES) return json({ error: 'A lista é maior que o limite inicial de 5 MB. Precisamos otimizar a importação.' }, 413);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_M3U_BYTES) return json({ error: 'A lista é maior que o limite inicial de 5 MB.' }, 413);
    if (!text.trimStart().startsWith('#EXTM3U')) return json({ error: 'A resposta não parece ser uma lista M3U válida.' }, 422);
    const channels = parseM3U(text);
    return json({ count: channels.length, channels, note: 'Foram importados apenas nomes e categorias. Endereços de transmissão e credenciais não são enviados ao navegador.' }, 200, { 'Cache-Control': 'private, max-age=180' });
  } catch (e) {
    return json({ error: `Não foi possível consultar a fonte M3U: ${e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de conexão'}.` }, 502);
  }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/session') {
    return json({ configured: Boolean(env.APP_PASSWORD && env.SESSION_SECRET), authenticated: await hasSession(request, env) });
  }
  if (request.method === 'POST' && url.pathname === '/api/login') {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: 'A proteção ainda não está configurada. Define APP_PASSWORD e SESSION_SECRET como segredos do Worker.' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    const supplied = String(body?.password || '');
    if (supplied.length > 512 || supplied !== env.APP_PASSWORD) return json({ error: 'Senha incorreta.' }, 401);
    const expiry = Math.floor(Date.now() / 1000) + 43200;
    const token = await signSession(expiry, env.SESSION_SECRET);
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, token, 43200), 'Cache-Control': 'no-store' });
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(request, '', 0), 'Cache-Control': 'no-store' });
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json({ ok: true, service: 'Vionza Studio', matchesConfigured: Boolean(env.FOOTBALL_DATA_API_KEY), imageConfigured: Boolean(env.OPENAI_API_KEY), channelsConfigured: Boolean(env.M3U_URL), imageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-1' });
  }

  if (url.pathname.startsWith('/api/') && !['/api/session', '/api/login', '/api/logout', '/api/health'].includes(url.pathname)) {
    if (!env.APP_PASSWORD || !env.SESSION_SECRET) return json({ error: 'A proteção ainda não está configurada. Define APP_PASSWORD e SESSION_SECRET como segredos do Worker.' }, 503);
    if (!(await hasSession(request, env))) return json({ error: 'Sessão expirada ou não autenticada. Entra novamente.' }, 401);
  }

  if (request.method === 'GET' && url.pathname === '/api/channels') {
    return getChannels(env, ctx);
  }

  if (request.method === 'GET' && url.pathname === '/api/matches') {
    const date = url.searchParams.get('date');
    if (!validDate(date)) return json({ error: 'Informe uma data válida no formato AAAA-MM-DD.' }, 400);
    if (!env.FOOTBALL_DATA_API_KEY) return json({ error: 'API esportiva não configurada. Adicione FOOTBALL_DATA_API_KEY como segredo.' }, 503);
    try {
      const apiUrl = new URL(`${FOOTBALL_API}/matches`);
      apiUrl.searchParams.set('dateFrom', date);
      apiUrl.searchParams.set('dateTo', date);
      const response = await fetch(apiUrl, { headers: { 'X-Auth-Token': env.FOOTBALL_DATA_API_KEY }, signal: AbortSignal.timeout(15000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return json({ error: body.message || `A API esportiva retornou HTTP ${response.status}.`, providerStatus: response.status }, response.status === 429 ? 429 : 502);
      const matches = (body.matches || []).map(formatMatch).sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
      return json({ date, count: matches.length, matches, provider: 'football-data.org', note: 'A cobertura depende do plano e das competições autorizadas. Os canais não são informados por esta API.' }, 200, { 'Cache-Control': 'public, max-age=120' });
    } catch (e) {
      return json({ error: `Não foi possível consultar a API esportiva: ${e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de conexão'}.` }, 502);
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/generate-background') {
    if (!env.OPENAI_API_KEY) return json({ error: 'Geração de imagem não configurada. Adicione OPENAI_API_KEY como segredo.' }, 503);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Corpo JSON inválido.' }, 400); }
    const format = body?.format || 'vertical';
    const formats = { vertical: '1024x1536', quadrado: '1024x1024', horizontal: '1536x1024' };
    if (!Object.hasOwn(formats, format)) return json({ error: 'Formato inválido.' }, 400);
    const style = String(body?.style || 'estádio futurista verde e azul').trim().slice(0, 240);
    const prompt = `Crie um fundo original para uma arte de agenda de futebol da marca Vionza Play. Estilo: ${style}. Estética premium de divulgação esportiva, estádio de futebol à noite, refletores dramáticos, atmosfera energética, gramado verde, paleta azul-marinho e verde-limão, contraste alto e acabamento profissional. Deixe uma área central/inferior escura e relativamente limpa para o sistema adicionar texto legível. NÃO inclua palavras, letras, números, escudos, marcas, logotipos, placares ou tipografia. Somente imagem de fundo, sem marcas registradas.`;
    try {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: formats[format], quality: 'medium' }),
        signal: AbortSignal.timeout(90000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json({ error: result.error?.message || `A API de imagens retornou HTTP ${response.status}.` }, 502);
      const b64 = result.data?.[0]?.b64_json;
      if (!b64) return json({ error: 'A API não retornou os dados da imagem.' }, 502);
      // Return the generated image directly; no persistent file storage is needed in this MVP.
      return json({ imageUrl: `data:image/png;base64,${b64}`, model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1' }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ error: `Não foi possível gerar o fundo: ${e.name === 'TimeoutError' ? 'tempo esgotado' : 'falha de conexão'}.` }, 502);
    }
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    return route(request, env, ctx);
  },
};
