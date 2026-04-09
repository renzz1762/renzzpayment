// api/proxy.js — Vercel Serverless Function
// Taruh file ini di: /api/proxy.js dalam project Vercel kamu

export default async function handler(req, res) {
  // Allow all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const API_BASE = 'https://api.app.orbitcloud.web.id/api/v1';
  const API_KEY  = '2c6320be8b4cde1d22bc9e9e53aeb93769d03cb8ad641fde';

  // path comes as query param: /api/proxy?path=/home&pages=1
  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: 'missing path' });

  // rebuild query string (exclude "path" itself)
  const qs = new URLSearchParams(rest).toString();
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;

  try {
    const opts = {
      method: req.method,
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
    };
    if (req.method === 'POST' && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, opts);
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
