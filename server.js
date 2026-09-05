require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');

function hashPassword(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createApp(overrides = {}) {
  const app = express();
  const PORT = overrides.port || Number(process.env.PORT) || 3000;
  const DATA_FILE = overrides.dataFile || path.join(__dirname, 'data', 'users.json');
  const ADMIN_KEY = overrides.adminKey || process.env.ADMIN_KEY || 'sangwa-admin-key';
  const DATABASE_URL = overrides.databaseUrl || process.env.DATABASE_URL || null;
  const SUPABASE_URL = process.env.SUPABASE_URL || null;
  const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || null;
  const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || null;
  const TTS_CACHE_DIR = overrides.ttsCacheDir || path.join(__dirname, 'data', 'tts-cache');

  // ---- Supabase Storage: persistent home for admin-recorded audio -------------
  // Render's disk is ephemeral (wiped on every restart, including automatic
  // spin-down after ~15 min idle on the free plan, not just on redeploy), so
  // recordings made through /record.html must NOT live on local disk in
  // production — see the incident this fixed. Resolves the real project URL
  // from (in order): an explicit SUPABASE_PROJECT_URL, the SUPABASE_URL var if
  // it's actually a URL (it once held a publishable key by mistake — kept
  // tolerant here in case that regresses), or the host embedded in DATABASE_URL.
  function deriveSupabaseProjectUrl() {
    if (process.env.SUPABASE_PROJECT_URL) return process.env.SUPABASE_PROJECT_URL;
    if (SUPABASE_URL && /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL)) return SUPABASE_URL;
    const match = DATABASE_URL && DATABASE_URL.match(/@db\.([a-z0-9]+)\.supabase\.co/);
    return match ? `https://${match[1]}.supabase.co` : null;
  }
  const SUPABASE_PROJECT_URL = deriveSupabaseProjectUrl();
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;
  const AUDIO_BUCKET = 'audio';
  const supabaseAdmin = (SUPABASE_PROJECT_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

  async function ensureAudioBucket() {
    if (!supabaseAdmin) return { ok: false, reason: 'not-configured' };
    try {
      const { data: existing } = await supabaseAdmin.storage.getBucket(AUDIO_BUCKET);
      if (!existing) {
        const { error } = await supabaseAdmin.storage.createBucket(AUDIO_BUCKET, { public: true });
        if (error && !/already exists/i.test(error.message || '')) throw error;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  // High-quality neural voices: British English + Beijing-standard Mandarin, one
  // male and one female each. See https://learn.microsoft.com/azure/ai-services/speech-service/language-support
  const AZURE_VOICES = {
    en: { female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
    zh: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
  };

  let dbClient = null;
  let databaseReady = false;

  function usesSupabase() {
    return Boolean(DATABASE_URL && DATABASE_URL.includes('supabase'));
  }

  async function getDbClient() {
    if (!DATABASE_URL) return null;
    if (!dbClient) {
      dbClient = new Client({
        connectionString: DATABASE_URL,
        ssl: usesSupabase() ? { rejectUnauthorized: false } : undefined,
      });
      await dbClient.connect();
    }
    return dbClient;
  }

  async function initDatabase() {
    const client = await getDbClient();
    if (!client) {
      databaseReady = false;
      return { connected: false, mode: 'file' };
    }

    await client.query(`
      create table if not exists public.users (
        id uuid primary key default gen_random_uuid(),
        email text unique,
        password_hash text not null,
        full_name text,
        username text not null unique,
        created_at timestamptz default now()
      );
    `);
    databaseReady = true;
    return { connected: true, mode: 'supabase', url: SUPABASE_URL };
  }

  function ensureDataFile() {
    const dir = path.dirname(DATA_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
    }
  }

  function readUsers() {
    ensureDataFile();
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.users) ? parsed.users : [];
    } catch (error) {
      return [];
    }
  }

  function writeUsers(users) {
    ensureDataFile();
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users }, null, 2), 'utf8');
  }

  function sanitizeUser(user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name || user.full_name || '',
      username: user.username || '',
      createdAt: user.createdAt || user.created_at,
    };
  }

  async function listUsersFromDb() {
    const client = await getDbClient();
    if (!client) return readUsers().map(sanitizeUser);
    const result = await client.query(
      'select id, email, full_name, username, created_at from public.users order by created_at desc'
    );
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.full_name || '',
      username: row.username || '',
      createdAt: row.created_at,
    }));
  }

  app.use(express.json({ limit: '1mb' }));
  // Recorded audio lives in Supabase Storage now (see the incident note above),
  // not on local disk — this just redirects to the bucket's public URL so
  // existing client code (<audio src="/audio/<lang>/<id>.webm">) keeps working.
  app.get('/audio/:lang/:file', (req, res) => {
    if (!supabaseAdmin) return res.status(503).end();
    const { data } = supabaseAdmin.storage.from(AUDIO_BUCKET).getPublicUrl(req.params.lang + '/' + req.params.file);
    return res.redirect(302, data.publicUrl);
  });
  app.use(express.static(__dirname));

  app.get('/api/health', async (req, res) => {
    const payload = {
      ok: true,
      time: new Date().toISOString(),
      storage: databaseReady ? 'supabase' : (DATABASE_URL ? 'supabase-pending' : 'file'),
      supabaseUrl: SUPABASE_URL || null,
    };

    if (!DATABASE_URL) {
      return res.json(payload);
    }

    try {
      const client = await getDbClient();
      const result = await client.query('select now() as now');
      payload.storage = 'supabase';
      payload.databaseTime = result.rows[0].now;
      return res.json(payload);
    } catch (error) {
      return res.status(503).json({
        ok: false,
        time: payload.time,
        storage: 'error',
        supabaseUrl: SUPABASE_URL || null,
        error: error.message,
      });
    }
  });

  app.post('/api/signup', async (req, res) => {
    const { email, password, name, username } = req.body || {};
    const trimmedPassword = String(password || '').trim();
    const trimmedUsername = String(username || '').trim();
    const trimmedEmail = email ? String(email).trim().toLowerCase() : '';
    const fullName = String(name || '').trim();

    if (!trimmedUsername || !trimmedPassword) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const client = await getDbClient();

    if (client) {
      try {
        const usernameCheck = await client.query('select id from public.users where lower(username) = $1', [trimmedUsername.toLowerCase()]);
        if (usernameCheck.rows.length) {
          return res.status(409).json({ error: 'That username is already taken.' });
        }

        if (trimmedEmail) {
          const emailCheck = await client.query('select id from public.users where lower(email) = $1', [trimmedEmail]);
          if (emailCheck.rows.length) {
            return res.status(409).json({ error: 'A user with that email already exists.' });
          }
        }

        const passwordHash = hashPassword(trimmedPassword);

        const result = await client.query(
          `insert into public.users (email, password_hash, full_name, username)
           values ($1, $2, $3, $4)
           returning id, email, full_name, username, created_at`,
          [trimmedEmail || null, passwordHash, fullName, trimmedUsername]
        );

        const saved = result.rows[0];
        return res.status(201).json({
          message: 'Account created successfully.',
          user: sanitizeUser({
            id: saved.id,
            email: saved.email,
            name: saved.full_name,
            username: saved.username,
            createdAt: saved.created_at,
          }),
        });
      } catch (error) {
        return res.status(500).json({ error: 'Database signup failed.', details: error.message });
      }
    }

    const users = readUsers();
    const usernameTaken = users.some((user) => String(user.username || '').trim().toLowerCase() === trimmedUsername.toLowerCase());
    if (usernameTaken) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    if (trimmedEmail) {
      const emailTaken = users.some((user) => String(user.email || '').trim().toLowerCase() === trimmedEmail);
      if (emailTaken) {
        return res.status(409).json({ error: 'A user with that email already exists.' });
      }
    }

    const newUser = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      email: trimmedEmail || null,
      password_hash: hashPassword(trimmedPassword),
      username: trimmedUsername,
      full_name: fullName,
      created_at: new Date().toISOString(),
    };

    users.push(newUser);
    writeUsers(users);

    return res.status(201).json({
      message: 'Account created successfully.',
      user: sanitizeUser(newUser),
    });
  });

  app.post('/api/login', async (req, res) => {
    const { email, username, password } = req.body || {};
    const trimmedPassword = String(password || '').trim();
    const trimmedUsername = username ? String(username).trim() : '';
    const trimmedEmail = email ? String(email).trim().toLowerCase() : '';

    if ((!trimmedUsername && !trimmedEmail) || !trimmedPassword) {
      return res.status(400).json({ error: 'Username or email and password are required.' });
    }

    const client = await getDbClient();
    if (client) {
      try {
        let result;
        if (trimmedUsername) {
          result = await client.query(
            'select id, email, full_name, username, created_at from public.users where lower(username) = $1 and password_hash = $2',
            [trimmedUsername.toLowerCase(), hashPassword(trimmedPassword)]
          );
        } else {
          result = await client.query(
            'select id, email, full_name, username, created_at from public.users where lower(email) = $1 and password_hash = $2',
            [trimmedEmail, hashPassword(trimmedPassword)]
          );
        }

        if (!result.rows.length) {
          return res.status(401).json({ error: 'Invalid username/email or password.' });
        }

        const user = result.rows[0];
        return res.json({
          message: 'Login successful.',
          user: sanitizeUser({
            id: user.id,
            email: user.email,
            name: user.full_name,
            username: user.username,
            createdAt: user.created_at,
          }),
        });
      } catch (error) {
        return res.status(500).json({ error: 'Database login failed.', details: error.message });
      }
    }

    const users = readUsers();
    const user = users.find((entry) => {
      const matchesUsername = trimmedUsername && String(entry.username || '').trim().toLowerCase() === trimmedUsername.toLowerCase();
      const matchesEmail = trimmedEmail && String(entry.email || '').trim().toLowerCase() === trimmedEmail;
      const passwordMatches = entry.password_hash === hashPassword(trimmedPassword) || entry.password === hashPassword(trimmedPassword);
      return (matchesUsername || matchesEmail) && passwordMatches;
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    return res.json({
      message: 'Login successful.',
      user: sanitizeUser(user),
    });
  });

  app.get('/api/admin/users', async (req, res) => {
    const incomingKey = req.headers['x-admin-key'];
    if (incomingKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized admin access.' });
    }

    const users = await listUsersFromDb();
    return res.json({ count: users.length, users });
  });

  app.get('/admin', (req, res) => {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  });

  app.get('/admin.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  });

  app.get('/record', (req, res) => {
    return res.sendFile(path.join(__dirname, 'record.html'));
  });

  app.get('/record.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'record.html'));
  });

  // ---- text-to-speech proxy (Azure AI Speech): English + Chinese only ---------
  // Tibetan has no usable TTS voice on any provider, so it is not handled here —
  // see the /api/admin/audio routes below for the real-recording approach.
  app.get('/api/tts', async (req, res) => {
    const lang = String(req.query.lang || '');
    const voice = String(req.query.voice || 'female');
    const text = String(req.query.text || '').slice(0, 500);

    const voiceName = AZURE_VOICES[lang] && AZURE_VOICES[lang][voice];
    if (!voiceName || !text.trim()) {
      return res.status(400).json({ error: 'Unsupported lang/voice or empty text.' });
    }
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(503).json({ error: 'Azure Speech is not configured on this server yet.' });
    }

    const cacheKey = crypto.createHash('sha256').update(voiceName + '|' + text).digest('hex');
    const cacheFile = path.join(TTS_CACHE_DIR, cacheKey + '.mp3');

    try {
      if (fs.existsSync(cacheFile)) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return fs.createReadStream(cacheFile).pipe(res);
      }

      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const langTag = lang === 'zh' ? 'zh-CN' : 'en-GB';
      const ssml = `<speak version="1.0" xml:lang="${langTag}"><voice name="${voiceName}">${escaped}</voice></speak>`;

      const azureRes = await fetch(
        `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'audio-16khz-64kbitrate-mono-mp3',
            'User-Agent': 'yeshe-app',
          },
          body: ssml,
        }
      );

      if (!azureRes.ok) {
        const details = await azureRes.text().catch(() => '');
        return res.status(502).json({ error: 'Azure Speech request failed.', details: details.slice(0, 300) });
      }

      const audioBuffer = Buffer.from(await azureRes.arrayBuffer());
      fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, audioBuffer);

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(audioBuffer);
    } catch (error) {
      return res.status(500).json({ error: 'TTS synthesis failed.', details: error.message });
    }
  });

  // ---- own-voice audio: real recordings uploaded via the /record admin tool ---
  // Stored in Supabase Storage at <bucket>/<lang>/<wordId>.webm — NOT on local
  // disk, which Render wipes on every restart (including automatic spin-down
  // after ~15 min idle on the free plan, not just on redeploy). Tibetan has no
  // usable TTS voice on any provider, so bo always relies on this; English
  // uses it only when you've recorded that word yourself, falling back to
  // Azure otherwise.
  const RECORDABLE_LANGS = ['bo', 'en'];
  function isSafeWordId(id) {
    return /^[a-zA-Z0-9_]{1,64}$/.test(id);
  }

  app.post('/api/admin/audio/:lang/:wordId', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    const incomingKey = req.headers['x-admin-key'];
    if (incomingKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized admin access.' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase Storage is not configured on this server yet.' });
    }
    const lang = req.params.lang;
    const wordId = req.params.wordId;
    if (!RECORDABLE_LANGS.includes(lang)) {
      return res.status(400).json({ error: 'Unsupported language.' });
    }
    if (!isSafeWordId(wordId)) {
      return res.status(400).json({ error: 'Invalid word id.' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No audio data received.' });
    }

    const { error } = await supabaseAdmin.storage
      .from(AUDIO_BUCKET)
      .upload(lang + '/' + wordId + '.webm', req.body, { contentType: 'audio/webm', upsert: true });
    if (error) {
      return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });
    }
    return res.json({ ok: true, wordId });
  });

  app.get('/api/admin/audio-status/:lang', async (req, res) => {
    const incomingKey = req.headers['x-admin-key'];
    if (incomingKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized admin access.' });
    }
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Supabase Storage is not configured on this server yet.' });
    }
    const lang = req.params.lang;
    if (!RECORDABLE_LANGS.includes(lang)) {
      return res.status(400).json({ error: 'Unsupported language.' });
    }

    let recorded = [];
    try {
      const { data, error } = await supabaseAdmin.storage.from(AUDIO_BUCKET).list(lang, { limit: 1000 });
      if (error) throw error;
      recorded = (data || [])
        .filter((f) => f.name.endsWith('.webm'))
        .map((f) => f.name.slice(0, -'.webm'.length));
    } catch (error) {
      recorded = [];
    }
    return res.json({ recorded });
  });

  app.use((req, res, next) => {
    const base = req.path;
    if (base === '/favicon.ico') return res.status(204).end();
    next();
  });

  app.listen = function listen(...args) {
    return express.application.listen.call(this, ...args);
  };

  return {
    app,
    PORT,
    DATA_FILE,
    ADMIN_KEY,
    DATABASE_URL,
    SUPABASE_URL,
    SUPABASE_PROJECT_URL,
    initDatabase,
    getDbClient,
    ensureAudioBucket,
  };
}

if (require.main === module) {
  const appState = createApp();
  const port = Number(process.env.PORT) || 3000;
  appState.ensureAudioBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: audio bucket ready.');
    else console.log('Supabase Storage not active for audio (' + bucketStatus.reason + ') — recordings would not persist.');
  });
  appState.initDatabase()
    .then((status) => {
      appState.app.listen(port, () => {
        if (status.connected) {
          console.log(`Yeshe backend running at http://localhost:${port} (Supabase connected)`);
        } else if (appState.DATABASE_URL) {
          console.log(`Yeshe backend running at http://localhost:${port} (Supabase configured but not ready — using file fallback)`);
        } else {
          console.log(`Yeshe backend running at http://localhost:${port} (file storage — set DATABASE_URL for Supabase)`);
        }
      });
    })
    .catch((error) => {
      console.error('Database init failed:', error.message);
      appState.app.listen(port, () => {
        console.log(`Yeshe backend running at http://localhost:${port} (JSON fallback mode)`);
      });
    });
}

module.exports = { createApp };
