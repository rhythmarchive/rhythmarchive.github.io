import { getBrowserStatsClient } from "../lib/stats-client";
import { submitUpdateReminder, type UpdateReminderResult } from "../lib/update-reminder-client";

type TurnstileApi = {
  render(element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }): string | number;
  reset(widgetId: string | number): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __rhythmArchiveTurnstileLoader?: Promise<TurnstileApi>;
  }
}

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
  const turnstileContainer = reminder.querySelector<HTMLElement>("[data-update-reminder-turnstile]");
  const turnstileSiteKey = turnstileContainer?.dataset.siteKey;
  let turnstileToken = "";
  let turnstileWidgetId: string | number | undefined;

  reminderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting || !reminderForm.reportValidity()) return;
    if (turnstileContainer && !turnstileToken) {
      renderStatus("请先完成验证。", "error");
      return;
    }
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
  if (turnstileContainer && turnstileSiteKey) void initializeTurnstile();

  async function submit(game: string): Promise<void> {
    let result: UpdateReminderResult;
    try {
      const visitorId = getBrowserStatsClient().getVisitorId();
      result = await submitUpdateReminder({ apiUrl, visitorId, game, ...(turnstileToken ? { turnstileToken } : {}) });
    } catch {
      result = { status: "failed", reason: "network" };
    }

    submitting = false;
    if (turnstileWidgetId !== undefined) window.turnstile?.reset(turnstileWidgetId);
    turnstileToken = "";
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

  async function initializeTurnstile(): Promise<void> {
    if (!turnstileContainer || !turnstileSiteKey) return;
    try {
      const api = await loadTurnstile();
      turnstileWidgetId = api.render(turnstileContainer, {
        sitekey: turnstileSiteKey,
        callback: (token) => { turnstileToken = token; renderStatus(""); renderControls(); },
        "expired-callback": () => { turnstileToken = ""; renderControls(); },
        "error-callback": () => { turnstileToken = ""; renderStatus("验证组件暂时不可用，请稍后再试。", "error"); renderControls(); },
      });
      renderControls();
    } catch {
      renderStatus("验证组件加载失败，请稍后再试。", "error");
    }
  }

  function loadTurnstile(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (window.__rhythmArchiveTurnstileLoader) return window.__rhythmArchiveTurnstileLoader;
    window.__rhythmArchiveTurnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.rhythmTurnstile = "true";
      script.addEventListener("load", () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile API missing")), { once: true });
      script.addEventListener("error", () => reject(new Error("Turnstile script failed")), { once: true });
      document.head.append(script);
    });
    return window.__rhythmArchiveTurnstileLoader;
  }

  function renderControls(): void {
    const waitingForTurnstile = Boolean(turnstileContainer && !turnstileToken);
    reminderGameSelect.disabled = submitting;
    reminderSubmitButton.disabled = submitting || waitingForTurnstile;
    reminderForm.setAttribute("aria-busy", String(submitting));
    reminderSubmitButton.textContent = submitting ? "提交中…" : waitingForTurnstile ? "完成验证后提交" : uiState === "error" ? "重试提醒" : "提醒一下";
  }

  function renderStatus(message: string, state?: Exclude<ReminderUiState, "idle">): void {
    reminderStatus.textContent = message;
    reminderStatus.hidden = !message;
    if (state) reminderStatus.dataset.state = state;
    else reminderStatus.removeAttribute("data-state");
  }
}