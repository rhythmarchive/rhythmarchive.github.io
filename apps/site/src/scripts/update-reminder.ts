import { getBrowserStatsClient } from "../lib/stats-client";
import { submitUpdateReminder, type UpdateReminderResult } from "../lib/update-reminder-client";

type ReminderUiState = "idle" | "success" | "duplicate" | "error";

initializeUpdateReminder();

function initializeUpdateReminder(): void {
  const reminder = document.querySelector<HTMLElement>("[data-update-reminder]");
  const formElement = reminder?.querySelector<HTMLFormElement>("[data-update-reminder-form]");
  const gameSelectElement = reminder?.querySelector<HTMLSelectElement>("[data-update-reminder-game]");
  const submitButtonElement = reminder?.querySelector<HTMLButtonElement>("[data-update-reminder-submit]");
  const statusElement = reminder?.querySelector<HTMLElement>("[data-update-reminder-status]");
  if (!reminder || !formElement || !gameSelectElement || !submitButtonElement || !statusElement) return;

  const reminderForm = formElement;
  const reminderGameSelect = gameSelectElement;
  const reminderSubmitButton = submitButtonElement;
  const reminderStatus = statusElement;
  const apiUrl = document.documentElement.dataset.statsApiUrl;
  let uiState: ReminderUiState = "idle";
  let submitting = false;

  reminderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting || !reminderForm.reportValidity()) return;
    const game = reminderGameSelect.value.trim();
    if (!game) return;
    submitting = true;
    renderControls();
    void submit(game);
  });

  reminderGameSelect.addEventListener("change", () => {
    if (submitting) return;
    uiState = "idle";
    renderStatus("");
    renderControls();
  });

  renderControls();

  async function submit(game: string): Promise<void> {
    let result: UpdateReminderResult;
    try {
      const visitorId = getBrowserStatsClient().getVisitorId();
      result = await submitUpdateReminder({ apiUrl, visitorId, game });
    } catch {
      result = { status: "failed", reason: "network" };
    }

    submitting = false;
    if (result.status === "accepted") {
      uiState = "success";
      renderStatus("已收到提醒，我会去检查一下。", "success");
    } else if (result.status === "duplicate") {
      uiState = "duplicate";
      renderStatus("这个游戏最近已经提醒过了，谢谢提醒。", "duplicate");
    } else {
      uiState = "error";
      renderStatus("暂时没能送出提醒，请稍后再试。", "error");
    }
    renderControls();
  }

  function renderControls(): void {
    reminderGameSelect.disabled = submitting;
    reminderSubmitButton.disabled = submitting;
    reminderForm.setAttribute("aria-busy", String(submitting));
    reminderSubmitButton.textContent = submitting ? "提交中…" : uiState === "error" ? "重试提醒" : "提醒一下";
  }

  function renderStatus(message: string, state?: Exclude<ReminderUiState, "idle">): void {
    reminderStatus.textContent = message;
    reminderStatus.hidden = !message;
    if (state) reminderStatus.dataset.state = state;
    else reminderStatus.removeAttribute("data-state");
  }
}