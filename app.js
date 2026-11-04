(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const fileInput = $('pdf-file');
  const fileName = $('file-name');
  const fileInfo = $('file-info');
  const convertButton = $('convert');
  const shareButton = $('share-epub');
  const directDownloadLink = $('direct-download');
  const layoutQuality = $('layout-quality');
  const layoutQualityWrap = $('layout-quality-wrap');
  const progressWrap = $('progress-wrap');
  const progressLabel = $('progress-label');
  const progressPct = $('progress-pct');
  const progressBar = $('progress-bar');
  const progressTrack = $('progress-track');
  const status = $('status');
  const shareLabel = $('share-label');

  const layoutPresets = {
    high: { maxEdge: 1500, quality: 0.78 },
    balanced: { maxEdge: 1200, quality: 0.68 },
    compact: { maxEdge: 950, quality: 0.58 }
  };
  const downloadUrlRetentionMs = 10 * 60 * 1000;

  let selectedFile = null;
  let epubBlob = null;
  let epubName = '阅读.epub';
  let epubDownloadUrl = null;
  let busy = false;
  let sharing = false;
  let pendingDownloadNotice = null;

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

  function selectedLayoutPreset() {
    return layoutPresets[layoutQuality.value] || layoutPresets.balanced;
  }

  function setStatus(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function prepareDirectDownload() {
    if (!epubBlob) throw new Error('EPUB 尚未生成。');
    if (epubDownloadUrl) return;

    const url = URL.createObjectURL(epubBlob);
    epubDownloadUrl = url;
    directDownloadLink.href = url;
    directDownloadLink.download = epubName;
    directDownloadLink.setAttribute('aria-disabled', 'false');
    directDownloadLink.removeAttribute('tabindex');
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      if (epubDownloadUrl !== url) return;
      epubDownloadUrl = null;
      if (epubBlob) {
        try {
          prepareDirectDownload();
        } catch (error) {
          directDownloadLink.removeAttribute('href');
          directDownloadLink.setAttribute('aria-disabled', 'true');
          directDownloadLink.setAttribute('tabindex', '-1');
          setStatus(`下载链接已失效，无法重新创建：${error?.message || '未知错误'}`, true);
        }
      }
    }, downloadUrlRetentionMs);
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
    layoutQuality.disabled = busy;
    layoutQualityWrap.hidden = selectedMode() !== 'layout';
    shareButton.disabled = !epubBlob || sharing;
  }

  function resetResult() {
    epubBlob = null;
    epubDownloadUrl = null;
    directDownloadLink.removeAttribute('href');
    directDownloadLink.removeAttribute('download');
    directDownloadLink.setAttribute('aria-disabled', 'true');
    directDownloadLink.setAttribute('tabindex', '-1');
    shareButton.disabled = true;
    shareLabel.textContent = '分享并保存 EPUB · iPhone 选择“图书”';
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
    input.addEventListener('change', () => {
      resetResult();
      refreshControls();
    });
  });

  layoutQuality.addEventListener('change', resetResult);

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

  async function renderPage(page, preset) {
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.6, preset.maxEdge / Math.max(viewport.width, viewport.height, 1));
    const scaled = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(scaled.width));
    canvas.height = Math.max(1, Math.ceil(scaled.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    const blob = await canvasToJpeg(canvas, preset.quality);
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
    const layoutPreset = mode === 'layout' ? selectedLayoutPreset() : null;
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
          const rendered = await renderPage(page, layoutPreset);
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
      const outputName = `${PdfEpubCore.safeFilename(title || selectedFile.name)}.epub`;
      epubBlob = blob;
      epubName = outputName;
      prepareDirectDownload();
      setProgress(1, 1, '转换完成');
      setStatus(`已生成 ${epubName} · ${formatSize(blob.size)}。可分享保存，也可直接下载。`);
    } catch (error) {
      console.error(error);
      epubBlob = null;
      epubDownloadUrl = null;
      directDownloadLink.removeAttribute('href');
      directDownloadLink.removeAttribute('download');
      directDownloadLink.setAttribute('aria-disabled', 'true');
      directDownloadLink.setAttribute('tabindex', '-1');
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

  function shareFailureMessage(error) {
    const name = error?.name || 'Error';
    const detail = error?.message ? `：${error.message}` : '';
    if (name === 'AbortError') return `系统分享已取消或未完成（${name}）；正在尝试下载`;
    if (name === 'NotAllowedError') return `Safari 未能启动分享（${name}，可能受点击手势或系统权限限制）；正在尝试下载`;
    if (name === 'DataError') return `系统无法传输此文件（${name}，大文件或分享目标可能受限）；正在尝试下载`;
    return `分享失败（${name}${detail}）；正在尝试下载`;
  }

  function clickDirectDownload(notice, error = false) {
    try {
      prepareDirectDownload();
      pendingDownloadNotice = { message: notice, error };
      directDownloadLink.click();
    } catch (downloadError) {
      pendingDownloadNotice = null;
      console.error(downloadError);
      setStatus(`${notice}。Safari 未能启动下载：${downloadError?.message || '未知错误'}。请点“直接下载 EPUB”重试。`, true);
    }
  }

  async function shareEpub() {
    if (!epubBlob || sharing) return;
    sharing = true;
    shareLabel.textContent = '正在打开系统分享…';
    setStatus(`正在分享 ${epubName}（${formatSize(epubBlob.size)}）…`);
    refreshControls();

    try {
      const file = new File([epubBlob], epubName, { type: 'application/epub+zip' });
      const files = [file];
      const canShareFiles = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files });
      if (!canShareFiles) {
        clickDirectDownload('Safari 当前不支持此 EPUB 的文件分享（文件类型或大小可能受限），已改为下载请求', true);
        return;
      }

      // Keep this call in the original click turn: yielding or awaiting before it can lose iOS transient activation.
      await navigator.share({ files, title: epubName });
      setStatus(`系统分享已完成：${epubName}。`);
    } catch (error) {
      console.error('EPUB share failed; falling back to direct download.', error);
      clickDirectDownload(`${shareFailureMessage(error)}，已发出下载请求；若 Safari 没有弹出下载提示，请点下方“直接下载 EPUB”重试`, true);
    } finally {
      sharing = false;
      shareLabel.textContent = '分享并保存 EPUB · iPhone 选择“图书”';
      refreshControls();
    }
  }

  convertButton.addEventListener('click', convert);
  shareButton.addEventListener('click', shareEpub);
  directDownloadLink.addEventListener('click', event => {
    if (!epubBlob) {
      event.preventDefault();
      return;
    }
    try {
      prepareDirectDownload();
    } catch (downloadError) {
      event.preventDefault();
      console.error(downloadError);
      setStatus(`无法创建下载链接：${downloadError?.message || '未知错误'}`, true);
      return;
    }
    const notice = pendingDownloadNotice || {
      message: `已请求 Safari 下载 ${epubName}（${formatSize(epubBlob.size)}）。若打开预览，可从分享菜单存储到“文件”，再用“图书”打开。`,
      error: false
    };
    pendingDownloadNotice = null;
    setStatus(notice.message, notice.error);
  });
  refreshControls();
})();
