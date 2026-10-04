'use strict';
(() => {
  const api = window.chartsHubShell;
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const panel = document.getElementById('content-state'), title = document.getElementById('state-title');
  const detail = document.getElementById('state-detail'), retry = document.getElementById('retry');
  let activeTab = 'catalogue', received = 0;
  function render(state) {
    if (!state || !['catalogue', 'companion'].includes(state.activeTab) || !state.tabs) return;
    activeTab = state.activeTab;
    const current = state.tabs[activeTab], name = activeTab === 'catalogue' ? 'catalogue' : 'Companion';
    for (const tab of tabs) {
      const selected = tab.dataset.tab === activeTab;
      tab.hidden = tab.dataset.tab === 'companion' && !state.companionAvailable;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      tab.setAttribute('aria-busy', String(Boolean(state.tabs[tab.dataset.tab]?.loading)));
      tab.querySelector('.tab-spinner').hidden = !state.tabs[tab.dataset.tab]?.loading;
    }
    panel.setAttribute('aria-labelledby', activeTab + '-tab');
    panel.setAttribute('aria-busy', String(Boolean(current.loading)));
    panel.hidden = Boolean(current.ready && !current.error);
    panel.classList.toggle('failed', Boolean(current.error));
    title.textContent = current.error ? `${activeTab === 'catalogue' ? 'Catalogue' : 'Companion'} indisponible` : `Chargement du ${name}…`;
    detail.textContent = current.error || (activeTab === 'catalogue' ? 'Votre espace ChartsHub s’ouvre ici.' : 'Vos widgets, filtres et réglages seront prêts dans un instant.');
    retry.hidden = !current.error;
    if (state.theme && ['dark', 'light'].includes(state.theme.mode) && /^#[a-f0-9]{6}$/i.test(state.theme.accent)) {
      document.documentElement.dataset.theme = state.theme.mode;
      document.documentElement.style.setProperty('--accent', state.theme.accent);
    }
    document.body.classList.toggle('mac', state.platform === 'darwin');
    document.querySelector('.shortcut').hidden = !state.companionAvailable;
  }
  function failed() {
    panel.hidden = false; panel.classList.add('failed'); panel.setAttribute('aria-busy', 'false');
    title.textContent = 'Navigation indisponible'; detail.textContent = 'Fermez puis rouvrez ChartsHub pour retrouver vos onglets.'; retry.hidden = true;
  }
  function select(name) { api.selectTab(name).catch(failed); }
  for (let index = 0; index < tabs.length; index++) {
    const tab = tabs[index];
    tab.addEventListener('click', () => select(tab.dataset.tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const available = tabs.filter(item => !item.hidden);
      const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1) : available[(available.indexOf(tab) + 1) % available.length];
      next.focus(); select(next.dataset.tab);
    });
  }
  retry.addEventListener('click', () => select(activeTab));
  const unsubscribe = api.onState(state => { received++; render(state); });
  api.getState().then(state => { if (received === 0) render(state); }).catch(failed);
  window.addEventListener('unload', unsubscribe, { once: true });
})();
