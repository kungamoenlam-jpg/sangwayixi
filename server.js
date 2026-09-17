require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

function hashPassword(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomLetters(n) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

// Matches the client-side username character rule (see errUsernameChars in
// index.html) — used here to keep usernames safe as Storage path segments.
function isSafeUsername(username) {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(String(username || ''));
}

// ---- character avatars: DiceBear's open-source "Avataaars" style (MIT
// licensed, api.dicebear.com) — illustrated human-like characters, not
// photorealistic, not AI-generated per-user. Every option here is copied
// straight from that style's published schema (api.dicebear.com/9.x/
// avataaars/schema.json) and whitelisted server-side so a client can't stuff
// arbitrary strings into a query string sent to a third party. ----
const AVATAAAR_OPTIONS = {
  top: ['hat','hijab','turban','winterHat1','winterHat02','winterHat03','winterHat04','bob','bun','curly','curvy','dreads','frida','fro','froBand','longButNotTooLong','miaWallace','shavedSides','straight02','straight01','straightAndStrand','dreads01','dreads02','frizzle','shaggy','shaggyMullet','shortCurly','shortFlat','shortRound','shortWaved','sides','theCaesar','theCaesarAndSidePart','bigHair'],
  hairColor: ['a55728','2c1b18','b58143','d6b370','724133','4a312c','f59797','ecdcbf','c93305','e8e1e1'],
  skinColor: ['614335','d08b5b','ae5d29','edb98a','ffdbb4','fd9841','f8d25c'],
  eyes: ['closed','cry','default','eyeRoll','happy','hearts','side','squint','surprised','winkWacky','wink','xDizzy'],
  eyebrows: ['angryNatural','defaultNatural','flatNatural','frownNatural','raisedExcitedNatural','sadConcernedNatural','unibrowNatural','upDownNatural','angry','default','raisedExcited','sadConcerned','upDown'],
  mouth: ['concerned','default','disbelief','eating','grimace','sad','screamOpen','serious','smile','tongue','twinkle','vomit'],
  facialHair: ['none','beardLight','beardMajestic','beardMedium','moustacheFancy','moustacheMagnum'],
  accessories: ['none','kurt','prescription01','prescription02','round','sunglasses','wayfarers','eyepatch'],
  clothing: ['blazerAndShirt','blazerAndSweater','collarAndSweater','graphicShirt','hoodie','overall','shirtCrewNeck','shirtScoopNeck','shirtVNeck'],
  clothesColor: ['262e33','65c9ff','5199e4','25557c','e6e6e6','929598','3c4f5c','b1e2ff','a7ffc4','ffafb9','ffffb1','ff488e','ff5c5c','ffffff'],
  backgroundColor: ['e8a33d','3fae72','e1584b','3d6fb4','b08ae0','4fb4d8','c94e86','8b95a6'],
};
const AVATAAAR_DEFAULTS = {
  top: 'shortFlat', hairColor: '4a312c', skinColor: 'edb98a', eyes: 'default', eyebrows: 'default',
  mouth: 'default', facialHair: 'none', accessories: 'none', clothing: 'hoodie', clothesColor: '65c9ff', backgroundColor: 'e8a33d',
};
function validateAvataaar(options) {
  const src = (options && typeof options === 'object') ? options : {};
  const result = {};
  for (const [key, allowed] of Object.entries(AVATAAAR_OPTIONS)) {
    result[key] = allowed.includes(src[key]) ? src[key] : AVATAAAR_DEFAULTS[key];
  }
  return result;
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

  // ---- Stripe: Premium subscription (unlocks levels 6-15) ---------------------
  // Two regional monthly prices, auto-created on startup so there's no manual
  // dashboard clicking to get the price IDs right — same self-bootstrap
  // philosophy as the `create table if not exists` below.
  // 'us' targets everyone outside China/Tibet (USD); 'cn' is a discounted CNY
  // price for users there, self-selected on the paywall screen (no IP
  // geolocation — see the paywall UI). Actual acceptance of CNY-friendly
  // payment methods (Alipay/WeChat Pay) depends on Stripe's private-preview
  // approval for recurring payments on those methods; plain card payments
  // always work via Checkout regardless.
  //
  // Stripe Checkout's own UI chrome (buttons, field labels, T&Cs) can be
  // localized via the `locale` param, but Stripe has no Tibetan locale — the
  // supported list tops out at zh/zh-HK/zh-TW for Chinese, nothing for bo.
  // 'zh' is used for both zh and bo app-language users as the closest
  // comprehensible option. What IS fully controllable regardless of Stripe's
  // locale support is the product name/description, which actually says what
  // you're buying — so there's a separate Product per app language (not just
  // per region), each with its own translated name/description, sharing the
  // same underlying regional prices.
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || null;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
  const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.kunga.me';
  const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
  const STRIPE_PRODUCT_METADATA_KEY = 'yeshe_premium';
  const SUBSCRIPTION_PLANS = {
    us: { currency: 'usd', amount: 100, label: '$1.00 / month' },
    cn: { currency: 'cny', amount: 500, label: '¥5.00 / month' },
  };
  const PRODUCT_TRANSLATIONS = {
    en: {
      name: 'Yeshe Premium',
      description: 'Unlocks the full 15-level Yeshe route (Daily Life Trail through Summit of Fluency).',
    },
    zh: {
      name: 'Yeshe 高级版',
      description: '解锁完整的15级Yeshe学习路线（从日常生活之路到流利之巅）。',
    },
    bo: {
      name: 'Yeshe མཐོ་རིམ།',
      description: 'Yeshe ཡི་ཚན་པ་15 ཧྲིལ་པོའི་ལམ་ཁ་ཕྱེ་ཐུབ། (བརྗོད་གཞིའི་ལམ་ནས་ཤིན་ཏུ་མཁས་པའི་རྩེ་མོ་བར།)',
    },
  };
  const STRIPE_CHECKOUT_LOCALE = { en: 'en', zh: 'zh', bo: 'zh' };
  // stripePriceIds.en.us, stripePriceIds.zh.cn, etc.
  let stripePriceIds = { en: {}, zh: {}, bo: {} };
  let stripeReady = false;

  async function ensureStripeProduct() {
    if (!stripe) return { ok: false, reason: 'not-configured' };
    try {
      for (const [lang, text] of Object.entries(PRODUCT_TRANSLATIONS)) {
        const products = await stripe.products.search({
          query: `metadata['app']:'${STRIPE_PRODUCT_METADATA_KEY}' AND metadata['lang']:'${lang}'`,
        });
        let product = products.data[0];
        if (!product) {
          product = await stripe.products.create({
            name: text.name,
            description: text.description,
            metadata: { app: STRIPE_PRODUCT_METADATA_KEY, lang },
          });
        }

        for (const [region, plan] of Object.entries(SUBSCRIPTION_PLANS)) {
          const prices = await stripe.prices.search({
            query: `product:'${product.id}' AND metadata['region']:'${region}' AND active:'true'`,
          });
          let price = prices.data[0];
          if (!price) {
            price = await stripe.prices.create({
              product: product.id,
              currency: plan.currency,
              unit_amount: plan.amount,
              recurring: { interval: 'month' },
              metadata: { region, lang },
            });
          }
          stripePriceIds[lang][region] = price.id;
        }
      }

      stripeReady = true;
      return { ok: true, priceIds: stripePriceIds };
    } catch (error) {
      stripeReady = false;
      return { ok: false, reason: error.message };
    }
  }

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
  const AVATAR_BUCKET = 'avatars';
  const supabaseAdmin = (SUPABASE_PROJECT_URL && SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(SUPABASE_PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

  async function ensureBucket(name) {
    if (!supabaseAdmin) return { ok: false, reason: 'not-configured' };
    try {
      const { data: existing } = await supabaseAdmin.storage.getBucket(name);
      if (!existing) {
        const { error } = await supabaseAdmin.storage.createBucket(name, { public: true });
        if (error && !/already exists/i.test(error.message || '')) throw error;
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }
  const ensureAudioBucket = () => ensureBucket(AUDIO_BUCKET);
  const ensureAvatarBucket = () => ensureBucket(AVATAR_BUCKET);

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
    await client.query(`
      alter table public.users
        add column if not exists stripe_customer_id text,
        add column if not exists subscription_status text,
        add column if not exists subscription_plan text,
        add column if not exists subscription_period_end timestamptz,
        add column if not exists avatar jsonb;
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
      subscription: sanitizeSubscription(user),
      avatar: sanitizeAvatar(user),
    };
  }

  // The avatar column is a single jsonb blob: {type:'avataaar', options:{...}}
  // or {type:'photo', updatedAt}. Photo bytes live in Supabase Storage, not
  // here — updatedAt is just a cache-busting query param for the <img> src.
  function sanitizeAvatar(user) {
    const raw = user.avatar || null;
    if (!raw || !raw.type) return { type: null, options: null, updatedAt: null };
    if (raw.type === 'avataaar') {
      return { type: 'avataaar', options: validateAvataaar(raw.options), updatedAt: raw.updatedAt || null };
    }
    if (raw.type === 'photo') {
      return { type: 'photo', options: null, updatedAt: raw.updatedAt || null };
    }
    return { type: null, options: null, updatedAt: null };
  }

  function sanitizeSubscription(user) {
    const status = user.subscription_status || user.subscriptionStatus || null;
    return {
      active: status === 'active' || status === 'trialing',
      status,
      plan: user.subscription_plan || user.subscriptionPlan || null,
      periodEnd: user.subscription_period_end || user.subscriptionPeriodEnd || null,
    };
  }

  // Looks a user up by username, returning the raw DB row / file record (not
  // sanitized) so callers can read/write subscription_* fields directly.
  async function findUserByUsername(username) {
    const trimmed = String(username || '').trim().toLowerCase();
    if (!trimmed) return null;
    const client = await getDbClient();
    if (client) {
      const result = await client.query('select * from public.users where lower(username) = $1', [trimmed]);
      return result.rows[0] || null;
    }
    const users = readUsers();
    return users.find((u) => String(u.username || '').trim().toLowerCase() === trimmed) || null;
  }

  async function findUserByStripeCustomerId(customerId) {
    if (!customerId) return null;
    const client = await getDbClient();
    if (client) {
      const result = await client.query('select * from public.users where stripe_customer_id = $1', [customerId]);
      return result.rows[0] || null;
    }
    const users = readUsers();
    return users.find((u) => u.stripe_customer_id === customerId) || null;
  }

  async function updateUserSubscription(userId, fields) {
    const client = await getDbClient();
    if (client) {
      await client.query(
        `update public.users set
           stripe_customer_id = coalesce($2, stripe_customer_id),
           subscription_status = coalesce($3, subscription_status),
           subscription_plan = coalesce($4, subscription_plan),
           subscription_period_end = coalesce($5, subscription_period_end)
         where id = $1`,
        [userId, fields.stripeCustomerId || null, fields.status || null, fields.plan || null, fields.periodEnd || null]
      );
      return;
    }
    const users = readUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) return;
    if (fields.stripeCustomerId) users[idx].stripe_customer_id = fields.stripeCustomerId;
    if (fields.status) users[idx].subscription_status = fields.status;
    if (fields.plan) users[idx].subscription_plan = fields.plan;
    if (fields.periodEnd) users[idx].subscription_period_end = fields.periodEnd;
    writeUsers(users);
  }

  async function updateUserAvatar(userId, avatar) {
    const client = await getDbClient();
    if (client) {
      await client.query('update public.users set avatar = $2 where id = $1', [userId, JSON.stringify(avatar)]);
      return;
    }
    const users = readUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) return;
    users[idx].avatar = avatar;
    writeUsers(users);
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

  // Stripe webhook needs the raw request body to verify the signature, so it
  // must be registered (with its own raw-body parser) before the global
  // express.json() below, which would otherwise consume and parse it first.
  app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ error: 'Stripe webhook is not configured on this server yet.' });
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (error) {
      return res.status(400).json({ error: 'Webhook signature verification failed.', details: error.message });
    }

    // As of API version 2025-03-31.basil, current_period_end moved off the
    // Subscription object onto each Subscription Item (a subscription can now
    // have items on different billing periods). Read from the first item, with
    // a fallback to the old top-level field for older API versions.
    function subscriptionPeriodEnd(subscription) {
      const itemEnd = subscription.items && subscription.items.data[0] && subscription.items.data[0].current_period_end;
      const end = itemEnd || subscription.current_period_end;
      return end ? new Date(end * 1000).toISOString() : null;
    }

    // Shared by checkout.session.completed and .async_payment_succeeded: some
    // payment methods (e.g. bank debits) settle after the session "completes",
    // so `completed` alone isn't proof of payment — payment_status is. See
    // https://docs.stripe.com/checkout/fulfillment.md.
    async function activateFromSession(session) {
      if (session.payment_status === 'unpaid') return;
      const username = session.client_reference_id;
      const user = username ? await findUserByUsername(username) : null;
      if (!user) return;
      const subscription = session.subscription
        ? await stripe.subscriptions.retrieve(session.subscription)
        : null;
      await updateUserSubscription(user.id, {
        stripeCustomerId: session.customer,
        status: subscription ? subscription.status : 'active',
        plan: session.metadata && session.metadata.region,
        periodEnd: subscription ? subscriptionPeriodEnd(subscription) : null,
      });
    }

    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        await activateFromSession(event.data.object);
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const user = await findUserByStripeCustomerId(subscription.customer);
        if (user) {
          await updateUserSubscription(user.id, {
            status: subscription.status,
            periodEnd: subscriptionPeriodEnd(subscription),
          });
        }
      } else if (event.type === 'invoice.payment_failed') {
        // The subscription's own status (past_due, unpaid, etc.) already comes
        // through as a separate customer.subscription.updated event — this
        // handler exists so a failed renewal is never silently unhandled.
        const invoice = event.data.object;
        const user = await findUserByStripeCustomerId(invoice.customer);
        if (user) console.log('Subscription renewal payment failed for user', user.username);
      }
      return res.json({ received: true });
    } catch (error) {
      console.error('Webhook handling failed for event', event.type, error);
      return res.status(500).json({ error: 'Webhook handling failed.', details: error.message });
    }
  });

  app.use(express.json({ limit: '1mb' }));
  // Recorded audio lives in Supabase Storage now (see the incident note above),
  // not on local disk — this just redirects to the bucket's public URL so
  // existing client code (<audio src="/audio/<lang>/<id>.webm">) keeps working.
  app.get('/audio/:lang/:file', (req, res) => {
    if (!supabaseAdmin) return res.status(503).end();
    const { data } = supabaseAdmin.storage.from(AUDIO_BUCKET).getPublicUrl(req.params.lang + '/' + req.params.file);
    return res.redirect(302, data.publicUrl);
  });
  // Same redirect-to-Storage pattern as /audio above, for user-uploaded
  // profile photos. 404s (rather than redirecting to a broken image) when the
  // user has no photo avatar, so <img onerror> can fall back cleanly.
  app.get('/avatar/:username', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).end();
    const username = req.params.username;
    if (!isSafeUsername(username)) return res.status(400).end();
    const user = await findUserByUsername(username);
    if (!user || !user.avatar || user.avatar.type !== 'photo') return res.status(404).end();
    const { data } = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(username.toLowerCase() + '.jpg');
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

  // ---- Stripe Premium subscription: checkout + status ------------------------
  app.post('/api/create-checkout-session', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const { username, region } = req.body || {};
    const lang = STRIPE_CHECKOUT_LOCALE[req.body && req.body.lang] ? req.body.lang : 'en';
    if (!SUBSCRIPTION_PLANS[region]) {
      return res.status(400).json({ error: 'Unknown region. Use "us" or "cn".' });
    }
    if (!stripeReady) await ensureStripeProduct();
    const priceId = stripePriceIds[lang] && stripePriceIds[lang][region];
    if (!priceId) {
      return res.status(503).json({ error: 'Stripe product/price setup has not completed yet. Try again shortly.' });
    }

    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    try {
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email || undefined,
          name: user.full_name || user.username,
          metadata: { username: user.username },
        });
        customerId = customer.id;
        await updateUserSubscription(user.id, { stripeCustomerId: customerId });
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: user.username,
        line_items: [{ price: priceId, quantity: 1 }],
        locale: STRIPE_CHECKOUT_LOCALE[lang],
        metadata: { region, lang, username: user.username },
        subscription_data: { metadata: { region, lang, username: user.username } },
        success_url: `${APP_BASE_URL}/?checkout=success`,
        cancel_url: `${APP_BASE_URL}/?checkout=cancel`,
        // Labels this flow in the Dashboard's Checkout analytics — 8 random
        // letters per Stripe's current tagging convention.
        integration_identifier: 'yeshepremium' + randomLetters(8),
      });

      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: 'Could not start checkout.', details: error.message });
    }
  });

  app.get('/api/subscription-status', async (req, res) => {
    const username = String(req.query.username || '');
    const user = await findUserByUsername(username);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    return res.json({ subscription: sanitizeSubscription(user), avatar: sanitizeAvatar(user) });
  });

  // ---- avatars: mascot (JSON config) or photo (uploaded image) ---------------
  app.post('/api/avatar/character', async (req, res) => {
    const { username, options } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const avatar = { type: 'avataaar', options: validateAvataaar(options), updatedAt: new Date().toISOString() };
    await updateUserAvatar(user.id, avatar);
    return res.json({ avatar });
  });

  app.post('/api/avatar/photo/:username', express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
    const username = req.params.username;
    if (!isSafeUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Photo storage is not configured on this server yet.' });
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No image data received.' });
    }

    const { error } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .upload(username.toLowerCase() + '.jpg', req.body, { contentType: 'image/jpeg', upsert: true });
    if (error) return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });

    const avatar = { type: 'photo', mascot: null, updatedAt: new Date().toISOString() };
    await updateUserAvatar(user.id, avatar);
    return res.json({ avatar });
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
    ensureAvatarBucket,
    ensureStripeProduct,
  };
}

if (require.main === module) {
  const appState = createApp();
  const port = Number(process.env.PORT) || 3000;
  appState.ensureAudioBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: audio bucket ready.');
    else console.log('Supabase Storage not active for audio (' + bucketStatus.reason + ') — recordings would not persist.');
  });
  appState.ensureAvatarBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: avatars bucket ready.');
    else console.log('Supabase Storage not active for avatars (' + bucketStatus.reason + ') — photo avatars would not persist.');
  });
  appState.ensureStripeProduct().then((stripeStatus) => {
    if (stripeStatus.ok) console.log('Stripe: Premium product/prices ready.');
    else console.log('Stripe not active (' + stripeStatus.reason + ') — subscriptions disabled until STRIPE_SECRET_KEY is set.');
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
