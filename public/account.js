/* global history */
const $ = (selector) => document.querySelector(selector);
const panels = [
  'login',
  'register',
  'request-reset',
  'verify',
  'reset',
  'profile',
  'check-email',
  'policies',
];
const initial = new URL(location.href);
let verificationToken = initial.searchParams.get('verify') ?? '',
  resetToken = initial.searchParams.get('reset') ?? '',
  busy = false,
  policies = null,
  currentUser = null;
// Tokens stay only in this page's memory, never in persistent browser storage.
if (verificationToken || resetToken) history.replaceState(null, '', '/account');
function status(message, error = false) {
  const node = $('#account-status');
  node.hidden = false;
  node.textContent = message;
  node.className = error ? 'warning' : 'help';
  node.setAttribute('aria-live', error ? 'assertive' : 'polite');
  node.focus();
}
function panel(name, { focus = true } = {}) {
  for (const key of panels) $('#' + key + '-panel').hidden = key !== name;
  $('#account-navigation').hidden = [
    'verify',
    'reset',
    'profile',
    'check-email',
    'policies',
  ].includes(name);
  for (const button of document.querySelectorAll('[data-account-panel]')) {
    if (button.dataset.accountPanel === name) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (focus) $('#' + name + '-heading').focus();
}
function policiesRequired(user = currentUser) {
  if (!policies?.enforced) return false;
  return typeof policies.required === 'boolean'
    ? policies.required
    : !user?.policyAcceptance ||
        user.policyAcceptance.termsVersion !== policies.termsVersion ||
        user.policyAcceptance.privacyVersion !== policies.privacyVersion;
}
function policyReceipt(terms, privacy) {
  if (!policies?.termsVersion || !policies?.privacyVersion ||
      !policies.documents?.terms?.sha256 || !policies.documents?.privacy?.sha256)
    throw Error('Current policies could not be loaded. Reload this page before continuing.');
  if (!$(terms).checked || !$(privacy).checked)
    throw Error('Accept the Terms of service and acknowledge the Privacy notice to continue.');
  return {
    termsVersion: policies.termsVersion,
    privacyVersion: policies.privacyVersion,
    termsDigest: policies.documents.terms.sha256,
    privacyDigest: policies.documents.privacy.sha256,
    termsAccepted: true,
    privacyAcknowledged: true,
  };
}
function policyInfo() {
  if (policies?.termsVersion && policies?.privacyVersion) {
    $('#register-policy-status').textContent =
      `Terms ${policies.termsVersion} · Privacy ${policies.privacyVersion}`;
    $('#policy-versions').textContent = $('#register-policy-status').textContent;
  }
}
function showUser(user) {
  const returnTo = initial.searchParams.get('returnTo');
  if (
    returnTo &&
    (returnTo === '/connections' || returnTo.startsWith('/oauth/authorize?')) &&
    !returnTo.includes(String.fromCharCode(92)) &&
    !Array.from(returnTo).some((c) => c.charCodeAt(0) < 32) &&
    !policiesRequired(user)
  ) {
    location.assign(returnTo);
    return;
  }
  currentUser = user;
  $('#account-name').textContent = user.name ?? '';
  $('#account-email').textContent = user.email ?? '';
  $('#account-verification').textContent =
    user.emailVerified || user.verified || user.verifiedAt ? 'Verified' : 'Not verified';
  $('#account-workspace-link').hidden = policiesRequired(user);
  $('#review-policies').hidden = !policiesRequired(user);
  if (policiesRequired(user)) {
    $('#policy-form').reset();
    panel('policies');
  } else panel('profile');
}
async function request(path, body, method = 'POST') {
  let response;
  try {
    response = await fetch('/api/account' + (path ? '/' + path : ''), {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...((path === 'accept-policies' || method === 'DELETE') && currentUser?.id
          ? { 'X-Rolemorrow-Account-ID': currentUser.id }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw Error('Could not reach the account service. Check your connection and try again.');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error('The account service could not respond. Please try again.');
  }
  if (!response.ok) {
    if (response.status === 409 && response.headers.get('X-Rolemorrow-Account-Mismatch') === '1')
      throw Error(
        'A different account is signed in. Reload this account page before accepting policies or deleting an account.',
      );
    if (response.status === 429)
      throw Error('Too many attempts. Wait a little before trying again.');
    if (response.status === 401)
      throw Error('We could not confirm these sign-in details. Check your email and password.');
    if (response.status === 403)
      throw Error('This action could not be confirmed. Verify your email or request a new link.');
    if (response.status === 428)
      throw Error(
        'Review the current Terms of service and Privacy notice before continuing. Reload if the policy versions changed.',
      );
    if (response.status === 400 || response.status === 409)
      throw Error(
        'Check your details. If you opened an email link, it may have expired or already been used.',
      );
    throw Error('The account service is unavailable. Please try again.');
  }
  if (data.policies) {
    policies = data.policies;
    policyInfo();
  }
  return data;
}
async function action(fn) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  try {
    await fn();
  } catch (error) {
    status(error.message || 'The request could not be completed. Please try again.', true);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}
for (const button of document.querySelectorAll('[data-account-panel]'))
  button.onclick = () => {
    panel(button.dataset.accountPanel);
    $('#account-status').hidden = true;
  };
$('#register-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await request('register', {
      name: $('#register-name').value,
      email: $('#register-email').value,
      password: $('#register-password').value,
      acceptance: policyReceipt('#register-terms', '#register-privacy'),
    });
    $('#register-form').reset();
    panel('check-email');
    status(
      'Check your email for the next step. If an account can be created with this address, a verification link will arrive.',
    );
  });
};
$('#login-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const data = await request('login', {
      email: $('#login-email').value,
      password: $('#login-password').value,
    });
    $('#login-form').reset();
    showUser(data.user ?? data);
    status(
      policiesRequired()
        ? 'Signed in. Review the current service policies to continue.'
        : 'Signed in. Open your workspace when you are ready.',
    );
  });
};
$('#request-reset-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await request('request-reset', { email: $('#reset-email').value });
    $('#request-reset-form').reset();
    status(
      'If this address belongs to an account, a password reset link will arrive. Check your email.',
    );
  });
};
$('#verify-email').onclick = () =>
  action(async () => {
    if (!verificationToken) throw Error('Open the verification link from your email first.');
    await request('verify', { token: verificationToken });
    verificationToken = '';
    panel('login');
    status('Email verified. Sign in with your password.');
  });
$('#reset-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (!resetToken) throw Error('Request a new password reset link before continuing.');
    await request('reset', { token: resetToken, password: $('#new-password').value });
    resetToken = '';
    $('#reset-form').reset();
    panel('login');
    status('Password changed. Sign in with your new password.');
  });
};
$('#review-policies').onclick = () => panel('policies');
$('#policy-account-options').onclick = () => panel('profile');
$('#policy-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const data = await request('accept-policies', {
      acceptance: policyReceipt('#policy-terms', '#policy-privacy'),
    });
    showUser(data.user ?? currentUser);
    status('Policy choices saved. Your profile and live-search permissions are unchanged.');
  });
};
$('#policy-signout').onclick = () => $('#logout').click();
$('#logout').onclick = () =>
  action(async () => {
    await request('logout', {});
    panel('login');
    status('Signed out.');
  });
$('#delete-account-form').onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    if (!$('#delete-account-confirm').checked)
      throw Error('Confirm that you want to delete this account and its workspace.');
    await request('', { password: $('#delete-password').value, confirm: true }, 'DELETE');
    $('#delete-account-form').reset();
    panel('login');
    status('Your account and its workspace have been deleted.');
  });
};
async function loadPolicies() {
  try {
    const response = await fetch('/api/policies', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw Error();
    policies = await response.json();
    if (!policies?.termsVersion || !policies?.privacyVersion) throw Error();
    policyInfo();
  } catch {
    $('#register-policy-status').textContent =
      'Current policies could not be loaded. Reload this page before creating an account.';
    policies = null;
  }
}
await loadPolicies();
if (verificationToken) panel('verify', { focus: false });
else if (resetToken) panel('reset', { focus: false });
else
  action(async () => {
    try {
      const response = await fetch('/api/account/me', { credentials: 'same-origin' });
      if (response.status === 401) {
        panel(initial.searchParams.get('view') === 'register' ? 'register' : 'login', {
          focus: false,
        });
        return;
      }
      if (!response.ok) throw Error('The account service is unavailable. Please try again.');
      const data = await response.json();
      if (data.policies) {
        policies = data.policies;
        policyInfo();
      }
      showUser(data.user ?? data);
    } catch (_error) {
      status('The account service is unavailable. Please try again.', true);
    }
  });
