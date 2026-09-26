(() => {
  const UUID_RE = /\/production\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  function currentProductionId() {
    const match = String(location.hash || '').match(UUID_RE);
    return match ? match[1] : null;
  }

  function failedAlert() {
    return [...document.querySelectorAll('.alert.danger')]
      .find((el) => /A produção falhou/i.test(el.textContent || '')) || null;
  }

  function installRetryButton() {
    const alert = failedAlert();
    if (!alert) return;
    if (alert.querySelector('#retryFailedProduction')) return;

    const productionId = currentProductionId();
    if (!productionId) return;

    const actions = document.createElement('div');
    actions.style.marginTop = '14px';

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'retryFailedProduction';
    button.className = 'btn danger';
    button.textContent = '↻ Corrigir erro e reiniciar produção';

    const status = document.createElement('div');
    status.id = 'retryFailedProductionStatus';
    status.className = 'muted';
    status.style.marginTop = '8px';
    status.style.fontSize = '12px';

    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = 'Corrigindo e reiniciando…';
      status.textContent = 'Aplicando a correção e preparando um novo processamento seguro…';

      try {
        const result = await invoke('mfcc-retry-production', { production_id: productionId });
        status.textContent = result?.message || 'Produção reiniciada.';
        button.textContent = '✓ Reinício enviado';
        if (typeof toast === 'function') {
          toast('Produção reiniciada', 'A correção foi aplicada e a produção voltou para a fila.', 'success');
        }
        setTimeout(() => {
          if (typeof route === 'function') route();
          else location.reload();
        }, 700);
      } catch (error) {
        const message = typeof errMsg === 'function' ? errMsg(error) : (error?.message || String(error));
        status.textContent = message;
        button.disabled = false;
        button.textContent = '↻ Tentar corrigir e reiniciar novamente';
        if (typeof toast === 'function') toast('Não foi possível reiniciar', message, 'error');
      }
    });

    actions.appendChild(button);
    actions.appendChild(status);
    alert.appendChild(actions);
  }

  const observer = new MutationObserver(() => installRetryButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(installRetryButton, 0));
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installRetryButton, { once: true });
  } else {
    installRetryButton();
  }
})();
