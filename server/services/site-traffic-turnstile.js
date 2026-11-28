const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const allowedHosts = new Set(['aoe2cn.cc', 'www.aoe2cn.cc']);

export function createSiteTrafficTurnstile({ siteKey = '', secretKey = '', fetchImpl = fetch } = {}) {
  siteKey = siteKey.trim();
  secretKey = secretKey.trim();
  const required = Boolean(siteKey || secretKey);
  // A partially configured deployment must never resume unverified counting.
  const ready = Boolean(siteKey && secretKey);
  let active = 0;

  return {
    required,
    config: { required, siteKey: ready ? siteKey : '' },
    async verify(token, action = 'site_page_view') {
      if (!required) return true;
      if (!ready || typeof token !== 'string' || !token.trim() || token.length > 2048 || active >= 8) return false;
      active++;
      try {
        const response = await fetchImpl(verifyUrl, {
          method: 'POST',
          body: new URLSearchParams({ secret: secretKey, response: token }),
          signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) return false;
        const result = await response.json();
        return result?.success === true && allowedHosts.has(result.hostname) && result.action === action;
      } catch {
        return false;
      } finally {
        active--;
      }
    }
  };
}
