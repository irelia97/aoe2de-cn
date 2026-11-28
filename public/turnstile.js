let turnstileScript;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!turnstileScript) {
    turnstileScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      const fail = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error('验证组件不可用'));
      };
      const timeout = setTimeout(fail, 8000);
      script.onerror = fail;
      script.onload = () => {
        if (!window.turnstile) return fail();
        clearTimeout(timeout);
        resolve(window.turnstile);
      };
      document.head.append(script);
    }).catch(error => { turnstileScript = null; throw error; });
  }
  return turnstileScript;
}
export async function getTurnstileToken(siteKey, action) {
  const turnstile = await loadTurnstile();
  const container = document.createElement('div');
  document.body.append(container);
  let widget;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      const fail = () => reject(new Error('验证未完成'));
      timeout = setTimeout(fail, 12000);
      widget = turnstile.render(container, {
        sitekey: siteKey,
        action,
        'response-field': false,
        retry: 'never',
        callback: resolve,
        'error-callback': fail,
        'expired-callback': fail,
        'timeout-callback': fail
      });
    });
  } finally {
    clearTimeout(timeout);
    if (widget != null) turnstile.remove(widget);
    container.remove();
  }
}
