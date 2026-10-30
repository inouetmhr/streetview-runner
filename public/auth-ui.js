/* User section of the side pane, passkey list and the logged-out auth toast */
import {
  registerWithPasskey,
  loginWithPasskey,
  addPasskey,
  logoutSession,
  updateUsername,
  fetchPasskeys,
  deletePasskey,
  renamePasskey,
} from "./api.js";

function qs(id) { return document.getElementById(id); }

// Generate friendly display names like "Blue Dragon"
export function generateFriendlyName() {
  const left = [
    'Blue','Crimson','Golden','Silver','Emerald','Sapphire','Ruby','Azure','Scarlet','Ivory','Onyx','Amber','Cobalt','Violet','Indigo','Coral','Teal','Misty','Sunny','Silent','Brave','Swift','Lunar','Solar','Neon','Frosty','Wild'
  ];
  const right = [
    'Dragon','Tiger','Falcon','Wolf','Eagle','Lion','Leopard','Shark','Panther','Phoenix','Bear','Dolphin','Fox','Hawk','Otter','Orca','Raven','Puma','Cobra','Lynx','Viper','Kite','Stallion','Mustang'
  ];
  const a = left[Math.floor(Math.random() * left.length)];
  const b = right[Math.floor(Math.random() * right.length)];
  return `${a} ${b}`;
}

/**
 * Wires the user/passkey UI.
 * - onLogin(user, { wasAnonymous }) runs after a successful register/login.
 * - onBeforeLogout() runs before the session is cleared and the page reloads.
 * - setAuthToastVisible(show) controls the logged-out toast.
 * Returns { getUser, refreshPasskeys }.
 */
export function createAuthUI({ initialUser, onLogin, onBeforeLogout, setAuthToastVisible }) {
  const uiUser = { name: qs('userName'), btnEdit: qs('btnEditName'), btnReg: qs('btnRegister'), btnLogin: qs('btnLogin'), btnAddPasskey: qs('btnAddPasskey'), btnLogout: qs('btnLogout'), hint: qs('authHint'), passkeyList: qs('passkeyList') };
  const authToast = { btnLogin: qs('toastLogin'), btnRegister: qs('toastRegister'), btnClose: qs('toastClose') };
  let sessionUser = initialUser;
  let passkeyItems = [];
  let passkeyCurrentId = null;

  const applyPasskeyResult = (res) => {
    passkeyItems = res.items || [];
    passkeyCurrentId = res.currentCredentialId || null;
    renderPasskeys();
  };

  const renderPasskeys = () => {
    if (!uiUser.passkeyList) return;
    if (!sessionUser) {
      uiUser.passkeyList.textContent = '—';
      return;
    }
    if (!passkeyItems.length) {
      uiUser.passkeyList.textContent = 'none';
      return;
    }
    uiUser.passkeyList.innerHTML = '';
    passkeyItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'center';
      row.style.gap = '.5rem';
      row.style.margin = '.2rem 0';
      const currentLabel = item.label ? item.label : `Passkey ${index + 1}`;
      const left = document.createElement('div');
      left.style.display = 'flex';
      left.style.alignItems = 'center';
      left.style.gap = '.35rem';
      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '.35rem';
      const btnRename = document.createElement('button');
      btnRename.className = 'ghost small btn-edit';
      btnRename.textContent = 'Edit';
      btnRename.title = 'Edit passkey label';
      btnRename.setAttribute('aria-label', 'Rename passkey');
      btnRename.addEventListener('click', async () => {
        const next = prompt('Rename passkey:', currentLabel);
        if (next === null) return;
        const trimmed = (next || '').trim();
        if (!trimmed) return;
        const res = await renamePasskey(item.id, trimmed);
        if (!res.ok) {
          alert(res.error?.error || 'Failed to rename passkey.');
          return;
        }
        applyPasskeyResult(res);
      });
      const label = document.createElement('span');
      label.textContent = currentLabel;
      const btnRemove = document.createElement('button');
      btnRemove.className = 'ghost small icon';
      btnRemove.textContent = '🗑';
      btnRemove.title = 'Remove passkey';
      btnRemove.setAttribute('aria-label', 'Remove passkey');
      btnRemove.addEventListener('click', async () => {
        const isCurrent = item.id && passkeyCurrentId && item.id === passkeyCurrentId;
        const message = isCurrent
          ? 'WARN: This is the passkey CURRENTLY USED. Remove anyway?'
          : 'Remove this passkey?';
        if (!confirm(message)) return;
        const res = await deletePasskey(item.id);
        if (!res.ok) {
          alert(res.error?.error || 'Failed to remove passkey.');
          return;
        }
        applyPasskeyResult(res);
      });
      left.appendChild(label);
      left.appendChild(btnRename);
      actions.appendChild(btnRemove);
      row.appendChild(left);
      row.appendChild(actions);
      uiUser.passkeyList.appendChild(row);
    });
  };

  const refreshPasskeys = async () => {
    if (!sessionUser) {
      applyPasskeyResult({ items: [], currentCredentialId: null });
      return;
    }
    applyPasskeyResult(await fetchPasskeys());
  };

  const updateUserUI = () => {
    const show = (el, visible) => { if (el) el.style.display = visible ? '' : 'none'; };
    const loggedIn = !!sessionUser;
    uiUser.name.textContent = loggedIn ? (sessionUser.username || 'Runner') : '—';
    show(uiUser.btnReg, !loggedIn);
    show(uiUser.btnLogin, !loggedIn);
    show(uiUser.hint, !loggedIn);
    show(uiUser.btnEdit, loggedIn);
    show(uiUser.btnAddPasskey, loggedIn);
    show(uiUser.btnLogout, loggedIn);
    setAuthToastVisible(!loggedIn);
    renderPasskeys();
  };

  const completeLogin = async (user, wasAnonymous) => {
    sessionUser = user;
    updateUserUI();
    await onLogin(user, { wasAnonymous });
    await refreshPasskeys();
  };

  const doRegister = async () => {
    const wasAnonymous = !sessionUser;
    const suggested = generateFriendlyName();
    const input = prompt('Choose your display name:', suggested);
    if (input === null) return; // user canceled
    const username = (input || '').trim() || suggested;
    const user = await registerWithPasskey(username);
    if (user) await completeLogin(user, wasAnonymous);
  };
  const doLogin = async () => {
    const user = await loginWithPasskey();
    if (user) await completeLogin(user, false);
  };
  const doAddPasskey = async () => {
    if (!sessionUser) return;
    const user = await addPasskey();
    if (user) {
      sessionUser = user;
      updateUserUI();
      await refreshPasskeys();
      alert('Passkey added to your account.');
    }
  };
  const doLogout = async () => {
    onBeforeLogout();
    await logoutSession();
    try { document.body.classList.remove('side-open'); } catch {}
    // Reload to reset app state and enforce unauthenticated flows
    location.reload();
  };
  const doEditName = async () => {
    if (!sessionUser) return;
    const suggested = sessionUser.username || generateFriendlyName();
    const next = prompt('Edit display name:', suggested);
    if (next === null) return;
    const name = (next || '').trim();
    if (!name) return;
    const updated = await updateUsername(name);
    if (updated) { sessionUser = updated; updateUserUI(); }
  };

  uiUser.btnReg?.addEventListener('click', doRegister);
  uiUser.btnLogin?.addEventListener('click', doLogin);
  uiUser.btnAddPasskey?.addEventListener('click', doAddPasskey);
  uiUser.btnLogout?.addEventListener('click', doLogout);
  uiUser.btnEdit?.addEventListener('click', doEditName);
  // Toast actions mirror side-pane buttons
  authToast.btnRegister?.addEventListener('click', doRegister);
  authToast.btnLogin?.addEventListener('click', doLogin);
  authToast.btnClose?.addEventListener('click', () => { setAuthToastVisible(false); });

  updateUserUI();

  return {
    getUser: () => sessionUser,
    refreshPasskeys,
  };
}
