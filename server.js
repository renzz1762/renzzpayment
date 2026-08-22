const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
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

const UPLOAD_DIR = path.join(os.tmpdir(), 'renz-audio', 'tmp_uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'renz-audio', 'tmp_output');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 200 * 1024 * 1024 } });

const jobs = new Map();
const FILE_TTL = 30 * 60 * 1000;
const LIMIT_S = 415;
const SAMPLE_RATE = 44100;
const DAILY_LIMIT = 2;

// ---------- auth / users ----------
// ⚠️ Vercel serverless functions can only write to os.tmpdir() (/tmp) — the
// rest of the filesystem, including __dirname, is read-only. Writing there
// crashes the function on EVERY request. This is the actual reason logins
// were failing before, regardless of any database setup.
const RUNTIME_DIR = path.join(os.tmpdir(), 'renz-audio');
const USERS_FILE = path.join(RUNTIME_DIR, 'users.json');

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
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
  if (user.plan === 'vip' || user.plan === 'vvip') {
    // Fixed VIP/VVIP accounts below have no expiry (planExpiresAt = null),
    // meaning they're always active until you change the password yourself.
    if (!user.planExpiresAt) return true;
    return user.planExpiresAt > Date.now();
  }
  return false;
}
function publicUser(user) {
  const usage = getUsage(user);
  const autoAccess = hasAutoAccess(user);
  // Owner AND VIP/VVIP = unlimited converts, no daily cap at all.
  // Only plain/free accounts are capped at DAILY_LIMIT per day.
  const unlimited = user.role === 'owner' || autoAccess;
  return {
    username: user.username,
    role: user.role,
    plan: user.plan || 'free',
    autoAccess,
    limit: unlimited ? null : DAILY_LIMIT,
    used: usage.count,
    remaining: unlimited ? null : Math.max(0, DAILY_LIMIT - usage.count)
  };
}

// ⚠️ All three accounts below come ONLY from environment variables — nothing
// is hardcoded in this file. Set these in Vercel: Project → Settings →
// Environment Variables, then redeploy:
//   OWNER_USERNAME / OWNER_PASSWORD   -> your owner login
//   VIP_USERNAME   / VIP_PASSWORD     -> the one shared VIP login you hand out
//   VVIP_USERNAME  / VVIP_PASSWORD    -> the one shared VVIP login you hand out
// There is no admin panel anymore — if you want to change any of these
// later, just edit the value in Vercel's Environment Variables and redeploy;
// the account is recreated fresh from env vars on every server start.
const FIXED_ACCOUNTS = [
  { role: 'owner', plan: 'owner', username: process.env.OWNER_USERNAME, password: process.env.OWNER_PASSWORD },
  { role: 'user', plan: 'vip', username: process.env.VIP_USERNAME, password: process.env.VIP_PASSWORD },
  { role: 'user', plan: 'vvip', username: process.env.VVIP_USERNAME, password: process.env.VVIP_PASSWORD }
];

let users = [];

async function ensureFixedAccounts() {
  let changed = false;
  for (const spec of FIXED_ACCOUNTS) {
    if (!spec.username || !spec.password) {
      console.warn(`⚠️  ${spec.plan.toUpperCase()}_USERNAME / ${spec.plan.toUpperCase()}_PASSWORD belum di-set di environment variables — akun ${spec.plan} tidak aktif.`);
      continue;
    }
    let existing = users.find((u) => u.plan === spec.plan && (spec.plan === 'owner' ? u.role === 'owner' : true));
    const passwordHash = await bcrypt.hash(spec.password, 10);
    if (existing) {
      if (existing.username !== spec.username || !(await bcrypt.compare(spec.password, existing.passwordHash).catch(() => false))) {
        existing.username = spec.username;
        existing.passwordHash = passwordHash;
        changed = true;
      }
    } else {
      users.push({
        id: crypto.randomUUID(),
        username: spec.username,
        passwordHash,
        role: spec.role,
        plan: spec.plan,
        planExpiresAt: null, // fixed accounts never expire on their own
        createdAt: Date.now(),
        usage: { date: todayStr(), count: 0 }
      });
      changed = true;
    }
  }
  if (changed) saveUsers();
}

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
users = loadUsers();
let usersReady = ensureFixedAccounts();

app.use(async (req, res, next) => {
  try {
    await usersReady;
    next();
  } catch (err) {
    next(err);
  }
});

app.use(session({
  // ⚠️ Also set SESSION_SECRET as a fixed env var in Vercel. If left on the
  // random fallback, every cold start / new instance gets a different
  // secret and can invalidate other people's login sessions.
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
  saveUsers();
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

// ⚠️ Maintenance mode is controlled 100% from Vercel env vars — nothing is
// hardcoded and nothing lives client-side, so users can't fake/hide it via
// devtools. Set these in Vercel: Project → Settings → Environment Variables:
//   MAINTENANCE_MESSAGE -> the text shown to users. Leave EMPTY/unset to
//                           keep the site fully live (overlay never shows).
//   MAINTENANCE_TITLE   -> optional custom title (has a default below).
// To turn maintenance ON: fill MAINTENANCE_MESSAGE and redeploy.
// To turn it OFF: clear MAINTENANCE_MESSAGE and redeploy.
app.get('/api/maintenance', (req, res) => {
  const message = (process.env.MAINTENANCE_MESSAGE || '').trim();
  const title = (process.env.MAINTENANCE_TITLE || '').trim() || '🛠 Sedang Maintenance';
  res.json({ active: message.length > 0, title, message });
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
    saveUsers();
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
