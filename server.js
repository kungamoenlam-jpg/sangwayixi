require('dotenv').config();

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { createAvatar } = require('@dicebear/core');
const { avataaars } = require('@dicebear/collection');
const sanitizeHtml = require('sanitize-html');

// Safety net: an Express async route handler that throws without its own
// try/catch produces a genuinely unhandled promise rejection at the Node
// process level (Express does not await or catch what an async handler
// returns), and Node's default since v15 is to crash the whole process on
// one of those -- taking down every route, not just the one that threw.
// That's exactly what happened in production from a single query against a
// column a migration had failed to actually add: one request to the
// booking API crashed the entire server, including completely unrelated
// routes like the store and the message inbox, until Render restarted it.
// Logging and surviving here isn't a substitute for fixing the real bug
// each time, but it stops one broken endpoint from being a whole-site
// outage while that fix lands.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (request may have failed, but the server is staying up):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (server is staying up):', error);
});

function hashPassword(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Diary entries are rich HTML straight from notebook.html's contenteditable
// page (the same editor used for notes -- bold/lists/tables/MathML equations,
// occasionally pasted content from elsewhere). Entries marked public end up
// rendered, unauthenticated, to any visitor of /diary, so this allowlist runs
// on every save (not just public ones, so nothing risky sits dormant waiting
// for a later public toggle) rather than trusting the editor's own paste
// handling to have kept things clean.
const DIARY_ALLOWED_TAGS = ['div','p','br','b','strong','i','em','u','s','strike','ul','ol','li','h1','h2','span','sub','sup',
  'table','tbody','thead','tr','td','th','blockquote','img',
  'math','mi','mn','mo','mrow','msub','msup','msubsup','mfrac','msqrt','mroot','munder','mover','munderover','mspace','mtext','mstyle','mtable','mtr','mtd'];
function sanitizeDiaryHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: DIARY_ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['style', 'class'],
      img: ['src', 'alt', 'style'],
      span: ['data-src', 'data-scale', 'style', 'class'],
      math: ['xmlns'],
    },
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^[a-zA-Z]+$/],
        'background-color': [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(/, /^[a-zA-Z]+$/],
        'font-weight': [/^\d+$/, /^[a-zA-Z]+$/],
        'font-style': [/^[a-zA-Z]+$/],
        'text-align': [/^[a-zA-Z]+$/],
        'text-decoration': [/^[a-zA-Z]+$/],
        'font-size': [/^[\d.]+(px|em|%)$/],
        'border-radius': [/^[\d.]+px$/],
        display: [/^[a-zA-Z]+$/],
        margin: [/^[\d.]+(px|em)?(\s[\d.]+(px|em)?)*$/],
        width: [/^[\d.]+(px|%)$/],
        height: [/^[\d.]+(px|%)$/],
      },
    },
  });
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
  clothing: ['blazerAndShirt','blazerAndSweater','collarAndSweater','graphicShirt','hoodie','overall','shirtCrewNeck','shirtScoopNeck','shirtVNeck','tibetanChuba','tibetanDress','monkRobe'],
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

// DiceBear's Avataaars collection has no Tibetan garments, so these three
// ('tibetanChuba', 'tibetanDress', 'monkRobe') are hand-drawn flat-vector
// fragments layered in as a post-processing step (see applyTibetanClothing
// below) rather than real DiceBear options — matching the same bounding box
// (x:32-232, y:0-110) every built-in clothing shape uses inside the
// `translate(0 170)` group, so they sit correctly under the neck.
const TIBETAN_CLOTHING_BASE = 'M104 29a72 72 0 0 0-72 72v9h200v-9a72 72 0 0 0-72-72Z';
const TIBETAN_CLOTHING_FRAGMENTS = {
  tibetanChuba: (color) => `
    <path d="${TIBETAN_CLOTHING_BASE}" fill="${color}"/>
    <path d="M132 29 100 58l10 52h20l8-52Z" fill="#000" fill-opacity=".12"/>
    <path d="M118 29q14 10 28 0l-6 22h-16Z" fill="#f4f0e6"/>
    <path d="M32 46h200v16H32Z" fill="#c1440e"/>
    <path d="M32 48h200v2.5H32Z" fill="#f4f0e6"/>
    <path d="M32 59.5h200v2.5H32Z" fill="#f4f0e6"/>
    <path d="M119 46v16h26V46Z" fill="#8a2f1c"/>
  `,
  tibetanDress: (color) => {
    const stripeColors = ['#7a1f2b', '#e8c34d', '#2d6e4e', '#c1440e', '#25557c', '#f4f0e6'];
    const x0 = 88, x1 = 176, y0 = 44, y1 = 110;
    const stripeW = (x1 - x0) / stripeColors.length;
    const stripes = stripeColors.map((c, i) =>
      `<rect x="${(x0 + i * stripeW).toFixed(1)}" y="${y0}" width="${stripeW.toFixed(1)}" height="${y1 - y0}" fill="${c}"/>`
    ).join('');
    return `
      <path d="${TIBETAN_CLOTHING_BASE}" fill="${color}"/>
      <path d="M132 29 108 60l8 50h32l8-50Z" fill="#000" fill-opacity=".1"/>
      <g clip-path="url(#tibetanApronClip)">${stripes}</g>
      <defs><clipPath id="tibetanApronClip"><path d="M88 44h88v46a44 44 0 0 1-88 0Z"/></clipPath></defs>
      <rect x="84" y="41" width="96" height="7" rx="1.5" fill="#3a1f1a"/>
    `;
  },
  monkRobe: (color) => `
    <path d="${TIBETAN_CLOTHING_BASE}" fill="${color}"/>
    <path d="M108 29 76 60v50h20l14-58Z" fill="#000" fill-opacity=".12"/>
    <path d="M96 29 26 52l10 24 84-32Z" fill="#e8a33d"/>
    <path d="M70 44 26 52l10 24 15-6-9-16Z" fill="#000" fill-opacity=".1"/>
    <path d="M96 29 26 52l10 24 7-3-9-17 70-27Z" fill="#000" fill-opacity=".08"/>
  `,
};
function applyTibetanClothing(svg, clothingKey, color) {
  const build = TIBETAN_CLOTHING_FRAGMENTS[clothingKey];
  if (!build) return svg;
  const marker = '<g transform="translate(0 170)">';
  const start = svg.indexOf(marker);
  if (start === -1) return svg;
  const contentStart = start + marker.length;
  const end = svg.indexOf('</g>', contentStart) + 4;
  return svg.slice(0, contentStart) + build(color) + '</g>' + svg.slice(end);
}

// Renders avatars with the @dicebear/collection package directly, in-process
// — no network call to api.dicebear.com. Two reasons: (1) that public API
// rate-limits bursts, which broke the picker UI when it tried to load ~94
// option thumbnails at once (Chrome reported ERR_BLOCKED_BY_ORB); (2) this
// app's audience is disproportionately in China/Tibet, where reaching some
// arbitrary Western API from every end user's browser is a real reliability
// risk that rendering server-side and serving from our own domain avoids
// entirely. Cache is in-memory and unbounded — the whole combinatorial space
// in practice is small (the 94 fixed picker thumbnails plus whatever actual
// users pick), and it resets harmlessly on restart since regenerating is
// cheap CPU work, not a network call.
const avatarSvgCache = new Map();
function renderAvataaarSvg(traits, extra) {
  const validated = validateAvataaar(traits);
  const params = Object.assign({}, validated, extra || {});
  if (validated.facialHair === 'none') { delete params.facialHair; params.facialHairProbability = 0; }
  else { params.facialHairProbability = 100; }
  if (validated.accessories === 'none') { delete params.accessories; params.accessoriesProbability = 0; }
  else { params.accessoriesProbability = 100; }

  const cacheKey = JSON.stringify(params);
  const cached = avatarSvgCache.get(cacheKey);
  if (cached) return cached;
  // @dicebear/core's OptionsSchema expects every field as an array (it picks
  // one entry per the seed). A bare string like 'e8a33d' also satisfies
  // JS's "is it iterable" check — strings are iterable character-by-character
  // — so it silently iterates the string and picks a single CHARACTER as the
  // "color" instead of erroring. Wrapping everything here is what avoids that.
  const customClothing = TIBETAN_CLOTHING_FRAGMENTS[validated.clothing];
  const dicebearParams = Object.assign({}, params);
  if (customClothing) dicebearParams.clothing = 'shirtCrewNeck';
  const arrayParams = {};
  for (const [key, val] of Object.entries(dicebearParams)) arrayParams[key] = [val];
  let svg = createAvatar(avataaars, arrayParams).toString();
  if (customClothing) svg = applyTibetanClothing(svg, validated.clothing, '#' + validated.clothesColor);
  avatarSvgCache.set(cacheKey, svg);
  return svg;
}

function createApp(overrides = {}) {
  const app = express();
  const PORT = overrides.port || Number(process.env.PORT) || 3000;
  const DATA_FILE = overrides.dataFile || path.join(__dirname, 'data', 'users.json');
  const CERTS_FILE = overrides.certsFile || path.join(__dirname, 'data', 'certificates.json');
  const NEWS_FILE = overrides.newsFile || path.join(__dirname, 'data', 'news.json');
  const BOOKINGS_FILE = overrides.bookingsFile || path.join(__dirname, 'data', 'bookings.json');
  const STORE_PRODUCTS_FILE = overrides.storeProductsFile || path.join(__dirname, 'data', 'store-products.json');
  const STORE_ORDERS_FILE = overrides.storeOrdersFile || path.join(__dirname, 'data', 'store-orders.json');
  const MESSAGES_FILE = overrides.messagesFile || path.join(__dirname, 'data', 'messages.json');
  const CLIPS_FILE = overrides.clipsFile || path.join(__dirname, 'data', 'clips.json');
  const ADMIN_KEY = overrides.adminKey || process.env.ADMIN_KEY || 'sangwa-admin-key';
  const DATABASE_URL = overrides.databaseUrl || process.env.DATABASE_URL || null;
  const SUPABASE_URL = process.env.SUPABASE_URL || null;
  const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || null;
  const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || null;
  const TTS_CACHE_DIR = overrides.ttsCacheDir || path.join(__dirname, 'data', 'tts-cache');
  // "Kunga's Diary" (notebook.html): the one account whose entries marked
  // public are served, unauthenticated, from /diary and /api/diary/public.
  // Hardcoded to a single owner (not every notebook user) by design.
  const DIARY_OWNER_USERNAME = overrides.diaryOwnerUsername || process.env.DIARY_OWNER_USERNAME || 'kunga';

  // ---- Stripe: Premium subscription (unlocks the final 2 levels: Frontier of
  // Science and Summit of Fluency) --------------------------------------------
  // Deliberately narrow for now — growth strategy is free-almost-everything
  // until the user base clears ~3000, then widen the paywall back out. See
  // the `paid:true` flags on LEVELS in index.html for what's actually locked.
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
      description: 'Unlocks the final two levels of the Yeshe route: Frontier of Science and Summit of Fluency.',
    },
    zh: {
      name: 'Yeshe 高级版',
      description: '解锁Yeshe学习路线的最后两关：「科学前沿」和「流利之巅」。',
    },
    bo: {
      name: 'Yeshe མཐོ་རིམ།',
      description: 'Yeshe ཡི་ལམ་ཁའི་མཐའ་མའི་ཚན་པ་གཉིས་ཁ་ཕྱེ་ཐུབ། ཚན་པ 14 དང 15།',
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
        } else if (product.name !== text.name || product.description !== text.description) {
          // Keep an already-created product's copy in sync with the code —
          // otherwise editing PRODUCT_TRANSLATIONS here would silently do
          // nothing once the product exists, since it's only ever created
          // once above.
          product = await stripe.products.update(product.id, {
            name: text.name,
            description: text.description,
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

  // Kunga's Diary archive: a second, independent Stripe subscription (weekly,
  // flat $1 — no regional pricing like Premium above, since this wasn't asked
  // for) that unlocks entries older than the free preview window. Kept as its
  // own product/price/customer-subscription rather than folding into Premium,
  // since the user explicitly wants it billed separately.
  const DIARY_PRODUCT_METADATA_KEY = 'yeshe_diary';
  const BOOKING_PRODUCT_METADATA_KEY = 'yeshe_call_booking';
  const STORE_PRODUCT_METADATA_KEY = 'yeshe_store';
  let diaryPriceId = null;
  let diaryStripeReady = false;

  async function ensureDiaryStripeProduct() {
    if (!stripe) return { ok: false, reason: 'not-configured' };
    try {
      const products = await stripe.products.search({
        query: `metadata['app']:'${DIARY_PRODUCT_METADATA_KEY}'`,
      });
      let product = products.data[0];
      if (!product) {
        product = await stripe.products.create({
          name: "Kunga's Diary — full archive",
          description: "Weekly access to every past entry of Kunga's Diary, not just the last 5 days.",
          metadata: { app: DIARY_PRODUCT_METADATA_KEY },
        });
      }
      const prices = await stripe.prices.search({
        query: `product:'${product.id}' AND active:'true'`,
      });
      let price = prices.data[0];
      if (!price) {
        price = await stripe.prices.create({
          product: product.id,
          currency: 'usd',
          unit_amount: 100,
          recurring: { interval: 'week' },
          metadata: { app: DIARY_PRODUCT_METADATA_KEY },
        });
      }
      diaryPriceId = price.id;
      diaryStripeReady = true;
      return { ok: true, priceId: diaryPriceId };
    } catch (error) {
      diaryStripeReady = false;
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
  const NEWS_BUCKET = 'news-photos';
  const STORE_BUCKET = 'store-photos';
  const CLIPS_BUCKET = 'clips';
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
  const ensureNewsBucket = () => ensureBucket(NEWS_BUCKET);
  const ensureStoreBucket = () => ensureBucket(STORE_BUCKET);
  const ensureClipsBucket = () => ensureBucket(CLIPS_BUCKET);

  // High-quality neural voices: British English + Beijing-standard Mandarin, one
  // male and one female each. Mandarin uses Azure's newer "Multilingual" neural
  // voices (same Xiaoxiao/Yunxi personas, a more natural-sounding successor
  // model) — see AZURE_VOICE_FALLBACK below for what happens if a region
  // doesn't yet serve them. See https://learn.microsoft.com/azure/ai-services/speech-service/language-support
  const AZURE_VOICES = {
    en: { female: 'en-GB-SoniaNeural', male: 'en-GB-RyanNeural' },
    zh: { female: 'zh-CN-XiaoxiaoMultilingualNeural', male: 'zh-CN-YunxiMultilingualNeural' },
  };
  // Multilingual voices aren't guaranteed available in every Azure Speech
  // region yet. If the primary voice request fails, retry once with the
  // classic standard-neural voice it's paired with so TTS never breaks.
  const AZURE_VOICE_FALLBACK = {
    'zh-CN-XiaoxiaoMultilingualNeural': 'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunxiMultilingualNeural': 'zh-CN-YunxiNeural',
  };
  // 24kHz/160kbps instead of the previous 16kHz/64kbps — the old format's low
  // sample rate and heavy compression were the main source of the "unclear,
  // robotic" sound users reported, independent of which voice model is used.
  const AZURE_TTS_FORMAT = 'audio-24khz-160kbitrate-mono-mp3';

  let dbClient = null;
  let databaseReady = false;
  // Guards against retrying a dead connection on every request: once a
  // connect() attempt has failed, dbClient stays null but we stop trying
  // again, since re-attempting a hung DNS lookup (e.g. Supabase briefly
  // unreachable) on every single request would otherwise make each of
  // those requests hang for as long as that lookup takes, one at a time,
  // instead of failing fast into the file-storage fallback like intended.
  let dbConnectAttempted = false;
  let dbConnectError = null;

  function usesSupabase() {
    return Boolean(DATABASE_URL && DATABASE_URL.includes('supabase'));
  }

  async function getDbClient() {
    if (!DATABASE_URL) return null;
    if (dbConnectAttempted) return dbClient;
    dbConnectAttempted = true;
    try {
      const client = new Client({
        connectionString: DATABASE_URL,
        ssl: usesSupabase() ? { rejectUnauthorized: false } : undefined,
        // Without this, a stalled DNS lookup or unreachable host can leave
        // the very first connect() attempt hanging far longer than a normal
        // failure (minutes, not seconds) — which, since this same attempt
        // gates server startup, would leave the whole app unreachable for
        // that whole time instead of falling back to file storage quickly.
        connectionTimeoutMillis: 8000,
      });
      await client.connect();
      dbClient = client;
    } catch (error) {
      dbClient = null;
      dbConnectError = error;
    }
    return dbClient;
  }

  async function initDatabase() {
    const client = await getDbClient();
    if (!client) {
      databaseReady = false;
      if (dbConnectError) console.error('Database init failed:', dbConnectError.message);
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
        add column if not exists avatar jsonb,
        add column if not exists notebook jsonb,
        add column if not exists diary jsonb,
        add column if not exists diary_subscription_status text,
        add column if not exists diary_subscription_period_end timestamptz;
    `);
    await client.query(`
      create table if not exists public.speedmath_certificates (
        id serial primary key,
        username text not null,
        correct integer not null,
        wrong integer not null,
        duration_sec integer not null,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists public.daily_news (
        id serial primary key,
        username text not null,
        title text not null,
        body text not null,
        image_path text,
        image_mime text,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists public.call_bookings (
        id serial primary key,
        datetime timestamptz not null,
        duration_minutes integer not null,
        status text not null default 'open',
        checkout_session_id text,
        hold_expires_at timestamptz,
        booker_name text,
        booker_email text,
        booker_note text,
        created_at timestamptz default now()
      );
    `);
    // The table above already existed in production before call_type was
    // added, so "create table if not exists" silently no-ops on it and
    // never adds the new column -- same reason the users table's own
    // incrementally-added columns go through a separate alter table block
    // instead of being edited into its original create statement.
    await client.query(`
      alter table public.call_bookings
        add column if not exists call_type text;
    `);
    await client.query(`
      create table if not exists public.store_products (
        id serial primary key,
        name text not null,
        description text,
        price_cents integer not null,
        type text not null default 'physical',
        category text,
        variants jsonb default '[]'::jsonb,
        image_path text,
        image_mime text,
        active boolean not null default true,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists public.store_orders (
        id serial primary key,
        items jsonb not null,
        total_cents integer not null,
        buyer_name text,
        buyer_email text,
        has_physical boolean not null default false,
        shipping_name text,
        shipping_address jsonb,
        status text not null default 'pending',
        checkout_session_id text,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists public.messages (
        id serial primary key,
        text text not null,
        anonymous boolean not null default true,
        sender_name text,
        sender_email text,
        read boolean not null default false,
        created_at timestamptz default now()
      );
    `);
    await client.query(`
      create table if not exists public.clips (
        id serial primary key,
        username text not null,
        caption text,
        video_path text,
        video_mime text,
        thumb_path text,
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

  // Kept separate from sanitizeSubscription/updateUserSubscription above —
  // the diary archive is billed as its own weekly Stripe subscription on the
  // same customer, so conflating the two fields would let either purchase's
  // webhook events silently overwrite the other's status.
  function sanitizeDiarySubscription(user) {
    const status = user.diary_subscription_status || user.diarySubscriptionStatus || null;
    return {
      active: status === 'active' || status === 'trialing',
      status,
      periodEnd: user.diary_subscription_period_end || user.diarySubscriptionPeriodEnd || null,
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

  async function updateUserDiarySubscription(userId, fields) {
    const client = await getDbClient();
    if (client) {
      await client.query(
        `update public.users set
           diary_subscription_status = coalesce($2, diary_subscription_status),
           diary_subscription_period_end = coalesce($3, diary_subscription_period_end)
         where id = $1`,
        [userId, fields.status || null, fields.periodEnd || null]
      );
      return;
    }
    const users = readUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) return;
    if (fields.status) users[idx].diary_subscription_status = fields.status;
    if (fields.periodEnd) users[idx].diary_subscription_period_end = fields.periodEnd;
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

  // The notebook column is a single jsonb blob: { "<subject>_<week>": {html,
  // grid, minH, topic, status, strokes, t}, ... } — the same shape the
  // notebook page already keeps in its own localStorage, just mirrored here
  // so it follows the user across devices. Whole-blob read/write (not a
  // per-page table) keeps this simple; notebook.html merges by each page's
  // own `t` timestamp so this never has to reason about partial updates.
  async function updateUserNotebook(userId, notebook) {
    const client = await getDbClient();
    if (client) {
      await client.query('update public.users set notebook = $2 where id = $1', [userId, JSON.stringify(notebook)]);
      return;
    }
    const users = readUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) return;
    users[idx].notebook = notebook;
    writeUsers(users);
  }

  // The diary column: { entries: [{id,date,html,mood,public,t}], pinHash }.
  // Entries never leave the server in one undifferentiated blob the way
  // notebook pages do -- callers below always read/write through the
  // diary-specific endpoints so public and PIN-locked entries stay separated
  // at the point entries are selected for a response, not just in the UI.
  async function updateUserDiary(userId, diary) {
    const client = await getDbClient();
    if (client) {
      await client.query('update public.users set diary = $2 where id = $1', [userId, JSON.stringify(diary)]);
      return;
    }
    const users = readUsers();
    const idx = users.findIndex((u) => u.id === userId);
    if (idx === -1) return;
    users[idx].diary = diary;
    writeUsers(users);
  }

  // Speed Math certificates: a flat, append-only public record (not nested
  // under a user row like notebook/diary, since these need to be listable
  // and linkable by their own id regardless of who earned them) -- file mode
  // keeps its own incrementing counter since there's no serial column to
  // lean on outside Postgres.
  function ensureCertsFile() {
    const dir = path.dirname(CERTS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CERTS_FILE)) {
      fs.writeFileSync(CERTS_FILE, JSON.stringify({ nextId: 1, certificates: [] }, null, 2), 'utf8');
    }
  }
  function readCertsFile() {
    ensureCertsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(CERTS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, certificates: Array.isArray(parsed.certificates) ? parsed.certificates : [] };
    } catch (error) {
      return { nextId: 1, certificates: [] };
    }
  }
  function writeCertsFile(data) {
    ensureCertsFile();
    fs.writeFileSync(CERTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  async function createCertificate({ username, correct, wrong, durationSec }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        'insert into public.speedmath_certificates (username, correct, wrong, duration_sec, created_at) values ($1,$2,$3,$4,$5) returning id, username, correct, wrong, duration_sec as "durationSec", created_at as "createdAt"',
        [username, correct, wrong, durationSec, createdAt]
      );
      return result.rows[0];
    }
    const data = readCertsFile();
    const cert = { id: data.nextId, username, correct, wrong, durationSec, createdAt };
    data.certificates.push(cert);
    data.nextId += 1;
    writeCertsFile(data);
    return cert;
  }
  async function getCertificateById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'select id, username, correct, wrong, duration_sec as "durationSec", created_at as "createdAt" from public.speedmath_certificates where id = $1',
        [id]
      );
      return result.rows[0] || null;
    }
    const data = readCertsFile();
    return data.certificates.find((c) => c.id === id) || null;
  }
  async function listTopCertificates(durationSec, limit) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'select id, username, correct, wrong, duration_sec as "durationSec", created_at as "createdAt" from public.speedmath_certificates where duration_sec = $1 order by correct desc, created_at asc limit $2',
        [durationSec, limit]
      );
      return result.rows;
    }
    const data = readCertsFile();
    return data.certificates
      .filter((c) => c.durationSec === durationSec)
      .sort((a, b) => b.correct - a.correct || new Date(a.createdAt) - new Date(b.createdAt))
      .slice(0, limit);
  }

  // Daily News: any logged-in user can post a newspaper clipping (photo/PDF
  // for context + the exact text, typed by hand at submission time, since
  // OCR is unreliable for Tibetan and inconsistent for Mandarin). Same flat,
  // append-only, listable-by-id shape as the certificates above, plus an
  // optional Storage-backed image like avatars.
  function ensureNewsFile() {
    const dir = path.dirname(NEWS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(NEWS_FILE)) {
      fs.writeFileSync(NEWS_FILE, JSON.stringify({ nextId: 1, articles: [] }, null, 2), 'utf8');
    }
  }
  function readNewsFile() {
    ensureNewsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, articles: Array.isArray(parsed.articles) ? parsed.articles : [] };
    } catch (error) {
      return { nextId: 1, articles: [] };
    }
  }
  function writeNewsFile(data) {
    ensureNewsFile();
    fs.writeFileSync(NEWS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  async function createNewsArticle({ username, title, body }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        'insert into public.daily_news (username, title, body, created_at) values ($1,$2,$3,$4) returning id, username, title, body, image_path as "imagePath", image_mime as "imageMime", created_at as "createdAt"',
        [username, title, body, createdAt]
      );
      return result.rows[0];
    }
    const data = readNewsFile();
    const article = { id: data.nextId, username, title, body, imagePath: null, imageMime: null, createdAt };
    data.articles.push(article);
    data.nextId += 1;
    writeNewsFile(data);
    return article;
  }
  async function getNewsArticleById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'select id, username, title, body, image_path as "imagePath", image_mime as "imageMime", created_at as "createdAt" from public.daily_news where id = $1',
        [id]
      );
      return result.rows[0] || null;
    }
    const data = readNewsFile();
    return data.articles.find((a) => a.id === id) || null;
  }
  async function listNewsArticles(limit) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'select id, username, title, body, image_path as "imagePath", image_mime as "imageMime", created_at as "createdAt" from public.daily_news order by created_at desc limit $1',
        [limit]
      );
      return result.rows;
    }
    const data = readNewsFile();
    return data.articles.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
  }
  async function setNewsArticleImage(id, { imagePath, imageMime }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'update public.daily_news set image_path=$1, image_mime=$2 where id=$3 returning id, username, title, body, image_path as "imagePath", image_mime as "imageMime", created_at as "createdAt"',
        [imagePath, imageMime, id]
      );
      return result.rows[0] || null;
    }
    const data = readNewsFile();
    const article = data.articles.find((a) => a.id === id);
    if (!article) return null;
    article.imagePath = imagePath;
    article.imageMime = imageMime;
    writeNewsFile(data);
    return article;
  }
  async function deleteNewsArticle(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        'delete from public.daily_news where id=$1 returning image_path as "imagePath"',
        [id]
      );
      return result.rows[0] || null;
    }
    const data = readNewsFile();
    const idx = data.articles.findIndex((a) => a.id === id);
    if (idx === -1) return null;
    const [removed] = data.articles.splice(idx, 1);
    writeNewsFile(data);
    return { imagePath: removed.imagePath };
  }

  // Call booking calendar: kunga adds individual open slots from the admin
  // page; a visitor picks one, pays $50, and the slot is only ever marked
  // "booked" from the webhook once payment is confirmed -- never from the
  // checkout-creation step, since a created Checkout Session is no guarantee
  // anyone pays. Between those two points the slot sits "pending" (holding
  // it off the public list) with a short expiry so an abandoned checkout
  // doesn't permanently lock the slot; both the expired-session webhook AND
  // every write-time check below self-heal a stale pending hold back to
  // open, so a missed webhook can't strand a slot forever.
  function ensureBookingsFile() {
    const dir = path.dirname(BOOKINGS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(BOOKINGS_FILE)) {
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify({ nextId: 1, slots: [] }, null, 2), 'utf8');
    }
  }
  function readBookingsFile() {
    ensureBookingsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, slots: Array.isArray(parsed.slots) ? parsed.slots : [] };
    } catch (error) {
      return { nextId: 1, slots: [] };
    }
  }
  function writeBookingsFile(data) {
    ensureBookingsFile();
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  function slotIsAvailable(slot, nowIso) {
    return slot.status === 'open' || (slot.status === 'pending' && slot.holdExpiresAt && slot.holdExpiresAt < nowIso);
  }
  const BOOKING_SELECT_SQL = `id, datetime, duration_minutes as "durationMinutes", status,
    checkout_session_id as "checkoutSessionId", hold_expires_at as "holdExpiresAt",
    booker_name as "bookerName", booker_email as "bookerEmail", booker_note as "bookerNote",
    call_type as "callType", created_at as "createdAt"`;

  async function createSlot({ datetime, durationMinutes }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        `insert into public.call_bookings (datetime, duration_minutes, status, created_at) values ($1,$2,'open',$3) returning ${BOOKING_SELECT_SQL}`,
        [datetime, durationMinutes, createdAt]
      );
      return result.rows[0];
    }
    const data = readBookingsFile();
    const slot = {
      id: data.nextId, datetime, durationMinutes, status: 'open',
      checkoutSessionId: null, holdExpiresAt: null,
      bookerName: null, bookerEmail: null, bookerNote: null, callType: null, createdAt,
    };
    data.slots.push(slot);
    data.nextId += 1;
    writeBookingsFile(data);
    return slot;
  }

  async function listOpenSlots() {
    const nowIso = new Date().toISOString();
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `select ${BOOKING_SELECT_SQL} from public.call_bookings
         where datetime > now() and (status='open' or (status='pending' and hold_expires_at < now()))
         order by datetime asc`
      );
      return result.rows;
    }
    const data = readBookingsFile();
    return data.slots
      .filter((s) => s.datetime > nowIso && slotIsAvailable(s, nowIso))
      .sort((a, b) => a.datetime.localeCompare(b.datetime));
  }

  async function listAllSlotsAdmin() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${BOOKING_SELECT_SQL} from public.call_bookings order by datetime asc`);
      return result.rows;
    }
    const data = readBookingsFile();
    return data.slots.slice().sort((a, b) => a.datetime.localeCompare(b.datetime));
  }

  async function getSlotById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${BOOKING_SELECT_SQL} from public.call_bookings where id=$1`, [id]);
      return result.rows[0] || null;
    }
    const data = readBookingsFile();
    return data.slots.find((s) => s.id === id) || null;
  }

  // Transitions an open (or stale-pending) slot to pending for a fresh
  // checkout attempt. Returns null if the slot is unavailable (already
  // booked, or genuinely held by someone else's still-live checkout) so the
  // caller can reject the request instead of double-booking.
  async function holdSlotForCheckout(id, { checkoutSessionId, holdExpiresAt }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.call_bookings set status='pending', checkout_session_id=$2, hold_expires_at=$3
         where id=$1 and (status='open' or (status='pending' and hold_expires_at < now()))
         returning ${BOOKING_SELECT_SQL}`,
        [id, checkoutSessionId, holdExpiresAt]
      );
      return result.rows[0] || null;
    }
    const data = readBookingsFile();
    const slot = data.slots.find((s) => s.id === id);
    if (!slot || !slotIsAvailable(slot, new Date().toISOString())) return null;
    slot.status = 'pending';
    slot.checkoutSessionId = checkoutSessionId;
    slot.holdExpiresAt = holdExpiresAt;
    writeBookingsFile(data);
    return slot;
  }

  async function markSlotBooked(checkoutSessionId, { name, email, note, callType }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.call_bookings set status='booked', booker_name=$2, booker_email=$3, booker_note=$4, call_type=$5
         where checkout_session_id=$1 returning ${BOOKING_SELECT_SQL}`,
        [checkoutSessionId, name, email, note, callType]
      );
      return result.rows[0] || null;
    }
    const data = readBookingsFile();
    const slot = data.slots.find((s) => s.checkoutSessionId === checkoutSessionId);
    if (!slot) return null;
    slot.status = 'booked';
    slot.bookerName = name;
    slot.bookerEmail = email;
    slot.bookerNote = note;
    slot.callType = callType;
    writeBookingsFile(data);
    return slot;
  }

  // Only releases a hold that's still "pending" -- a session that expires
  // after the webhook already (rarely but theoretically, out of order)
  // marked it booked must never un-book a paid slot.
  async function releaseSlotIfPending(checkoutSessionId) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.call_bookings set status='open', checkout_session_id=null, hold_expires_at=null
         where checkout_session_id=$1 and status='pending' returning ${BOOKING_SELECT_SQL}`,
        [checkoutSessionId]
      );
      return result.rows[0] || null;
    }
    const data = readBookingsFile();
    const slot = data.slots.find((s) => s.checkoutSessionId === checkoutSessionId && s.status === 'pending');
    if (!slot) return null;
    slot.status = 'open';
    slot.checkoutSessionId = null;
    slot.holdExpiresAt = null;
    writeBookingsFile(data);
    return slot;
  }

  async function deleteSlot(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`delete from public.call_bookings where id=$1 returning status`, [id]);
      return result.rows[0] || null;
    }
    const data = readBookingsFile();
    const idx = data.slots.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [removed] = data.slots.splice(idx, 1);
    writeBookingsFile(data);
    return { status: removed.status };
  }

  // Yeshe Store: admin-managed products (digital courses and physical
  // clothing side by side) and the orders they generate. Orders are created
  // as "pending" right when checkout starts -- entirely in this app's own
  // storage, never crammed into Stripe metadata, which both keeps metadata
  // tiny (just an order id) and gives every checkout attempt a durable
  // record even if the payment is abandoned. Unlike the booking calendar's
  // slots, a pending order holds nothing exclusive (no inventory is
  // decremented), so there's no race to guard against and no expiry to
  // release -- an abandoned "pending" order is just inert history.
  function ensureStoreProductsFile() {
    const dir = path.dirname(STORE_PRODUCTS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STORE_PRODUCTS_FILE)) {
      fs.writeFileSync(STORE_PRODUCTS_FILE, JSON.stringify({ nextId: 1, products: [] }, null, 2), 'utf8');
    }
  }
  function readStoreProductsFile() {
    ensureStoreProductsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(STORE_PRODUCTS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, products: Array.isArray(parsed.products) ? parsed.products : [] };
    } catch (error) {
      return { nextId: 1, products: [] };
    }
  }
  function writeStoreProductsFile(data) {
    ensureStoreProductsFile();
    fs.writeFileSync(STORE_PRODUCTS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  const PRODUCT_SELECT_SQL = `id, name, description, price_cents as "priceCents", type, category, variants,
    image_path as "imagePath", image_mime as "imageMime", active, created_at as "createdAt"`;

  async function createProduct({ name, description, priceCents, type, category, variants }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        `insert into public.store_products (name, description, price_cents, type, category, variants, created_at)
         values ($1,$2,$3,$4,$5,$6,$7) returning ${PRODUCT_SELECT_SQL}`,
        [name, description, priceCents, type, category, JSON.stringify(variants), createdAt]
      );
      return result.rows[0];
    }
    const data = readStoreProductsFile();
    const product = {
      id: data.nextId, name, description, priceCents, type, category, variants,
      imagePath: null, imageMime: null, active: true, createdAt,
    };
    data.products.push(product);
    data.nextId += 1;
    writeStoreProductsFile(data);
    return product;
  }

  async function updateProduct(id, { name, description, priceCents, type, category, variants }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.store_products set name=$2, description=$3, price_cents=$4, type=$5, category=$6, variants=$7
         where id=$1 returning ${PRODUCT_SELECT_SQL}`,
        [id, name, description, priceCents, type, category, JSON.stringify(variants)]
      );
      return result.rows[0] || null;
    }
    const data = readStoreProductsFile();
    const product = data.products.find((p) => p.id === id);
    if (!product) return null;
    Object.assign(product, { name, description, priceCents, type, category, variants });
    writeStoreProductsFile(data);
    return product;
  }

  async function getProductById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${PRODUCT_SELECT_SQL} from public.store_products where id=$1`, [id]);
      return result.rows[0] || null;
    }
    const data = readStoreProductsFile();
    return data.products.find((p) => p.id === id) || null;
  }

  async function listActiveProducts() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${PRODUCT_SELECT_SQL} from public.store_products where active=true order by created_at desc`);
      return result.rows;
    }
    const data = readStoreProductsFile();
    return data.products.filter((p) => p.active).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function listAllProductsAdmin() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${PRODUCT_SELECT_SQL} from public.store_products order by created_at desc`);
      return result.rows;
    }
    const data = readStoreProductsFile();
    return data.products.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function setProductImage(id, { imagePath, imageMime }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.store_products set image_path=$1, image_mime=$2 where id=$3 returning ${PRODUCT_SELECT_SQL}`,
        [imagePath, imageMime, id]
      );
      return result.rows[0] || null;
    }
    const data = readStoreProductsFile();
    const product = data.products.find((p) => p.id === id);
    if (!product) return null;
    product.imagePath = imagePath;
    product.imageMime = imageMime;
    writeStoreProductsFile(data);
    return product;
  }

  async function setProductActive(id, active) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.store_products set active=$2 where id=$1 returning ${PRODUCT_SELECT_SQL}`,
        [id, active]
      );
      return result.rows[0] || null;
    }
    const data = readStoreProductsFile();
    const product = data.products.find((p) => p.id === id);
    if (!product) return null;
    product.active = active;
    writeStoreProductsFile(data);
    return product;
  }

  function ensureStoreOrdersFile() {
    const dir = path.dirname(STORE_ORDERS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STORE_ORDERS_FILE)) {
      fs.writeFileSync(STORE_ORDERS_FILE, JSON.stringify({ nextId: 1, orders: [] }, null, 2), 'utf8');
    }
  }
  function readStoreOrdersFile() {
    ensureStoreOrdersFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(STORE_ORDERS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, orders: Array.isArray(parsed.orders) ? parsed.orders : [] };
    } catch (error) {
      return { nextId: 1, orders: [] };
    }
  }
  function writeStoreOrdersFile(data) {
    ensureStoreOrdersFile();
    fs.writeFileSync(STORE_ORDERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  const ORDER_SELECT_SQL = `id, items, total_cents as "totalCents", buyer_name as "buyerName", buyer_email as "buyerEmail",
    has_physical as "hasPhysical", shipping_name as "shippingName", shipping_address as "shippingAddress",
    status, checkout_session_id as "checkoutSessionId", created_at as "createdAt"`;

  async function createStoreOrder({ items, totalCents, buyerName, buyerEmail, hasPhysical }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        `insert into public.store_orders (items, total_cents, buyer_name, buyer_email, has_physical, status, created_at)
         values ($1,$2,$3,$4,$5,'pending',$6) returning ${ORDER_SELECT_SQL}`,
        [JSON.stringify(items), totalCents, buyerName, buyerEmail, hasPhysical, createdAt]
      );
      return result.rows[0];
    }
    const data = readStoreOrdersFile();
    const order = {
      id: data.nextId, items, totalCents, buyerName, buyerEmail, hasPhysical,
      shippingName: null, shippingAddress: null, status: 'pending', checkoutSessionId: null, createdAt,
    };
    data.orders.push(order);
    data.nextId += 1;
    writeStoreOrdersFile(data);
    return order;
  }

  async function setOrderCheckoutSession(id, checkoutSessionId) {
    const client = await getDbClient();
    if (client) {
      await client.query(`update public.store_orders set checkout_session_id=$2 where id=$1`, [id, checkoutSessionId]);
      return;
    }
    const data = readStoreOrdersFile();
    const order = data.orders.find((o) => o.id === id);
    if (!order) return;
    order.checkoutSessionId = checkoutSessionId;
    writeStoreOrdersFile(data);
  }

  async function markOrderPaid(checkoutSessionId, { shippingName, shippingAddress }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.store_orders set status='paid', shipping_name=$2, shipping_address=$3
         where checkout_session_id=$1 returning ${ORDER_SELECT_SQL}`,
        [checkoutSessionId, shippingName, shippingAddress ? JSON.stringify(shippingAddress) : null]
      );
      return result.rows[0] || null;
    }
    const data = readStoreOrdersFile();
    const order = data.orders.find((o) => o.checkoutSessionId === checkoutSessionId);
    if (!order) return null;
    order.status = 'paid';
    order.shippingName = shippingName;
    order.shippingAddress = shippingAddress || null;
    writeStoreOrdersFile(data);
    return order;
  }

  async function getOrderById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${ORDER_SELECT_SQL} from public.store_orders where id=$1`, [id]);
      return result.rows[0] || null;
    }
    const data = readStoreOrdersFile();
    return data.orders.find((o) => o.id === id) || null;
  }

  async function listAllOrdersAdmin() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${ORDER_SELECT_SQL} from public.store_orders order by created_at desc`);
      return result.rows;
    }
    const data = readStoreOrdersFile();
    return data.orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // Anonymous (or named) messages to Kunga -- a Tellonym-style ask box.
  // Whoever sends it chooses whether their name/email are even collected;
  // the public GET surface never exists at all (only the admin-key-gated
  // inbox can list these), so there's nothing for this feature to leak.
  function ensureMessagesFile() {
    const dir = path.dirname(MESSAGES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(MESSAGES_FILE)) {
      fs.writeFileSync(MESSAGES_FILE, JSON.stringify({ nextId: 1, messages: [] }, null, 2), 'utf8');
    }
  }
  function readMessagesFile() {
    ensureMessagesFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, messages: Array.isArray(parsed.messages) ? parsed.messages : [] };
    } catch (error) {
      return { nextId: 1, messages: [] };
    }
  }
  function writeMessagesFile(data) {
    ensureMessagesFile();
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  const MESSAGE_SELECT_SQL = `id, text, anonymous, sender_name as "senderName", sender_email as "senderEmail",
    read, created_at as "createdAt"`;

  async function createMessage({ text, anonymous, senderName, senderEmail }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        `insert into public.messages (text, anonymous, sender_name, sender_email, created_at)
         values ($1,$2,$3,$4,$5) returning ${MESSAGE_SELECT_SQL}`,
        [text, anonymous, senderName, senderEmail, createdAt]
      );
      return result.rows[0];
    }
    const data = readMessagesFile();
    const message = { id: data.nextId, text, anonymous, senderName, senderEmail, read: false, createdAt };
    data.messages.push(message);
    data.nextId += 1;
    writeMessagesFile(data);
    return message;
  }

  async function listAllMessagesAdmin() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${MESSAGE_SELECT_SQL} from public.messages order by created_at desc`);
      return result.rows;
    }
    const data = readMessagesFile();
    return data.messages.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function setMessageRead(id, read) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.messages set read=$2 where id=$1 returning ${MESSAGE_SELECT_SQL}`,
        [id, read]
      );
      return result.rows[0] || null;
    }
    const data = readMessagesFile();
    const message = data.messages.find((m) => m.id === id);
    if (!message) return null;
    message.read = read;
    writeMessagesFile(data);
    return message;
  }

  async function deleteMessage(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`delete from public.messages where id=$1 returning id`, [id]);
      return result.rows[0] || null;
    }
    const data = readMessagesFile();
    const idx = data.messages.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    data.messages.splice(idx, 1);
    writeMessagesFile(data);
    return { id };
  }

  // Kunga's Clips: a TikTok/YouTube-style video feed. Uploading needs a
  // real kunga.me login (not anonymous like the message box or tip jar) --
  // every clip is tied to the uploader's username, which is also what
  // makes self-serve deletion and takedowns possible. A clip only ever
  // shows up in the public feed once it has a video attached (listClips
  // filters on video_path is not null), so an abandoned two-step upload
  // (metadata created, video never finished uploading) never appears as a
  // broken entry. Any visitor can watch without an account; only the
  // uploader or an admin-key holder can delete a given clip.
  function ensureClipsFile() {
    const dir = path.dirname(CLIPS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CLIPS_FILE)) {
      fs.writeFileSync(CLIPS_FILE, JSON.stringify({ nextId: 1, clips: [] }, null, 2), 'utf8');
    }
  }
  function readClipsFile() {
    ensureClipsFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf8'));
      return { nextId: parsed.nextId || 1, clips: Array.isArray(parsed.clips) ? parsed.clips : [] };
    } catch (error) {
      return { nextId: 1, clips: [] };
    }
  }
  function writeClipsFile(data) {
    ensureClipsFile();
    fs.writeFileSync(CLIPS_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
  const CLIP_SELECT_SQL = `id, username, caption, video_path as "videoPath", video_mime as "videoMime",
    thumb_path as "thumbPath", created_at as "createdAt"`;

  async function createClip({ username, caption }) {
    const client = await getDbClient();
    const createdAt = new Date().toISOString();
    if (client) {
      const result = await client.query(
        `insert into public.clips (username, caption, created_at) values ($1,$2,$3) returning ${CLIP_SELECT_SQL}`,
        [username, caption, createdAt]
      );
      return result.rows[0];
    }
    const data = readClipsFile();
    const clip = { id: data.nextId, username, caption, videoPath: null, videoMime: null, thumbPath: null, createdAt };
    data.clips.push(clip);
    data.nextId += 1;
    writeClipsFile(data);
    return clip;
  }

  async function getClipById(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(`select ${CLIP_SELECT_SQL} from public.clips where id=$1`, [id]);
      return result.rows[0] || null;
    }
    const data = readClipsFile();
    return data.clips.find((c) => c.id === id) || null;
  }

  async function listClips() {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `select ${CLIP_SELECT_SQL} from public.clips where video_path is not null order by created_at desc`
      );
      return result.rows;
    }
    const data = readClipsFile();
    return data.clips.filter((c) => c.videoPath).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function setClipVideo(id, { videoPath, videoMime }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.clips set video_path=$1, video_mime=$2 where id=$3 and video_path is null returning ${CLIP_SELECT_SQL}`,
        [videoPath, videoMime, id]
      );
      return result.rows[0] || null;
    }
    const data = readClipsFile();
    const clip = data.clips.find((c) => c.id === id);
    if (!clip || clip.videoPath) return null;
    clip.videoPath = videoPath;
    clip.videoMime = videoMime;
    writeClipsFile(data);
    return clip;
  }

  async function setClipThumb(id, { thumbPath }) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `update public.clips set thumb_path=$1 where id=$2 and thumb_path is null returning ${CLIP_SELECT_SQL}`,
        [thumbPath, id]
      );
      return result.rows[0] || null;
    }
    const data = readClipsFile();
    const clip = data.clips.find((c) => c.id === id);
    if (!clip || clip.thumbPath) return null;
    clip.thumbPath = thumbPath;
    writeClipsFile(data);
    return clip;
  }

  async function deleteClip(id) {
    const client = await getDbClient();
    if (client) {
      const result = await client.query(
        `delete from public.clips where id=$1 returning video_path as "videoPath", thumb_path as "thumbPath"`,
        [id]
      );
      return result.rows[0] || null;
    }
    const data = readClipsFile();
    const idx = data.clips.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const [removed] = data.clips.splice(idx, 1);
    writeClipsFile(data);
    return { videoPath: removed.videoPath, thumbPath: removed.thumbPath };
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
      const isDiary = session.metadata && session.metadata.app === DIARY_PRODUCT_METADATA_KEY;
      if (isDiary) {
        await updateUserDiarySubscription(user.id, {
          status: subscription ? subscription.status : 'active',
          periodEnd: subscription ? subscriptionPeriodEnd(subscription) : null,
        });
      } else {
        await updateUserSubscription(user.id, {
          stripeCustomerId: session.customer,
          status: subscription ? subscription.status : 'active',
          plan: session.metadata && session.metadata.region,
          periodEnd: subscription ? subscriptionPeriodEnd(subscription) : null,
        });
      }
    }

    // Fulfillment for a call booking happens only here, from a confirmed
    // payment — never at checkout-session-creation time, since a created
    // session is no guarantee anyone actually pays. See the comment above
    // the booking data-layer functions for how the pending hold works.
    async function finalizeBookingFromSession(session) {
      if (session.payment_status === 'unpaid') return;
      const details = session.customer_details || {};
      await markSlotBooked(session.id, {
        name: (session.metadata && session.metadata.bookerName) || details.name || '',
        email: (session.metadata && session.metadata.bookerEmail) || details.email || '',
        note: (session.metadata && session.metadata.bookerNote) || '',
        callType: (session.metadata && session.metadata.callType) || 'voice',
      });
    }

    // Store order fulfillment, same "only from a confirmed payment" rule as
    // the booking calendar above. Shipping comes from
    // collected_information.shipping_details in the current API version --
    // the older top-level session.shipping_details field this account's
    // Stripe docs used to document has been superseded there.
    async function finalizeStoreOrderFromSession(session) {
      if (session.payment_status === 'unpaid') return;
      const shipping = session.collected_information && session.collected_information.shipping_details;
      await markOrderPaid(session.id, {
        shippingName: shipping ? shipping.name : null,
        shippingAddress: shipping ? shipping.address : null,
      });
    }

    try {
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        const session = event.data.object;
        if (session.metadata && session.metadata.app === BOOKING_PRODUCT_METADATA_KEY) {
          await finalizeBookingFromSession(session);
        } else if (session.metadata && session.metadata.app === STORE_PRODUCT_METADATA_KEY) {
          await finalizeStoreOrderFromSession(session);
        } else {
          await activateFromSession(session);
        }
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        if (session.metadata && session.metadata.app === BOOKING_PRODUCT_METADATA_KEY) {
          await releaseSlotIfPending(session.id);
        }
      } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const user = await findUserByStripeCustomerId(subscription.customer);
        if (user) {
          const isDiary = subscription.metadata && subscription.metadata.app === DIARY_PRODUCT_METADATA_KEY;
          if (isDiary) {
            await updateUserDiarySubscription(user.id, {
              status: subscription.status,
              periodEnd: subscriptionPeriodEnd(subscription),
            });
          } else {
            await updateUserSubscription(user.id, {
              status: subscription.status,
              periodEnd: subscriptionPeriodEnd(subscription),
            });
          }
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

  // Notebook pages (typed text + handwriting stroke coordinates) can run
  // larger than the other JSON payloads this server handles, so the limit
  // here is a bit more generous than a pure API body would need.
  app.use(express.json({ limit: '3mb' }));
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

  // Server-rendered DiceBear avatar (see renderAvataaarSvg above for why this
  // isn't just an <img> pointed straight at api.dicebear.com). Output is
  // fully deterministic per query string, so it's safe to cache aggressively.
  app.get('/api/avatar-render', (req, res) => {
    const q = req.query || {};
    const extra = { seed: String(q.seed || 'yeshe').slice(0, 40) };
    const scale = parseInt(q.scale, 10);
    if (Number.isFinite(scale)) extra.scale = Math.max(50, Math.min(200, scale));
    const translateY = parseInt(q.translateY, 10);
    if (Number.isFinite(translateY)) extra.translateY = Math.max(-100, Math.min(100, translateY));

    const svg = renderAvataaarSvg(q, extra);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(svg);
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

  app.post('/api/kungas-diary/subscribe', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const { username } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!diaryStripeReady) await ensureDiaryStripeProduct();
    if (!diaryPriceId) {
      return res.status(503).json({ error: 'Stripe product/price setup has not completed yet. Try again shortly.' });
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
        line_items: [{ price: diaryPriceId, quantity: 1 }],
        metadata: { app: DIARY_PRODUCT_METADATA_KEY, username: user.username },
        subscription_data: { metadata: { app: DIARY_PRODUCT_METADATA_KEY, username: user.username } },
        success_url: `${APP_BASE_URL}/diary?sub=success`,
        cancel_url: `${APP_BASE_URL}/diary?sub=cancel`,
        integration_identifier: 'kungasdiary' + randomLetters(8),
      });

      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: 'Could not start checkout.', details: error.message });
    }
  });

  app.get('/api/kungas-diary/subscription-status', async (req, res) => {
    const username = String(req.query.username || '');
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ subscription: sanitizeDiarySubscription(user) });
  });

  // ---- Tip jar: a one-off payment for any amount, no account needed. Built
  //      with price_data (an amount chosen at checkout-session-creation time)
  //      rather than a pre-created Price, since the whole point is that the
  //      amount isn't fixed. No webhook handling is added for this: there is
  //      no account to update and nothing to fulfill, so Stripe's own
  //      dashboard is the record of what came in. The shared webhook handler
  //      already no-ops safely on these sessions since they never set
  //      client_reference_id, so a logged-in reader's subscription can never
  //      be touched by a tip. ------------------------------------------------
  const TIP_MIN_CENTS = 100;
  const TIP_MAX_CENTS = 10000000;
  app.post('/api/tip/checkout-session', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const { amount, name } = req.body || {};
    const amountCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountCents) || amountCents < TIP_MIN_CENTS || amountCents > TIP_MAX_CENTS) {
      return res.status(400).json({ error: `Enter an amount between $${(TIP_MIN_CENTS/100).toFixed(2)} and $${(TIP_MAX_CENTS/100).toFixed(2)}.` });
    }
    const safeName = String(name || '').trim().slice(0, 60).replace(/[<>]/g, '');

    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        submit_type: 'donate',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: safeName ? `Tip for Kunga, from ${safeName}` : 'Tip for Kunga' },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        success_url: `${APP_BASE_URL}/tip?sent=success`,
        cancel_url: `${APP_BASE_URL}/tip?sent=cancel`,
        integration_identifier: 'kungatipjar' + randomLetters(8),
      });
      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: 'Could not start checkout.', details: error.message });
    }
  });

  // ---- Call booking calendar: $50/hour, scaled to the slot's actual
  //      duration (a 30-min slot is $25, not a flat $50), paid before it's
  //      confirmed. Writing (adding/removing open slots) is admin-key
  //      gated, same reasoning as Kunga's Diary -- this is now a monetized
  //      calendar, not a trust-the-client notebook field. Booking itself
  //      needs no account: a visitor gives a name/email so Kunga can follow
  //      up and send the call link himself (there's no email-sending
  //      integration in this codebase to automate that). ---------------------
  const CALL_PRICE_PER_HOUR_CENTS = 5000;
  const CALL_HOLD_MINUTES = 30;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CALL_TYPES = ['voice', 'video'];

  function callPriceCentsFor(durationMinutes) {
    return Math.round((CALL_PRICE_PER_HOUR_CENTS * durationMinutes) / 60);
  }

  app.get('/api/booking/slots', async (req, res) => {
    const slots = await listOpenSlots();
    const withPrice = slots.map((s) => ({ ...s, priceCents: callPriceCentsFor(s.durationMinutes) }));
    return res.json({ slots: withPrice, pricePerHourCents: CALL_PRICE_PER_HOUR_CENTS });
  });

  app.post('/api/booking/checkout', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const id = Number(req.body && req.body.slotId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid slot.' });
    const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200);
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    const callType = CALL_TYPES.includes(req.body && req.body.callType) ? req.body.callType : null;
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (!callType) return res.status(400).json({ error: 'Please choose voice or video.' });

    const slot = await getSlotById(id);
    if (!slot) return res.status(404).json({ error: 'That slot no longer exists.' });
    if (slot.datetime <= new Date().toISOString()) return res.status(409).json({ error: "That slot's time has already passed." });

    try {
      const holdExpiresAt = new Date(Date.now() + CALL_HOLD_MINUTES * 60000).toISOString();
      const priceCents = callPriceCentsFor(slot.durationMinutes);
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        submit_type: 'book',
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${callType === 'video' ? 'Video' : 'Voice'} call with Kunga — ${fmtSlotLabel(slot)} (${slot.durationMinutes} min)` },
            unit_amount: priceCents,
          },
          quantity: 1,
        }],
        customer_email: email,
        metadata: { app: BOOKING_PRODUCT_METADATA_KEY, slotId: String(id), bookerName: name, bookerEmail: email, bookerNote: note, callType },
        expires_at: Math.floor(Date.now() / 1000) + CALL_HOLD_MINUTES * 60,
        success_url: `${APP_BASE_URL}/calendar?booked=success`,
        cancel_url: `${APP_BASE_URL}/calendar?booked=cancel`,
        integration_identifier: 'kungacallbooking' + randomLetters(8),
      });

      const held = await holdSlotForCheckout(id, { checkoutSessionId: session.id, holdExpiresAt });
      if (!held) {
        // Someone else grabbed it between the read above and now -- the
        // Checkout Session we just created is simply left to expire unused.
        return res.status(409).json({ error: 'That slot was just booked by someone else. Pick another.' });
      }
      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: 'Could not start checkout.', details: error.message });
    }
  });

  function fmtSlotLabel(slot) {
    try {
      return new Date(slot.datetime).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
    } catch (error) {
      return slot.datetime;
    }
  }

  app.get('/api/booking/admin/slots', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const slots = await listAllSlotsAdmin();
    return res.json({ slots });
  });

  app.post('/api/booking/admin/slots', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const { datetime, durationMinutes } = req.body || {};
    const parsedDate = new Date(datetime);
    if (!datetime || Number.isNaN(parsedDate.getTime())) return res.status(400).json({ error: 'Invalid date/time.' });
    if (parsedDate.toISOString() <= new Date().toISOString()) return res.status(400).json({ error: 'Pick a time in the future.' });
    const duration = Number(durationMinutes);
    if (![15, 30, 45, 60].includes(duration)) return res.status(400).json({ error: 'Duration must be 15, 30, 45 or 60 minutes.' });
    const slot = await createSlot({ datetime: parsedDate.toISOString(), durationMinutes: duration });
    return res.json({ slot });
  });

  app.post('/api/booking/admin/delete-slot', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const id = Number(req.body && req.body.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const slot = await getSlotById(id);
    if (!slot) return res.status(404).json({ error: 'Slot not found.' });
    if (slot.status === 'booked') {
      return res.status(409).json({ error: "This slot is already booked and paid for — cancel it from Stripe's dashboard if you need to refund, then delete it here." });
    }
    await deleteSlot(id);
    return res.json({ ok: true });
  });

  // ---- Yeshe Store: a real cart (digital courses + physical YESHE clothing
  //      side by side). Prices always come from THIS server's product
  //      record at the moment of checkout, never trusted from the client,
  //      so an edited price or a tampered cart total can't slip through.
  //      Placeholder country list for physical shipping -- ask to change it
  //      if it doesn't match where orders should actually be allowed to ship.
  const STORE_SHIP_COUNTRIES = ['AU','US','CA','GB','NZ','CN','HK','TW','SG','JP','DE','FR'];
  const STORE_MAX_LINE_QTY = 20;
  const STORE_MAX_LINE_ITEMS = 30;

  app.get('/api/store/products', async (req, res) => {
    const products = await listActiveProducts();
    return res.json({ products });
  });

  app.post('/api/store/checkout', async (req, res) => {
    if (!stripe) {
      return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
    }
    const body = req.body || {};
    const cartItems = Array.isArray(body.items) ? body.items : [];
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email.' });
    if (!cartItems.length) return res.status(400).json({ error: 'Your cart is empty.' });
    if (cartItems.length > STORE_MAX_LINE_ITEMS) return res.status(400).json({ error: 'Too many different items in one order.' });

    const orderItems = [];
    let totalCents = 0;
    let hasPhysical = false;
    for (const raw of cartItems) {
      const productId = Number(raw && raw.productId);
      const qty = Number(raw && raw.qty);
      if (!Number.isInteger(productId) || !Number.isInteger(qty) || qty < 1 || qty > STORE_MAX_LINE_QTY) {
        return res.status(400).json({ error: 'Invalid cart item.' });
      }
      const product = await getProductById(productId);
      if (!product || !product.active) return res.status(409).json({ error: `"${raw.name || 'An item'}" in your cart is no longer available.` });
      const variant = raw.variant ? String(raw.variant).slice(0, 40) : null;
      if (variant && !product.variants.includes(variant)) {
        return res.status(400).json({ error: `Invalid option for ${product.name}.` });
      }
      if (!variant && product.variants.length) {
        return res.status(400).json({ error: `Please choose an option for ${product.name}.` });
      }
      if (product.type === 'physical') hasPhysical = true;
      orderItems.push({ productId: product.id, name: product.name, priceCents: product.priceCents, qty, variant });
      totalCents += product.priceCents * qty;
    }

    try {
      const order = await createStoreOrder({ items: orderItems, totalCents, buyerName: name, buyerEmail: email, hasPhysical });

      const sessionParams = {
        mode: 'payment',
        line_items: orderItems.map((item) => ({
          price_data: {
            currency: 'usd',
            product_data: { name: item.name + (item.variant ? ` (${item.variant})` : '') },
            unit_amount: item.priceCents,
          },
          quantity: item.qty,
        })),
        customer_email: email,
        metadata: { app: STORE_PRODUCT_METADATA_KEY, orderId: String(order.id) },
        success_url: `${APP_BASE_URL}/store?order=success`,
        cancel_url: `${APP_BASE_URL}/store?order=cancel`,
        integration_identifier: 'yeshestore' + randomLetters(8),
      };
      if (hasPhysical) {
        sessionParams.shipping_address_collection = { allowed_countries: STORE_SHIP_COUNTRIES };
      }
      const session = await stripe.checkout.sessions.create(sessionParams);
      await setOrderCheckoutSession(order.id, session.id);
      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: 'Could not start checkout.', details: error.message });
    }
  });

  app.get('/api/store/admin/products', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const products = await listAllProductsAdmin();
    return res.json({ products });
  });

  app.post('/api/store/admin/products', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const { id, name, description, price, type, category, variants } = req.body || {};
    const cleanName = String(name || '').trim().slice(0, 120);
    const cleanDesc = String(description || '').trim().slice(0, 2000);
    const priceCents = Math.round(Number(price) * 100);
    const cleanType = type === 'digital' ? 'digital' : 'physical';
    const cleanCategory = String(category || '').trim().slice(0, 60);
    const cleanVariants = Array.isArray(variants)
      ? variants.map((v) => String(v).trim().slice(0, 40)).filter(Boolean).slice(0, 12)
      : [];
    if (!cleanName) return res.status(400).json({ error: 'Name is required.' });
    if (!Number.isFinite(priceCents) || priceCents <= 0) return res.status(400).json({ error: 'Enter a valid price.' });

    const fields = { name: cleanName, description: cleanDesc, priceCents, type: cleanType, category: cleanCategory, variants: cleanVariants };
    const product = id ? await updateProduct(Number(id), fields) : await createProduct(fields);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    return res.json({ product });
  });

  app.post('/api/store/admin/products/:id/photo', express.raw({ type: '*/*', limit: '8mb' }), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Photo storage is not configured on this server yet.' });
    const product = await getProductById(id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = { 'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png', 'image/webp':'webp' }[contentType];
    if (!ext) return res.status(400).json({ error: 'Only JPEG, PNG or WebP images are accepted.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'No image data received.' });
    const objectPath = id + '.' + ext;
    const { error } = await supabaseAdmin.storage.from(STORE_BUCKET).upload(objectPath, req.body, { contentType, upsert: true });
    if (error) return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });
    const updated = await setProductImage(id, { imagePath: objectPath, imageMime: contentType });
    return res.json({ product: updated });
  });

  app.post('/api/store/admin/delete-product', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const id = Number(req.body && req.body.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const product = await setProductActive(id, false);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    return res.json({ ok: true });
  });

  app.get('/api/store/admin/orders', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const orders = await listAllOrdersAdmin();
    return res.json({ orders });
  });

  // Same redirect-to-Storage pattern as /news-photo and /avatar.
  app.get('/store-photo/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    if (!supabaseAdmin) return res.status(503).end();
    const product = await getProductById(id);
    if (!product || !product.imagePath) return res.status(404).end();
    const { data } = supabaseAdmin.storage.from(STORE_BUCKET).getPublicUrl(product.imagePath);
    return res.redirect(302, data.publicUrl);
  });

  // ---- Anonymous messages ("send Kunga a message", Tellonym-style): no
  //      account needed to send, and no public read endpoint exists at all
  //      -- only the admin-key-gated inbox below can ever list these, so a
  //      sender's choice to stay anonymous can't be undone by some other
  //      route reading the data back out. --------------------------------
  const MESSAGE_MAX_LEN = 1000;
  app.post('/api/messages/send', async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim().slice(0, MESSAGE_MAX_LEN);
    const anonymous = body.anonymous !== false;
    if (!text) return res.status(400).json({ error: 'Write something first.' });
    const senderName = anonymous ? null : String(body.senderName || '').trim().slice(0, 80) || null;
    const senderEmail = anonymous ? null : String(body.senderEmail || '').trim().slice(0, 200) || null;
    const message = await createMessage({ text, anonymous, senderName, senderEmail });
    return res.json({ ok: true, id: message.id });
  });

  app.get('/api/messages/admin', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const messages = await listAllMessagesAdmin();
    return res.json({ messages });
  });

  app.post('/api/messages/admin/mark-read', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const id = Number(req.body && req.body.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const read = req.body && req.body.read !== false;
    const message = await setMessageRead(id, read);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    return res.json({ message });
  });

  app.post('/api/messages/admin/delete', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const id = Number(req.body && req.body.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const removed = await deleteMessage(id);
    if (!removed) return res.status(404).json({ error: 'Message not found.' });
    return res.json({ ok: true });
  });

  // ---- Kunga's Clips: a video feed anyone can watch, but only a logged-in
  //      kunga.me account can upload to -- every clip is tied to a real
  //      username (not anonymous) so self-serve delete and admin takedowns
  //      both have something to check against. Two-step upload (create the
  //      metadata row, then attach the video/thumbnail binaries) mirrors
  //      the store-product and avatar-photo pattern already in this file.
  const CLIP_CAPTION_MAX = 300;
  const CLIP_VIDEO_MIME_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
  const CLIP_THUMB_MIME_EXT = { 'image/jpeg': 'jpg' };

  app.get('/api/clips', async (req, res) => {
    const clips = await listClips();
    return res.json({ clips });
  });

  app.post('/api/clips', async (req, res) => {
    const { username, caption } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'Log in on kunga.me first to upload.' });
    const cleanCaption = String(caption || '').trim().slice(0, CLIP_CAPTION_MAX);
    const clip = await createClip({ username: user.username, caption: cleanCaption });
    return res.json({ clip });
  });

  app.post('/api/clips/:id/video', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Video storage is not configured on this server yet.' });
    const clip = await getClipById(id);
    if (!clip) return res.status(404).json({ error: 'Clip not found.' });
    if (clip.videoPath) return res.status(409).json({ error: 'This clip already has a video.' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = CLIP_VIDEO_MIME_EXT[contentType];
    if (!ext) return res.status(400).json({ error: 'Only MP4, MOV or WebM videos are accepted.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'No video data received.' });
    const objectPath = id + '.' + ext;
    const { error } = await supabaseAdmin.storage.from(CLIPS_BUCKET).upload(objectPath, req.body, { contentType, upsert: true });
    if (error) return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });
    const updated = await setClipVideo(id, { videoPath: objectPath, videoMime: contentType });
    if (!updated) return res.status(409).json({ error: 'This clip already has a video.' });
    return res.json({ clip: updated });
  });

  app.post('/api/clips/:id/thumbnail', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Image storage is not configured on this server yet.' });
    const clip = await getClipById(id);
    if (!clip) return res.status(404).json({ error: 'Clip not found.' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = CLIP_THUMB_MIME_EXT[contentType];
    if (!ext) return res.status(400).json({ error: 'Thumbnail must be a JPEG image.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'No thumbnail data received.' });
    const objectPath = id + '-thumb.' + ext;
    const { error } = await supabaseAdmin.storage.from(CLIPS_BUCKET).upload(objectPath, req.body, { contentType, upsert: true });
    if (error) return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });
    const updated = await setClipThumb(id, { thumbPath: objectPath });
    return res.json({ clip: updated || clip });
  });

  app.post('/api/clips/:id/delete', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const clip = await getClipById(id);
    if (!clip) return res.status(404).json({ error: 'Clip not found.' });
    const { username } = req.body || {};
    const isOwner = username && String(username).toLowerCase() === String(clip.username).toLowerCase();
    const isAdmin = req.headers['x-admin-key'] === ADMIN_KEY;
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Only the uploader or an admin can delete this clip.' });
    const removed = await deleteClip(id);
    if (removed && supabaseAdmin) {
      const paths = [removed.videoPath, removed.thumbPath].filter(Boolean);
      if (paths.length) await supabaseAdmin.storage.from(CLIPS_BUCKET).remove(paths).catch(() => {});
    }
    return res.json({ ok: true });
  });

  // Same redirect-to-Storage pattern as /store-photo and /news-photo.
  app.get('/clip-video/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    if (!supabaseAdmin) return res.status(503).end();
    const clip = await getClipById(id);
    if (!clip || !clip.videoPath) return res.status(404).end();
    const { data } = supabaseAdmin.storage.from(CLIPS_BUCKET).getPublicUrl(clip.videoPath);
    return res.redirect(302, data.publicUrl);
  });

  app.get('/clip-thumb/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    if (!supabaseAdmin) return res.status(503).end();
    const clip = await getClipById(id);
    if (!clip || !clip.thumbPath) return res.status(404).end();
    const { data } = supabaseAdmin.storage.from(CLIPS_BUCKET).getPublicUrl(clip.thumbPath);
    return res.redirect(302, data.publicUrl);
  });

  // ---- notebook (kunga-notebook.html / /notebook): free-form notes, synced
  //      to the account when the visitor is logged in on the main site (same
  //      username-trust model as the rest of this file — no session token,
  //      the client just states who it is). Guests stay on localStorage only,
  //      which notebook.html already handles on its own. -------------------
  app.get('/api/notebook', async (req, res) => {
    const username = String(req.query.username || '');
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ pages: user.notebook || {} });
  });

  app.post('/api/notebook', async (req, res) => {
    const { username, pages } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!pages || typeof pages !== 'object' || Array.isArray(pages)) {
      return res.status(400).json({ error: 'Invalid notebook data.' });
    }
    await updateUserNotebook(user.id, pages);
    return res.json({ ok: true });
  });

  // ---- Kunga's Diary (notebook.html's Diary section + /diary): a single
  //      owner account (DIARY_OWNER_USERNAME) with two kinds of entries --
  //      public ones, served unauthenticated to any visitor at /diary, and
  //      PIN-locked ones, which this GET and every other route below never
  //      includes unless /api/diary/unlock just verified the PIN. The PIN
  //      is a screen-lock against someone glancing at an already-logged-in
  //      notebook, not a replacement for real auth -- same trust level as
  //      the rest of this file's username-trust model. ----------------------
  const DIARY_MAX_HTML = 500000;
  function diaryPublicEntries(diary) {
    return ((diary && diary.entries) || []).filter((e) => e && e.public === true);
  }
  function diaryPrivateEntries(diary) {
    return ((diary && diary.entries) || []).filter((e) => e && e.public !== true);
  }
  app.get('/api/diary', async (req, res) => {
    const username = String(req.query.username || '');
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const diary = user.diary || {};
    return res.json({
      entries: diaryPublicEntries(diary),
      hasPin: Boolean(diary.pinHash),
      privateCount: diaryPrivateEntries(diary).length,
    });
  });

  app.post('/api/diary/set-pin', async (req, res) => {
    const { username, pin } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!/^\d{4,8}$/.test(String(pin || ''))) return res.status(400).json({ error: 'PIN must be 4-8 digits.' });
    const diary = user.diary || { entries: [] };
    if (diary.pinHash) return res.status(409).json({ error: 'A PIN is already set.' });
    diary.pinHash = hashPassword(pin);
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true });
  });

  app.post('/api/diary/change-pin', async (req, res) => {
    const { username, currentPin, newPin } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const diary = user.diary || { entries: [] };
    if (!diary.pinHash || diary.pinHash !== hashPassword(currentPin)) {
      return res.status(401).json({ error: 'Incorrect current PIN.' });
    }
    if (!/^\d{4,8}$/.test(String(newPin || ''))) return res.status(400).json({ error: 'PIN must be 4-8 digits.' });
    diary.pinHash = hashPassword(newPin);
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true });
  });

  app.post('/api/diary/unlock', async (req, res) => {
    const { username, pin } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const diary = user.diary || {};
    if (!diary.pinHash || diary.pinHash !== hashPassword(pin)) {
      return res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
    }
    return res.json({ ok: true, entries: diaryPrivateEntries(diary) });
  });

  app.post('/api/diary/entry', async (req, res) => {
    const { username, entry } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!entry || typeof entry !== 'object' || !entry.date) {
      return res.status(400).json({ error: 'Invalid diary entry.' });
    }
    const html = sanitizeDiaryHtml(entry.html);
    if (html.length > DIARY_MAX_HTML) return res.status(413).json({ error: 'That entry is too large.' });
    const diary = user.diary || { entries: [] };
    if (!Array.isArray(diary.entries)) diary.entries = [];
    const id = String(entry.id || crypto.randomUUID());
    const saved = {
      id,
      date: String(entry.date).slice(0, 10),
      html,
      mood: String(entry.mood || '').slice(0, 8),
      public: entry.public === true,
      t: Date.now(),
    };
    const idx = diary.entries.findIndex((e) => e.id === id);
    if (idx === -1) diary.entries.push(saved); else diary.entries[idx] = saved;
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true, entry: saved });
  });

  app.post('/api/diary/delete', async (req, res) => {
    const { username, id } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const diary = user.diary || { entries: [] };
    diary.entries = (diary.entries || []).filter((e) => e.id !== id);
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true });
  });

  // Public reader (/diary): the owner's own entries are never selected by
  // request-supplied username -- always this one hardcoded owner -- and only
  // entries explicitly marked public are selected, so a locked entry can
  // never reach this response. A separate, OPTIONAL ?username= identifies
  // the *viewer* (not the owner) purely to check whether they've paid for
  // the full archive -- it never changes which diary is being read.
  const DIARY_FREE_ENTRIES = 5;
  app.get('/api/diary/public', async (req, res) => {
    const owner = await findUserByUsername(DIARY_OWNER_USERNAME);
    const entries = owner ? diaryPublicEntries(owner.diary || {}) : [];
    entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.t || 0) - (a.t || 0));

    const viewerUsername = String(req.query.username || '').trim();
    let unlocked = false;
    if (viewerUsername) {
      if (viewerUsername.toLowerCase() === DIARY_OWNER_USERNAME.toLowerCase()) {
        unlocked = true;
      } else {
        const viewer = await findUserByUsername(viewerUsername);
        unlocked = viewer ? sanitizeDiarySubscription(viewer).active : false;
      }
    }

    const visible = unlocked ? entries : entries.slice(0, DIARY_FREE_ENTRIES);
    return res.json({
      entries: visible.map((e) => ({ date: e.date, mood: e.mood, html: e.html, t: e.t })),
      lockedCount: unlocked ? 0 : Math.max(0, entries.length - DIARY_FREE_ENTRIES),
      subscribed: unlocked,
    });
  });

  // ---- Kunga's Diary writing: gated by the server's ADMIN_KEY (not the
  //      username-trust model the rest of this file uses) because this is
  //      now the one piece of content people pay to read in full -- letting
  //      any client assert username:'kunga' the way /api/diary/entry above
  //      does would let anyone deface or fabricate paid content. -----------
  app.get('/api/kungas-diary/entries', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const user = await findUserByUsername(DIARY_OWNER_USERNAME);
    const entries = user ? diaryPublicEntries(user.diary || {}) : [];
    entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.t || 0) - (a.t || 0));
    return res.json({ entries });
  });

  app.post('/api/kungas-diary/entry', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const { id, date, html, mood } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD.' });
    }
    const cleanHtml = sanitizeDiaryHtml(html);
    if (!cleanHtml.trim()) return res.status(400).json({ error: 'Entry text cannot be empty.' });
    if (cleanHtml.length > DIARY_MAX_HTML) return res.status(413).json({ error: 'That entry is too large.' });

    const user = await findUserByUsername(DIARY_OWNER_USERNAME);
    if (!user) return res.status(500).json({ error: 'Diary owner account not found.' });
    const diary = user.diary || { entries: [] };
    if (!Array.isArray(diary.entries)) diary.entries = [];
    const entryId = String(id || crypto.randomUUID());
    const saved = { id: entryId, date: String(date), html: cleanHtml, mood: String(mood || '').slice(0, 8), public: true, t: Date.now() };
    const idx = diary.entries.findIndex((e) => e.id === entryId);
    if (idx === -1) diary.entries.push(saved); else diary.entries[idx] = saved;
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true, entry: saved });
  });

  app.post('/api/kungas-diary/delete', async (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized.' });
    const { id } = req.body || {};
    const user = await findUserByUsername(DIARY_OWNER_USERNAME);
    if (!user) return res.status(500).json({ error: 'Diary owner account not found.' });
    const diary = user.diary || { entries: [] };
    diary.entries = (diary.entries || []).filter((e) => e.id !== id);
    await updateUserDiary(user.id, diary);
    return res.json({ ok: true });
  });

  // ---- Speed Math (Mental Math's timed mode): a "most correct before the
  //      clock runs out" drill. A completed run can be "certified" -- written
  //      to a public, append-only table so the score is shareable and
  //      verifiable via its own certificate id, not just a private best-score
  //      number like the other math modes. --------------------------------
  const SPEEDMATH_DURATIONS = [60, 120];
  app.post('/api/speedmath/certify', async (req, res) => {
    const { username, correct, wrong, durationSec } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const duration = Number(durationSec);
    if (!SPEEDMATH_DURATIONS.includes(duration)) {
      return res.status(400).json({ error: 'Invalid duration.' });
    }
    const correctNum = Number(correct), wrongNum = Number(wrong);
    if (!Number.isInteger(correctNum) || !Number.isInteger(wrongNum) || correctNum < 0 || wrongNum < 0) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    // Generous sanity cap, not a serious anti-cheat measure (same username-
    // trust model as the rest of this file) -- just enough to keep an
    // obvious client-side tamper from landing a nonsense number in a PUBLIC
    // table. ~2 answers/second sustained is already far beyond realistic play.
    if (correctNum > duration * 2 || wrongNum > duration * 2) {
      return res.status(400).json({ error: 'Score out of range.' });
    }
    const cert = await createCertificate({ username: user.username, correct: correctNum, wrong: wrongNum, durationSec: duration });
    return res.json({ ok: true, certificate: cert });
  });

  app.get('/api/speedmath/certificate/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const cert = await getCertificateById(id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
    return res.json({ certificate: cert });
  });

  app.get('/api/speedmath/leaderboard', async (req, res) => {
    const duration = Number(req.query.duration) || 120;
    if (!SPEEDMATH_DURATIONS.includes(duration)) return res.status(400).json({ error: 'Invalid duration.' });
    const top = await listTopCertificates(duration, 50);
    return res.json({ duration, certificates: top });
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

  // Shared by the manual photo upload and the AI-generated avatar below —
  // both just end up as image bytes that need to land in the same Storage
  // bucket/path and flip the user's avatar to type 'photo'.
  async function uploadAvatarBuffer(user, buffer) {
    const { error } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .upload(user.username.toLowerCase() + '.jpg', buffer, { contentType: 'image/jpeg', upsert: true });
    if (error) return { error };
    const avatar = { type: 'photo', mascot: null, updatedAt: new Date().toISOString() };
    await updateUserAvatar(user.id, avatar);
    return { avatar };
  }

  app.post('/api/avatar/photo/:username', express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
    const username = req.params.username;
    if (!isSafeUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Photo storage is not configured on this server yet.' });
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No image data received.' });
    }

    const result = await uploadAvatarBuffer(user, req.body);
    if (result.error) return res.status(502).json({ error: 'Upload to storage failed.', details: result.error.message });
    return res.json({ avatar: result.avatar });
  });

  // ---- AI avatars (Pollinations AI): deliberately picker-only, no free-text
  // prompt field, so nothing a visitor types is ever forwarded to a
  // third-party image generator — see AVATAR_AI_OPTIONS/AVATAR_AI_STYLE in
  // index.html, which this mirrors exactly so the client-side live preview
  // (a plain <img> pointed straight at Pollinations) matches what actually
  // gets generated and stored here. ------------------------------------------
  const AVATAR_AI_STYLE = 'anime style character portrait avatar, Tibetan inspired design, traditional chuba clothing, {hair} hair, {expression} expression, {role} archetype, single person, head and shoulders, clean simple background, digital painting';
  const AVATAR_AI_OPTIONS = {
    hair: { black: 'black', brown: 'brown', silver: 'silver-white', auburn: 'auburn red-brown', blue: 'blue-tinted black' },
    expression: { happy: 'happy smiling', determined: 'determined focused', calm: 'calm serene', playful: 'playful grinning', brave: 'brave confident' },
    role: { herder: 'yak herder', scholar: 'scholar monk', traveler: 'mountain traveler', artist: 'thangka painter artist', warrior: 'warrior archer' },
  };
  async function fetchAvatarImage(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Pollinations' free tier allows only one queued request per IP at a
      // time (HTTP 429 "Queue full" otherwise) — a short gap before retrying
      // lets that slot clear instead of colliding with the failed attempt.
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const genRes = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!genRes.ok) throw new Error('Pollinations request failed: ' + genRes.status);
        const buffer = Buffer.from(await genRes.arrayBuffer());
        if (buffer.length < 2000) throw new Error('Generated image looked invalid.');
        return buffer;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
  app.post('/api/avatar/generate', async (req, res) => {
    const { username, hair, expression, role, seed } = req.body || {};
    if (!isSafeUsername(username)) return res.status(400).json({ error: 'Invalid username.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Avatar storage is not configured on this server yet.' });
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const hairPhrase = AVATAR_AI_OPTIONS.hair[hair] || AVATAR_AI_OPTIONS.hair.black;
    const expressionPhrase = AVATAR_AI_OPTIONS.expression[expression] || AVATAR_AI_OPTIONS.expression.happy;
    const rolePhrase = AVATAR_AI_OPTIONS.role[role] || AVATAR_AI_OPTIONS.role.traveler;
    const prompt = AVATAR_AI_STYLE.replace('{hair}', hairPhrase).replace('{expression}', expressionPhrase).replace('{role}', rolePhrase);
    const safeSeed = Number.isFinite(Number(seed)) ? Math.floor(Number(seed)) % 1e9 : Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true&seed=${safeSeed}`;

    // Pollinations' latency is uneven (seconds to well over 30s) and it
    // occasionally returns a short error body instead of an image, so this
    // retries once with a fresh request before giving up on the user.
    let buffer;
    try {
      buffer = await fetchAvatarImage(url);
    } catch (error) {
      return res.status(502).json({ error: 'Avatar generation failed. Try again.', details: error.message });
    }

    const result = await uploadAvatarBuffer(user, buffer);
    if (result.error) return res.status(502).json({ error: 'Upload to storage failed.', details: result.error.message });
    return res.json({ avatar: result.avatar });
  });

  // ---- Daily News: user-submitted newspaper clippings, typed out exactly ----
  const NEWS_TITLE_MAX = 140;
  const NEWS_BODY_MAX = 4000;
  const NEWS_MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

  app.post('/api/news', async (req, res) => {
    const { username, title, body } = req.body || {};
    const user = await findUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const cleanTitle = String(title || '').trim();
    const cleanBody = String(body || '').trim();
    if (!cleanTitle || cleanTitle.length > NEWS_TITLE_MAX) {
      return res.status(400).json({ error: `Title must be 1-${NEWS_TITLE_MAX} characters.` });
    }
    if (cleanBody.length < 10 || cleanBody.length > NEWS_BODY_MAX) {
      return res.status(400).json({ error: `Article text must be 10-${NEWS_BODY_MAX} characters.` });
    }
    const article = await createNewsArticle({ username: user.username, title: cleanTitle, body: cleanBody });
    return res.json({ article });
  });

  app.post('/api/news/:id/photo', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    if (!supabaseAdmin) return res.status(503).json({ error: 'Photo storage is not configured on this server yet.' });
    const article = await getNewsArticleById(id);
    if (!article) return res.status(404).json({ error: 'Article not found.' });
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = NEWS_MIME_EXT[contentType];
    if (!ext) return res.status(400).json({ error: 'Only JPEG, PNG, WebP images or PDF files are accepted.' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No file data received.' });
    }
    const objectPath = id + '.' + ext;
    const { error } = await supabaseAdmin.storage.from(NEWS_BUCKET).upload(objectPath, req.body, { contentType, upsert: true });
    if (error) return res.status(502).json({ error: 'Upload to storage failed.', details: error.message });
    const updated = await setNewsArticleImage(id, { imagePath: objectPath, imageMime: contentType });
    return res.json({ article: updated });
  });

  app.get('/api/news', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const articles = await listNewsArticles(limit);
    return res.json({ articles });
  });

  app.get('/api/news/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const article = await getNewsArticleById(id);
    if (!article) return res.status(404).json({ error: 'Article not found.' });
    return res.json({ article });
  });

  app.delete('/api/news/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id.' });
    const { username } = req.body || {};
    const article = await getNewsArticleById(id);
    if (!article) return res.status(404).json({ error: 'Article not found.' });
    if (!username || String(username).toLowerCase() !== String(article.username).toLowerCase()) {
      return res.status(403).json({ error: 'Only the original poster can delete this.' });
    }
    const removed = await deleteNewsArticle(id);
    if (removed && removed.imagePath && supabaseAdmin) {
      await supabaseAdmin.storage.from(NEWS_BUCKET).remove([removed.imagePath]).catch(() => {});
    }
    return res.json({ ok: true });
  });

  // Same redirect-to-Storage pattern as /avatar above.
  app.get('/news-photo/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    if (!supabaseAdmin) return res.status(503).end();
    const article = await getNewsArticleById(id);
    if (!article || !article.imagePath) return res.status(404).end();
    const { data } = supabaseAdmin.storage.from(NEWS_BUCKET).getPublicUrl(article.imagePath);
    return res.redirect(302, data.publicUrl);
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

  app.get('/notebook', (req, res) => {
    return res.sendFile(path.join(__dirname, 'notebook.html'));
  });

  app.get('/notebook.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'notebook.html'));
  });

  app.get('/diary', (req, res) => {
    return res.sendFile(path.join(__dirname, 'diary.html'));
  });

  app.get('/diary.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'diary.html'));
  });

  app.get('/diary/write', (req, res) => {
    return res.sendFile(path.join(__dirname, 'diary-write.html'));
  });

  app.get('/diary/write.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'diary-write.html'));
  });

  app.get('/calendar', (req, res) => {
    return res.sendFile(path.join(__dirname, 'calendar.html'));
  });

  app.get('/calendar.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'calendar.html'));
  });

  app.get('/calendar/admin', (req, res) => {
    return res.sendFile(path.join(__dirname, 'calendar-admin.html'));
  });

  app.get('/calendar/admin.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'calendar-admin.html'));
  });

  app.get('/turkey', (req, res) => {
    return res.sendFile(path.join(__dirname, 'turkey.html'));
  });

  app.get('/turkey.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'turkey.html'));
  });

  app.get('/store', (req, res) => {
    return res.sendFile(path.join(__dirname, 'store.html'));
  });

  app.get('/store.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'store.html'));
  });

  app.get('/store/admin', (req, res) => {
    return res.sendFile(path.join(__dirname, 'store-admin.html'));
  });

  app.get('/store/admin.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'store-admin.html'));
  });

  app.get('/messages', (req, res) => {
    return res.sendFile(path.join(__dirname, 'messages.html'));
  });

  app.get('/messages.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'messages.html'));
  });

  app.get('/messages/admin', (req, res) => {
    return res.sendFile(path.join(__dirname, 'messages-admin.html'));
  });

  app.get('/messages/admin.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'messages-admin.html'));
  });

  app.get('/camera', (req, res) => {
    return res.sendFile(path.join(__dirname, 'camera.html'));
  });

  app.get('/camera.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'camera.html'));
  });

  app.get('/clips', (req, res) => {
    return res.sendFile(path.join(__dirname, 'clips.html'));
  });

  app.get('/clips.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'clips.html'));
  });

  app.get('/poker', (req, res) => {
    return res.sendFile(path.join(__dirname, 'poker.html'));
  });

  app.get('/poker.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'poker.html'));
  });

  app.get('/probability-night', (req, res) => {
    return res.sendFile(path.join(__dirname, 'probability-night.html'));
  });

  app.get('/probability-night.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'probability-night.html'));
  });

  app.get('/certificate/:id', (req, res) => {
    return res.sendFile(path.join(__dirname, 'certificate.html'));
  });

  app.get('/certificate', (req, res) => {
    return res.sendFile(path.join(__dirname, 'certificate.html'));
  });

  app.get('/leaderboard', (req, res) => {
    return res.sendFile(path.join(__dirname, 'leaderboard.html'));
  });

  app.get('/leaderboard.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'leaderboard.html'));
  });

  app.get('/daily-optimism', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-optimism.html'));
  });

  app.get('/daily-optimism.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-optimism.html'));
  });

  app.get('/daily-news', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-news.html'));
  });

  app.get('/daily-news.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-news.html'));
  });

  app.get('/daily-news/submit', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-news.html'));
  });

  app.get('/daily-news/:id', (req, res) => {
    return res.sendFile(path.join(__dirname, 'daily-news.html'));
  });

  app.get('/tip', (req, res) => {
    return res.sendFile(path.join(__dirname, 'tip.html'));
  });

  app.get('/tip.html', (req, res) => {
    return res.sendFile(path.join(__dirname, 'tip.html'));
  });

  // ---- text-to-speech proxy (Azure AI Speech): English + Chinese only ---------
  // Tibetan has no usable TTS voice on any provider, so it is not handled here —
  // see the /api/admin/audio routes below for the real-recording approach.
  app.get('/api/tts', async (req, res) => {
    const lang = String(req.query.lang || '');
    const voice = String(req.query.voice || 'female');
    const text = String(req.query.text || '').slice(0, 500);

    const primaryVoiceName = AZURE_VOICES[lang] && AZURE_VOICES[lang][voice];
    if (!primaryVoiceName || !text.trim()) {
      return res.status(400).json({ error: 'Unsupported lang/voice or empty text.' });
    }
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(503).json({ error: 'Azure Speech is not configured on this server yet.' });
    }

    const langTag = lang === 'zh' ? 'zh-CN' : 'en-GB';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    async function synthesize(voiceName) {
      const ssml = `<speak version="1.0" xml:lang="${langTag}"><voice name="${voiceName}">${escaped}</voice></speak>`;
      const azureRes = await fetch(
        `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': AZURE_TTS_FORMAT,
            'User-Agent': 'yeshe-app',
          },
          body: ssml,
        }
      );
      if (!azureRes.ok) {
        const details = await azureRes.text().catch(() => '');
        const err = new Error('Azure Speech request failed.');
        err.details = details.slice(0, 300);
        throw err;
      }
      return Buffer.from(await azureRes.arrayBuffer());
    }

    try {
      // Try the primary (e.g. multilingual) voice first; a region that
      // doesn't yet serve it falls back to the paired standard voice so
      // playback never breaks even if a newer voice isn't available yet.
      let voiceName = primaryVoiceName;
      let cacheKey = crypto.createHash('sha256').update(voiceName + '|' + AZURE_TTS_FORMAT + '|' + text).digest('hex');
      let cacheFile = path.join(TTS_CACHE_DIR, cacheKey + '.mp3');

      if (fs.existsSync(cacheFile)) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return fs.createReadStream(cacheFile).pipe(res);
      }

      let audioBuffer;
      try {
        audioBuffer = await synthesize(voiceName);
      } catch (primaryError) {
        const fallbackVoice = AZURE_VOICE_FALLBACK[voiceName];
        if (!fallbackVoice) throw primaryError;
        voiceName = fallbackVoice;
        cacheKey = crypto.createHash('sha256').update(voiceName + '|' + AZURE_TTS_FORMAT + '|' + text).digest('hex');
        cacheFile = path.join(TTS_CACHE_DIR, cacheKey + '.mp3');
        if (fs.existsSync(cacheFile)) {
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return fs.createReadStream(cacheFile).pipe(res);
        }
        audioBuffer = await synthesize(voiceName);
      }

      fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, audioBuffer);

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(audioBuffer);
    } catch (error) {
      return res.status(502).json({ error: 'Azure Speech request failed.', details: error.details || error.message });
    }
  });

  // ---- own-voice audio: real recordings uploaded via the /record admin tool ---
  // Stored in Supabase Storage at <bucket>/<lang>/<wordId>.webm — NOT on local
  // disk, which Render wipes on every restart (including automatic spin-down
  // after ~15 min idle on the free plan, not just on redeploy). Tibetan has no
  // usable TTS voice on any provider, so bo always relies on this; English and
  // Mandarin use it only when you've recorded that item yourself, falling
  // back to Azure otherwise.
  const RECORDABLE_LANGS = ['bo', 'en', 'zh'];
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

    // The word bank is now large enough (3,000+ entries) that a single list()
    // call can't be trusted to return everything in one page, so page through
    // with offset until a short page confirms there's nothing left.
    let recorded = [];
    try {
      const pageSize = 1000;
      let offset = 0;
      for (;;) {
        const { data, error } = await supabaseAdmin.storage
          .from(AUDIO_BUCKET)
          .list(lang, { limit: pageSize, offset });
        if (error) throw error;
        const page = data || [];
        recorded.push(...page.filter((f) => f.name.endsWith('.webm')).map((f) => f.name.slice(0, -'.webm'.length)));
        if (page.length < pageSize) break;
        offset += pageSize;
      }
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
    ensureNewsBucket,
    ensureStoreBucket,
    ensureClipsBucket,
    ensureStripeProduct,
    ensureDiaryStripeProduct,
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
  appState.ensureNewsBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: news-photos bucket ready.');
    else console.log('Supabase Storage not active for news photos (' + bucketStatus.reason + ') — photos/PDFs would not persist.');
  });
  appState.ensureStoreBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: store-photos bucket ready.');
    else console.log('Supabase Storage not active for store photos (' + bucketStatus.reason + ') — product photos would not persist.');
  });
  appState.ensureClipsBucket().then((bucketStatus) => {
    if (bucketStatus.ok) console.log('Supabase Storage: clips bucket ready.');
    else console.log('Supabase Storage not active for clips (' + bucketStatus.reason + ') — video uploads would not persist.');
  });
  appState.ensureStripeProduct().then((stripeStatus) => {
    if (stripeStatus.ok) console.log('Stripe: Premium product/prices ready.');
    else console.log('Stripe not active (' + stripeStatus.reason + ') — subscriptions disabled until STRIPE_SECRET_KEY is set.');
  });
  appState.ensureDiaryStripeProduct().then((stripeStatus) => {
    if (stripeStatus.ok) console.log("Stripe: Kunga's Diary archive price ready.");
    else console.log('Stripe not active for the diary archive (' + stripeStatus.reason + ') — subscriptions disabled until STRIPE_SECRET_KEY is set.');
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
