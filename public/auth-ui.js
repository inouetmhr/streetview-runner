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
import { qs, notify } from "./dom.js";
import { askText, askConfirm } from "./dialog.js";

// Generate friendly display names like "Blue Dragon"
export function generateFriendlyName() {
  const left = [
    "Blue","Crimson","Golden","Silver","Emerald","Sapphire","Ruby","Azure","Scarlet","Ivory","Onyx","Amber","Cobalt","Violet","Indigo","Coral","Teal","Misty","Sunny","Silent","Brave","Swift","Lunar","Solar","Neon","Frosty","Wild"
  ];
  const right = [
    "Dragon","Tiger","Falcon","Wolf","Eagle","Lion","Leopard","Shark","Panther","Phoenix","Bear","Dolphin","Fox","Hawk","Otter","Orca","Raven","Puma","Cobra","Lynx","Viper","Kite","Stallion","Mustang"
  ];
  const a = left[Math.floor(Math.random() * left.length)];
  const b = right[Math.floor(Math.random() * right.length)];
  return `${a} ${b}`;
}

// Swaps `span` for a text input in place. Enter or leaving the field saves, Esc cancels.
// onSave(value) runs only for a changed, non-empty value.
function editInPlace(span, current, onSave, { maxLength = 64 } = {}) {
  const input = document.createElement("input");
  input.className = "inline-edit";
  input.value = current;
  input.maxLength = maxLength;
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(span);
    if (save && value && value !== current) await onSave(value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  span.replaceWith(input);
  input.focus();
  input.select();
}

const errorText = (res, fallback) => (res?.error?.error ? `${fallback}: ${res.error.error}.` : `${fallback}.`);

/**
 * Wires the user/passkey UI.
 * - onLogin(user, { wasAnonymous }) runs after a successful register/login.
 * - onBeforeLogout() runs before the session is cleared and the page reloads.
 * - setAuthToastVisible(show) controls the logged-out toast.
 * Returns { getUser, refreshPasskeys }.
 */
export function createAuthUI({ initialUser, onLogin, onBeforeLogout, setAuthToastVisible }) {
  const uiUser = { name: qs("userName"), btnEdit: qs("btnEditName"), btnReg: qs("btnRegister"), btnLogin: qs("btnLogin"), btnAddPasskey: qs("btnAddPasskey"), btnLogout: qs("btnLogout"), hint: qs("authHint"), passkeyList: qs("passkeyList") };
  const authToast = { btnLogin: qs("toastLogin"), btnRegister: qs("toastRegister"), btnClose: qs("toastClose") };
  let sessionUser = initialUser;
  let passkeyItems = [];
  let passkeyCurrentId = null;

  const applyPasskeyResult = (res) => {
    passkeyItems = res.items || [];
    passkeyCurrentId = res.currentCredentialId || null;
    renderPasskeys();
  };

  const renamePasskeyInPlace = (item, label, span) => {
    editInPlace(span, label, async (next) => {
      const res = await renamePasskey(item.id, next);
      if (!res.ok) return notify(errorText(res, "Could not rename the passkey"), { kind: "error" });
      applyPasskeyResult(res);
    });
  };

  const removePasskey = async (item) => {
    const isCurrent = item.id && passkeyCurrentId && item.id === passkeyCurrentId;
    const message = isCurrent
      ? "This is the passkey you are signed in with. This device will be signed out."
      : "Devices signed in with this passkey will be signed out.";
    if (!(await askConfirm("Remove this passkey?", message, { okLabel: "Remove", danger: true }))) return;
    const res = await deletePasskey(item.id);
    if (!res.ok) return notify(errorText(res, "Could not remove the passkey"), { kind: "error" });
    applyPasskeyResult(res);
    notify("Passkey removed.");
  };

  const renderPasskeys = () => {
    if (!uiUser.passkeyList) return;
    if (!sessionUser) {
      uiUser.passkeyList.textContent = "—";
      return;
    }
    if (!passkeyItems.length) {
      uiUser.passkeyList.textContent = "none";
      return;
    }
    uiUser.passkeyList.replaceChildren(...passkeyItems.map((item, index) => {
      const row = document.createElement("div");
      row.className = "passkey-row";
      const currentLabel = item.label ? item.label : `Passkey ${index + 1}`;
      const left = document.createElement("div");
      left.className = "passkey-name";
      const label = document.createElement("span");
      label.textContent = currentLabel;
      const btnRename = document.createElement("button");
      btnRename.className = "ghost small btn-edit";
      btnRename.textContent = "Edit";
      btnRename.title = "Edit passkey label";
      btnRename.setAttribute("aria-label", "Rename passkey");
      btnRename.addEventListener("click", () => renamePasskeyInPlace(item, currentLabel, label));
      const actions = document.createElement("div");
      actions.className = "passkey-actions";
      const btnRemove = document.createElement("button");
      btnRemove.className = "ghost small icon";
      btnRemove.textContent = "🗑";
      btnRemove.title = "Remove passkey";
      btnRemove.setAttribute("aria-label", "Remove passkey");
      btnRemove.addEventListener("click", () => removePasskey(item));
      left.append(label, btnRename);
      actions.append(btnRemove);
      row.append(left, actions);
      return row;
    }));
  };

  const refreshPasskeys = async () => {
    if (!sessionUser) {
      applyPasskeyResult({ items: [], currentCredentialId: null });
      return;
    }
    applyPasskeyResult(await fetchPasskeys());
  };

  const updateUserUI = () => {
    const show = (el, visible) => { if (el) el.style.display = visible ? "" : "none"; };
    const loggedIn = !!sessionUser;
    uiUser.name.textContent = loggedIn ? (sessionUser.username || "Runner") : "—";
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
    notify(`Signed in as ${user.username || "Runner"}.`);
    await onLogin(user, { wasAnonymous });
    await refreshPasskeys();
  };

  const doRegister = async () => {
    const wasAnonymous = !sessionUser;
    const suggested = generateFriendlyName();
    const input = await askText("Choose your display name", suggested, { okLabel: "Create passkey" });
    if (input === null) return; // user canceled
    const username = input.trim() || suggested;
    const { user, error } = await registerWithPasskey(username);
    if (error) return notify(error, { kind: "error" });
    if (user) await completeLogin(user, wasAnonymous);
  };
  const doLogin = async () => {
    const { user, error } = await loginWithPasskey();
    if (error) return notify(error, { kind: "error" });
    if (user) await completeLogin(user, false);
  };
  const doAddPasskey = async () => {
    if (!sessionUser) return;
    const { user, error } = await addPasskey();
    if (error) return notify(error, { kind: "error" });
    if (user) {
      sessionUser = user;
      updateUserUI();
      await refreshPasskeys();
      notify("Passkey added. Use Edit to rename it.");
    }
  };
  const doLogout = async () => {
    onBeforeLogout();
    await logoutSession();
    try { document.body.classList.remove("side-open"); } catch {}
    // Reload to reset app state and enforce unauthenticated flows
    location.reload();
  };
  const doEditName = () => {
    if (!sessionUser) return;
    editInPlace(uiUser.name, sessionUser.username || "", async (name) => {
      const updated = await updateUsername(name);
      if (!updated) return notify("Could not update the display name.", { kind: "error" });
      sessionUser = updated;
      updateUserUI();
    }, { maxLength: 32 });
  };

  uiUser.btnReg?.addEventListener("click", doRegister);
  uiUser.btnLogin?.addEventListener("click", doLogin);
  uiUser.btnAddPasskey?.addEventListener("click", doAddPasskey);
  uiUser.btnLogout?.addEventListener("click", doLogout);
  uiUser.btnEdit?.addEventListener("click", doEditName);
  // Toast actions mirror side-pane buttons
  authToast.btnRegister?.addEventListener("click", doRegister);
  authToast.btnLogin?.addEventListener("click", doLogin);
  authToast.btnClose?.addEventListener("click", () => { setAuthToastVisible(false); });

  updateUserUI();

  return {
    getUser: () => sessionUser,
    refreshPasskeys,
  };
}
