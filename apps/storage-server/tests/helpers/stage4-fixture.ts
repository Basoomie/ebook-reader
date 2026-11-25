/**
 * WP20d test fixtures: small store pages in the formats the stage-4 parsers read (checked against
 * real pages in scripts/prove-stage4-parsers.ts), and a stand-in "internet" that answers the
 * fetch queue's requests by URL.
 */
export interface AmazonPage {
  asin: string;
  title: string;
  authors: { name: string; role: string }[];
  description?: string;
  series?: string;
  breadcrumbs?: string[];
  rank?: string[];
  cover?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function amazonDp(p: AmazonPage): string {
  const authors = p.authors
    .map(
      (a) =>
        `<span class="author notFaded"><a class="a-link-normal" href="/x">${esc(a.name)}</a><span class="contribution"><span class="a-color-secondary">(${a.role})</span></span></span>`,
    )
    .join('');
  return `<html><head><link rel="canonical" href="https://www.amazon.co.jp/x/dp/${p.asin}" /></head><body>
<div id="wayfinding-breadcrumbs_feature_div"><ul>${(p.breadcrumbs ?? ['Kindleストア', 'Kindle本', 'ライトノベル']).map((b) => `<li><a href="/b">${esc(b)}</a></li>`).join('')}</ul></div>
<span id="productTitle" class="a-size-extra-large">${esc(p.title)}</span>
${authors}
<div id="bookDescription_feature_div"><div class="a-expander-content a-expander-partial-collapse-content">${(p.description ?? '').split('\n').map(esc).join('<br>')}</div></div>
${p.series !== undefined ? `<div data-rpi-attribute-name="book_details-series"><span>${esc(p.series)}</span></div><div>本の長さ 300ページ</div>` : ''}
<ul><li>Amazon 売れ筋ランキング: ${(p.rank ?? ['Kindleストアの売れ筋ランキングを見る', 'ライトノベル (Kindleストア)']).map((r) => `<a href="/r">${esc(r)}</a>`).join(' ')}</li></ul>
<script>var data = {"hiRes":"${p.cover ?? `https://m.media-amazon.com/images/I/${p.asin}.jpg`}"};</script>
</body></html>`;
}

export function amazonSearch(items: [string, string][]): string {
  return `<html><body>${items
    .map(
      ([asin, title]) =>
        `<div data-asin="${asin}" data-index="1" data-component-type="s-search-result"><h2><a><span>${esc(title)}</span></a></h2></div>`,
    )
    .join('\n')}</body></html>`;
}

export const AMAZON_404 =
  '<html><head><title>ページが見つかりません</title></head><body><!-- api-services-support@amazon.com --><b>何かお探しですか？</b></body></html>';
export const AMAZON_CHALLENGE = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5; URL='/s?k=x&bm-verify=AAQ'" /><script> var i = 1; var j = i + Number("1"); </script></head><body><script> function triggerInterstitialChallenge() { xhr.open("POST", "/_sec/verify?provider=interstitial", false); }</script></body></html>`;

export function bookwalkerList(items: [string, string][]): string {
  return `<html><body>${items
    .map(
      ([u, t]) =>
        `<a href="${u}" class="m-book-item__title" data-x="1" title="${esc(t)}">${esc(t)}</a>`,
    )
    .join('\n')}</body></html>`;
}

export function bookwalkerDetail(name: string, description: string, keywords: string): string {
  return `<html><head><meta name="keywords" content="${esc(keywords)}"><script type="application/ld+json">${JSON.stringify({ name, description, image: 'https://rimg.bookwalker.jp/x.jpg' })}</script></head><body></body></html>`;
}

export function bookmeterPartial(
  books: { id: string; title: string; authors: string[]; pages?: number; reg?: number }[],
): string {
  return `<span id="contents"><div class="books"><ul class="book-list__group">${books
    .map(
      (b) =>
        `<li class="group__book"><div class="book__detail"><div class="detail__title"><a href="/books/${b.id}">${esc(b.title)}</a></div><ul class="detail__authors">${b.authors.map((a) => `<li><a href="/search?author=x">${esc(a)}</a></li>`).join('')}</ul><div class="detail__page">${b.pages ?? 300}</div>${b.reg !== undefined ? `<dl class="detail__options"><dt class="options__title">登録</dt><dd class="options__item">${b.reg}</dd></dl>` : ''}</div></li>`,
    )
    .join('')}</ul></div></span>`;
}

export function bookmeterStores(isbn13: string, honto: string): string {
  return JSON.stringify({
    resources: [
      {
        alphabet_name: 'kinokuniya',
        url: `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url=${encodeURIComponent(`https://www.kinokuniya.co.jp/f/dsg-01-${isbn13}`)}?bm=${isbn13}`,
      },
      {
        alphabet_name: 'honto',
        url: `//ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=3&vc_url=${encodeURIComponent(`https://honto.jp/ebook/pd_${honto}.html?partnerid=02vc01`)}`,
      },
      {
        alphabet_name: 'amazon',
        url: 'https://www.amazon.co.jp/dp/4797384352/ref=as_li_tf_tl?tag=bookmeter-22',
      },
    ],
  });
}

export function nativelySitemap(ids: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://learnnatively.com/</loc></url>${ids
    .map((i) => `<url><loc>https://learnnatively.com/book/${i}/</loc></url>`)
    .join('')}</urlset>`;
}

export function nativelyBook(title: string, isbn13: string, kindleAsin: string): string {
  const data = [
    '$',
    '$L23',
    null,
    {
      data: {
        item: { id: 'x', title, isbn: '', isbn13 },
        whereToFindUrls: [
          {
            bookType: 'ebook',
            url: `https://www.amazon.co.jp/dp/${kindleAsin}/ref=nosim?tag=natively0d-22`,
            bookProvider: { slug: 'amazon-kindle-jp' },
          },
        ],
      },
    },
  ];
  const chunk = JSON.stringify(`11:${JSON.stringify(data)}\n`);
  return `<html><body><script>self.__next_f.push([1,${chunk}])</script></body></html>`;
}

export function ndlAnswer(rows: { name: string; yomi: string; auth?: string }[]): string {
  return JSON.stringify({
    head: { vars: ['name', 'auth', 'label', 'yomi'] },
    results: {
      bindings: rows.map((r) => ({
        name: { type: 'literal', value: r.name },
        auth: { type: 'uri', value: r.auth ?? 'http://id.ndl.go.jp/auth/ndlna/1' },
        label: { type: 'literal', value: r.name },
        yomi: { type: 'literal', value: r.yomi },
      })),
    },
  });
}

/** A stand-in internet: URL (or a test) -> status and body. Unknown URLs answer 404. */
export type Site = (req: {
  site: string;
  url: string;
  method: string;
  body: string | null;
}) => { status: number | null; body?: string | Buffer; error?: string } | undefined;
