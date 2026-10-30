/* In-page replacements for prompt() and confirm(), built on one <dialog id="appDialog"> */
import { qs } from "./dom.js";

// Opens the dialog and resolves with the input value (askText) or true (askConfirm)
// when OK is chosen, or null when it is cancelled (button, Esc or backdrop click).
function open({ title, message = "", value = null, okLabel = "OK", danger = false }) {
  const dialog = qs("appDialog");
  const input = qs("appDialogInput");
  const ok = qs("appDialogOk");
  qs("appDialogTitle").textContent = title;
  qs("appDialogMessage").textContent = message;
  qs("appDialogMessage").hidden = !message;
  input.hidden = value === null;
  input.value = value ?? "";
  ok.textContent = okLabel;
  ok.classList.toggle("danger", danger);
  return new Promise((resolve) => {
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "ok") return resolve(null);
      resolve(value === null ? true : input.value);
    }, { once: true });
    dialog.showModal();
    if (value !== null) input.select();
    else ok.focus();
  });
}

export function askText(title, value, { okLabel = "Save" } = {}) {
  return open({ title, value: value || "", okLabel });
}

export async function askConfirm(title, message, { okLabel = "OK", danger = false } = {}) {
  return (await open({ title, message, okLabel, danger })) === true;
}

// Close on a backdrop click (the dialog element itself, outside its content).
document.addEventListener("click", (e) => {
  const dialog = qs("appDialog");
  if (e.target === dialog) dialog.close();
});
