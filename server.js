const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = path.join(__dirname, 'tmp_uploads');
const OUTPUT_DIR = path.join(__dirname, 'tmp_output');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

const jobs = new Map();
const FILE_TTL = 30 * 60 * 1000;
const LIMIT_S = 415;
const SAMPLE_RATE = 44100;
const DAILY_LIMIT = 2;

// ---------- auth / users ----------
// IMPORTANT (Vercel): the filesystem on Vercel serverless functions is
// read-only/ephemeral — a local users.json file does NOT survive between
// requests or deployments. So user data (owner/vip/vvip accounts) is stored
// in Redis (Vercel KV or Upstash Redis, both use the same REST API) when the
// KV_REST_API_URL / KV_REST_API_TOKEN env vars are present. If they are not
// present (e.g. running locally on your own machine), it falls back to the
// local users.json file so you can still develop without setting up Redis.
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const USERS_KEY = 'renz:users';

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKV = Boolean(KV_URL && KV_TOKEN);

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!res.ok) throw new Error(`KV get gagal (${res.status})`);
  const data = await res.json();
  return data.result ?? null;
}

async function kvSet(key, valueStr) {
  const res = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
    body: valueStr
  });
  if (!res.ok) throw new Error(`KV set gagal (${res.status})`);
}

async function loadUsersFromStore() {
  if (useKV) {
    const raw = await kvGet(USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  }
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}

let users = [];

async function saveUsers() {
  if (useKV) {
    await kvSet(USERS_KEY, JSON.stringify(users));
  } else {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function findUser(username) {
  return users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}
function getUsage(user) {
  const today = todayStr();
  if (!user.usage || user.usage.date !== today) {
    user.usage = { date: today, count: 0 };
  }
  return user.usage;
}
function hasAutoAccess(user) {
  if (user.role === 'owner') return true;
  if ((user.plan === 'vip' || user.plan === 'vvip') && user.planExpiresAt && user.planExpiresAt > Date.now()) return true;
  return false;
}
function publicUser(user) {
  const usage = getUsage(user);
  const autoAccess = hasAutoAccess(user);
  // Owner AND active VIP/VVIP = unlimited converts, no daily cap at all.
  // Only plain/free accounts are capped at DAILY_LIMIT per day.
  const unlimited = user.role === 'owner' || autoAccess;
  return {
    username: user.username,
    role: user.role,
    plan: user.plan || 'free',
    planExpiresAt: user.planExpiresAt || null,
    planDaysLeft: user.planExpiresAt ? Math.max(0, Math.ceil((user.planExpiresAt - Date.now()) / 86400000)) : null,
    autoAccess,
    limit: unlimited ? null : DAILY_LIMIT,
    used: usage.count,
    remaining: unlimited ? null : Math.max(0, DAILY_LIMIT - usage.count)
  };
}

// ⚠️ Owner login now comes ONLY from environment variables — nothing is
// hardcoded here anymore. Set these in Vercel: Project → Settings →
// Environment Variables:
//   OWNER_USERNAME = your chosen owner username
//   OWNER_PASSWORD = your chosen owner password
// then redeploy. If they are missing, no owner account is created and a
// warning is printed to the server logs.
const OWNER_USERNAME = process.env.OWNER_USERNAME;
const OWNER_PASSWORD = process.env.OWNER_PASSWORD;

async function ensureOwner() {
  const existing = users.find((u) => u.role === 'owner');
  if (existing) {
    // keep the stored owner login in sync if the env var was rotated
    if (OWNER_USERNAME && OWNER_PASSWORD &&
        (existing.username !== OWNER_USERNAME || !(await bcrypt.compare(OWNER_PASSWORD, existing.passwordHash).catch(() => false)))) {
      existing.username = OWNER_USERNAME;
      existing.passwordHash = await bcrypt.hash(OWNER_PASSWORD, 10);
      await saveUsers();
    }
    return;
  }
  if (!OWNER_USERNAME || !OWNER_PASSWORD) {
    console.warn('⚠️  OWNER_USERNAME / OWNER_PASSWORD belum di-set di environment variables. Owner login tidak akan bisa dipakai sampai ini di-set (lalu redeploy).');
    return;
  }
  users.push({
    id: crypto.randomUUID(),
    username: OWNER_USERNAME,
    passwordHash: await bcrypt.hash(OWNER_PASSWORD, 10),
    role: 'owner',
    plan: 'owner',
    planExpiresAt: null,
    createdAt: Date.now(),
    usage: { date: todayStr(), count: 0 }
  });
  await saveUsers();
}

let usersReady = (async () => {
  users = await loadUsersFromStore();
  await ensureOwner();
})();

// Reload the freshest copy of users from the store on every request. This
// matters on Vercel because multiple serverless instances can be running at
// once — without this, an account added via the admin panel on one instance
// might not be visible to logins hitting a different instance.
app.use(async (req, res, next) => {
  try {
    await usersReady;
    users = await loadUsersFromStore();
    next();
  } catch (err) {
    next(err);
  }
});

app.use(session({
  // ⚠️ Also set SESSION_SECRET as a fixed env var in Vercel. If left on the
  // random fallback, every cold start / new instance gets a different
  // secret and can invalidate other instances' login sessions.
  secret: process.env.SESSION_SECRET || 'renz-audio-' + crypto.randomBytes(16).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  const user = users.find((u) => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Kamu belum login. Login dulu untuk convert audio.' });
  req.user = user;
  next();
}

function requireOwner(req, res, next) {
  const user = users.find((u) => u.id === req.session.userId);
  if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Khusus owner.' });
  req.user = user;
  next();
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
  if (findUser(username)) return res.status(409).json({ error: 'Username sudah dipakai' });

  const user = {
    id: crypto.randomUUID(),
    username: String(username).trim(),
    passwordHash: await bcrypt.hash(String(password), 10),
    role: 'user',
    plan: 'free',
    planExpiresAt: null,
    createdAt: Date.now(),
    usage: { date: todayStr(), count: 0 }
  };
  users.push(user);
  await saveUsers();
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = findUser(username || '');
  if (!user) return res.status(401).json({ error: 'Username atau password salah' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Username atau password salah' });
  req.session.userId = user.id;
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const user = users.find((u) => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Belum login' });
  res.json(publicUser(user));
});

// ---------- admin panel (owner only) — add/remove VIP & VVIP accounts ----------
app.get('/api/admin/users', requireOwner, (req, res) => {
  const list = users
    .filter((u) => u.role !== 'owner')
    .map((u) => ({
      username: u.username,
      plan: u.plan,
      planExpiresAt: u.planExpiresAt,
      daysLeft: u.planExpiresAt ? Math.max(0, Math.ceil((u.planExpiresAt - Date.now()) / 86400000)) : null,
      expired: u.planExpiresAt ? u.planExpiresAt <= Date.now() : false,
      createdAt: u.createdAt
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.post('/api/admin/users', requireOwner, async (req, res) => {
  const { username, password, plan, days } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  if (String(username).length < 3) return res.status(400).json({ error: 'Username minimal 3 karakter' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
  if (!['vip', 'vvip'].includes(plan)) return res.status(400).json({ error: "Plan harus 'vip' atau 'vvip'" });

  const d = Number(days) > 0 ? Number(days) : (plan === 'vip' ? 10 : 30);
  const expiresAt = Date.now() + d * 24 * 60 * 60 * 1000;

  let user = findUser(username);
  if (user && user.role === 'owner') return res.status(400).json({ error: 'Tidak bisa pakai username owner' });

  if (user) {
    // username sudah ada -> update jadi VIP/VVIP baru (password & masa aktif direset)
    user.passwordHash = await bcrypt.hash(String(password), 10);
    user.plan = plan;
    user.planExpiresAt = expiresAt;
  } else {
    user = {
      id: crypto.randomUUID(),
      username: String(username).trim(),
      passwordHash: await bcrypt.hash(String(password), 10),
      role: 'user',
      plan,
      planExpiresAt: expiresAt,
      createdAt: Date.now(),
      usage: { date: todayStr(), count: 0 }
    };
    users.push(user);
  }
  await saveUsers();
  res.json({ ok: true, username: user.username, plan: user.plan, planExpiresAt: user.planExpiresAt });
});

app.delete('/api/admin/users/:username', requireOwner, async (req, res) => {
  const idx = users.findIndex((u) => u.username.toLowerCase() === req.params.username.toLowerCase());
  if (idx === -1) return res.status(404).json({ error: 'User tidak ditemukan' });
  if (users[idx].role === 'owner') return res.status(400).json({ error: 'Tidak bisa hapus akun owner' });
  users.splice(idx, 1);
  await saveUsers();
  res.json({ ok: true });
});

const factorOf = (semi) => Math.pow(2, semi / 12);
const effOf = (factor) => +(1 / factor).toFixed(3);

function buildAtempoChain(factor) {
  const filters = [];
  let f = factor;
  if (!isFinite(f) || f <= 0) f = 1;
  while (f > 2.0) { filters.push('atempo=2.0'); f /= 2.0; }
  while (f < 0.5) { filters.push('atempo=0.5'); f /= 0.5; }
  filters.push(`atempo=${f.toFixed(4)}`);
  return filters;
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(new Error('File audio tidak valid / corrupt'));
      resolve(data.format.duration || 0);
    });
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/process', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File audio wajib diupload' });

  const modeReq = req.body.mode === 'manual' ? 'manual' : 'linked';
  if (modeReq === 'linked' && !hasAutoAccess(req.user)) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Mode Otomatis khusus VIP/VVIP. Upgrade dulu untuk pakai fitur ini.', vipRequired: true });
  }

  // Owner and active VIP/VVIP accounts skip the daily counter entirely —
  // only plain/free accounts are limited to DAILY_LIMIT per day.
  if (req.user.role !== 'owner' && !hasAutoAccess(req.user)) {
    const usage = getUsage(req.user);
    if (usage.count >= DAILY_LIMIT) {
      fs.unlink(req.file.path, () => {});
      return res.status(429).json({ error: `Limit harian ${DAILY_LIMIT}x convert sudah habis. Coba lagi besok.` });
    }
    usage.count += 1;
    await saveUsers();
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'queued', queuePosition: 1, createdAt: Date.now() });
  res.json({ jobId });

  processAudio(jobId, req.file, req.body, req.user).catch((err) => {
    jobs.set(jobId, { status: 'failed', error: err.message || 'Conversion failed' });
    fs.unlink(req.file.path, () => {});
  });
});

async function processAudio(jobId, file, body, user) {
  jobs.set(jobId, { status: 'processing' });

  const mode = body.mode === 'manual' ? 'manual' : 'linked';
  const semitones = parseFloat(body.semitones) || 0;
  const pitchSemitones = parseFloat(body.pitchSemitones) || 0;
  const speed = parseFloat(body.speed) || 1;
  const volume = parseFloat(body.volume) || 1;
  const format = ['ogg', 'mp3', 'wav'].includes(body.format) ? body.format : 'ogg';

  const srcDuration = await getDuration(file.path);

  const filters = [];
  let factor, finalSpeed;

  if (mode === 'manual') {
    const pitchFactor = factorOf(pitchSemitones);
    filters.push(`asetrate=${SAMPLE_RATE}*${pitchFactor}`, `aresample=${SAMPLE_RATE}`);
    const tempoCorrection = speed / pitchFactor;
    filters.push(...buildAtempoChain(tempoCorrection));
    factor = pitchFactor;
    finalSpeed = speed;
  } else {
    factor = factorOf(semitones);
    filters.push(`asetrate=${SAMPLE_RATE}*${factor}`, `aresample=${SAMPLE_RATE}`);
    finalSpeed = factor;
  }

  filters.push(`volume=${volume}`);

  const outDuration = finalSpeed > 0 ? srcDuration / finalSpeed : srcDuration;
  const overLimit = outDuration > LIMIT_S;
  const recommendedSemitones = overLimit
    ? Math.ceil(12 * Math.log2(srcDuration / LIMIT_S) * 10) / 10
    : null;

  const outFilename = `${jobId}.${format}`;
  const outPath = path.join(OUTPUT_DIR, outFilename);

  await new Promise((resolve, reject) => {
    let cmd = ffmpeg(file.path).audioFilters(filters);
    if (format === 'mp3') cmd = cmd.audioCodec('libmp3lame');
    else if (format === 'ogg') cmd = cmd.audioCodec('libvorbis');
    else cmd = cmd.audioCodec('pcm_s16le');
    cmd.on('end', resolve).on('error', reject).save(outPath);
  });

  fs.unlink(file.path, () => {});

  jobs.set(jobId, {
    status: 'done',
    effectSpeed: effOf(factor),
    semitones: mode === 'manual' ? pitchSemitones : semitones,
    mode,
    speed: mode === 'manual' ? finalSpeed : null,
    factor: +factor.toFixed(2),
    srcDuration,
    outDuration,
    overLimit,
    recommendedSemitones,
    downloadUrl: `/download/${outFilename}`,
    filename: outFilename,
    usage: publicUser(user)
  });

  setTimeout(() => {
    fs.unlink(outPath, () => {});
    jobs.delete(jobId);
  }, FILE_TTL);
}

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job expired atau tidak ditemukan' });
  res.json(job);
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File expired, convert ulang track-nya' });
  res.download(filePath, req.query.name || req.params.filename);
});

app.post('/api/roblox-upload', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Roblox API key kosong' });

    const { outputName, creatorType, creatorId, assetName } = req.body || {};
    if (!outputName || !creatorId) return res.status(400).json({ error: 'outputName dan creatorId wajib diisi' });

    const filePath = path.join(OUTPUT_DIR, outputName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File expired, convert ulang lalu upload lagi' });

    const creator = creatorType === 'group' ? { groupId: Number(creatorId) } : { userId: Number(creatorId) };
    const requestPayload = { assetType: 'Audio', displayName: assetName || outputName, description: assetName || outputName, creationContext: { creator } };

    const mime = outputName.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg';
    const fileBuffer = fs.readFileSync(filePath);

    const form = new FormData();
    form.append('request', JSON.stringify(requestPayload));
    form.append('fileContent', new Blob([fileBuffer], { type: mime }), outputName);

    const uploadRes = await fetch('https://apis.roblox.com/assets/v1/assets', { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) return res.status(uploadRes.status).json({ error: uploadData.message || 'Upload ke Roblox gagal' });

    const operationId = uploadData.path ? uploadData.path.split('/').pop() : null;
    let assetId = null;

    if (operationId) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const opRes = await fetch(`https://apis.roblox.com/assets/v1/operations/${operationId}`, { headers: { 'x-api-key': apiKey } });
        const opData = await opRes.json();
        if (opData.done && opData.response?.assetId) { assetId = opData.response.assetId; break; }
      }
    }

    if (!assetId) return res.status(202).json({ error: 'Upload diterima tapi masih diproses roblox, coba cek moderation sebentar lagi' });
    res.json({ assetId, moderationState: 'Reviewing' });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

app.get('/api/roblox-moderation/:assetId', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Roblox API key kosong' });

    const { assetId } = req.params;
    const r = await fetch(`https://apis.roblox.com/assets/v1/assets/${assetId}`, { headers: { 'x-api-key': apiKey } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Gagal cek moderation' });

    const moderationState = data.moderationResult?.moderationState || 'Reviewing';
    res.json({ moderationState });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Internal error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Renz Audio server jalan di port ${PORT}`));
module.exports = app;