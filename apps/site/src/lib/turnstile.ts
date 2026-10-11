type TurnstileApi = {
  render(element: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }): string | number;
  reset(widgetId: string | number): void;
};
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    __rhythmArchiveTurnstileLoader?: Promise<TurnstileApi>;
  }
}
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (window.__rhythmArchiveTurnstileLoader) return window.__rhythmArchiveTurnstileLoader;
  window.__rhythmArchiveTurnstileLoader = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true; script.defer = true; script.dataset.rhythmTurnstile = 'true';
    script.addEventListener('load', () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile API missing')), { once: true });
    script.addEventListener('error', () => { delete window.__rhythmArchiveTurnstileLoader; script.remove(); reject(new Error('Turnstile script failed')); }, { once: true });
    document.head.append(script);
  });
  return window.__rhythmArchiveTurnstileLoader;
}
