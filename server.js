require('dotenv').config({ quiet: true });

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENWEATHER_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const APP_VERSION = `1.0.0+${process.env.RENDER_GIT_COMMIT?.slice(0, 7) || process.env.GIT_COMMIT?.slice(0, 7) || process.env.BUILD_ID || 'local'}`;
const CHAT_TIMEOUT_MS = 15000;
const CHAT_MAX_MESSAGES = 10;
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
const deepseekClient = DEEPSEEK_API_KEY
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

  if (session.user && session.userAccessToken === accessToken) return session.user;

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

async function getActiveConversation(userId) {
  if (!supabaseAdmin || !isUuid(userId)) return null;
  const { data, error } = await supabaseAdmin
    .from('chat_conversations')
    .select('id, user_id, started_at, closed_at')
    .eq('user_id', userId)
    .is('closed_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('Active conversation load error', error.message);
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

async function getOrCreateActiveConversation(userId) {
  const current = await getActiveConversation(userId);
  if (current) return current;
  return createConversation(userId);
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

app.get('/api/chat/history', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({ error: 'Pro chat se musíte přihlásit.' });
  }

  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Chatová historie není nakonfigurována.' });
  }

  const conversation = await getActiveConversation(user.id);
  if (!conversation) {
    return res.json({ messages: [], conversationId: null, maxMessages: CHAT_MAX_MESSAGES });
  }

  const messages = await listConversationMessages(conversation.id);
  res.json({
    messages,
    conversationId: conversation.id,
    maxMessages: CHAT_MAX_MESSAGES
  });
});

app.post('/api/chat', async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({ error: 'Pro chat se musíte přihlásit.' });
  }

  if (!deepseekClient) {
    return res.status(503).json({ error: 'Chat není nakonfigurován.' });
  }
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Chatová historie není nakonfigurována.' });
  }

  const message = (req.body?.message || '').toString().trim();
  if (!message) return res.status(400).json({ error: 'Zadejte zprávu.' });
  if (message.length > 4000) return res.status(400).json({ error: 'Zpráva je příliš dlouhá.' });

  try {
    let conversation = await getOrCreateActiveConversation(user.id);
    const messageCount = await getConversationMessageCount(conversation.id);
    if (messageCount + 2 > CHAT_MAX_MESSAGES) {
      await closeConversation(conversation.id);
      conversation = await createConversation(user.id);
    }

    await addConversationMessage({
      userId: user.id,
      conversationId: conversation.id,
      role: 'user',
      content: message
    });

    const history = await listConversationMessages(conversation.id);
    const systemPrompt = [
      'Jsi český AI asistent zaměřený výhradně na počasí.',
      'Odpovídej pouze na dotazy související s počasím, klimatem, předpovědí, teplotou, srážkami, větrem, kvalitou ovzduší a plánováním aktivit podle počasí.',
      'Pokud je dotaz "co je dnes za den", odpověz stručně a hned se doptáš na lokalitu a nabídneš pomoc s počasím.',
      'Na dotazy mimo počasí (například "jak se mám") neodpovídej věcně: krátce odmítni a okamžitě převeď konverzaci k počasí.',
      'Piš česky, stručně a věcně.'
    ].join(' ');

    const completion = await Promise.race([
      deepseekClient.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...history.map((item) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: item.text
          }))
        ],
        stream: false,
        temperature: 0.6
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          const timeoutError = new Error('Chat momentálně neodpovídá. Zkuste to prosím znovu.');
          timeoutError.status = 504;
          reject(timeoutError);
        }, CHAT_TIMEOUT_MS);
      })
    ]);

    const reply = completion.choices?.[0]?.message?.content?.trim() || 'Odpověď se nepodařilo vytvořit.';
    await addConversationMessage({
      userId: user.id,
      conversationId: conversation.id,
      role: 'assistant',
      content: reply
    });

    res.json({
      message: reply,
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
  res.json({ version: APP_VERSION });
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
  if (error || !data?.session || !data?.user) {
    return res.status(401).json({ error: 'Neplatný e-mail nebo heslo.' });
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
    const url = 'https://api.openweathermap.org/geo/1.0/direct';
    const resp = await axios.get(url, { params: { q, limit: 12, appid: API_KEY } });
    const items = resp.data || [];

    const qn = norm(q);
    // Build enriched items
    let list = items.map(item => ({
      name: item.name,
      local_names: item.local_names || {},
      state: item.state,
      country: item.country,
      lat: item.lat,
      lon: item.lon,
      population: item.population || 0
    }));

    // Build friendly display name and scoring
    list = list.map(it => {
      // friendly display
      let displayName = it.name;
      try {
        const locals = Object.values(it.local_names || {}).map(v => (v||'').toString());
        const csLocal = it.local_names && (it.local_names.cs || it.local_names['cs']);
        if (it.country === 'CZ') {
          if (locals.some(v => /praha/i.test(v))) displayName = 'Praha';
          else if (csLocal) displayName = csLocal;
          else displayName = it.name;
        } else if (csLocal) {
          displayName = csLocal;
        }
      } catch (e) {
        displayName = it.name;
      }
      it.shortName = displayName;
      // skip the region when it just repeats the city name ("Praha, Prague, CZ")
      const state = it.state && norm(it.state) !== norm(displayName) && norm(it.state) !== norm(it.name) ? it.state : '';
      it.display = `${displayName}${state ? ', ' + state : ''}${it.country ? ', ' + it.country : ''}`;

      // scoring
      let score = 0;
      if (norm(it.name) === qn) score += 120;
      const localValues = Object.values(it.local_names || {}).map(v => norm(v));
      if (localValues.includes(qn)) score += 120;
      if (localValues.some(v => v.includes(qn))) score += 60;
      if (it.country === 'CZ') score += 80;
      if (qn === 'praha' && (norm(it.name) === 'prague')) score += 50;
      score += Math.min(it.population || 0, 1000000) / 10000;
      it._score = score;
      return it;
    });

    // sort by score desc
    list.sort((a,b) => (b._score || 0) - (a._score || 0));

    // Deduplicate by rounded lat/lon (merge identical locations) to avoid duplicate names
    const seen = new Map();
    for (const it of list) {
      const key = `${(it.lat||0).toFixed(4)}|${(it.lon||0).toFixed(4)}`;
      if (!seen.has(key)) seen.set(key, it);
    }
    let deduped = Array.from(seen.values());

    // Ensure Prague CZ is first when user typed Praha/Prague
    if ((qn === 'praha' || qn === 'prague')) {
      const hasCZ = deduped.some(i => i.country === 'CZ');
      if (!hasCZ) {
        deduped.unshift({ name: 'Praha', state: '', country: 'CZ', lat: 50.0755381, lon: 14.4378005, display: 'Praha, CZ', population: 1300000, source: 'fallback' });
      } else {
        // move the first CZ item to the top
        const idx = deduped.findIndex(i => i.country === 'CZ');
        if (idx > 0) {
          const [cz] = deduped.splice(idx,1);
          deduped.unshift(cz);
        }
      }
    }

    res.json(deduped.slice(0,8));
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
    let lat, lon, name, country;

    if (latQ && lonQ) {
      lat = parseFloat(latQ); lon = parseFloat(lonQ);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        return res.status(400).json({ error: 'Neplatné souřadnice' });
      }
      // try reverse geocode to get name/country
      try {
        const revUrl = 'https://api.openweathermap.org/geo/1.0/reverse';
        const revResp = await axios.get(revUrl, { params: { lat, lon, limit: 1, appid: API_KEY } });
        const place = revResp.data && revResp.data[0];
        if (place) { name = place.name; country = place.country; }
      } catch (e) { /* ignore reverse errors */ }
      // the label the user picked wins over the reverse-geocoded English name
      if (preferredName) name = preferredName;
      if (!name && city) name = city;
    } else {
      // geocode by city string
      const geoUrl = 'https://api.openweathermap.org/geo/1.0/direct';
      const geoResp = await axios.get(geoUrl, { params: { q: city, limit: 1, appid: API_KEY } });
      const place = geoResp.data && geoResp.data[0];
      if (!place) return res.status(404).json({ error: 'Město nebylo nalezeno' });
      lat = place.lat; lon = place.lon; name = place.name; country = place.country;
    }

    // 2) Current weather
    const curUrl = 'https://api.openweathermap.org/data/2.5/weather';
    const curResp = await axios.get(curUrl, { params: { lat, lon, units: 'metric', appid: API_KEY } });

    // 3) Forecast 5 day / 3 hour
    const fUrl = 'https://api.openweathermap.org/data/2.5/forecast';
    const fResp = await axios.get(fUrl, { params: { lat, lon, units: 'metric', appid: API_KEY } });

    // 4) Air pollution (if available)
    let air = null;
    try {
      const aUrl = 'https://api.openweathermap.org/data/2.5/air_pollution';
      const aResp = await axios.get(aUrl, { params: { lat, lon, appid: API_KEY } });
      air = aResp.data;
    } catch (e) {
      // ignore air pollution errors
    }

    const searchedCity = preferredName || name || city;

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
      await logSearch(user.id, searchedCity);
    }

    res.json({
      location: { name, country, lat, lon },
      current: curResp.data,
      forecast: fResp.data,
      air,
      usage: usagePayload(session, user)
    });
  } catch (err) {
    console.error('Weather error', err.response?.data || err.message || err);
    const msg = err.response?.data?.message || err.message;
    res.status(err.response?.status || 500).json({ error: msg });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Server běží na http://localhost:${PORT}`));
