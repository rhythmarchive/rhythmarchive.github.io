import { loadTurnstile } from '../lib/turnstile';
import { normalizeStatsApiUrl } from '../lib/stats-client';

for (const root of document.querySelectorAll<HTMLDetailsElement>('[data-resource-feedback]')) {
  const form = root.querySelector<HTMLFormElement>('form');
  if (!form) continue;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const status = form.querySelector<HTMLElement>('[data-feedback-status]')!;
  let token = '';
  let widget: string | number | undefined;
  let submitting = false;
  let loading = false;
  root.addEventListener('toggle', async () => {
    if (!root.open || widget !== undefined || loading) return;
    loading = true;
    try {
      const api = await loadTurnstile();
      widget = api.render(form.querySelector<HTMLElement>('[data-feedback-turnstile]')!, {
        sitekey: root.dataset.siteKey!, action: 'resource-feedback',
        callback: (value) => { token = value; button.disabled = submitting; button.textContent = '发送邮件反馈'; },
        'expired-callback': () => { token = ''; button.disabled = true; },
        'error-callback': () => { token = ''; button.disabled = true; status.textContent = '验证失败，请稍后重试或使用 GitHub 反馈。'; },
      });
    } catch { status.textContent = '验证加载失败，请重新展开或使用 GitHub 反馈。'; }
    finally { loading = false; }
  });
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
        signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' },
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
      if (widget !== undefined) window.turnstile?.reset(widget);
    }
  });
}
