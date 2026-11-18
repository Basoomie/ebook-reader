/**
 * What a site's answer means for the queue (WP20d). A challenge or a "too busy" page is never
 * answered or worked around: the site's queue backs off and asks again later.
 *
 * Seen in the reference run (source-probe/out3/raw, checked 2026-11-17):
 * - Amazon's not-found page: HTTP 404, 2.6 KB, "ページが見つかりません". It carries
 *   api-services-support@amazon.com in a comment, which made ref4 count 33 of them as challenges.
 * - Amazon's bot check: HTTP 200, 2-5 KB, Akamai's interstitial (bm-verify, /_sec/verify,
 *   triggerInterstitialChallenge). The classic captcha page (/errors/validateCaptcha) is matched
 *   too.
 * - Amazon's HTTP 503 (a 320-byte page) or 429: seen live 2026-11-17 for 64 of 381 Amazon
 *   requests at the 8 s pace while one-off requests got the page. Treated like the bot check
 *   (decided by the user): the same doubling back-off and the automatic slow-down.
 * Bookmeter's search page always carries a congestion notice in its template, so it says
 * nothing; Bookmeter's busy answers are its HTTP statuses (403/429/503).
 */
export type ResponseClass = 'ok' | 'gone' | 'challenge' | 'busy' | 'error';

const AMAZON_CHALLENGE =
  /bm-verify=|\/_sec\/verify|triggerInterstitialChallenge|\/errors\/validateCaptcha|opfcaptcha|name="amzn-captcha/;
/** Largest Amazon answer that can be a challenge page (real product pages are > 300 KB). */
const CHALLENGE_MAX_BYTES = 20_000;

export function classifyResponse(
  site: string,
  status: number | null,
  body: Buffer | null,
): ResponseClass {
  if (status === null) return 'error';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status === 503) return site.startsWith('amazon') ? 'challenge' : 'busy';
  if (status === 403)
    return site.startsWith('amazon') && looksLikeAmazonCheck(body) ? 'challenge' : 'busy';
  if (status < 200 || status >= 300) return 'error';
  if (site.startsWith('amazon') && looksLikeAmazonCheck(body)) return 'challenge';
  return 'ok';
}

function looksLikeAmazonCheck(body: Buffer | null): boolean {
  if (!body || body.length > CHALLENGE_MAX_BYTES) return false;
  return AMAZON_CHALLENGE.test(body.toString('latin1'));
}
