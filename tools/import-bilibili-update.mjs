import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [articleId, cacheArgument = '.cache/bilibili-updates.json'] = process.argv.slice(2);
if (!/^\d+$/.test(articleId || '')) throw new Error('Usage: node tools/import-bilibili-update.mjs <article-id> [cache-path]');
const cachePath = resolve(cacheArgument);
let cookie = '';
try {
  const state = JSON.parse(readFileSync(resolve('.cache/danmaku/bilibili_storage_state.json'), 'utf8'));
  cookie = (state.cookies || []).filter(item => /(?:^|\.)bilibili\.com$/i.test(item.domain || '')).map(item => `${item.name}=${item.value}`).join('; ');
} catch {}
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const linkify = value => escape(value).replace(/https?:\/\/[^\s&lt;&quot;'，。；！？、）】]+/gi, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

function nodeHtml(node) {
  if (Number(node?.node_type) === 1 && node.word) {
    let value = linkify(node.word.words || '');
    if (node.word.style?.bold) value = `<strong>${value}</strong>`;
    if (node.word.style?.italic) value = `<em>${value}</em>`;
    if (node.word.style?.strikethrough) value = `<s>${value}</s>`;
    if (node.word.style?.underline) value = `<u>${value}</u>`;
    return value;
  }
  if (Number(node?.node_type) === 4 && node.link) {
    const href = /^https?:\/\//i.test(String(node.link.link || '')) ? node.link.link : '#';
    return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(node.link.show_text || href)}</a>`;
  }
  return '';
}

function contentHtml(opus) {
  const output = [];
  let listHash = '';
  let listLevel = 0;
  const closeList = () => {
    if (!listHash) return;
    output.push('</ul>');
    listHash = '';
    listLevel = 0;
  };
  for (const paragraph of opus?.content?.paragraphs || []) {
    const type = Number(paragraph?.para_type);
    const nodes = paragraph?.text?.nodes || [];
    const html = nodes.map(nodeHtml).join('');
    const plain = nodes.map(node => node?.word?.words || node?.link?.show_text || '').join('').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').trim();
    if (!output.length && (!plain || /^(?:#[^#]+#\s*)+$/u.test(plain))) continue;
    if (type === 6) {
      const format = paragraph.format?.list_format || {};
      const hash = String(paragraph.format?.combine_hash || `list-${output.length}`);
      const level = Math.max(1, Number(format.level) || 1);
      if (hash !== listHash || level !== listLevel) {
        closeList();
        output.push(`<ul class="updates-opus-list level-${level}">`);
        listHash = hash;
        listLevel = level;
      }
      output.push(`<li>${html}</li>`);
      continue;
    }
    closeList();
    if (type === 2) {
      const pictures = paragraph.pic?.pics || [];
      if (pictures.length) output.push(`<figure class="updates-opus-pictures">${pictures.map(picture => {
        const source = String(picture?.url || '').replace(/^http:\/\//i, 'https://');
        return source ? `<img src="${escape(source)}" alt="" referrerpolicy="no-referrer" loading="eager"${picture.width ? ` width="${Number(picture.width)}"` : ''}${picture.height ? ` height="${Number(picture.height)}"` : ''}>` : '';
      }).join('')}</figure>`);
    } else if (type === 3) output.push('<hr>');
    else if (type === 9) {
      const heading = Math.min(4, Math.max(2, Number(paragraph.format?.heading_type) + 1 || 2));
      if (html) output.push(`<h${heading}>${html}</h${heading}>`);
    } else if (html) {
      const align = Number(paragraph.format?.align);
      output.push(`<p${align === 2 ? ' class="align-center"' : align === 3 ? ' class="align-right"' : ''}>${html}</p>`);
    }
  }
  closeList();
  return output.join('');
}

function renderedArticleBody(page) {
  const marker = '<div class="opus-module-content';
  const start = page.indexOf(marker);
  if (start < 0) return '';
  const openEnd = page.indexOf('>', start);
  let depth = 1;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = openEnd + 1;
  for (let match; (match = tags.exec(page));) {
    depth += /^<\/div/i.test(match[0]) ? -1 : 1;
    if (depth === 0) return normalizeRenderedArticleBody(page.slice(openEnd + 1, match.index))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<div\b[^>]*opus-module-topic[^>]*>[\s\S]*?<\/div>\s*<\/div>/i, '')
      .trim();
  }
  return '';
}

function normalizeRenderedArticleBody(html) {
  let value = String(html || '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<span\b[^>]*>/gi, '')
    .replace(/<\/span>/gi, '')
    .replace(/<h2\b/gi, '<h3')
    .replace(/<\/h2>/gi, '</h3>')
    .replace(/<h1\b/gi, '<h2')
    .replace(/<\/h1>/gi, '</h2>')
    .replace(/\s(?:style|class|data-[\w-]+|start|list-style-type)=(?:"[^"]*"|'[^']*')/gi, '');
  value = value.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (block, inner) => {
    const level = Math.max(1, Number(inner.match(/<li\b[^>]*\blevel=["']?(\d+)/i)?.[1]) || 1);
    return `<ul class="updates-opus-list level-${level}">${inner.replace(/<li\b[^>]*>/gi, '<li>')}</ul>`;
  });
  value = value.replace(/\slevel=(?:"[^"]*"|'[^']*')/gi, '');
  value = value.replace(/^\s*<p>([\s\S]*?)<\/p>/i, (block, inner) => {
    const plain = inner.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').trim();
    return /^(?:#[^#]+#\s*)+$/u.test(plain) ? '' : block;
  });
  return value;
}

const response = await fetch(`https://api.bilibili.com/x/article/view?id=${articleId}`, {
  headers: { accept: 'application/json', referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', ...(cookie ? { cookie } : {}) }
});
if (!response.ok) throw new Error(`Article HTTP ${response.status}`);
const payload = await response.json();
const data = Number(payload?.code) === 0 ? payload.data : null;
let fallback = {};
let renderedBody = '';
if (!data) {
  const listResponse = await fetch('https://api.bilibili.com/x/article/list/web/articles?id=153587&web_location=333.1400', { headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0' } });
  const listPayload = await listResponse.json();
  fallback = (listPayload?.data?.articles || []).find(item => String(item.id) === articleId) || {};
  for (let attempt = 0; attempt < 10 && !renderedBody; attempt += 1) {
    const pageResponse = await fetch(`https://www.bilibili.com/read/cv${articleId}?spm_id_from=333.999.0.${attempt}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', ...(cookie ? { cookie } : {}) }
    });
    renderedBody = renderedArticleBody(await pageResponse.text());
  }
  if (!renderedBody) throw new Error(`Article API code ${payload?.code}; rendered page unavailable`);
}
const coverUrl = String(data?.opus?.article?.cover?.[0]?.url || data?.banner_url || '').replace(/^http:\/\//i, 'https://');
const cover = coverUrl ? `<figure class="updates-opus-cover"><img src="${escape(coverUrl)}" alt="" referrerpolicy="no-referrer" loading="eager"></figure>` : '';
const article = {
  id: String(data?.id || fallback.id || articleId),
  title: String(data?.title || fallback.title || ''),
  author: data?.author?.name || data?.author?.uname || '灵梦の蝴蝶结',
  authorUid: String(data?.author?.mid || data?.author?.uid || '2608713'),
  publishedAt: (data?.publish_time || fallback.publish_time) ? new Date(Number(data?.publish_time || fallback.publish_time) * 1000).toISOString() : '',
  sourceUrl: `https://www.bilibili.com/read/cv${articleId}`,
  contentHtml: `${cover}${data ? contentHtml(data.opus) : renderedBody}`,
  summary: String(data?.summary || fallback.summary || ''),
  words: Number(data?.words || fallback.words || 0),
  publishTime: Number(data?.publish_time || fallback.publish_time || 0)
};
if (!article.contentHtml) throw new Error('Article content is empty');
const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
cache.formatVersion = 5;
cache.updatedAt = new Date().toISOString();
cache.articles = [...(cache.articles || []).filter(item => String(item.id) !== article.id), article]
  .sort((left, right) => Number(right.publishTime || 0) - Number(left.publishTime || 0));
writeFileSync(cachePath, JSON.stringify(cache));
console.log(JSON.stringify({ id: article.id, title: article.title, contentLength: article.contentHtml.length, articleCount: cache.articles.length }));
