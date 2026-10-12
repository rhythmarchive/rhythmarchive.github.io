import { onPageLoad, pageSignal, onPageCleanup } from "./page-lifecycle";
import { loadTurnstile } from '../lib/turnstile';
import { normalizeStatsApiUrl } from '../lib/stats-client';
import { setSurfaceVisible } from './motion';

onPageLoad(() => {
  for (const root of document.querySelectorAll<HTMLElement>('[data-resource-feedback]')) {
    const dialog = root.querySelector<HTMLDialogElement>('dialog')!;
    const sheet = root.querySelector<HTMLElement>('[data-feedback-sheet]')!;
    const trigger = root.querySelector<HTMLButtonElement>('[data-feedback-open]')!;
    const close = root.querySelector<HTMLButtonElement>('[data-feedback-close]')!;
    const signal = pageSignal();
    let closing = false;
    let restoreScroll: (() => void) | undefined;
    const unlock = () => { restoreScroll?.(); restoreScroll = undefined; };
    const dismiss = async () => {
      if (!dialog.open || closing) return;
      closing = true;
      await setSurfaceVisible(sheet, false, 'fade');
      if (signal.aborted) return;
      dialog.close();
    };
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); void dismiss(); }, { signal });
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || closing) return;
      const controls = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select, textarea, input:not([disabled]), iframe, [tabindex="0"]'))
        .filter(node => node.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }, { signal });
    close.addEventListener('click', () => { void dismiss(); }, { signal });
    // A drag from inside the form to outside is not a backdrop click.
    let backdropPress = false;
    const outside = (event: PointerEvent | MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', (event) => { backdropPress = outside(event); }, { signal });
    dialog.addEventListener('click', (event) => { if (backdropPress && outside(event)) void dismiss(); backdropPress = false; }, { signal });
    dialog.addEventListener('close', () => {
      unlock();
      closing = false;
      if (!signal.aborted) trigger.focus({ preventScroll: true });
    }, { signal });
    trigger.addEventListener('click', () => {
      if (dialog.open || closing) return;
      const body = document.body;
      const html = document.documentElement;
      const y = window.scrollY;
      const bodyStyle = body.style.cssText;
      const overflow = html.style.overflow;
      const scrollbarWidth = window.innerWidth - html.clientWidth;
      const paddingRight = getComputedStyle(body).paddingRight;
      body.style.position = 'fixed'; body.style.top = `-${y}px`; body.style.width = '100%';
      body.style.paddingRight = `${Number.parseFloat(paddingRight) + scrollbarWidth}px`;
      html.style.overflow = 'hidden';
      restoreScroll = () => {
        body.style.cssText = bodyStyle; html.style.overflow = overflow;
        window.scrollTo({ top: y, behavior: 'instant' });
      };
      dialog.showModal();
      void setSurfaceVisible(sheet, true);
      close.focus({ preventScroll: true });
      void prepareVerification();
    }, { signal });
    onPageCleanup(() => {
      void setSurfaceVisible(sheet, false, 'instant');
      dialog.close(); unlock();
      if (widget !== undefined) window.turnstile?.remove(widget);
    });
    const form = root.querySelector<HTMLFormElement>('form');
    const button = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
    const status = form?.querySelector<HTMLElement>('[data-feedback-status]');
    let token = '';
    let widget: string | number | undefined;
    let submitting = false;
    let loading = false;
    async function prepareVerification() {
      if (!form || !button || !status || widget !== undefined || loading) return;
      loading = true;
      try {
        const api = await loadTurnstile();
        if (signal.aborted || !dialog.open || closing) return;
        widget = api.render(form.querySelector<HTMLElement>('[data-feedback-turnstile]')!, {
          sitekey: root.dataset.siteKey!, action: 'resource-feedback',
          callback: (value) => { token = value; button.disabled = submitting; button.textContent = '发送邮件反馈'; },
          'expired-callback': () => { token = ''; button.disabled = true; },
          'error-callback': () => { token = ''; button.disabled = true; status.textContent = '验证失败，请稍后重试或使用 GitHub 反馈。'; },
        });
      } catch { if (!signal.aborted) status.textContent = '验证加载失败，请重新打开或使用 GitHub 反馈。'; }
      finally { loading = false; }
    }
    if (!form || !button || !status) continue;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const api = normalizeStatsApiUrl(document.documentElement.dataset.statsApiUrl);
      if (!api || !token || submitting || !form.reportValidity()) return;
      submitting = true;
      button.disabled = true;
      button.textContent = '提交中…';
      form.setAttribute('aria-busy', 'true');
      const data = new FormData(form);
      try {
        const response = await fetch(`${api}/v1/resource-feedback`, { method: 'POST', credentials: 'omit',
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: root.dataset.resourceId, name: root.dataset.name,
            kind: data.get('kind'), description: data.get('description'), turnstileToken: token }) });
        const body = await response.json() as { status?: string };
        status.textContent = response.ok ? body.status === 'duplicate' ? '该资源近期已收到你的反馈。' : '反馈已提交，邮件将在稍后发送。'
          : '提交失败，请稍后重试或使用 GitHub 反馈。';
        if (response.ok) form.reset();
      } catch { status.textContent = '提交结果未确认，请稍后重试或使用 GitHub 反馈。'; }
      finally {
        submitting = false; token = ''; button.disabled = true;
        button.textContent = '完成验证后发送邮件'; form.setAttribute('aria-busy', 'false');
        if (!signal.aborted && widget !== undefined) window.turnstile?.reset(widget);
      }
    }, { signal });
  }
});
