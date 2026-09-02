// Vercel Serverless Function — proxy ke Jikan API (unofficial MyAnimeList API)
// Tidak butuh npm install apapun: pakai `fetch` bawaan Node.js 18+ di Vercel.
//
// Endpoint yang tersedia:
//   /api/api?action=search&q=<judul>&limit=10
//   /api/api?action=detail&id=<mal_id>
//   /api/api?action=episodes&id=<mal_id>&page=1
//   /api/api?action=characters&id=<mal_id>

const JIKAN_BASE = "https://api.jikan.moe/v4";

module.exports = async function handler(req, res) {
  // Izinkan dipanggil dari frontend manapun (aman karena cuma proxy data publik)
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { action, q, id, limit, page } = req.query;

  try {
    let url;

    if (action === "search") {
      if (!q) return res.status(400).json({ error: "Parameter 'q' wajib diisi" });
      url = `${JIKAN_BASE}/anime?q=${encodeURIComponent(q)}&limit=${limit || 12}`;
    } else if (action === "detail") {
      if (!id) return res.status(400).json({ error: "Parameter 'id' wajib diisi" });
      url = `${JIKAN_BASE}/anime/${id}/full`;
    } else if (action === "episodes") {
      if (!id) return res.status(400).json({ error: "Parameter 'id' wajib diisi" });
      url = `${JIKAN_BASE}/anime/${id}/episodes?page=${page || 1}`;
    } else if (action === "characters") {
      if (!id) return res.status(400).json({ error: "Parameter 'id' wajib diisi" });
      url = `${JIKAN_BASE}/anime/${id}/characters`;
    } else {
      return res.status(400).json({
        error: "Parameter 'action' tidak valid. Gunakan: search, detail, episodes, characters"
      });
    }

    const response = await fetch(url);

    if (!response.ok) {
      // Jikan rate-limit-nya ketat, teruskan status aslinya biar frontend bisa handle
      return res.status(response.status).json({ error: `Jikan API error: ${response.status}` });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: `Gagal mengambil data: ${error.message}` });
  }
};
