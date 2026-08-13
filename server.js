require('dotenv').config({ quiet: true });

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const multer = require('multer');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { version: APP_BASE_VERSION } = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
function normalizeBuildToken(value) {
  return (value || '').toString().trim().replace(/[^0-9A-Za-z-]+/g, '-').replace(/^-+|-+$/g, '');
}

function createAppVersion() {
  const buildNumber = normalizeBuildToken(process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER);
  const buildId = normalizeBuildToken(process.env.BUILD_ID);
  const gitSha = normalizeBuildToken(
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA
  );

  if (buildNumber) return `${APP_BASE_VERSION}+build.${buildNumber}`;
  if (buildId) return `${APP_BASE_VERSION}+build.${buildId}`;
  if (gitSha) return `${APP_BASE_VERSION}+${gitSha.slice(0, 7)}`;
  return `${APP_BASE_VERSION}+local`;
}

function readGitMetadata() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8'
    }).trim();
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8'
    }).trim();
    return { branch: branch || null, commit: commit || null };
  } catch (error) {
    return { branch: null, commit: null };
  }
}

const APP_VERSION = createAppVersion();
const APP_GIT = readGitMetadata();
const CHAT_TIMEOUT_MS = 120000;
const CHAT_MAX_MESSAGES = 10;
const DEEPSEEK_DEBUG_LOG_PATH = process.env.DEEPSEEK_DEBUG_LOG_PATH || path.join(__dirname, 'tmp_deepseek_debug.log');
const CHAT_IDLE_CLOSE_MS = 30 * 60 * 1000;
const FREE_LIMIT = 5;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ANONYMOUS_SESSIONS = Math.max(
  100,
  Number.parseInt(process.env.MAX_ANONYMOUS_SESSIONS || '5000', 10) || 5000
);
const MAX_RATE_LIMIT_KEYS = 10000;
const AUTH_COOKIE_TTL = 30 * 24 * 60 * 60;
const STARTING_CREDITS = 5;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const BIO_MAX_LENGTH = 500;
const ACCESS_TOKEN_COOKIE = 'wa_at';
const REFRESH_TOKEN_COOKIE = 'wa_rt';
const AVATAR_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(value => value.trim().toLowerCase())
  .filter(Boolean);

if (!API_KEY) {
  console.warn('Varování: OPENWEATHER_API_KEY není nastaven. Použijte: set OPENWEATHER_API_KEY=... (cmd) nebo $env:OPENWEATHER_API_KEY = "..." (PowerShell)');
}

if (!DEEPSEEK_API_KEY) {
  console.warn('Varování: DEEPSEEK_API_KEY není nastaven.');
}
let deepseekClient = DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })
  : null;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
  console.warn('Varování: Supabase klíče nejsou plně nastavené. Přihlášení a chatová historie budou vypnuté.');
}

const supabaseAdmin = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    })
  : null;

function createAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function publicUser(authUser, profile) {
  const firstName = (profile?.first_name || authUser?.user_metadata?.first_name || '').toString().trim();
  const lastName = (profile?.last_name || authUser?.user_metadata?.last_name || '').toString().trim();
  const email = (profile?.email || authUser?.email || '').toString().trim().toLowerCase();
  const computedRole = profile?.role === 'admin' || ADMIN_EMAILS.includes(email) ? 'admin' : 'user';
  const profileCredits = Number.parseInt(profile?.credits, 10);

  return {
    id: authUser.id,
    firstName,
    lastName,
    name: [firstName, lastName].filter(Boolean).join(' ') || email || 'Uživatel',
    email,
    phone: (profile?.phone || authUser?.user_metadata?.phone || '').toString().trim(),
    countryCode: (profile?.country_code || authUser?.user_metadata?.country_code || '').toString().trim().toUpperCase(),
    role: computedRole,
    credits: Number.isFinite(profileCredits) ? profileCredits : STARTING_CREDITS,
    isBlocked: Boolean(profile?.is_blocked),
    avatarUrl: (profile?.avatar_url || '').toString().trim() || null,
    bio: (profile?.bio || '').toString()
  };
}

async function getProfile(user) {
  const userId = typeof user === 'string' ? user : user?.id;
  if (!supabaseAdmin || !isUuid(userId)) return null;
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, first_name, last_name, email, phone, country_code, role, credits, is_blocked, avatar_url, bio')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('Profile load error', error.message);
    return null;
  }
  return data;
}

async function ensureAdminRole(user) {
  if (!supabaseAdmin) return;
  const email = (user?.email || '').toString().trim().toLowerCase();
  if (!ADMIN_EMAILS.includes(email) || !isUuid(user?.id)) return;
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ role: 'admin' })
    .eq('id', user.id)
    .neq('role', 'admin');
  if (error) {
    console.error('Admin role sync error', error.message);
  }
}

function setAuthCookies(res, authSession) {
  const accessToken = authSession?.access_token;
  const refreshToken = authSession?.refresh_token;
  if (!accessToken || !refreshToken) return;
  appendCookie(res, serializeCookie(ACCESS_TOKEN_COOKIE, accessToken, AUTH_COOKIE_TTL));
  appendCookie(res, serializeCookie(REFRESH_TOKEN_COOKIE, refreshToken, AUTH_COOKIE_TTL));
}

function clearAuthCookies(res) {
  appendCookie(res, serializeCookie(ACCESS_TOKEN_COOKIE, '', 0));
  appendCookie(res, serializeCookie(REFRESH_TOKEN_COOKIE, '', 0));
}

async function resolveUserFromTokens(req, res, accessToken, refreshToken) {
  const auth = createAuthClient();
  if (!auth || !accessToken) return null;

  let currentAccessToken = accessToken;
  let user = null;

  const userResult = await auth.auth.getUser(currentAccessToken);
  if (!userResult.error && userResult.data?.user) {
    user = userResult.data.user;
  }

  if (!user && refreshToken) {
    const refreshResult = await auth.auth.refreshSession({ refresh_token: refreshToken });
    if (!refreshResult.error && refreshResult.data?.session) {
      setAuthCookies(res, refreshResult.data.session);
      currentAccessToken = refreshResult.data.session.access_token;
      user = refreshResult.data.user || null;
    }
  }

  if (!user) return null;

  await ensureAdminRole(user);
  const profile = await getProfile(user);
  const normalizedUser = publicUser(user, profile);
  const session = getSession(req, res);
  session.user = normalizedUser;
  session.userAccessToken = currentAccessToken;
  return normalizedUser;
}

async function getAuthenticatedUser(req, res) {
  const session = getSession(req, res);
  const cookies = parseCookies(req);
  const accessToken = cookies[ACCESS_TOKEN_COOKIE];
  const refreshToken = cookies[REFRESH_TOKEN_COOKIE];

  if (!accessToken) {
    session.user = null;
    session.userAccessToken = null;
    return null;
  }

  if (session.user && session.userAccessToken === accessToken) {
    const profile = await getProfile(session.user.id);
    if (profile) {
      session.user = publicUser({ id: session.user.id, email: session.user.email }, profile);
    }
    return session.user;
  }

  try {
    const user = await resolveUserFromTokens(req, res, accessToken, refreshToken);
    if (!user) {
      clearAuthCookies(res);
      session.user = null;
      session.userAccessToken = null;
    }
    return user;
  } catch (error) {
    console.error('Auth resolve error', error.message || error);
    clearAuthCookies(res);
    session.user = null;
    session.userAccessToken = null;
    return null;
  }
}

async function consumeUserCredit(userId) {
  if (!supabaseAdmin || !isUuid(userId)) return -1;
  const { data, error } = await supabaseAdmin.rpc('consume_credit', { p_user_id: userId });
  if (error) {
    console.error('Credit consume error', error.message);
    return -1;
  }
  const remaining = Number.parseInt(data, 10);
  return Number.isFinite(remaining) ? remaining : -1;
}

async function getLatestConversation(userId) {
  if (!supabaseAdmin || !isUuid(userId)) return null;
  const { data, error } = await supabaseAdmin
    .from('chat_conversations')
    .select('id, user_id, started_at, closed_at')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Latest conversation load error', error.message);
    return null;
  }
  return data || null;
}

async function createConversation(userId) {
  const { data, error } = await supabaseAdmin
    .from('chat_conversations')
    .insert({ user_id: userId })
    .select('id, user_id, started_at, closed_at')
    .single();
  if (error) throw error;
  return data;
}

async function closeConversation(conversationId) {
  if (!supabaseAdmin || !isUuid(conversationId)) return;
  const { error } = await supabaseAdmin
    .from('chat_conversations')
    .update({ closed_at: new Date().toISOString() })
    .eq('id', conversationId)
    .is('closed_at', null);
  if (error) {
    console.error('Conversation close error', error.message);
  }
}

async function listConversationMessages(conversationId) {
  if (!supabaseAdmin || !isUuid(conversationId)) return [];
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('Conversation messages load error', error.message);
    return [];
  }
  return (data || []).map(item => ({
    role: item.role,
    text: item.content,
    createdAt: item.created_at
  }));
}

async function listRecentConversationMessages(conversationId, limit) {
  if (!supabaseAdmin || !isUuid(conversationId)) return [];
  const safeLimit = Number.parseInt(limit, 10);
  if (!Number.isFinite(safeLimit) || safeLimit <= 0) return [];
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) {
    console.error('Recent conversation messages load error', error.message);
    return [];
  }
  return (data || []).reverse().map(item => ({
    role: item.role,
    text: item.content,
    createdAt: item.created_at
  }));
}

async function addConversationMessage({ userId, conversationId, role, content }) {
  if (!supabaseAdmin) throw new Error('Supabase not configured');
  const { error } = await supabaseAdmin.from('chat_messages').insert({
    user_id: userId,
    conversation_id: conversationId,
    role,
    content
  });
  if (error) throw error;
}

async function getConversationMessageCount(conversationId) {
  if (!supabaseAdmin || !isUuid(conversationId)) return 0;
  const { count, error } = await supabaseAdmin
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);
  if (error) {
    console.error('Conversation count load error', error.message);
    return 0;
  }
  return count || 0;
}

async function getConversationLastActivityAt(conversation) {
  if (!supabaseAdmin || !isUuid(conversation?.id)) return conversation?.started_at || null;
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Conversation activity load error', error.message);
    return conversation.started_at || null;
  }
  return data?.created_at || conversation.started_at || null;
}

function getVisibleConversationMessageCount(messageCount) {
  const safeCount = Number.parseInt(messageCount, 10);
  if (!Number.isFinite(safeCount) || safeCount <= 0) return 0;
  return Math.min(safeCount, CHAT_MAX_MESSAGES);
}

function isConversationExpired(lastActivityAt) {
  const timestamp = Date.parse((lastActivityAt || '').toString());
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  return timestamp + CHAT_IDLE_CLOSE_MS <= Date.now();
}

function ensureSupabaseAdmin(res, message = 'Tato funkce není nakonfigurována.') {
  if (supabaseAdmin) return true;
  res.status(503).json({ error: message });
  return false;
}

async function requireAuthenticatedUserOrFail(req, res, message = 'Pro tuto akci se musíte přihlásit.') {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    res.status(401).json({ error: message });
    return null;
  }
  return user;
}

async function requireAdminUserOrFail(req, res) {
  const user = await requireAuthenticatedUserOrFail(req, res, 'Pro administraci se musíte přihlásit.');
  if (!user) return null;
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Tato stránka je dostupná pouze administrátorům.' });
    return null;
  }
  return user;
}

function validateProfileUpdate(body) {
  const firstName = (body?.firstName || '').toString().trim();
  const lastName = (body?.lastName || '').toString().trim();
  const phone = (body?.phone || '').toString().trim();
  const countryCode = (body?.countryCode || '').toString().trim().toUpperCase();
  const bio = (body?.bio || '').toString().trim();

  if (!firstName || firstName.length > 100) return { error: 'Zadejte platné jméno.' };
  if (!lastName || lastName.length > 100) return { error: 'Zadejte platné příjmení.' };
  if (!/^[+0-9 ()-]{7,32}$/.test(phone)) return { error: 'Zadejte platné telefonní číslo.' };
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'Vyberte zemi.' };
  if (bio.length > BIO_MAX_LENGTH) return { error: `Bio může mít maximálně ${BIO_MAX_LENGTH} znaků.` };

  return { firstName, lastName, phone, countryCode, bio };
}

function serializeProfile(user) {
  return {
    id: user.id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
    phone: user.phone,
    countryCode: user.country_code,
    role: user.role,
    credits: user.credits,
    isBlocked: Boolean(user.is_blocked),
    avatarUrl: user.avatar_url || null,
    bio: user.bio || '',
    name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Uživatel'
  };
}

function avatarPublicUrl(objectPath) {
  if (!SUPABASE_URL || !objectPath) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/avatars/${objectPath}`;
}

function avatarObjectPathFromUrl(value) {
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/avatars/`;
  const url = (value || '').toString().trim();
  if (!url || !SUPABASE_URL || !url.startsWith(prefix)) return null;
  return decodeURIComponent(url.slice(prefix.length));
}

app.use(express.json());
app.set('trust proxy', 1);

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES },
  fileFilter(req, file, cb) {
    if (AVATAR_MIME_TO_EXT[file.mimetype]) return cb(null, true);
    const err = new Error('INVALID_AVATAR_TYPE');
    err.code = 'INVALID_AVATAR_TYPE';
    cb(err);
  }
});

// In-memory guest sessions. Map insertion order acts as an LRU queue.
const sessions = new Map();
const rateBuckets = new Map();

function removeExpiredState() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (s.lastSeen + SESSION_TTL_MS <= now) sessions.delete(sid);
  }
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}

setInterval(removeExpiredState, 10 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', Array.isArray(current) ? [...current, cookie] : [current, cookie]);
}

function serializeCookie(name, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function getSession(req, res) {
  let sid = parseCookies(req)['wa_sid'];
  let session = sid ? sessions.get(sid) : null;

  if (session && session.lastSeen + SESSION_TTL_MS <= Date.now()) {
    sessions.delete(sid);
    session = null;
  }

  if (!session) {
    while (sessions.size >= MAX_ANONYMOUS_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
    sid = crypto.randomUUID();
    session = { count: 0, lastSeen: Date.now() };
    sessions.set(sid, session);
    appendCookie(res, serializeCookie('wa_sid', sid, SESSION_TTL_MS / 1000));
  } else {
    // Touch the entry so the least recently used session remains first.
    session.lastSeen = Date.now();
    sessions.delete(sid);
    sessions.set(sid, session);
  }

  return session;
}

function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && rateBuckets.size >= MAX_RATE_LIMIT_KEYS) {
        rateBuckets.delete(rateBuckets.keys().next().value);
      }
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({
        error: 'Příliš mnoho požadavků. Zkuste to prosím později.',
        code: 'RATE_LIMITED'
      });
    }

    next();
  };
}

function protectStateChangingRequests(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const requestedWith = req.get('X-Requested-With');
  const origin = req.get('Origin');
  let originAllowed = true;

  if (origin) {
    try {
      const originUrl = new URL(origin);
      const configuredOrigins = (process.env.APP_ORIGIN || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      originAllowed = originUrl.host === req.get('host') || configuredOrigins.includes(originUrl.origin);
    } catch (e) {
      originAllowed = false;
    }
  }

  if (requestedWith !== 'weather-app' || !originAllowed) {
    return res.status(403).json({
      error: 'Požadavek byl odmítnut z bezpečnostních důvodů.',
      code: 'CSRF_REJECTED'
    });
  }

  next();
}

function requireWeatherConfig(req, res, next) {
  if (API_KEY) return next();
  return res.status(503).json({
    error: 'Služba počasí není nakonfigurována.',
    code: 'WEATHER_NOT_CONFIGURED'
  });
}

const generalApiLimit = rateLimit('api', 120, 60 * 1000);
const authApiLimit = rateLimit('auth', 20, 15 * 60 * 1000);
const adminApiLimit = rateLimit('admin', 60, 60 * 1000);
const profileApiLimit = rateLimit('profile', 40, 60 * 1000);
const suggestApiLimit = rateLimit('suggest', 60, 60 * 1000);
const weatherApiLimit = rateLimit('weather', 30, 60 * 1000);

app.use('/api', generalApiLimit, protectStateChangingRequests);

function usagePayload(session, user = null) {
  return {
    count: session.count,
    limit: FREE_LIMIT,
    remaining: user ? null : Math.max(0, FREE_LIMIT - session.count),
    credits: user ? user.credits : null,
    user
  };
}

function formatChatError(err) {
  const status = err.status || err.response?.status || 500;
  const responseBody = typeof err.response?.data === 'string' ? err.response.data : '';
  const rawMessage =
    err.response?.data?.error?.message ||
    err.response?.data?.message ||
    responseBody ||
    err.message ||
    'Chat se nepodařilo odeslat.';

  if (
    /<html[\s>]/i.test(rawMessage) ||
    /web page blocked/i.test(rawMessage) ||
    /blocked sites/i.test(rawMessage) ||
    /api\.deepseek\.com/i.test(rawMessage)
  ) {
    return {
      status: 503,
      message: 'Firemní síť blokuje přístup k DeepSeek API. Mimo VPN by chat měl fungovat.'
    };
  }

  return {
    status,
    message: rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}…` : rawMessage
  };
}

function createHttpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function appendDeepseekDebugLog(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    fs.appendFileSync(DEEPSEEK_DEBUG_LOG_PATH, line, 'utf8');
  } catch (error) {
    console.error('DeepSeek debug log write error', error.message || error);
  }
}

function cloneDeepseekMessages(messages) {
  return (messages || []).map(message => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  }));
}

async function requestDeepseekChatCompletion({ phase, messages, meta = {}, temperature = 0 }) {
  if (!deepseekClient) {
    throw createHttpError(503, 'Chat není nakonfigurován.', 'CHAT_NOT_CONFIGURED');
  }

  const requestMeta = {
    phase,
    model: DEEPSEEK_MODEL,
    timeoutMs: CHAT_TIMEOUT_MS,
    meta,
    messages: cloneDeepseekMessages(messages)
  };
  const startedAt = Date.now();

  appendDeepseekDebugLog({ event: 'request', ...requestMeta });
  console.log('DeepSeek request', JSON.stringify({
    phase,
    model: DEEPSEEK_MODEL,
    timeoutMs: CHAT_TIMEOUT_MS,
    meta
  }));

  try {
    const completion = await Promise.race([
      deepseekClient.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages,
        stream: false,
        temperature
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          const timeoutError = new Error('Chat momentálně neodpovídá. Zkuste to prosím znovu.');
          timeoutError.status = 504;
          reject(timeoutError);
        }, CHAT_TIMEOUT_MS);
      })
    ]);

    const reply = completion.choices?.[0]?.message?.content?.trim() || '';
    const durationMs = Date.now() - startedAt;
    appendDeepseekDebugLog({
      event: 'response',
      phase,
      model: DEEPSEEK_MODEL,
      durationMs,
      meta,
      reply
    });
    console.log('DeepSeek response', JSON.stringify({
      phase,
      model: DEEPSEEK_MODEL,
      durationMs,
      meta
    }));
    return completion;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    appendDeepseekDebugLog({
      event: 'error',
      phase,
      model: DEEPSEEK_MODEL,
      durationMs,
      meta,
      error: {
        message: error.message || String(error),
        status: error.status || error.response?.status || null,
        data: error.response?.data || null
      }
    });
    console.error('DeepSeek error', JSON.stringify({
      phase,
      model: DEEPSEEK_MODEL,
      durationMs,
      meta,
      message: error.message || String(error),
      status: error.status || error.response?.status || null
    }));
    throw error;
  }
}

function buildLocalizedPlace(place) {
  let displayName = place.name;
  try {
    const localNames = Object.values(place.local_names || {}).map(value => (value || '').toString());
    const csLocal = place.local_names?.cs || place.local_names?.cz;
    if (place.country === 'CZ') {
      if (localNames.some(value => /praha/i.test(value))) displayName = 'Praha';
      else if (csLocal) displayName = csLocal;
    } else if (csLocal) {
      displayName = csLocal;
    }
  } catch (error) {
    displayName = place.name;
  }

  const state = place.state && norm(place.state) !== norm(displayName) && norm(place.state) !== norm(place.name)
    ? place.state
    : '';

  return {
    ...place,
    shortName: displayName,
    display: `${displayName}${state ? ', ' + state : ''}${place.country ? ', ' + place.country : ''}`
  };
}

function rankPlaces(query, items) {
  const qn = norm(query);
  let list = (items || []).map(item => ({
    name: item.name,
    local_names: item.local_names || {},
    state: item.state,
    country: item.country,
    lat: item.lat,
    lon: item.lon,
    population: item.population || 0
  }));

  list = list.map(item => {
    const localized = buildLocalizedPlace(item);
    const localValues = Object.values(localized.local_names || {}).map(value => norm(value));
    let score = 0;

    if (norm(localized.name) === qn) score += 120;
    if (localValues.includes(qn)) score += 120;
    if (localValues.some(value => value.includes(qn))) score += 60;
    if (localized.country === 'CZ') score += 80;
    if (qn === 'praha' && norm(localized.name) === 'prague') score += 50;
    score += Math.min(localized.population || 0, 1000000) / 10000;

    return { ...localized, _score: score };
  });

  list.sort((a, b) => (b._score || 0) - (a._score || 0));

  const seen = new Map();
  for (const item of list) {
    const key = `${(item.lat || 0).toFixed(4)}|${(item.lon || 0).toFixed(4)}`;
    if (!seen.has(key)) seen.set(key, item);
  }

  const deduped = Array.from(seen.values());
  if (qn === 'praha' || qn === 'prague') {
    const idx = deduped.findIndex(item => item.country === 'CZ');
    if (idx === -1) {
      deduped.unshift({
        name: 'Praha',
        state: '',
        country: 'CZ',
        lat: 50.0755381,
        lon: 14.4378005,
        population: 1300000,
        shortName: 'Praha',
        display: 'Praha, CZ'
      });
    } else if (idx > 0) {
      const [prague] = deduped.splice(idx, 1);
      deduped.unshift(prague);
    }
  }

  return deduped;
}

async function lookupPlaces(query, limit = 8) {
  const safeQuery = normalizeSearch(query);
  const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 1);
  const url = 'https://api.openweathermap.org/geo/1.0/direct';
  const response = await axios.get(url, {
    params: { q: safeQuery, limit: Math.max(safeLimit, 12), appid: API_KEY }
  });
  return rankPlaces(safeQuery, response.data || []).slice(0, safeLimit);
}

async function reverseLookupPlace(lat, lon) {
  const url = 'https://api.openweathermap.org/geo/1.0/reverse';
  const response = await axios.get(url, {
    params: { lat, lon, limit: 1, appid: API_KEY }
  });
  return response.data?.[0] || null;
}

async function fetchWeatherBundle({ city, lat, lon, preferredName = '' }) {
  let resolvedLat = lat;
  let resolvedLon = lon;
  let name = normalizeSearch(preferredName);
  let country = '';
  const requestedCity = normalizeSearch(city);

  if (resolvedLat != null && resolvedLon != null) {
    resolvedLat = Number.parseFloat(resolvedLat);
    resolvedLon = Number.parseFloat(resolvedLon);
    if (
      !Number.isFinite(resolvedLat) ||
      !Number.isFinite(resolvedLon) ||
      resolvedLat < -90 ||
      resolvedLat > 90 ||
      resolvedLon < -180 ||
      resolvedLon > 180
    ) {
      throw createHttpError(400, 'Neplatné souřadnice', 'INVALID_COORDINATES');
    }

    try {
      const place = await reverseLookupPlace(resolvedLat, resolvedLon);
      if (place) {
        country = place.country || '';
        if (!name) {
          const localized = buildLocalizedPlace(place);
          name = localized.shortName || localized.name || '';
        }
      }
    } catch (error) {
      // Reverse geocoding is best-effort only.
    }

    if (!name && requestedCity) name = requestedCity;
  } else {
    if (!requestedCity) {
      throw createHttpError(400, 'Město nebo souřadnice jsou povinné', 'MISSING_LOCATION');
    }
    const [place] = await lookupPlaces(requestedCity, 1);
    if (!place) throw createHttpError(404, 'Město nebylo nalezeno', 'CITY_NOT_FOUND');
    resolvedLat = place.lat;
    resolvedLon = place.lon;
    name = name || place.shortName || place.name || requestedCity;
    country = place.country || '';
  }

  const weatherParams = {
    lat: resolvedLat,
    lon: resolvedLon,
    units: 'metric',
    appid: API_KEY
  };

  const [currentResult, forecastResult, airResult] = await Promise.allSettled([
    axios.get('https://api.openweathermap.org/data/2.5/weather', { params: weatherParams }),
    axios.get('https://api.openweathermap.org/data/2.5/forecast', { params: weatherParams }),
    axios.get('https://api.openweathermap.org/data/2.5/air_pollution', {
      params: { lat: resolvedLat, lon: resolvedLon, appid: API_KEY }
    })
  ]);

  if (currentResult.status !== 'fulfilled') throw currentResult.reason;
  if (forecastResult.status !== 'fulfilled') throw forecastResult.reason;

  const current = currentResult.value.data;
  const forecast = forecastResult.value.data;
  const air = airResult.status === 'fulfilled' ? airResult.value.data : null;

  if (!name) name = forecast?.city?.name || current?.name || requestedCity || 'Vybrané město';
  if (!country) country = forecast?.city?.country || current?.sys?.country || '';

  return {
    location: { name, country, lat: resolvedLat, lon: resolvedLon },
    current,
    forecast,
    air
  };
}

function weatherLocalDate(dt, tzOffset) {
  return new Date((dt + (tzOffset || 0)) * 1000);
}

function formatWeatherTime(dt, tzOffset) {
  if (!dt) return null;
  return weatherLocalDate(dt, tzOffset).toLocaleTimeString('cs-CZ', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });
}

function formatWeatherDate(dt, tzOffset) {
  if (!dt) return null;
  return weatherLocalDate(dt, tzOffset).toLocaleDateString('cs-CZ', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    timeZone: 'UTC'
  });
}

function formatTemp(value) {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value)} °C`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value)} %`;
}

function formatWind(value) {
  if (!Number.isFinite(value)) return null;
  return `${(Math.round(value * 10) / 10).toString().replace('.', ',')} m/s`;
}

function formatVisibility(value) {
  if (!Number.isFinite(value)) return null;
  if (value >= 1000) return `${(Math.round((value / 1000) * 10) / 10).toString().replace('.', ',')} km`;
  return `${Math.round(value)} m`;
}

function getWeatherTimezone(bundle) {
  return bundle.current?.timezone ?? bundle.forecast?.city?.timezone ?? 0;
}

function getForecastItems(bundle) {
  return Array.isArray(bundle.forecast?.list) ? bundle.forecast.list : [];
}

function isSameWeatherDay(left, right) {
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

function getForecastItemsForDay(bundle, dayOffset) {
  const tzOffset = getWeatherTimezone(bundle);
  const baseDt = bundle.current?.dt || getForecastItems(bundle)[0]?.dt || Math.floor(Date.now() / 1000);
  const targetDay = weatherLocalDate(baseDt, tzOffset);
  targetDay.setUTCDate(targetDay.getUTCDate() + dayOffset);
  return getForecastItems(bundle).filter(item => isSameWeatherDay(weatherLocalDate(item.dt, tzOffset), targetDay));
}

function pickDominantDescription(items) {
  const counts = new Map();
  for (const item of items || []) {
    const description = (item.weather?.[0]?.description || '').toString().trim();
    if (!description) continue;
    counts.set(description, (counts.get(description) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

function getMaxPop(items) {
  return (items || []).reduce((max, item) => Math.max(max, Number(item.pop) || 0), 0);
}

function getTotalPrecipVolume(items) {
  return (items || []).reduce((sum, item) => {
    const rain = Number(item.rain?.['3h']) || 0;
    const snow = Number(item.snow?.['3h']) || 0;
    return sum + rain + snow;
  }, 0);
}

function summarizeForecastItems(items, tzOffset) {
  if (!items?.length) return null;
  const temps = items
    .map(item => Number(item.main?.temp))
    .filter(value => Number.isFinite(value));
  return {
    dateLabel: formatWeatherDate(items[0].dt, tzOffset),
    minTemp: temps.length ? Math.min(...temps) : null,
    maxTemp: temps.length ? Math.max(...temps) : null,
    description: pickDominantDescription(items),
    pop: getMaxPop(items),
    precipVolume: getTotalPrecipVolume(items)
  };
}

function summarizeForecastDay(bundle, dayOffset) {
  return summarizeForecastItems(getForecastItemsForDay(bundle, dayOffset), getWeatherTimezone(bundle));
}

function summarizeUpcomingHours(bundle, hours) {
  const forecastItems = getForecastItems(bundle);
  if (!forecastItems.length) return null;
  const baseDt = bundle.current?.dt || forecastItems[0]?.dt || Math.floor(Date.now() / 1000);
  const selected = forecastItems.filter(item => item.dt > baseDt && item.dt <= baseDt + (hours * 60 * 60));
  return summarizeForecastItems(selected.length ? selected : forecastItems.slice(0, Math.ceil(hours / 3)), getWeatherTimezone(bundle));
}

function summarizeAirQuality(air) {
  const currentAir = air?.list?.[0];
  if (!currentAir) return null;
  const labels = {
    1: 'dobrá',
    2: 'uspokojivá',
    3: 'střední',
    4: 'špatná',
    5: 'velmi špatná'
  };
  return {
    aqi: currentAir.main?.aqi || null,
    label: labels[currentAir.main?.aqi] || null,
    components: currentAir.components || {}
  };
}

function buildLocationLabel(location) {
  return [location?.name, location?.country].filter(Boolean).join(', ') || 'vybraném místě';
}

function buildUmbrellaAdvice(summary) {
  if (!summary) return 'Na deštník teď nemám dost dat.';
  const description = (summary.description || '').toLowerCase();
  if (summary.pop >= 0.6 || summary.precipVolume >= 1 || /(rain|drizzle|storm|snow|shower|déšť|přeháň|bouř|sněh)/.test(description)) {
    return 'Deštník bych si vzal.';
  }
  if (summary.pop >= 0.3) return 'Spíš ano, šance na srážky je zvýšená.';
  return 'Spíš ne, srážky teď nevypadají pravděpodobně.';
}

function parseJsonObject(text) {
  const raw = (text || '').toString().trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const fenced = raw.match(/```json\s*([\s\S]+?)```/i)?.[1] || raw.match(/\{[\s\S]*\}/)?.[0];
    if (!fenced) return null;
    try {
      return JSON.parse(fenced);
    } catch (nestedError) {
      return null;
    }
  }
}

function isDateOnlyQuestion(message) {
  return /\b(co|jak[ýy])\s+je\s+(dnes|dneska)\s+za\s+den\b/i.test((message || '').toString());
}

function normalizeRequestedCities(value) {
  const seen = new Set();
  const cities = [];
  const entries = Array.isArray(value) ? value : [value];

  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeSearch(entry);
    if (!normalized) continue;

    const commaParts = normalized.split(/\s*,\s*/).filter(Boolean);
    const hasListSeparators =
      commaParts.length > 2 ||
      /[;\/]/.test(normalized) ||
      /\s+(?:a|i|and)\s+/i.test(normalized);
    const parts = hasListSeparators
      ? normalized
          .split(/\s*(?:,|;|\/|\s+a\s+|\s+i\s+|\s+and\s+)\s*/i)
          .map(part => normalizeSearch(part).slice(0, 100))
          .filter(Boolean)
      : [normalized.slice(0, 100)];

    for (const city of parts) {
      const key = city.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cities.push(city);
    }
  }

  return cities;
}

function formatQuotedCityList(cities) {
  const items = normalizeRequestedCities(cities).map(city => `„${city}“`);
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} a ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} a ${items.at(-1)}`;
}

function extractExplicitCitiesFromMessage(message) {
  const text = (message || '').toString().trim();
  if (!text) return [];

  const cleaned = text
    .replace(/[?!]+$/g, '')
    .replace(/\b(prosím|please)\b/gi, '')
    .trim();

  const match = cleaned.match(/\b(?:v|ve|pro|mezi|porovnej)\s+(.+)$/i);
  const candidate = match?.[1] || cleaned;
  const cities = normalizeRequestedCities(candidate);

  return cities.length > 1 ? cities : [];
}

function isMultiCityCorrection(message) {
  return /\b(ne(?:ní|ni)\s+to\s+jedno\s+m[ěe]sto|jsou\s+to\s+\d+\s+r[ůu]zn[áa]\s+m[ěe]sta|jsou\s+to\s+(dv[ěe]|t[řr]i)\s+r[ůu]zn[áa]\s+m[ěe]sta)\b/i
    .test((message || '').toString());
}

function extractCitiesFromHistoryMessage(message) {
  const text = (message || '').toString();
  const quoted = text.match(/„([^“]+)“/);
  if (quoted?.[1]) {
    const quotedCities = normalizeRequestedCities(quoted[1]);
    if (quotedCities.length > 1) return quotedCities;
  }
  return extractExplicitCitiesFromMessage(text);
}

function isLikelyWeatherMessage(message) {
  return /\b(jak|jaka|jaká|kolik|bude|bude\s+v|je|teplota|pršet|prset|sněžit|snezit|vítr|vitr|vlhkost|počasí|pocasi|aktuální|aktualni)\b/i
    .test((message || '').toString());
}

function isLikelyWeatherFollowUp(history, latestUserMessage) {
  const text = (latestUserMessage || '').toString().trim();
  if (isLikelyWeatherMessage(text)) return true;
  if (!/^(a|a\s+co|a\s+v)\b/i.test(text)) return false;
  return history.some(item => item.role === 'user' && isLikelyWeatherMessage(item.text));
}

function inferWeatherChatIntentLocally(history) {
  const latestUserMessage = history.filter(item => item.role === 'user').at(-1)?.text || '';
  if (!latestUserMessage) return null;

  if (!isMultiCityCorrection(latestUserMessage)) return null;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    const previousCities = extractCitiesFromHistoryMessage(item.text);
    if (previousCities.length > 1) {
      return {
        weatherRelevant: true,
        needsCity: false,
        city: previousCities[0],
        cities: previousCities,
        userQuestion: latestUserMessage,
        source: 'local-correction-history'
      };
    }
  }

  return null;
}

function getRecentIntentContext(history) {
  const latestUserIndex = history.map(item => item.role).lastIndexOf('user');
  const previousUser = latestUserIndex > 0
    ? history.slice(0, latestUserIndex).filter(item => item.role === 'user').at(-1)?.text || ''
    : '';
  const previousAssistant = latestUserIndex > 0
    ? history.slice(0, latestUserIndex).filter(item => item.role === 'assistant').at(-1)?.text || ''
    : '';
  return {
    previousUser,
    previousAssistant,
    latestUser: history[latestUserIndex]?.text || ''
  };
}

async function inferFocusedMultiCityIntent(history) {
  const context = getRecentIntentContext(history);
  const messages = [
    {
      role: 'system',
      content: [
        'Zpracuj český follow-up o počasí a vrať pouze JSON bez markdownu.',
        'Uživatel výslovně uvádí více měst v poslední zprávě.',
        'Normalizuj názvy měst do běžného tvaru pro vyhledání, například Praha, Brno, Olomouc, Ostrava.',
        'Použij jen krátký kontext předchozího dotazu a odpovědi.',
        'Vrať JSON ve tvaru {"weatherRelevant":true,"needsCity":false,"city":"Praha","cities":["Praha","Brno"],"userQuestion":"..."}.' ,
        'Pokud si nejsi jistý, vrať weatherRelevant=true a vyplň cities podle poslední uživatelské zprávy v nejpravděpodobnějším tvaru.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify(context)
    }
  ];
  const completion = await requestDeepseekChatCompletion({
    phase: 'intent',
    messages,
    meta: {
      historyLength: history.length,
      latestUserMessage: context.latestUser,
      mode: 'focused-multi-city'
    }
  });

  const content = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseJsonObject(content);
  if (!parsed) throw createHttpError(502, 'Nepodařilo se zpracovat požadavek chatu.', 'CHAT_INTENT_INVALID');

  const cities = normalizeRequestedCities(parsed.cities);
  if (!cities.length) {
    cities.push(...normalizeRequestedCities(parsed.city));
  }

  return {
    weatherRelevant: parsed.weatherRelevant !== false,
    needsCity: Boolean(parsed.needsCity) || !cities.length,
    city: cities[0] || null,
    cities,
    userQuestion: (parsed.userQuestion || '').toString().trim()
  };
}

async function inferWeatherChatIntent(history) {
  const localIntent = inferWeatherChatIntentLocally(history);
  if (localIntent) {
    appendDeepseekDebugLog({
      event: 'skip',
      phase: 'intent',
      reason: localIntent.source,
      latestUserMessage: localIntent.userQuestion,
      cities: localIntent.cities
    });
    return localIntent;
  }

  const latestUserMessage = history.filter(item => item.role === 'user').at(-1)?.text || '';
  const explicitCities = extractExplicitCitiesFromMessage(latestUserMessage);
  if (explicitCities.length > 1 && isLikelyWeatherFollowUp(history, latestUserMessage)) {
    return inferFocusedMultiCityIntent(history);
  }

  const conversation = history.map(item => {
    const role = item.role === 'assistant' ? 'Asistent' : 'Uživatel';
    return `${role}: ${item.text}`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: [
        'Analyzuj českou konverzaci o počasí a vrať pouze JSON bez markdownu.',
        'Použij kontext celé konverzace, ale intent určuj podle poslední uživatelské zprávy.',
        'Pokud poslední zpráva navazuje zájmeny jako "tam", "ve všech", "a zítra", "a co vítr", "které z nich", přenes poslední explicitně zmíněné město nebo celý seznam měst.',
        'Pokud poslední zpráva opravuje předchozí odpověď nebo upřesňuje dotaz slovy jako "ptal jsem se", "myslel jsem", "ne, chci", "jsou to 3 různá města", zachovej město, seznam měst i čas z předchozího počasového dotazu.',
        'Pokud uživatel zmiňuje více měst, vrať je v poli cities ve stejném pořadí.',
        'I když je město jen jedno, vrať ho také v poli cities s jednou položkou.',
        'Pokud chybí město, nastav needsCity=true, city=null a cities=[].',
        'Pokud zpráva není o počasí, nastav weatherRelevant=false.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        'Vrať JSON ve tvaru:',
        '{"weatherRelevant":true,"needsCity":false,"city":"Praha","cities":["Praha"],"userQuestion":"..."}',
        '',
        'Konverzace:',
        conversation
      ].join('\n')
    }
  ];
  const completion = await requestDeepseekChatCompletion({
    phase: 'intent',
    messages,
    meta: {
      historyLength: history.length,
      latestUserMessage
    }
  });

  const content = completion.choices?.[0]?.message?.content?.trim() || '';
  const parsed = parseJsonObject(content);
  if (!parsed) throw createHttpError(502, 'Nepodařilo se zpracovat požadavek chatu.', 'CHAT_INTENT_INVALID');

  const cities = normalizeRequestedCities(parsed.cities);
  if (!cities.length) {
    cities.push(...normalizeRequestedCities(parsed.city));
  }

  const city = cities[0] || null;
  return {
    weatherRelevant: parsed.weatherRelevant !== false,
    needsCity: Boolean(parsed.needsCity) || !cities.length,
    city,
    cities,
    userQuestion: (parsed.userQuestion || '').toString().trim()
  };
}

function formatWeatherDateTime(dt, tzOffset) {
  if (!dt) return null;
  return weatherLocalDate(dt, tzOffset).toLocaleString('cs-CZ', {
    weekday: 'long',
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  });
}

function formatWeatherDayName(dt, tzOffset) {
  if (!dt) return null;
  return weatherLocalDate(dt, tzOffset).toLocaleDateString('cs-CZ', {
    weekday: 'long',
    timeZone: 'UTC'
  });
}

function createWeatherChatDataset(bundle) {
  const tzOffset = getWeatherTimezone(bundle);
  const current = bundle.current || {};
  const forecastItems = getForecastItems(bundle);
  const air = summarizeAirQuality(bundle.air);
  const dailyMap = new Map();

  for (const item of forecastItems) {
    const dateKey = weatherLocalDate(item.dt, tzOffset).toLocaleDateString('sv-SE', { timeZone: 'UTC' });
    if (!dailyMap.has(dateKey)) dailyMap.set(dateKey, []);
    dailyMap.get(dateKey).push(item);
  }

  const daily = Array.from(dailyMap.entries()).map(([date, items]) => {
    const summary = summarizeForecastItems(items, tzOffset);
    return {
      date,
      dayName: formatWeatherDayName(items[0]?.dt, tzOffset),
      minTempC: summary?.minTemp != null ? Math.round(summary.minTemp) : null,
      maxTempC: summary?.maxTemp != null ? Math.round(summary.maxTemp) : null,
      description: summary?.description || null,
      maxPrecipProbabilityPct: summary?.pop != null ? Math.round(summary.pop * 100) : null,
      precipMm: summary?.precipVolume != null ? Math.round(summary.precipVolume * 10) / 10 : null,
      entries: items.map(item => ({
        at: formatWeatherDateTime(item.dt, tzOffset),
        tempC: Number.isFinite(Number(item.main?.temp)) ? Math.round(Number(item.main.temp)) : null,
        feelsLikeC: Number.isFinite(Number(item.main?.feels_like)) ? Math.round(Number(item.main.feels_like)) : null,
        humidityPct: Number.isFinite(Number(item.main?.humidity)) ? Math.round(Number(item.main.humidity)) : null,
        windMS: Number.isFinite(Number(item.wind?.speed)) ? Math.round(Number(item.wind.speed) * 10) / 10 : null,
        description: item.weather?.[0]?.description || null,
        precipProbabilityPct: Number.isFinite(Number(item.pop)) ? Math.round(Number(item.pop) * 100) : null,
        rainMm3h: Number(item.rain?.['3h']) || 0,
        snowMm3h: Number(item.snow?.['3h']) || 0
      }))
    };
  });

  return {
    loc: {
      n: bundle.location?.name || null,
      c: bundle.location?.country || null,
      lat: bundle.location?.lat ?? null,
      lon: bundle.location?.lon ?? null
    },
    now: {
      at: formatWeatherDateTime(current.dt, tzOffset),
      day: formatWeatherDayName(current.dt, tzOffset),
      desc: current.weather?.[0]?.description || null,
      t: Number.isFinite(Number(current.main?.temp)) ? Math.round(Number(current.main.temp)) : null,
      feel: Number.isFinite(Number(current.main?.feels_like)) ? Math.round(Number(current.main.feels_like)) : null,
      hum: Number.isFinite(Number(current.main?.humidity)) ? Math.round(Number(current.main.humidity)) : null,
      press: Number.isFinite(Number(current.main?.pressure)) ? Math.round(Number(current.main.pressure)) : null,
      vis: Number.isFinite(Number(current.visibility)) ? Math.round(Number(current.visibility)) : null,
      cloud: Number.isFinite(Number(current.clouds?.all)) ? Math.round(Number(current.clouds.all)) : null,
      wind: Number.isFinite(Number(current.wind?.speed)) ? Math.round(Number(current.wind.speed) * 10) / 10 : null,
      gust: Number.isFinite(Number(current.wind?.gust)) ? Math.round(Number(current.wind.gust) * 10) / 10 : null,
      rise: formatWeatherTime(current.sys?.sunrise, tzOffset),
      set: formatWeatherTime(current.sys?.sunset, tzOffset)
    },
    air: air ? {
      aqi: air.aqi,
      label: air.label,
      pm25: Number.isFinite(Number(air.components.pm2_5)) ? Number(air.components.pm2_5) : null,
      pm10: Number.isFinite(Number(air.components.pm10)) ? Number(air.components.pm10) : null,
      o3: Number.isFinite(Number(air.components.o3)) ? Number(air.components.o3) : null,
      no2: Number.isFinite(Number(air.components.no2)) ? Number(air.components.no2) : null,
      co: Number.isFinite(Number(air.components.co)) ? Number(air.components.co) : null
    } : null,
    range: {
      from: forecastItems[0] ? formatWeatherDateTime(forecastItems[0].dt, tzOffset) : null,
      to: forecastItems.length ? formatWeatherDateTime(forecastItems[forecastItems.length - 1].dt, tzOffset) : null
    },
    days: daily.map(day => ({
      d: day.date,
      day: day.dayName,
      min: day.minTempC,
      max: day.maxTempC,
      desc: day.description,
      pop: day.maxPrecipProbabilityPct,
      precip: day.precipMm,
      slots: day.entries.map(entry => ({
        at: entry.at,
        t: entry.tempC,
        feel: entry.feelsLikeC,
        hum: entry.humidityPct,
        wind: entry.windMS,
        desc: entry.description,
        pop: entry.precipProbabilityPct,
        rain: entry.rainMm3h,
        snow: entry.snowMm3h
      }))
    }))
  };
}

async function fetchWeatherChatBundles(intent) {
  const requestedCities = normalizeRequestedCities(intent.cities?.length ? intent.cities : intent.city);
  const results = await Promise.all(requestedCities.map(async (requestedCity) => {
    try {
      const bundle = await fetchWeatherBundle({
        city: requestedCity,
        preferredName: requestedCity
      });
      return { requestedCity, bundle, error: null };
    } catch (error) {
      return { requestedCity, bundle: null, error };
    }
  }));

  const bundles = [];
  const missingCities = [];

  for (const result of results) {
    if (!result.error) {
      bundles.push(result.bundle);
      continue;
    }

    const status = result.error.status || result.error.response?.status;
    if (status === 404) {
      missingCities.push(result.requestedCity);
      continue;
    }

    throw result.error;
  }

  if (!bundles.length && missingCities.length) {
    const error = createHttpError(404, 'Města nebyla nalezena', 'CITY_NOT_FOUND');
    error.missingCities = missingCities;
    throw error;
  }

  return { bundles, missingCities };
}

async function answerWeatherQuestionWithData(history, intent, bundles) {
  const latestUserMessage = history.filter(item => item.role === 'user').at(-1)?.text || intent.userQuestion || '';
  const conversation = history.map(item => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: item.text
  }));
  const weatherData = bundles.map(createWeatherChatDataset);
  const locationLabels = bundles.map(bundle => buildLocationLabel(bundle.location));

  const messages = [
    {
      role: 'system',
      content: [
        'Jsi český asistent pro počasí.',
        'Odpovídej pouze z dodaných dat OpenWeatherMap.',
        'Odpověz přímo na poslední uživatelský dotaz, nepiš automaticky vícedenní souhrn.',
        'Pokud dostaneš data pro více měst, odpověz pro každé město zvlášť nebo je stručně porovnej podle dotazu.',
        'Když se uživatel ptá na konkrétní den, čas, minimum, maximum nebo srážky, vytáhni přesně tu hodnotu z poskytnutých dat.',
        'Použij kontext předchozí konverzace pro odkazy typu "tam", "v neděli", "a co vítr", ale finální odpověď má řešit poslední dotaz.',
        'Pokud požadovaný den nebo údaj v datech chybí, řekni to jasně a stručně.',
        'Legenda datasetu: loc={n název,c stát}, now={at čas,day den,desc popis,t teplota,feel pocit,hum vlhkost,press tlak,vis viditelnost,cloud oblačnost,wind vítr,gust nárazy,rise východ,set západ}, air={aqi,label,pm25,pm10,o3,no2,co}, range={from,to}, days=[{d datum,day,min,max,desc,pop pravděpodobnost srážek v %,precip srážky v mm,slots=[{at,t,feel,hum,wind,desc,pop,rain,snow}]}].',
        `K dispozici máš data pro tato místa: ${locationLabels.join('; ')}.`
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({
        latestQuestion: latestUserMessage,
        resolvedCity: intent.city,
        resolvedCities: locationLabels,
        conversation,
        weatherData
      })
    }
  ];
  const completion = await requestDeepseekChatCompletion({
    phase: 'answer',
    messages,
    meta: {
      cityCount: bundles.length,
      cities: locationLabels,
      latestUserMessage
    }
  });

  const reply = completion.choices?.[0]?.message?.content?.trim();
  if (!reply) throw createHttpError(502, 'Nepodařilo se vytvořit odpověď z dat o počasí.', 'CHAT_REPLY_INVALID');
  return reply;
}

app.get('/api/chat/history', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({ error: 'Pro chat se musíte přihlásit.' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Chatová historie není nakonfigurována.' });
  }

  const conversation = await getLatestConversation(user.id);
  if (!conversation) {
    return res.json({
      messages: [],
      messageCount: 0,
      conversationId: null,
      maxMessages: CHAT_MAX_MESSAGES
    });
  }

  const messages = await listConversationMessages(conversation.id);
  res.json({
    messages,
    messageCount: getVisibleConversationMessageCount(messages.length),
    conversationId: conversation.id,
    maxMessages: CHAT_MAX_MESSAGES
  });
});

app.post('/api/chat/new', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({ error: 'Pro chat se musíte přihlásit.' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Chatová historie není nakonfigurována.' });
  }

  try {
    const conversation = await getLatestConversation(user.id);
    if (conversation && !conversation.closed_at) {
      await closeConversation(conversation.id);
    }

    const nextConversation = await createConversation(user.id);
    res.json({
      messages: [],
      messageCount: 0,
      rotated: true,
      conversationId: nextConversation.id,
      maxMessages: CHAT_MAX_MESSAGES
    });
  } catch (err) {
    console.error('Chat reset error', err.message || err);
    res.status(500).json({ error: 'Nový chat se nepodařilo vytvořit.' });
  }
});

app.post('/api/chat', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({ error: 'Pro chat se musíte přihlásit.' });
  }

  if (!deepseekClient) {
    return res.status(503).json({ error: 'Chat není nakonfigurován.' });
  }
  if (!API_KEY) {
    return res.status(503).json({ error: 'Chat počasí není nakonfigurován.' });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Chatová historie není nakonfigurována.' });
  }

  const message = (req.body?.message || '').toString().trim();
  if (!message) return res.status(400).json({ error: 'Zadejte zprávu.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Zpráva je příliš dlouhá.' });

  try {
    let rotated = false;
    let conversation = await getLatestConversation(user.id);

    if (conversation) {
      const lastActivityAt = await getConversationLastActivityAt(conversation);
      if (conversation.closed_at || isConversationExpired(lastActivityAt)) {
        if (!conversation.closed_at) {
          await closeConversation(conversation.id);
        }
        conversation = null;
        rotated = true;
      }
    }

    if (!conversation) {
      conversation = await createConversation(user.id);
    }

    await addConversationMessage({
      userId: user.id,
      conversationId: conversation.id,
      role: 'user',
      content: message
    });

    const history = await listRecentConversationMessages(conversation.id, CHAT_MAX_MESSAGES);
    const latestUserMessage = history.filter(item => item.role === 'user').at(-1)?.text || message;
    let reply;

    if (isDateOnlyQuestion(latestUserMessage)) {
      const today = new Date().toLocaleDateString('cs-CZ', {
        weekday: 'long',
        day: 'numeric',
        month: 'numeric',
        year: 'numeric'
      });
      reply = `Dnes je ${today}. Napiš mi město a řeknu ti počasí nebo předpověď.`;
    } else {
      const intent = await inferWeatherChatIntent(history);

      if (!intent.weatherRelevant) {
        reply = 'Pomůžu jen s počasím. Napiš prosím město a co tě zajímá, třeba „Bude zítra v Brně pršet?“';
      } else if (intent.needsCity || !intent.city) {
        reply = 'Potřebuji ještě město. Napiš prosím například „Jaké je teď počasí v Praze?“';
      } else {
        try {
          const { bundles, missingCities } = await fetchWeatherChatBundles(intent);
          reply = await answerWeatherQuestionWithData(history, intent, bundles);
          if (missingCities.length) {
            const missingLabel = formatQuotedCityList(missingCities);
            const prefix = missingCities.length === 1
              ? `Město ${missingLabel} jsem v OpenWeatherMap nenašel. `
              : `Města ${missingLabel} jsem v OpenWeatherMap nenašel. `;
            reply = `${prefix}${reply}`;
          }
        } catch (error) {
          const status = error.status || error.response?.status;
          if (status === 404) {
            const missingCities = normalizeRequestedCities(error.missingCities?.length ? error.missingCities : intent.cities);
            if (missingCities.length > 1) {
              reply = `Města ${formatQuotedCityList(missingCities)} jsem v OpenWeatherMap nenašel. Zkus prosím přesnější názvy, ideálně i se státem.`;
            } else {
              reply = `Město ${formatQuotedCityList(missingCities.length ? missingCities : intent.city)} jsem v OpenWeatherMap nenašel. Zkus prosím přesnější název, ideálně i se státem.`;
            }
          } else {
            throw error;
          }
        }
      }
    }

    await addConversationMessage({
      userId: user.id,
      conversationId: conversation.id,
      role: 'assistant',
      content: reply
    });
    const messages = await listConversationMessages(conversation.id);
    const messageCount = await getConversationMessageCount(conversation.id);

    res.json({
      message: reply,
      messages,
      messageCount: getVisibleConversationMessageCount(messageCount),
      rotated,
      conversationId: conversation.id,
      maxMessages: CHAT_MAX_MESSAGES
    });
  } catch (err) {
    console.error('Chat error', err.response?.data || err.message || err);
    const formatted = formatChatError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});


async function logSearch(userId, city) {
  const label = normalizeSearch(city).slice(0, 100);
  if (!userId || !label) return;
  const { error } = await supabaseAdmin.from('search_logs').insert({
    user_id: userId,
    city: label
  });
  if (error) console.error('Search log error', error.message);
}


function isUuid(value) {
  return /^[0-9a-f-]{36}$/i.test((value || '').toString());
}

app.get('/api/usage', async (req, res) => {
  const session = getSession(req, res);
  res.json(usagePayload(session, await getAuthenticatedUser(req, res)));
});

app.get('/api/version', (req, res) => {
  res.json({
    version: APP_VERSION,
    branch: APP_GIT.branch,
    commit: APP_GIT.commit
  });
});

app.post('/api/usage/reset', async (req, res) => {
  const session = getSession(req, res);
  session.count = 0;
  res.json(usagePayload(session, await getAuthenticatedUser(req, res)));
});

function requireSupabase(res) {
  if (createAuthClient() && supabaseAdmin) return true;
  res.status(503).json({ error: 'Registrace není nakonfigurována.' });
  return false;
}

function validateRegistration(body) {
  const firstName = (body?.firstName || '').toString().trim();
  const lastName = (body?.lastName || '').toString().trim();
  const email = (body?.email || '').toString().trim().toLowerCase();
  const phone = (body?.phone || '').toString().trim();
  const countryCode = (body?.countryCode || '').toString().trim().toUpperCase();
  const password = (body?.password || '').toString();

  if (!firstName || firstName.length > 100) return { error: 'Zadejte platné jméno.' };
  if (!lastName || lastName.length > 100) return { error: 'Zadejte platné příjmení.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Zadejte platný e-mail.' };
  if (!/^[+0-9 ()-]{7,32}$/.test(phone)) return { error: 'Zadejte platné telefonní číslo.' };
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'Vyberte zemi.' };
  if (password.length < 8) return { error: 'Heslo musí mít alespoň 8 znaků.' };

  return { firstName, lastName, email, phone, countryCode, password };
}

function registrationErrorMessage(error) {
  if (/email rate limit/i.test(error.message)) {
    return 'Bylo odesláno příliš mnoho potvrzovacích e-mailů. Zkuste to prosím později.';
  }
  if (/invalid.*email|email.*invalid/i.test(error.message)) {
    return 'Tuto e-mailovou adresu nelze použít.';
  }
  if (/password/i.test(error.message)) {
    return 'Heslo nesplňuje bezpečnostní požadavky.';
  }
  return 'Registraci se nepodařilo dokončit. Zkuste to prosím znovu.';
}

function loginErrorPayload(error) {
  const message = (error?.message || '').toString();
  if (/email not confirmed|not confirmed/i.test(message)) {
    return {
      status: 403,
      error: 'E-mail ještě není potvrzený. Otevřete potvrzovací odkaz a pak se přihlaste.'
    };
  }
  if (/too many requests|rate limit/i.test(message)) {
    return {
      status: 429,
      error: 'Příliš mnoho pokusů o přihlášení. Zkuste to prosím později.'
    };
  }
  if (/invalid login credentials|invalid.*email|invalid.*password|user not found/i.test(message)) {
    return { status: 401, error: 'Neplatný e-mail nebo heslo.' };
  }
  return {
    status: 401,
    error: 'Přihlášení se nepodařilo. Zkuste to prosím znovu.'
  };
}

app.post('/api/auth/register', authApiLimit, async (req, res) => {
  if (!requireSupabase(res)) return;
  const input = validateRegistration(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  const auth = createAuthClient();
  const { data, error } = await auth.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: `${req.protocol}://${req.get('host')}`,
      data: {
        first_name: input.firstName,
        last_name: input.lastName,
        phone: input.phone,
        country_code: input.countryCode
      }
    }
  });

  if (error) {
    const duplicate = /already registered|already exists/i.test(error.message);
    return res.status(duplicate ? 409 : 400).json({
      error: duplicate ? 'Účet s tímto e-mailem už existuje.' : registrationErrorMessage(error)
    });
  }

  const anonymousSession = getSession(req, res);
  if (data.session) {
    setAuthCookies(res, data.session);
    anonymousSession.count = 0;
  }

  const user = data.session && data.user
    ? publicUser(data.user, await getProfile(data.user))
    : null;
  if (user) {
    anonymousSession.user = user;
    anonymousSession.userAccessToken = data.session.access_token;
  }

  res.status(201).json({
    ...usagePayload(anonymousSession, user),
    registered: true,
    confirmationRequired: !data.session,
    message: data.session
      ? 'Registrace proběhla úspěšně.'
      : 'Registrace proběhla úspěšně. Potvrďte prosím e-mail a poté se přihlaste.'
  });
});

app.post('/api/auth/login', authApiLimit, async (req, res) => {
  if (!requireSupabase(res)) return;

  const email = (req.body?.email || '').toString().trim().toLowerCase();
  const password = (req.body?.password || '').toString();
  if (!email || !password) {
    return res.status(400).json({ error: 'Zadejte e-mail a heslo.' });
  }

  const auth = createAuthClient();
  const { data, error } = await auth.auth.signInWithPassword({ email, password });
  if (error) {
    const payload = loginErrorPayload(error);
    return res.status(payload.status).json({ error: payload.error });
  }
  if (!data?.session || !data?.user) {
    return res.status(401).json({ error: 'Přihlášení se nepodařilo. Zkuste to prosím znovu.' });
  }

  await ensureAdminRole(data.user);
  setAuthCookies(res, data.session);
  const session = getSession(req, res);
  session.count = 0;
  session.user = publicUser(data.user, await getProfile(data.user));
  session.userAccessToken = data.session.access_token;
  res.json(usagePayload(session, session.user));
});

app.post('/api/auth/logout', async (req, res) => {
  const session = getSession(req, res);
  clearAuthCookies(res);
  session.user = null;
  session.userAccessToken = null;
  res.json(usagePayload(session));
});

app.get('/api/profile', profileApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Profil není nakonfigurován.')) return;
  const user = await requireAuthenticatedUserOrFail(req, res, 'Nejste přihlášeni.');
  if (!user) return;

  const profile = await getProfile(user.id);
  if (!profile) {
    return res.status(404).json({ error: 'Profil nebyl nalezen.' });
  }

  res.json({ user: publicUser({ id: user.id, email: user.email }, profile) });
});

app.patch('/api/profile', profileApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Profil není nakonfigurován.')) return;
  const user = await requireAuthenticatedUserOrFail(req, res, 'Nejste přihlášeni.');
  if (!user) return;

  const input = validateProfileUpdate(req.body);
  if (input.error) {
    return res.status(400).json({ error: input.error });
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone,
      country_code: input.countryCode,
      bio: input.bio
    })
    .eq('id', user.id)
    .select('id, first_name, last_name, email, phone, country_code, role, credits, is_blocked, avatar_url, bio')
    .single();

  if (error) {
    console.error('Profile update error', error.message);
    return res.status(400).json({ error: 'Profil se nepodařilo uložit.' });
  }

  const session = getSession(req, res);
  session.user = publicUser({ id: user.id, email: data.email }, data);
  res.json({ user: session.user });
});

app.post('/api/profile/avatar', profileApiLimit, (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Avatar není nakonfigurován.')) return;

  avatarUpload.single('avatar')(req, res, async (uploadError) => {
    if (uploadError) {
      if (uploadError.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `Avatar může mít maximálně ${Math.round(AVATAR_MAX_BYTES / 1024 / 1024)} MB.` });
      }
      if (uploadError.code === 'INVALID_AVATAR_TYPE') {
        return res.status(400).json({ error: 'Avatar musí být ve formátu JPG, PNG nebo WebP.' });
      }
      console.error('Avatar upload error', uploadError.message || uploadError);
      return res.status(400).json({ error: 'Nahrání avatara selhalo.' });
    }

    const user = await requireAuthenticatedUserOrFail(req, res, 'Nejste přihlášeni.');
    if (!user) return;
    if (!req.file) {
      return res.status(400).json({ error: 'Vyberte avatar k nahrání.' });
    }

    const fileExt = AVATAR_MIME_TO_EXT[req.file.mimetype];
    const objectPath = `${user.id}/${crypto.randomUUID()}.${fileExt}`;
    const currentProfile = await getProfile(user.id);
    const previousObjectPath = avatarObjectPathFromUrl(currentProfile?.avatar_url);

    const uploadResult = await supabaseAdmin.storage
      .from('avatars')
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadResult.error) {
      console.error('Avatar storage upload error', uploadResult.error.message);
      return res.status(400).json({ error: 'Avatar se nepodařilo nahrát.' });
    }

    const publicUrl = avatarPublicUrl(objectPath);
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ avatar_url: publicUrl })
      .eq('id', user.id)
      .select('id, first_name, last_name, email, phone, country_code, role, credits, is_blocked, avatar_url, bio')
      .single();

    if (error) {
      console.error('Avatar profile update error', error.message);
      await supabaseAdmin.storage.from('avatars').remove([objectPath]);
      return res.status(400).json({ error: 'Avatar se nepodařilo uložit do profilu.' });
    }

    if (previousObjectPath && previousObjectPath !== objectPath) {
      const removeResult = await supabaseAdmin.storage.from('avatars').remove([previousObjectPath]);
      if (removeResult.error) {
        console.error('Avatar cleanup error', removeResult.error.message);
      }
    }

    const session = getSession(req, res);
    session.user = publicUser({ id: user.id, email: data.email }, data);
    res.json({ user: session.user });
  });
});

app.get('/api/admin/users', adminApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Administrace není nakonfigurována.')) return;
  const adminUser = await requireAdminUserOrFail(req, res);
  if (!adminUser) return;

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, first_name, last_name, email, phone, country_code, role, credits, is_blocked, avatar_url, bio, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Admin users load error', error.message);
    return res.status(500).json({ error: 'Uživatele se nepodařilo načíst.' });
  }

  res.json({ users: (data || []).map(serializeProfile) });
});

app.get('/api/admin/searches', adminApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Administrace není nakonfigurována.')) return;
  const adminUser = await requireAdminUserOrFail(req, res);
  if (!adminUser) return;

  const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const { data: searches, error: searchesError } = await supabaseAdmin
    .from('search_logs')
    .select('user_id, city, searched_at')
    .order('searched_at', { ascending: false })
    .limit(limit);

  if (searchesError) {
    console.error('Admin searches load error', searchesError.message);
    return res.status(500).json({ error: 'Historii vyhledávání se nepodařilo načíst.' });
  }

  const userIds = Array.from(new Set((searches || []).map(item => item.user_id).filter(isUuid)));
  let profilesById = new Map();

  if (userIds.length) {
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', userIds);
    if (profilesError) {
      console.error('Admin search profiles load error', profilesError.message);
      return res.status(500).json({ error: 'Profily k historii vyhledávání se nepodařilo načíst.' });
    }
    profilesById = new Map((profiles || []).map((item) => [item.id, item]));
  }

  res.json({
    searches: (searches || []).map((item) => {
      const profile = profilesById.get(item.user_id);
      const userName = profile ? [profile.first_name, profile.last_name].filter(Boolean).join(' ') : '';
      return {
        city: item.city,
        searchedAt: item.searched_at,
        userEmail: profile?.email || '',
        userName: userName || profile?.email || ''
      };
    })
  });
});

app.post('/api/admin/users/:userId/credits', adminApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Administrace není nakonfigurována.')) return;
  const adminUser = await requireAdminUserOrFail(req, res);
  if (!adminUser) return;

  const targetUserId = (req.params.userId || '').toString().trim();
  const amount = Number.parseInt(req.body?.amount, 10);
  if (!isUuid(targetUserId)) {
    return res.status(400).json({ error: 'Neplatné ID uživatele.' });
  }
  if (!Number.isFinite(amount) || amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'Zadejte počet kreditů od 1 do 100000.' });
  }

  const { data, error } = await supabaseAdmin.rpc('add_credits', {
    p_user_id: targetUserId,
    p_amount: amount
  });

  if (error) {
    console.error('Admin add credits error', error.message);
    return res.status(400).json({ error: 'Kredity se nepodařilo dobít.' });
  }

  if (targetUserId === adminUser.id) {
    const profile = await getProfile(adminUser.id);
    if (profile) {
      const session = getSession(req, res);
      session.user = publicUser({ id: adminUser.id, email: adminUser.email }, profile);
      session.userAccessToken = parseCookies(req)[ACCESS_TOKEN_COOKIE] || session.userAccessToken || null;
    }
  }

  res.json({
    credits: Number.parseInt(data, 10) || 0,
    message: `Kredity byly navýšeny o ${amount}.`
  });
});

app.post('/api/admin/users/:userId/block', adminApiLimit, async (req, res) => {
  if (!ensureSupabaseAdmin(res, 'Administrace není nakonfigurována.')) return;
  const adminUser = await requireAdminUserOrFail(req, res);
  if (!adminUser) return;

  const targetUserId = (req.params.userId || '').toString().trim();
  const blocked = req.body?.blocked;
  if (!isUuid(targetUserId)) {
    return res.status(400).json({ error: 'Neplatné ID uživatele.' });
  }
  if (typeof blocked !== 'boolean') {
    return res.status(400).json({ error: 'Neplatný požadavek na změnu stavu.' });
  }
  if (targetUserId === adminUser.id) {
    return res.status(400).json({ error: 'Nemůžete zablokovat vlastní účet.' });
  }

  const { data, error } = await supabaseAdmin.rpc('set_user_blocked', {
    p_user_id: targetUserId,
    p_blocked: blocked
  });

  if (error) {
    console.error('Admin block user error', error.message);
    return res.status(400).json({ error: 'Stav uživatele se nepodařilo změnit.' });
  }

  res.json({
    user: serializeProfile(data),
    message: blocked ? 'Uživatel byl zablokován.' : 'Uživatel byl znovu aktivován.'
  });
});

// Helper to normalize
function norm(s){ return (s||'').toString().trim().toLowerCase(); }
function normalizeSearch(s){ return (s||'').toString().trim().replace(/\s+/g, ' '); }

// Geocoding suggestion endpoint with smarter ranking and Prague fallback
app.get('/api/suggest', suggestApiLimit, requireWeatherConfig, async (req, res) => {
  const q = normalizeSearch(req.query.q);
  if (!q || q.length < 2) return res.json([]);
  if (q.length > 100) {
    return res.status(400).json({
      error: 'Název města je příliš dlouhý.',
      code: 'INVALID_CITY_QUERY'
    });
  }
  try {
    res.json(await lookupPlaces(q, 8));
  } catch (err) {
    console.error('Suggest error', err.response?.data || err.message || err);
    res.status(500).json([]);
  }
});

// Weather endpoint: accept city or lat+lon. Use free endpoints (current + forecast + air)
app.get('/api/weather', weatherApiLimit, requireWeatherConfig, async (req, res) => {
  const city = normalizeSearch(req.query.city);
  const latQ = req.query.lat;
  const lonQ = req.query.lon;

  if (!city && !(latQ && lonQ)) return res.status(400).json({ error: 'Město nebo souřadnice jsou povinné' });
  if (city.length > 100) {
    return res.status(400).json({
      error: 'Název města je příliš dlouhý.',
      code: 'INVALID_CITY_QUERY'
    });
  }

  const session = getSession(req, res);
  let user = await getAuthenticatedUser(req, res);
  if (!user && session.count >= FREE_LIMIT) {
    return res.status(429).json({
      error: `Bez registrace je možné provést pouze ${FREE_LIMIT} dotazů.`,
      code: 'FREE_LIMIT_REACHED',
      usage: usagePayload(session, user)
    });
  }
  if (user && user.credits < 1) {
    return res.status(402).json({
      error: 'Nemáte dostatek kreditů. Požádejte administrátora o dobití.',
      code: 'INSUFFICIENT_CREDITS',
      usage: usagePayload(session, user)
    });
  }

  const preferredName = normalizeSearch(req.query.name).slice(0, 100);

  try {
    const weather = await fetchWeatherBundle({
      city,
      lat: latQ,
      lon: lonQ,
      preferredName
    });

    const searchedCity = preferredName || weather.location.name || city;

    if (!user) {
      session.count += 1;
    } else {
      const remaining = await consumeUserCredit(user.id);
      if (remaining < 0) {
        return res.status(402).json({
          error: 'Nemáte dostatek kreditů. Požádejte administrátora o dobití.',
          code: 'INSUFFICIENT_CREDITS',
          usage: usagePayload(session, user)
        });
      }
      user = { ...user, credits: remaining };
      session.user = user;
      await logSearch(user.id, searchedCity);
    }

    res.json({
      ...weather,
      usage: usagePayload(session, user)
    });
  } catch (err) {
    console.error('Weather error', err.response?.data || err.message || err);
    const msg = err.response?.data?.message || err.message;
    res.status(err.status || err.response?.status || 500).json({ error: msg, code: err.code });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));
}

module.exports = {
  app,
  normalizeRequestedCities,
  extractExplicitCitiesFromMessage,
  inferWeatherChatIntentLocally,
  inferWeatherChatIntent,
  createWeatherChatDataset,
  fetchWeatherChatBundles,
  answerWeatherQuestionWithData,
  setDeepseekClientForTesting(client) {
    deepseekClient = client;
  },
  getDeepseekDebugLogPath() {
    return DEEPSEEK_DEBUG_LOG_PATH;
  }
};
