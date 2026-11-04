(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const fileInput = $('pdf-file');
  const fileName = $('file-name');
  const fileInfo = $('file-info');
  const convertButton = $('convert');
  const downloadButton = $('download');
  const progressWrap = $('progress-wrap');
  const progressLabel = $('progress-label');
  const progressPct = $('progress-pct');
  const progressBar = $('progress-bar');
  const progressTrack = $('progress-track');
  const status = $('status');
  const downloadLabel = $('download-label');

  let selectedFile = null;
  let epubBlob = null;
  let epubName = '阅读.epub';
  let busy = false;

  if (globalThis.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', location.href).href;
  }

  function formatSize(size) {
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  function selectedMode() {
    return document.querySelector('input[name="mode"]:checked')?.value || 'layout';
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function setProgress(done, total, label) {
    const value = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
    progressBar.style.width = `${value}%`;
    progressPct.textContent = `${value}%`;
    progressTrack.setAttribute('aria-valuenow', String(value));
    progressLabel.textContent = label;
  }

  function refreshControls() {
    convertButton.disabled = !selectedFile || busy;
    fileInput.disabled = busy;
    document.querySelectorAll('input[name="mode"]').forEach(input => { input.disabled = busy; });
  }

  function resetResult() {
    epubBlob = null;
    downloadButton.disabled = true;
    downloadLabel.textContent = '下载 EPUB';
    progressWrap.hidden = true;
    setStatus('');
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] || null;
    resetResult();
    if (!file) {
      selectedFile = null;
      fileName.textContent = '点此选择 PDF';
      fileInfo.textContent = '支持从“文件”App 选择文稿';
      refreshControls();
      return;
    }
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      selectedFile = null;
      fileName.textContent = '请选择 PDF 文件';
      fileInfo.textContent = '当前选择的文件不是 PDF';
      setStatus('只支持 PDF 文件。', true);
    } else {
      selectedFile = file;
      fileName.textContent = file.name;
      fileInfo.textContent = `${formatSize(file.size)} · 文件只在本机处理`;
    }
    refreshControls();
  });

  document.querySelectorAll('input[name="mode"]').forEach(input => {
    input.addEventListener('change', resetResult);
  });

  function canvasToJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法压缩页面图片，请重试。')), 'image/jpeg', quality);
        return;
      }
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const binary = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/jpeg' }));
      } catch (error) {
        reject(error);
      }
    });
  }

  async function renderCover(page) {
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.25, 850 / Math.max(viewport.width, viewport.height, 1));
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(scaled.width));
    canvas.height = Math.max(1, Math.ceil(scaled.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    const blob = await canvasToJpeg(canvas, 0.76);
    canvas.width = 1;
    canvas.height = 1;
    return { image: blob, width: viewport.width, height: viewport.height };
  }

  async function renderPage(page) {
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.6, 1500 / Math.max(viewport.width, viewport.height, 1));
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(scaled.width));
    canvas.height = Math.max(1, Math.ceil(scaled.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    const blob = await canvasToJpeg(canvas, 0.78);
    canvas.width = 1;
    canvas.height = 1;
    return { image: blob, width: viewport.width, height: viewport.height };
  }

  async function readOutline(pdf, nodes, depth = 0) {
    if (!Array.isArray(nodes) || depth > 10) return [];
    const result = [];
    for (const node of nodes.slice(0, 3000)) {
      let page = 1;
      try {
        let dest = node.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          page = Number.isInteger(dest[0]) ? dest[0] + 1 : await pdf.getPageIndex(dest[0]) + 1;
        }
      } catch (_) {
        // 跳过无法定位到页码的外部链接或损坏书签。
      }
      result.push({
        title: String(node.title || '未命名书签'),
        page,
        children: await readOutline(pdf, node.items, depth + 1)
      });
    }
    return result;
  }

  function yieldToBrowser() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async function convert() {
    if (!selectedFile || busy) return;
    resetResult();
    busy = true;
    refreshControls();
    progressWrap.hidden = false;
    setStatus('正在读取 PDF…');
    setProgress(0, 1, '准备转换');

    let loadingTask = null;
    let pdf = null;
    const mode = selectedMode();
    try {
      if (!globalThis.pdfjsLib || !globalThis.JSZip || !globalThis.PdfEpubCore) {
        throw new Error('本地转换组件未能加载。请通过静态网页地址打开，并确认 vendor 目录完整。');
      }
      const bytes = new Uint8Array(await selectedFile.arrayBuffer());
      loadingTask = pdfjsLib.getDocument({
        data: bytes,
        isEvalSupported: false,
        useSystemFonts: true,
        disableAutoFetch: true,
        disableStream: true,
        cMapUrl: new URL('./vendor/cmaps/', location.href).href,
        cMapPacked: false,
        useWorkerFetch: false,
        maxImageSize: 18_000_000
      });
      pdf = await loadingTask.promise;
      const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
      const title = metadata.info?.Title?.trim() || PdfEpubCore.safeFilename(selectedFile.name);
      const author = metadata.info?.Author?.trim() || 'PDF 转换';
      const outline = await readOutline(pdf, await pdf.getOutline().catch(() => null));
      const pages = [];
      let cover = null;
      const total = pdf.numPages;
      setProgress(0, total, mode === 'layout' ? '正在逐页渲染' : '正在提取文字');
      setStatus(`共 ${total} 页，正在本机处理…`);
      await yieldToBrowser();

      for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
        const page = await pdf.getPage(pageNumber);
        if (mode === 'layout') {
          const rendered = await renderPage(page);
          if (pageNumber === 1) cover = rendered.image;
          pages.push({ ...rendered, imageType: 'image/jpeg' });
        } else {
          if (pageNumber === 1) {
            const renderedCover = await renderCover(page);
            cover = renderedCover.image;
            pages.push({ coverDimensions: { width: renderedCover.width, height: renderedCover.height } });
          }
          const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          const pageText = PdfEpubCore.textItemsToHtml(content.items);
          if (pageNumber === 1) pages[pages.length - 1].html = pageText;
          else pages.push({ html: pageText });
        }
        page.cleanup();
        setProgress(pageNumber, total, mode === 'layout' ? `正在渲染第 ${pageNumber} / ${total} 页` : `正在提取第 ${pageNumber} / ${total} 页`);
        if (pageNumber % 2 === 0 || pageNumber === total) await yieldToBrowser();
      }

      await loadingTask.destroy();
      loadingTask = null;
      pdf = null;
      setProgress(0, 1, '正在打包 EPUB');
      setStatus('页面已处理，正在生成电子书…');
      await yieldToBrowser();
      const blob = await PdfEpubCore.createEpub({
        title,
        author,
        mode,
        pages,
        cover,
        coverDimensions: mode === 'text' ? pages[0]?.coverDimensions : pages[0],
        coverType: 'image/jpeg',
        outline
      }, JSZip);
      epubBlob = blob;
      epubName = `${PdfEpubCore.safeFilename(title || selectedFile.name)}.epub`;
      downloadButton.disabled = false;
      setProgress(1, 1, '转换完成');
      setStatus(`已生成 ${epubName} · ${formatSize(blob.size)}。`);
      downloadLabel.textContent = '保存 EPUB · 在 iPhone 上分享至“图书”';
    } catch (error) {
      console.error(error);
      const message = error?.name === 'PasswordException'
        ? '此 PDF 需要密码；当前版本无法处理加密文档。'
        : error?.name === 'InvalidPDFException'
          ? '无法读取该 PDF，请确认文件未损坏且未加密。'
          : (error?.message || '转换失败，请重试。');
      setStatus(message, true);
      setProgress(0, 1, '转换失败');
    } finally {
      if (loadingTask) {
        try { await loadingTask.destroy(); } catch (_) { /* 已结束的任务 */ }
      } else if (pdf) {
        try { await pdf.destroy(); } catch (_) { /* 已结束的任务 */ }
      }
      busy = false;
      refreshControls();
    }
  }

  async function saveEpub() {
    if (!epubBlob) return;
    const file = new File([epubBlob], epubName, { type: 'application/epub+zip' });
    try {
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: epubName });
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setStatus('分享面板无法打开，正在改用浏览器下载。');
    }
    const url = URL.createObjectURL(epubBlob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = epubName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  convertButton.addEventListener('click', convert);
  downloadButton.addEventListener('click', saveEpub);
  refreshControls();
})();
