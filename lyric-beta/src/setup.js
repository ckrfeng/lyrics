'use strict';
const el = id => document.getElementById(id);
const api = window.verseSetup;
api.init().then(data => {
  el('client-id').value = data.clientId; el('redirect').textContent = data.redirectUri;
  el('message').textContent = data.message || (!data.shortcutAvailable ? 'The show/hide shortcut is in use by another app. Use the menu bar.' : '');
});
el('connect-form').onsubmit = async event => {
  event.preventDefault(); el('connect').disabled = true; el('client-id').disabled = true; el('cancel').hidden = false;
  el('message').textContent = 'Finish connecting in your browser. This expires in three minutes.';
  try { const result = await api.connect(el('client-id').value.trim()); if (!result.ok) el('message').textContent = result.message; }
  catch { el('message').textContent = 'Could not connect. Please try again.'; }
  finally { el('connect').disabled = false; el('client-id').disabled = false; el('cancel').hidden = true; }
};
el('cancel').onclick = () => api.cancel(); el('demo').onclick = () => api.demo();
el('dashboard').onclick = () => api.openHelp('dashboard'); el('privacy').onclick = () => api.openHelp('privacy');
