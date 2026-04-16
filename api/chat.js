/* ================================================================
   HANAMORI CALYX AI — Vercel API Proxy
   By renzzzzofc18 | v5.1
   - Proxy ke OpenRouter AI
   - Support web search tools
   - Support max_tokens tinggi (4000+)
   - CORS enabled untuk akses dari browser
================================================================ */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL = 'openai/gpt-4o-mini'; // Ganti sesuai model OpenRouter lo

export default async function handler(req, res) {
  // CORS headers — wajib biar bisa diakses dari browser
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const body = req.body;

    // Build request to OpenRouter — forward semua parameter termasuk tools
    const orBody = {
      model: body.model || MODEL,
      max_tokens: body.max_tokens || 4000,
      temperature: body.temperature ?? 0.3,
      messages: body.messages || [],
    };

    // Forward tools kalau ada (web search, dll)
    if (body.tools && body.tools.length > 0) {
      orBody.tools = body.tools;
    }

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

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // Normalize response — handle tool_use blocks (web search)
    // Jika ada tool_use blocks, extract text saja ke format standard
    if (data.content && Array.isArray(data.content)) {
      const textOnly = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      // Return dalam format OpenRouter-compatible untuk main.js
      return res.status(200).json({
        choices: [{ message: { content: textOnly } }],
        _raw: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({
      error: { message: 'Server error: ' + err.message }
    });
  }
}
