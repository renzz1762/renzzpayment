/* ================================================================
   HANAMORI CALYX AI — Vercel API Proxy
   By renzzzzofc18 | v5.2
================================================================ */

const MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

export default async function handler(req, res) {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: { message: 'API key tidak ditemukan. Set OPENROUTER_API_KEY di Vercel env.' } });
  }

  try {
    const body = req.body;

    // Ganti openrouter/free ke model valid — model ID itu tidak bisa dikirim langsung ke API
    let model = body.model || MODEL;
    if (!model || model === 'openrouter/free') model = MODEL;

    const orBody = {
      model: model,
      max_tokens: body.max_tokens || 4000,
      temperature: body.temperature ?? 0.3,
      messages: body.messages || [],
    };

    if (body.tools && body.tools.length > 0) orBody.tools = body.tools;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://hanamori-calyx.vercel.app',
        'X-Title': 'HANAMORI CALYX AI v5.0',
      },
      body: JSON.stringify(orBody),
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    if (data.content && Array.isArray(data.content)) {
      const textOnly = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return res.status(200).json({ choices: [{ message: { content: textOnly } }], _raw: data });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
}
