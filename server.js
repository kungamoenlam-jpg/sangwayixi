const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

function createApp(overrides = {}) {
  const app = express();
  const PORT = overrides.port || Number(process.env.PORT) || 3000;
  const DATA_FILE = overrides.dataFile || path.join(__dirname, 'data', 'users.json');
  const ADMIN_KEY = overrides.adminKey || process.env.ADMIN_KEY || 'sangwa-admin-key';

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
      name: user.name || '',
      username: user.username || '',
      createdAt: user.createdAt,
    };
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(__dirname));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.post('/api/signup', (req, res) => {
    const { email, password, name, username } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const trimmedEmail = String(email).trim().toLowerCase();
    const trimmedPassword = String(password).trim();

    if (!trimmedEmail || !trimmedPassword) {
      return res.status(400).json({ error: 'Email and password cannot be empty.' });
    }

    const users = readUsers();
    const existing = users.find((user) => user.email === trimmedEmail);
    if (existing) {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }

    const newUser = {
      id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      email: trimmedEmail,
      password: trimmedPassword,
      name: String(name || '').trim(),
      username: String(username || '').trim() || trimmedEmail.split('@')[0],
      createdAt: new Date().toISOString(),
    };

    users.push(newUser);
    writeUsers(users);

    return res.status(201).json({
      message: 'Account created successfully.',
      user: sanitizeUser(newUser),
    });
  });

  app.post('/api/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const users = readUsers();
    const user = users.find(
      (entry) => entry.email === String(email).trim().toLowerCase() && entry.password === String(password).trim()
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    return res.json({
      message: 'Login successful.',
      user: sanitizeUser(user),
    });
  });

  app.get('/api/admin/users', (req, res) => {
    const incomingKey = req.headers['x-admin-key'];
    if (incomingKey !== ADMIN_KEY) {
      return res.status(401).json({ error: 'Unauthorized admin access.' });
    }

    const users = readUsers().map(sanitizeUser);
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

  return { app, PORT, DATA_FILE, ADMIN_KEY };
}

if (require.main === module) {
  const { app } = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Sangwa backend running at http://localhost:${port}`);
  });
}

module.exports = { createApp };
