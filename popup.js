window.onerror = (m) => { document.getElementById('log').textContent += 'ERRO JS: ' + m + '\n'; };

const logEl = document.getElementById('log');
const add = m => { logEl.textContent += m + '\n'; logEl.scrollTop = 1e9; };
chrome.runtime.onMessage.addListener(m => { if (m.type === 'log') add(m.msg); });

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        for (const u of performance.getEntriesByType('resource').map(r => r.name)) {
          const m = u.match(/[?&]userId=(\d+)/);
          if (u.includes('/api/posts/feed') && m) return m[1];
        }
        const s = JSON.stringify({ ...localStorage, ...sessionStorage });
        const m = s.match(/"userId"\s*:\s*"(\d+)"/) || s.match(/"id"\s*:\s*(\d{5,})/);
        return m ? m[1] : null;
      }
    });
    if (result && !document.getElementById('userId').value) {
      document.getElementById('userId').value = result;
      add('userId detectado: ' + result);
    }
  } catch (e) { add('sem acesso a pagina: ' + e.message); }
})();

document.getElementById('go').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const username = new URL(tab.url).pathname.split('/').filter(Boolean).pop();
  if (!username) return add('Abra a pagina de um perfil primeiro.');
  logEl.textContent = '';
  add('iniciando @' + username);
  chrome.runtime.sendMessage({
    type: 'start', username,
    userId: document.getElementById('userId').value.trim(),
    filtro: document.getElementById('filtro').value,
    modo: document.getElementById('modo').value,
    videos: document.getElementById('videos').checked,
    delay: Number(document.getElementById('delay').value) || 0
  }, (r) => { if (chrome.runtime.lastError) add('ERRO sendMessage: ' + chrome.runtime.lastError.message); });
};

document.getElementById('stop').onclick = () => chrome.runtime.sendMessage({ type: 'stop' });
