/* ================================================================
   HANAMORI CALYX AI — Vercel API Proxy v5.4
   Pakai Anthropic API langsung (Claude) — lebih stabil
================================================================ */

export default async function handler(req, res) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY belum di-set di Vercel.' } });
  }

  try {
    const body = req.body;
    const messages = (body.messages || []).filter(m => m.role !== 'system');
    const systemMsg = (body.messages || []).find(m => m.role === 'system');

    // Normalize message content (handle array format dari frontend)
    const normalizedMessages = messages.map(m => {
      if (Array.isArray(m.content)) {
        // Ada image atau multi-part
        const parts = m.content.map(part => {
          if (part.type === 'text') return { type: 'text', text: part.text };
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            if (url.startsWith('data:')) {
              const [meta, data] = url.split(',');
              const mediaType = meta.replace('data:', '').replace(';base64', '');
              return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
            }
          }
          return { type: 'text', text: JSON.stringify(part) };
        });
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content };
    });

    const anthropicBody = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: body.max_tokens || 4000,
      messages: normalizedMessages,
      ...(systemMsg ? { system: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) } : {}),
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: { message: data?.error?.message || 'Anthropic API error' } });
    }

    // Normalize ke format OpenAI-compatible biar main.js tidak perlu diubah
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }],
    });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: { message: 'Server error: ' + err.message } });
  }
}
