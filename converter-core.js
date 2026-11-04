(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PdfEpubCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPUB_MIMETYPE = 'application/epub+zip';
  const XML_NS = 'http://www.w3.org/1999/xhtml';

  function escapeXml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    })[char]);
  }

  function safeFilename(value) {
    const name = String(value || '阅读').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
    return (name || '阅读').slice(0, 100);
  }

  function textItemsToHtml(items) {
    const lines = [];
    let line = '';
    let previousY = null;
    let previousXEnd = null;
    let previousFont = 12;
    const flush = () => {
      const content = line.replace(/[\t ]+/g, ' ').trim();
      if (content) lines.push(content);
      line = '';
      previousXEnd = null;
    };

    for (const item of items || []) {
      if (!item || typeof item.str !== 'string') continue;
      const value = item.str.replace(/\u0000/g, '').trim();
      if (!value) {
        if (item.hasEOL) flush();
        continue;
      }
      const transform = item.transform || [];
      const x = Number(transform[4]);
      const y = Number(transform[5]);
      const font = Math.max(1, Math.hypot(Number(transform[2]) || 0, Number(transform[3]) || 0) || previousFont);
      if (line && Number.isFinite(y) && Number.isFinite(previousY) && Math.abs(y - previousY) > Math.max(2, font * 0.5)) flush();
      if (line && Number.isFinite(x) && Number.isFinite(previousXEnd) && x - previousXEnd > Math.max(1.5, font * 0.18) && !/^\s/.test(item.str)) line += ' ';
      line += value;
      previousY = y;
      previousXEnd = Number.isFinite(x) ? x + Math.max(value.length * font * 0.48, Number(item.width) || 0) : null;
      previousFont = font;
      if (item.hasEOL) flush();
    }
    flush();
    if (!lines.length) return '<p class="empty">（本页没有可提取的文字）</p>';
    return lines.map(text => `<p>${escapeXml(text)}</p>`).join('\n');
  }

  function xhtml(title, body, lang, nested = false, dimensions = null, fixedLayout = false) {
    const styleHref = nested ? '../styles/book.css' : 'styles/book.css';
    const width = Math.max(1, Math.round(Number(dimensions?.width) || 1200));
    const height = Math.max(1, Math.round(Number(dimensions?.height) || 1600));
    const viewport = fixedLayout ? `width=${width}, height=${height}` : 'width=device-width, initial-scale=1';
    const bodyClass = fixedLayout ? ' class="fixed-page"' : '';
    return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="${XML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}"><head><meta charset="utf-8"/><meta name="viewport" content="${viewport}"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="${styleHref}"/></head><body${bodyClass}>${body}</body></html>`;
  }

  function navItems(nodes, pages, prefix = '') {
    const children = Array.isArray(nodes) ? nodes : [];
    if (!children.length) return '';
    return `<ol>${children.map((node, i) => {
      const page = Math.max(1, Math.min(pages.length, Number(node.page) || 1));
      const href = `text/page-${String(page).padStart(4, '0')}.xhtml#page-${page}`;
      const label = escapeXml(node.title || `书签 ${i + 1}`);
      const nested = navItems(node.children, pages, `${prefix}${i}.`);
      return `<li><a href="${href}">${label}</a>${nested}</li>`;
    }).join('')}</ol>`;
  }

  function ncxItems(nodes, pages, counter = { value: 0 }, idPrefix = 'nav') {
    const children = Array.isArray(nodes) ? nodes : [];
    return children.map((node, i) => {
      const order = ++counter.value;
      const id = `${idPrefix}-${order}`;
      const page = Math.max(1, Math.min(pages.length, Number(node.page) || 1));
      const href = `text/page-${String(page).padStart(4, '0')}.xhtml#page-${page}`;
      const nested = ncxItems(node.children, pages, counter, id);
      return `<navPoint id="${id}" playOrder="${order}"><navLabel><text>${escapeXml(node.title || `书签 ${i + 1}`)}</text></navLabel><content src="${href}"/>${nested}</navPoint>`;
    }).join('');
  }

  function outlineDepth(nodes) {
    const children = Array.isArray(nodes) ? nodes : [];
    if (!children.length) return 0;
    return Math.max(...children.map(node => 1 + outlineDepth(node.children)));
  }

  function xmlFile(title, body) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
  }

  function imageByteLength(image) {
    if (image == null) return 0;
    if (typeof image.size === 'number') return image.size;
    if (typeof image.byteLength === 'number') return image.byteLength;
    if (typeof image.length === 'number') return image.length;
    return -1;
  }

  async function createEpub(options, JSZip) {
    if (typeof JSZip !== 'function') throw new Error('JSZip 未加载');
    const { pages, mode } = options || {};
    if (!Array.isArray(pages) || !pages.length) throw new Error('没有可写入 EPUB 的页面');
    if (mode !== 'layout' && mode !== 'text') throw new Error('未知转换模式');
    const zip = new JSZip();
    const title = String(options.title || '未命名文档').trim() || '未命名文档';
    const author = String(options.author || 'PDF 转换').trim() || 'PDF 转换';
    const lang = String(options.language || 'zh-CN');
    const bookId = options.identifier || `urn:uuid:${cryptoRandomId()}`;
    const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const pageCount = pages.length;
    const coverImage = options.cover || pages[0].image;
    const coverType = options.coverType || 'image/jpeg';
    const coverExtension = coverType === 'image/png' ? 'png' : 'jpg';
    const fixedLayout = mode === 'layout';
    const coverDimensions = options.coverDimensions || pages[0];
    const add = (path, data, extra = {}) => zip.file(path, data, { createFolders: false, ...extra });

    if (fixedLayout) {
      for (let index = 0; index < pageCount; index++) {
        if (imageByteLength(pages[index].image) <= 0) {
          throw new Error(`第 ${index + 1} 页图片为空或缺失`);
        }
      }
    }

    // EPUB 要求该文件是 ZIP 中第一个成员，并且保持 STORE（不压缩）。
    add('mimetype', EPUB_MIMETYPE, { compression: 'STORE' });
    add('META-INF/container.xml', xmlFile('container', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'));
    add('OEBPS/styles/book.css', 'html{font-family:serif;line-height:1.72;color:#222}body{margin:0 auto;padding:1em;max-width:42em}p{margin:.6em 0;text-indent:2em;orphans:2;widows:2}.empty{text-indent:0;color:#777;font-style:italic}.page-image{display:block;width:100%;height:auto;max-width:100%;margin:0 auto;object-fit:contain}.page{break-after:page;page-break-after:always}.pagebreak{display:block;height:0;overflow:hidden}figure{margin:0}.cover-page{margin:0;padding:0;text-align:center}.cover-page img{display:block;width:100%;height:auto;margin:0 auto}.page-label{font-size:.8em;color:#777;text-align:center;text-indent:0;margin:1em 0}.fixed-page{width:100vw;height:100vh;max-width:none;margin:0;padding:0;display:grid;place-items:center;overflow:hidden}.fixed-page .page,.fixed-page figure{width:100%;height:100%;margin:0}.fixed-page .page-image,.fixed-page .cover-page img{width:100%;height:100%;max-width:100vw;max-height:100vh;object-fit:contain}');
    if (coverImage) add(`OEBPS/images/cover.${coverExtension}`, coverImage, { binary: true });

    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
      '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
      `<item id="cover-image" href="images/cover.${coverExtension}" media-type="${escapeXml(coverType)}" properties="cover-image"/>`,
      '<item id="css" href="styles/book.css" media-type="text/css"/>'
    ];
    const spine = ['<itemref idref="cover"/>'];

    add('OEBPS/cover.xhtml', xhtml(title, coverImage ? `<section class="cover-page"><img src="images/cover.${coverExtension}" alt="${escapeXml(title)} 封面"/></section>` : `<h1>${escapeXml(title)}</h1>`, lang, false, coverDimensions, fixedLayout));

    for (let index = 0; index < pageCount; index++) {
      const pageNumber = index + 1;
      const id = `page-${String(pageNumber).padStart(4, '0')}`;
      let body;
      if (mode === 'layout') {
        const imageExtension = pages[index].imageType === 'image/png' ? 'png' : 'jpg';
        const imagePath = index === 0 && pages[index].image === coverImage
          ? `../images/cover.${coverExtension}`
          : `../images/${id}.${imageExtension}`;
        if (!(index === 0 && pages[index].image === coverImage)) {
          add(`OEBPS/images/${id}.${imageExtension}`, pages[index].image, { binary: true });
          manifest.push(`<item id="image-${id}" href="images/${id}.${imageExtension}" media-type="${imageExtension === 'png' ? 'image/png' : 'image/jpeg'}"/>`);
        }
        body = `<section class="page"><span id="page-${pageNumber}" class="pagebreak" epub:type="pagebreak" role="doc-pagebreak" aria-label="${pageNumber}"/><figure><img class="page-image" src="${imagePath}" alt="第 ${pageNumber} 页"/></figure></section>`;
      } else {
        body = `<article class="page"><span id="page-${pageNumber}" class="pagebreak" epub:type="pagebreak" role="doc-pagebreak" aria-label="${pageNumber}"/><h2 class="page-label">第 ${pageNumber} 页</h2>${pages[index].html || '<p class="empty">（本页没有可提取的文字）</p>'}</article>`;
      }
      const href = `text/page-${String(pageNumber).padStart(4, '0')}.xhtml`;
      add(`OEBPS/${href}`, xhtml(`${title} · 第 ${pageNumber} 页`, body, lang, true, pages[index], fixedLayout));
      manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="${id}"/>`);
    }

    const outline = Array.isArray(options.outline) && options.outline.length
      ? options.outline
      : [{ title: '正文', page: 1, children: [] }];
    const toc = navItems(outline, pages);
    const navBody = `<nav epub:type="toc" id="toc"><h1>目录</h1>${toc}</nav>${pageCount <= 250 ? `<nav epub:type="page-list"><h2>页码</h2><ol>${pages.map((_, i) => `<li><a href="text/page-${String(i + 1).padStart(4, '0')}.xhtml#page-${i + 1}">${i + 1}</a></li>`).join('')}</ol></nav>` : ''}`;
    add('OEBPS/nav.xhtml', xhtml(`${title} · 目录`, navBody, lang));
    add('OEBPS/toc.ncx', xmlFile('ncx', `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${escapeXml(bookId)}"/><meta name="dtb:depth" content="${outlineDepth(outline)}"/><meta name="dtb:totalPageCount" content="${pageCount}"/><meta name="dtb:maxPageNumber" content="${pageCount}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${ncxItems(outline, pages)}</navMap></ncx>`));
    const layoutValue = fixedLayout ? 'pre-paginated' : 'reflowable';
    const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(lang)}" prefix="rendition: http://www.idpf.org/vocab/rendition/#"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(author)}</dc:creator><dc:language>${escapeXml(lang)}</dc:language><meta property="dcterms:modified">${date}</meta><meta property="rendition:layout">${layoutValue}</meta><meta property="rendition:spread">none</meta></metadata><manifest>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine></package>`;
    add('OEBPS/content.opf', xmlFile('opf', opf));
    return zip.generateAsync({
      type: typeof window !== 'undefined' ? 'blob' : 'nodebuffer',
      mimeType: EPUB_MIMETYPE,
      compression: 'STORE'
    });
  }

  function cryptoRandomId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  return { EPUB_MIMETYPE, createEpub, escapeXml, safeFilename, textItemsToHtml };
});
