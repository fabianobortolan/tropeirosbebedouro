// Service Worker - Modo Palco Offline
// Cache cifras, áudios e assets do app para funcionar sem internet

const APP_CACHE = 'tropeiros-app-v3';
const SONGS_CACHE = 'tropeiros-songs-v3';
const AUDIO_CACHE = 'tropeiros-audio-v3';

// Assets estáticos do app (shell)
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ─── Install: pré-cacheia o shell ───────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ─── Activate: limpa caches antigos ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const validCaches = [APP_CACHE, SONGS_CACHE, AUDIO_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !validCaches.includes(key))
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch: estratégia por tipo de recurso ───────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora requisições não-GET e chrome-extension
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // 1. Áudios (mp3, wav, ogg, m4a, aac) → Cache First, depois rede
  if (isAudioRequest(url)) {
    event.respondWith(cacheFirst(request, AUDIO_CACHE));
    return;
  }

  // 2. API de músicas/cifras (supabase storage, PDFs, imagens de solo) → Network First com fallback cache
  if (isSongDataRequest(url)) {
    event.respondWith(networkFirst(request, SONGS_CACHE));
    return;
  }

  // 3. API REST/GraphQL (dados dinâmicos) → Network Only (sem cache)
  if (isApiRequest(url)) {
    return; // deixa passar sem interceptar
  }

  // 4. Assets estáticos do app (JS, CSS, fontes, imagens) → Cache First
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, APP_CACHE));
    return;
  }

  // 5. Navegação (HTML) → Network First com fallback para index.html (SPA)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match('/index.html')
      )
    );
    return;
  }
});

// ─── Estratégias de cache ────────────────────────────────────────────────────

// Cache First: serve do cache; se não tiver, busca na rede e armazena
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.status === 200) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Network First: tenta rede; se falhar, serve do cache
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── Helpers de classificação ────────────────────────────────────────────────

function isAudioRequest(url) {
  return /\.(mp3|wav|ogg|m4a|aac|flac|mid|midi)(\?|$)/i.test(url.pathname);
}

function isSongDataRequest(url) {
  // Supabase Storage: só arquivos públicos (PDFs, imagens de solo).
  // NUNCA o banco (/rest/v1), o login (/auth/v1) ou funções (/functions/v1):
  // essas respostas dependem do usuário logado e não podem ir para o cache.
  if (url.hostname.includes('supabase.co')) return url.pathname.startsWith('/storage/v1/object/public/');
  // PDFs e imagens de partitura/solo
  if (/\.(pdf|png|jpg|jpeg|webp|svg)(\?|$)/i.test(url.pathname)) return true;
  return false;
}

function isApiRequest(url) {
  // Endpoints dinâmicos (banco, login, funções do Supabase e APIs em geral)
  return (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('base44.com') ||
    url.pathname.startsWith('/api/')
  );
}

function isStaticAsset(url) {
  return /\.(js|css|woff2?|ttf|eot|ico)(\?|$)/i.test(url.pathname);
}

// ─── Mensagem para pré-cachear músicas sob demanda ───────────────────────────
// O app pode enviar: postMessage({ type: 'CACHE_SONG', urls: [...] })
self.addEventListener('message', async (event) => {
  if (event.data?.type === 'CACHE_SONG') {
    const urls = event.data.urls || [];
    const [songCache, audioCache] = await Promise.all([
      caches.open(SONGS_CACHE),
      caches.open(AUDIO_CACHE),
    ]);

    for (const url of urls) {
      try {
        const response = await fetch(url);
        if (response && response.status === 200) {
          const isAudio = isAudioRequest(new URL(url));
          if (isAudio) {
            await audioCache.put(url, response);
          } else {
            await songCache.put(url, response);
          }
        }
      } catch {
        // URL inacessível, ignora
      }
    }

    // Confirma para o app
    event.source?.postMessage({ type: 'CACHE_SONG_DONE', urls });
  }

  // Limpa caches de músicas (útil para liberar espaço)
  if (event.data?.type === 'CLEAR_SONG_CACHE') {
    await Promise.all([
      caches.delete(SONGS_CACHE),
      caches.delete(AUDIO_CACHE),
    ]);
    event.source?.postMessage({ type: 'CACHE_CLEARED' });
  }
});
