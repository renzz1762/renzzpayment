const thumbCache = {};
let gfxItems = null, bgItems = null;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('yearNow').textContent = new Date().getFullYear();
  renderVideos();
});

// ===== TAB SWITCH =====
function switchTab(name, btn){
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');

  if(name === 'gfx' && gfxItems === null) loadBoard('gfx', BAHAN_GFX_BOARD);
  if(name === 'bg' && bgItems === null) loadBoard('bg', BACKGROUND_GFX_BOARD);
}

// ===== HELPERS =====
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function slug(str){
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') || 'file';
}
function emptyState(icon, msg, extraHtml){
  return `<div class="empty-state"><i class="fa-solid ${icon}"></i><p>${msg}</p>${extraHtml||''}</div>`;
}
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._tm);
  showToast._tm = setTimeout(() => t.classList.remove('show'), 3200);
}

// ===== DOWNLOAD (VIDEO & GAMBAR) =====
async function forceDownload(url, filename){
  try{
    const res = await fetch(url, { mode: 'cors' });
    if(!res.ok) throw new Error('fetch gagal');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(blobUrl);
    showToast('Download berhasil!');
  }catch(e){
    window.open(url, '_blank');
    showToast('Dibuka di tab baru — tekan lama / klik kanan lalu "Save As" untuk simpan');
  }
}

async function downloadVideo(link, btn){
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Proses...';
  try{
    const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(link)}`;
    const res = await fetch(api);
    const json = await res.json();
    if(json.code !== 0 || !json.data || !json.data.play) throw new Error('API gagal ambil video');
    let playUrl = json.data.play;
    if(playUrl.startsWith('/')) playUrl = 'https://www.tikwm.com' + playUrl;
    await forceDownload(playUrl, `mentahan-${json.data.id || Date.now()}.mp4`);
  }catch(e){
    showToast('Gagal download otomatis, coba tombol TikTok / TikTok Lite untuk buka manual');
  }finally{
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

// ===== THUMBNAIL DARI LINK TIKTOK =====
async function getTiktokThumb(link){
  if(thumbCache[link]) return thumbCache[link];
  try{
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(link)}`);
    const json = await res.json();
    thumbCache[link] = json.thumbnail_url || '';
    return thumbCache[link];
  }catch(e){
    return '';
  }
}

async function loadThumb(p){
  const url = await getTiktokThumb(p.tiktok);
  const img = document.getElementById(`thumb-${p.id}`);
  const loading = document.getElementById(`loading-${p.id}`);
  if(!img) return;
  if(url){
    img.src = url;
    img.style.display = 'block';
    if(loading) loading.style.display = 'none';
  }else if(loading){
    loading.innerHTML = '<i class="fa-solid fa-video"></i>';
  }
}

// ===== RENDER: VIDEO =====
function renderVideos(){
  const q = document.getElementById('searchVideo').value.toLowerCase();
  const grid = document.getElementById('videoGrid');
  const filtered = PRODUCTS.filter(p =>
    p.title.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q)
  );
  if(!filtered.length){ grid.innerHTML = emptyState('fa-video-slash', 'Belum ada mentahan video'); return; }

  grid.innerHTML = filtered.map(p => `
    <div class="card video-card">
      <div class="thumb-wrap">
        <img class="thumb-img" id="thumb-${p.id}" src="" alt="${escapeHtml(p.title)}" style="display:none">
        <div class="thumb-loading" id="loading-${p.id}"><i class="fa-solid fa-spinner fa-spin"></i></div>
        <span class="badge-cat">${escapeHtml(p.category || 'mentahan')}</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(p.title)}</div>
        <div class="card-actions">
          <a href="${p.tiktok}" target="_blank" class="btn-outline" title="Buka di TikTok"><i class="fa-brands fa-tiktok"></i></a>
          ${p.tiktokLite ? `<a href="${p.tiktokLite}" target="_blank" class="btn-outline" title="Buka di TikTok Lite"><i class="fa-solid fa-bolt"></i></a>` : ''}
          <button class="btn-download" onclick="downloadVideo('${p.tiktok}', this)"><i class="fa-solid fa-download"></i> Download</button>
        </div>
      </div>
    </div>
  `).join('');

  filtered.forEach(loadThumb);
}

// ===== AMBIL ISI FOLDER PINTEREST VIA RSS =====
function toRssUrl(boardUrl){
  if(!boardUrl || !boardUrl.includes('pinterest.com')) return null;
  let clean = boardUrl.split('?')[0];
  if(!clean.endsWith('/')) clean += '/';
  return clean + 'rss/';
}

async function fetchPinterestBoard(boardUrl){
  const rss = toRssUrl(boardUrl);
  if(!rss) return [];
  const proxied = `https://corsproxy.io/?url=${encodeURIComponent(rss)}`;
  const res = await fetch(proxied);
  if(!res.ok) throw new Error('proxy gagal');
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const items = [...doc.querySelectorAll('item')];
  return items.map((item, i) => {
    const title = item.querySelector('title')?.textContent?.trim() || `GFX ${i + 1}`;
    const link = item.querySelector('link')?.textContent || boardUrl;
    const desc = item.querySelector('description')?.textContent || '';
    const match = desc.match(/src="([^"]+)"/);
    const image = match ? match[1] : '';
    return { id: i + 1, title, image, link };
  }).filter(p => p.image);
}

async function loadBoard(kind, boardUrl){
  const gridId = kind === 'gfx' ? 'gfxGrid' : 'bgGrid';
  const grid = document.getElementById(gridId);
  grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Memuat isi folder Pinterest...</p></div>`;
  try{
    const items = await fetchPinterestBoard(boardUrl);
    if(kind === 'gfx') gfxItems = items; else bgItems = items;
    if(kind === 'gfx') renderGfx(); else renderBg();
  }catch(e){
    if(kind === 'gfx') gfxItems = []; else bgItems = [];
    grid.innerHTML = emptyState('fa-triangle-exclamation',
      'Gagal narik isi folder otomatis',
      `<a href="${boardUrl}" target="_blank" class="btn-outline-wide" style="margin-top:10px;display:inline-flex"><i class="fa-solid fa-up-right-from-square"></i> Buka Folder di Pinterest</a>`
    );
  }
}

// ===== RENDER: BAHAN GFX =====
function renderGfx(){
  if(gfxItems === null) return;
  const q = document.getElementById('searchGfx').value.toLowerCase();
  const grid = document.getElementById('gfxGrid');
  const filtered = gfxItems.filter(g => g.title.toLowerCase().includes(q));
  if(!filtered.length){ grid.innerHTML = emptyState('fa-layer-group', 'Belum ada bahan GFX'); return; }

  grid.innerHTML = filtered.map(g => `
    <div class="card gfx-card">
      <div class="thumb-wrap" onclick='openLightbox(${JSON.stringify(g.image)}, ${JSON.stringify(g.title)})'>
        <img class="thumb-img" src="${g.image}" alt="${escapeHtml(g.title)}" loading="lazy">
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(g.title)}</div>
        <div class="card-actions">
          <button class="btn-download" onclick="forceDownload('${g.image}', '${slug(g.title)}.jpg')"><i class="fa-solid fa-download"></i> Download</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ===== RENDER: BACKGROUND GFX =====
function renderBg(){
  if(bgItems === null) return;
  const q = document.getElementById('searchBg').value.toLowerCase();
  const grid = document.getElementById('bgGrid');
  const filtered = bgItems.filter(b => b.title.toLowerCase().includes(q));
  if(!filtered.length){ grid.innerHTML = emptyState('fa-mountain-sun', 'Belum ada background GFX'); return; }

  grid.innerHTML = filtered.map(b => `
    <div class="card bg-card">
      <div class="thumb-wrap" onclick='openLightbox(${JSON.stringify(b.image)}, ${JSON.stringify(b.title)})'>
        <img class="thumb-img" src="${b.image}" alt="${escapeHtml(b.title)}" loading="lazy">
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(b.title)}</div>
        <div class="card-actions">
          <button class="btn-download" onclick="forceDownload('${b.image}', '${slug(b.title)}.jpg')"><i class="fa-solid fa-download"></i> Download</button>
        </div>
      </div>
    </div>
  `).join('');
}

// ===== LIGHTBOX =====
function openLightbox(src, title){
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxTitle').textContent = title;
  const dlBtn = document.getElementById('lightboxDownloadBtn');
  dlBtn.onclick = () => forceDownload(src, slug(title) + '.jpg');
  document.getElementById('imgLightbox').classList.add('show');
}
function closeLightbox(e){
  if(e.target.id === 'imgLightbox' || e.target.closest('.btn-close')){
    document.getElementById('imgLightbox').classList.remove('show');
  }
}