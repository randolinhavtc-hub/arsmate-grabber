const API = 'https://arsmate.com/api';
const PROXY = 'https://video-proxy.aroman-4f3.workers.dev';

let cancelado = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => chrome.runtime.sendMessage({ type: 'log', msg }).catch(() => {});
const basename = u => decodeURIComponent(u.split('?')[0].split('/').pop() || 'arquivo');

async function acharUserId(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        for (const u of performance.getEntriesByType('resource').map(r => r.name)) {
          if (u.includes('/api/posts/feed')) {
            const m = u.match(/[?&]userId=(\d+)/);
            if (m) return m[1];
          }
        }
        return null;
      }
    });
    return result || null;
  } catch { return null; }
}

async function pegarCriador(username) {
  const r = await fetch(`${API}/creators/${encodeURIComponent(username)}`, { credentials: 'include' });
  const j = await r.json();
  if (!j.success || !j.creator) throw new Error('perfil nao encontrado');
  return j.creator;
}

async function listarPosts(userId, criadorId, filtro) {
  const posts = [];
  for (let page = 1; page <= 200 && !cancelado; page++) {
    const q = new URLSearchParams({
      creatorId: criadorId, limit: '20', page: String(page),
      contentFilter: filtro, ordenacion: 'recientes', filtroMedia: 'todos'
    });
    if (userId) q.set('userId', userId);
    const r = await fetch(`${API}/posts/feed?${q}`, { credentials: 'include' });
    const j = await r.json();
    if (!j.success || !j.posts?.length) break;
    posts.push(...j.posts);
    log(`pagina ${page} -> ${posts.length} posts`);
    if (!j.hasMore) break;
    await sleep(400);
  }
  return posts;
}

async function assinar(userId, postId, mediaId) {
  const corpo = { postId };
  if (mediaId) corpo.mediaId = mediaId;
  if (userId) corpo.userId = userId;
  const r = await fetch(`${API}/image/generate-token`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo)
  });
  let j = {};
  try { j = await r.json(); } catch {}
  return { status: r.status, ...j };
}

async function resolverPost(userId, post) {
  const itens = (post.mediaItems || []).filter(i => i.type === 'image');
  const vistos = new Set();
  const saida = [];
  let restrito = false;

  for (const item of itens) {
    if (cancelado) break;
    if (item.url) {
      const nome = basename(item.url);
      if (!vistos.has(nome)) { vistos.add(nome); saida.push({ url: item.url, nome }); }
      continue;
    }
    const j = await assinar(userId, post.id, item.id);
    if (j.imageUrl) {
      const nome = basename(j.imageUrl);
      if (!vistos.has(nome)) { vistos.add(nome); saida.push({ url: j.imageUrl, nome }); }
    } else if (j.restricted) restrito = true;
    await sleep(150);
  }
  return { itens, saida, restrito };
}

async function tentarBlur(criadorId, post, itens) {
  const alvos = [...itens.map(i => i.id), post.id].filter(Boolean);
  for (const alvo of alvos) {
    const url = `${PROXY}/video/${criadorId}/${alvo}/thumbnail_blur.jpg`;
    try {
      const r = await fetch(url);
      const t = r.headers.get('content-type') || '';
      if (r.ok && t.startsWith('image/')) return await r.blob();
    } catch {}
    await sleep(120);
  }
  return null;
}

async function baixarVideo(userId, post, item, pasta) {
  let master = item.hlsManifestUrl || post.media?.hlsManifestUrl;
  if (!master) {
    const r = await fetch(`${API}/video/generate-token`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, postId: post.id })
    });
    const j = await r.json().catch(() => ({}));
    if (!j.success || !j.secureUrl) return false;
    master = j.secureUrl;
  }

  const mres = await fetch(master);
  if (!mres.ok) return false;
  const mtxt = await mres.text();

  const variantes = [...mtxt.matchAll(/^([^#\s][^\s]*\.m3u8)/gm)].map(m => new URL(m[1].trim(), master).href);
  if (!variantes.length) return false;
  const escolhida = variantes[variantes.length - 1];

  const vres = await fetch(escolhida);
  if (!vres.ok) return false;
  const vtxt = await vres.text();

  const segmentos = [...vtxt.matchAll(/^([^#\s][^\s]*\.(?:ts|m4s|mp4))/gm)].map(m => new URL(m[1].trim(), escolhida).href);
  if (!segmentos.length) return false;

  const partes = [];
  let bytes = 0;
  for (const seg of segmentos) {
    if (cancelado) break;
    const r = await fetch(seg);
    if (!r.ok) continue;
    const b = new Uint8Array(await r.arrayBuffer());
    partes.push(b); bytes += b.length;
    await sleep(120);
  }
  if (!partes.length) return false;

  await salvar(new Blob(partes, { type: 'video/mp2t' }), `${pasta}/${post.id}_video.ts`);
  log(`video ${post.id} (${(bytes / 1048576).toFixed(1)} MB, ${segmentos.length} segmentos)`);
  return true;
}

async function blobParaDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

async function salvar(blob, caminho) {
  await chrome.downloads.download({
    url: await blobParaDataUrl(blob),
    filename: caminho.replace(/[\\/:*?"<>|]/g, '_'),
    conflictAction: 'uniquify',
    saveAs: false
  });
}

async function baixarUrl(url, caminho) {
  for (let t = 1; t <= 2; t++) {
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    if (r.ok && ct.startsWith('image/')) { await salvar(await r.blob(), caminho); return true; }
    if (r.status !== 403 && r.status !== 429) return false;
    await sleep(700);
  }
  return false;
}

async function executar({ username, filtro, modo, delay, userId: manual, videos }) {
  cancelado = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const userId = manual || (await acharUserId(tab.id));
  if (userId) log(`userId: ${userId}`); else log('sessao anonima');

  const criador = await pegarCriador(username);
  const pasta = `arsmate/${username}_${filtro}`;
  log(`perfil: @${criador.username} (id ${criador.id})`);

  for (const [rotulo, url] of [['avatar', criador.avatar], ['capa', criador.cover]]) {
    if (url && await baixarUrl(url, `arsmate/${username}/_${rotulo}.jpg`)) log(`ok _${rotulo}`);
  }

  if (modo === 'dom') {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const s = new Set();
        document.querySelectorAll('img[src]').forEach(e => s.add(e.src));
        document.querySelectorAll('[style*="video-proxy"]').forEach(e => {
          (e.getAttribute('style').match(/https:\/\/[^"')]+/g) || []).forEach(u => s.add(u));
        });
        return [...s].filter(u => !u.includes('/profile/'));
      }
    });
    let n = 0;
    for (const url of [...new Set(result || [])]) {
      if (cancelado) break;
      if (await baixarUrl(url, `${pasta}/dom_${++n}_${basename(url)}`)) log(`ok dom_${n}`);
      await sleep(delay);
    }
    log(`FIM DOM: ${n} tentativas`);
    return n;
  }

  const posts = await listarPosts(userId, criador.id, filtro);
  log(`${posts.length} posts coletados`);

  let full = 0, blur = 0, vids = 0, indisponivel = 0, restritoCount = 0, semObjetoCount = 0;

  for (const post of posts) {
    if (cancelado) break;
    const { itens, saida, restrito } = await resolverPost(userId, post);

    for (const alvo of saida) {
      if (cancelado) break;
      const ext = (alvo.nome.split('.').pop() || 'jpg').toLowerCase();
      const caminho = `${pasta}/${post.id}_${alvo.nome.replace(/\.[^.]+$/, '')}.${ext}`;
      if (await baixarUrl(alvo.url, caminho)) {
        full++;
        log(`full ${post.id}/${alvo.nome}`);
      } else {
        indisponivel++;
        if (restrito) restritoCount++; else semObjetoCount++;
        log(`x ${post.id}/${alvo.nome} ${restrito ? '(restrito)' : '(sem objeto)'}`);
      }
      await sleep(delay);
    }

    if (videos) {
      for (const item of (post.mediaItems || []).filter(i => i.type === 'video')) {
        if (cancelado) break;
        if (await baixarVideo(userId, post, item, pasta)) vids++;
        else if (!saida.length) {
          indisponivel++;
          if (restrito) restritoCount++; else semObjetoCount++;
          log(`x video ${post.id} ${restrito ? '(restrito)' : '(sem objeto)'}`);
        }
        await sleep(delay);
      }
    }

    if (!saida.length && itens.length) {
      const blob = await tentarBlur(criador.id, post, itens);
      if (blob) {
        await salvar(blob, `${pasta}/${post.id}_blur.jpg`);
        blur++;
        log(`blur ${post.id}`);
      } else {
        indisponivel++;
        if (restrito) restritoCount++; else semObjetoCount++;
        log(`x ${post.id} ${restrito ? '(restrito)' : '(sem objeto)'}`);
      }
      await sleep(delay);
    }
  }

  log(`FIM: ${full} full, ${blur} blur, ${vids} videos, ${indisponivel} indisponiveis (${restritoCount} restrito, ${semObjetoCount} sem objeto)`);
  return full + blur + vids;
}

chrome.runtime.onMessage.addListener((msg, _s, responder) => {
  if (msg.type === 'start') {
    executar(msg).then(n => responder({ ok: true, total: n }))
                 .catch(e => { log('ERRO: ' + e.message); responder({ ok: false }); });
    return true;
  }
  if (msg.type === 'stop') { cancelado = true; responder({ ok: true }); }
});
