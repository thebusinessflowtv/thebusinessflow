(() => {
  const UUID_RE = /\/production\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const SUPABASE_URL = 'https://fykwalznmcrjgnyveagy.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_46tbOLOFhKqirGConFVg2w_xRQmmVli';
  let client = null;

  function getClient() {
    if (client) return client;
    if (!window.supabase?.createClient) throw new Error('Supabase não carregado.');
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    return client;
  }

  function currentProductionId() {
    const match = String(location.hash || '').match(UUID_RE);
    return match ? match[1] : null;
  }

  function failedAlert() {
    return [...document.querySelectorAll('.alert.danger')]
      .find((el) => /A produção falhou/i.test(el.textContent || '')) || null;
  }

  function notify(title, text, type = 'success') {
    const host = document.getElementById('toasts');
    if (!host) return;
    const item = document.createElement('div');
    item.className = `toast ${type === 'error' ? 'error' : 'success'}`;
    item.innerHTML = `<b>${title}</b>${text ? `<div>${text}</div>` : ''}`;
    host.appendChild(item);
    setTimeout(() => item.remove(), 4500);
  }

  async function retryProduction(productionId) {
    const sb = getClient();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error('Sua sessão expirou. Entre novamente no Control Center.');

    const response = await fetch(`${SUPABASE_URL}/functions/v1/mfcc-retry-production`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({ production_id: productionId })
    });

    const raw = await response.text();
    let result = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch { result = { message: raw }; }
    if (!response.ok) throw new Error(result?.message || result?.error || `Erro HTTP ${response.status}`);
    return result;
  }

  function installRetryButton() {
    const alert = failedAlert();
    if (!alert) return;
    if (alert.querySelector('#retryFailedProduction')) return;

    const productionId = currentProductionId();
    if (!productionId) return;

    const actions = document.createElement('div');
    actions.style.marginTop = '14px';
    actions.style.display = 'flex';
    actions.style.flexDirection = 'column';
    actions.style.alignItems = 'flex-start';
    actions.style.gap = '8px';

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'retryFailedProduction';
    button.className = 'btn danger';
    button.textContent = '↻ Corrigir erro e reiniciar produção';

    const status = document.createElement('div');
    status.id = 'retryFailedProductionStatus';
    status.className = 'muted';
    status.style.fontSize = '12px';
    status.style.lineHeight = '1.4';

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = 'Corrigindo e reiniciando…';
      status.textContent = 'Diagnóstico do erro e novo disparo em andamento…';

      try {
        const result = await retryProduction(productionId);
        status.textContent = result?.message || 'Erro corrigido e reinício enviado.';
        button.textContent = '✓ Reinício enviado';
        notify('Produção reiniciada', 'A correção foi aplicada e o vídeo voltou para a fila.');
        setTimeout(() => location.reload(), 900);
      } catch (error) {
        const message = error?.message || String(error);
        status.textContent = message;
        button.disabled = false;
        button.textContent = '↻ Tentar corrigir e reiniciar novamente';
        notify('Não foi possível reiniciar', message, 'error');
      }
    });

    actions.appendChild(button);
    actions.appendChild(status);
    alert.appendChild(actions);
  }

  const observer = new MutationObserver(() => installRetryButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(installRetryButton, 0));
  window.addEventListener('pageshow', () => setTimeout(installRetryButton, 0));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installRetryButton, { once: true });
  } else {
    installRetryButton();
  }
})();
