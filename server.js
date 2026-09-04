require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');

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
    initDatabase,
    getDbClient,
  };
}

if (require.main === module) {
  const appState = createApp();
  const port = Number(process.env.PORT) || 3000;
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
