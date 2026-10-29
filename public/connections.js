const status = document.querySelector('#connection-status');
const show = (text) => {
  status.textContent = text;
};
async function request(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error ?? 'Connection unavailable.');
  return data;
}
const form = document.querySelector('#consent-form');
if (form)
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const data = await request('/api/connections/authorize', {
        requestId: new FormData(form).get('requestId'),
        consent: true,
      });
      location.assign(data.redirectTo);
    } catch (error) {
      show(error.message);
      button.disabled = false;
    }
  };
else {
  document.querySelector('#mcp-address').textContent = location.origin + '/mcp';
  try {
    await request('/api/account/me');
    const render = async () => {
      const data = await request('/api/connections');
      const list = document.querySelector('#connections-list');
      list.replaceChildren();
      for (const connection of data.connections) {
        const section = document.createElement('section'),
          name = document.createElement('h2'),
          info = document.createElement('p'),
          button = document.createElement('button');
        name.textContent = 'Codex';
        info.textContent =
          (connection.active ? 'Active' : 'Revoked or expired') +
          ' · ' +
          (connection.scopes ?? []).join(', ') +
          ' · expires ' +
          new Date(connection.expiresAt).toLocaleString();
        button.textContent = 'Revoke connection';
        button.disabled = !connection.active;
        button.onclick = async () => {
          button.disabled = true;
          try {
            await request('/api/connections/' + connection.id + '/revoke', {});
            show('Connection revoked.');
            await render();
          } catch (error) {
            show(error.message);
            button.disabled = false;
          }
        };
        section.append(name, info, button);
        list.append(section);
      }
      if (!data.connections.length) list.textContent = 'No active connections.';
    };
    await render();
  } catch (error) {
    show(error.message);
    const link = document.createElement('a');
    link.href = '/account?returnTo=%2Fconnections';
    link.textContent = 'Sign in';
    status.after(link);
  }
}
