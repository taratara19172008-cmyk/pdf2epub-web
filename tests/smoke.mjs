import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require('../vendor/jszip.min.js');
const Core = require('../converter-core.js');

// PDF.js needs browser geometry globals at module load. Stub only those APIs;
// the test exercises PDF parsing and text extraction through its real worker.
globalThis.__import_meta_url = pathToFileURL(fileURLToPath(new URL('../vendor/pdfjs.bundle.js', import.meta.url))).href;
globalThis.DOMMatrix = class DOMMatrix { constructor() {} };
globalThis.ImageData = class ImageData {};
globalThis.Path2D = class Path2D {};
const originalWarn = console.warn;
console.warn = () => {};
require('../vendor/pdfjs.bundle.js');
console.warn = originalWarn;
const pdfjsLib = globalThis.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(fileURLToPath(new URL('../vendor/pdf.worker.mjs', import.meta.url))).href;

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const outputDir = await mkdtemp(join(tmpdir(), 'pdf2epub-smoke-'));

function makePdf() {
  const content = 'BT /F1 18 Tf 1 0 0 1 40 240 Tm (Hello PDF EPUB) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

function readFirstZipEntry(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'ZIP local file header signature');
  const method = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const name = buffer.subarray(30, 30 + nameLength).toString('utf8');
  const dataStart = 30 + nameLength + extraLength;
  const size = buffer.readUInt32LE(18);
  return { name, method, extraLength, data: buffer.subarray(dataStart, dataStart + size).toString('utf8') };
}

async function inspectEpub(buffer, expectedFiles, { expectedText, layout } = {}) {
  const first = readFirstZipEntry(buffer);
  assert.equal(first.name, 'mimetype', 'mimetype must be the first ZIP member');
  assert.equal(first.method, 0, 'mimetype must be uncompressed');
  assert.equal(first.extraLength, 0, 'mimetype must not have extra ZIP fields');
  assert.equal(first.data, 'application/epub+zip');
  const archive = await JSZip.loadAsync(buffer);
  for (const path of expectedFiles) assert.ok(archive.file(path), `missing ${path}`);
  const container = await archive.file('META-INF/container.xml').async('string');
  const opf = await archive.file('OEBPS/content.opf').async('string');
  const nav = await archive.file('OEBPS/nav.xhtml').async('string');
  const manifest = new Map([...opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)].map(match => [match[1], match[2]]));
  assert.match(container, /OEBPS\/content\.opf/);
  assert.match(opf, /version="3\.0"/);
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, new RegExp(`<meta property="rendition:layout">${layout ? 'pre-paginated' : 'reflowable'}<\/meta>`));
  assert.match(nav, /epub:type="toc"/);
  assert.ok(manifest.size > 0);
  for (const href of manifest.values()) assert.ok(archive.file(`OEBPS/${href}`), `OPF points to missing OEBPS/${href}`);
  if (expectedText) {
    const page = await archive.file('OEBPS/text/page-0001.xhtml').async('string');
    assert.ok(page.includes(expectedText));
  }
}

assert.match(Core.textItemsToHtml([
  { str: '中文转换', width: 42, transform: [12, 0, 0, 12, 10, 100], hasEOL: true },
  { str: 'EPUB & Books', width: 70, transform: [12, 0, 0, 12, 10, 80], hasEOL: true }
]), /EPUB &amp; Books/);

const pdfTask = pdfjsLib.getDocument({ data: makePdf(), isEvalSupported: false, verbosity: pdfjsLib.VerbosityLevel.ERRORS });
let extractedHtml;
try {
  const pdf = await pdfTask.promise;
  assert.equal(pdf.numPages, 1);
  const page = await pdf.getPage(1);
  const text = await page.getTextContent();
  assert.ok(text.items.some(item => item.str.includes('Hello PDF EPUB')));
  extractedHtml = Core.textItemsToHtml(text.items);
  page.cleanup();
} finally {
  await pdfTask.destroy();
}

const textEpub = await Core.createEpub({
  title: '测试书籍',
  author: '本地测试',
  mode: 'text',
  cover: pixel,
  coverType: 'image/png',
  pages: [{ html: extractedHtml }, { html: '<p>第二页</p>' }],
  outline: [{ title: '第一章', page: 1, children: [{ title: '第二页', page: 2 }] }]
}, JSZip);
const textPath = join(outputDir, 'test-text.epub');
await writeFile(textPath, textEpub);
const textBytes = await readFile(textPath);
await inspectEpub(textBytes, [
  'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/toc.ncx',
  'OEBPS/cover.xhtml', 'OEBPS/images/cover.png', 'OEBPS/text/page-0001.xhtml', 'OEBPS/text/page-0002.xhtml'
], { expectedText: 'Hello PDF EPUB', layout: false });

const layoutEpub = await Core.createEpub({
  title: '版面测试', mode: 'layout', cover: pixel, coverType: 'image/png',
  pages: [{ image: pixel, imageType: 'image/png' }, { image: pixel, imageType: 'image/png' }]
}, JSZip);
const layoutPath = join(outputDir, 'test-layout.epub');
await writeFile(layoutPath, layoutEpub);
const layoutBytes = await readFile(layoutPath);
await inspectEpub(layoutBytes, [
  'META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml',
  'OEBPS/images/cover.png', 'OEBPS/images/page-0002.png',
  'OEBPS/text/page-0001.xhtml', 'OEBPS/text/page-0002.xhtml'
], { layout: true });
const layoutArchive = await JSZip.loadAsync(layoutBytes);
const fixedPage = await layoutArchive.file('OEBPS/text/page-0001.xhtml').async('string');
assert.match(fixedPage, /width=1200, height=1600/);
const ncx = await layoutArchive.file('OEBPS/toc.ncx').async('string');
assert.match(ncx, /playOrder="1"/);
const textArchive = await JSZip.loadAsync(textBytes);
const bookmarkNav = await textArchive.file('OEBPS/nav.xhtml').async('string');
assert.match(bookmarkNav, /第一章/);
assert.match(bookmarkNav, /page-0002\.xhtml#page-2/);

console.log(`EPUB smoke test passed; generated ${textPath} (${textBytes.length} B) and ${layoutPath} (${layoutBytes.length} B).`);
