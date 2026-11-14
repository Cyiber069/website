// First run "set your password" and sign in.
import { api } from '../api.js';
import { $, html, setHTML, friendly } from '../ui.js';

export default {
  mount(root, { mode, note, onDone }) {
    const setup = mode === 'setup';
    setHTML(root, html`<main class="auth">
      <form class="card auth__card stack" novalidate>
        <div class="auth__brand"><img src="/img/logo.png" alt="ACX Ebikes" width="158" height="40"><span class="brand__tag">Agent</span></div>
        <h1 class="auth__title">${setup ? 'Set your password' : 'Sign in'}</h1>
        <p class="muted">${setup ? 'You are the first one here, so you choose the password. You will use it on your phone and your laptop.' : (note || 'Enter your password to see what the agent is doing.')}</p>
        <div class="field">
          <label class="field__label" for="pw">Password</label>
          <input class="input" id="pw" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}" aria-describedby="pw-err">
          ${setup ? html`<p class="field__hint">At least 8 characters.</p>` : ''}
        </div>
        ${setup ? html`<div class="field"><label class="field__label" for="pw2">Type it again</label><input class="input" id="pw2" name="confirm" type="password" autocomplete="new-password" required></div>` : ''}
        <p class="form-error" id="pw-err" role="alert" hidden></p>
        <button class="btn btn--primary btn--block btn--lg" type="submit">${setup ? 'Save password and start' : 'Sign in'}</button>
      </form>
    </main>`);
    const form = $('form', root);
    const pw = $('#pw', root);
    const errBox = $('#pw-err', root);
    const fail = (msg, input = pw) => { errBox.textContent = msg; errBox.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); };
    form.addEventListener('input', () => { errBox.hidden = true; for (const i of form.querySelectorAll('[aria-invalid]')) i.removeAttribute('aria-invalid'); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = pw.value;
      if (!password) return fail('Type your password first.');
      if (setup) {
        if (password.length < 8) return fail('That is too short. Use at least 8 characters.');
        const again = $('#pw2', root);
        if (again.value !== password) return fail('The two passwords do not match. Type them again.', again);
      }
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        await api(setup ? '/api/setup' : '/api/login', { body: { password }, quiet401: true });
        onDone();
      } catch (err) {
        btn.disabled = false;
        if (err.code === 'wrong_password') return fail('That password is not right. Try again.');
        if (err.status === 401) return fail('That password is not right. Try again.');
        fail(friendly(err, 'Could not sign in. Check your connection and try again.'));
      }
    });
    setTimeout(() => pw.focus(), 50);
  },
};
