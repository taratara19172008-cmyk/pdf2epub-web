# 纸间 · PDF 转 EPUB

一个纯前端静态网页：PDF 文件只在当前设备的浏览器里读取、渲染和打包，不会上传。生成的文件使用 EPUB 3，包含 Apple Books 可识别的封面、目录和阅读顺序。

## 使用

1. 用 Safari 打开部署后的网页，点“选择 PDF 文件”并从“文件”App 选取文档。
2. 选择“保留原版面”或“提取文字重排”，点“开始转换”。
3. 转换完成后可点“分享并保存 EPUB”，在 iPhone/iPad 系统分享面板中选择“图书”；分享失败会显示原因并自动尝试下载。也可随时点“直接下载 EPUB”，再从“文件”App 的分享菜单用图书打开。

转换模式：

- **保留原版面**：逐页渲染成 JPEG，并输出固定版式 EPUB，适合扫描版、图表和复杂排版。可选清晰（最长边上限约 1500 px、JPEG 78%）、均衡（最长边上限约 1200 px、68%）或省空间（最长边上限约 950 px、58%）；默认均衡，较低设置可减少扫描文档的 EPUB 体积。渲染逐页进行并释放画布以控制峰值内存。
- **提取文字重排**：提取 PDF 中的文字并按页面生成可缩放的正文，适合文字型 PDF。扫描件需要先经过 OCR 才会有可提取文字。

PDF.js、JSZip 和中文 CID 字体所需的 CMap 映射都放在 `vendor/`，网页不请求 CDN 或转换服务。PDF.js 使用本地 worker 和映射文件；出于 Safari 对本地文件和 worker 的安全限制，建议通过 HTTP(S) 地址提供静态文件，而不要直接双击 `index.html`。

## 部署

将整个目录原样部署到任意静态文件托管，确保 `vendor/` 子目录也一并上传，然后通过 HTTPS 地址访问。也可以在电脑上用任意静态文件服务器预览，例如：

```sh
python3 -m http.server 8000
```

然后访问 `http://localhost:8000`。该服务器只负责发送 HTML、JS 和本地依赖；PDF 解析、页面渲染及 EPUB 打包都在浏览器内完成。

## 本地结构检查

需要 Node.js 20.16 或更新版本，不需要安装 npm 包：

```sh
node tests/smoke.mjs
```

脚本用 PDF.js 的本地 worker 读取一份生成的最小 PDF，再分别生成文字重排和原版面两种测试 EPUB；它会检查 ZIP 中 `mimetype` 的顺序与压缩方式、EPUB 容器、OPF、nav、封面以及页面资源。

## 说明

- 加密或损坏的 PDF 目前无法转换。
- 非常大的扫描 PDF 仍可能受 iPhone 可用内存和剩余存储空间限制。转换时请保持 Safari 页面打开；可选“省空间”降低图片尺寸和质量。
- EPUB 文件分享是否可用由 iOS/Safari 决定；分享 API 可能在 `canShare` 通过后仍拒绝文件或传输。页面会显示失败状态并尝试 Blob URL 下载。Safari 对 Blob 下载的表现可能因 iOS 版本而异；若没有出现下载提示，可再次点“直接下载 EPUB”，或在打开的预览页通过分享菜单存储到“文件”。

## 本地依赖与许可证

- `vendor/pdfjs.bundle.js`、`vendor/pdf.worker.mjs`：PDF.js 5.4.296，Apache-2.0。该版本 worker 与主文件相匹配；主文件仅为网页挂载了 `pdfjsLib` 全局变量。legacy 构建还包含 core-js 3.45.1 polyfills（MIT）。
- `vendor/jszip.min.js`：JSZip 3.10.2，MIT。
- `vendor/cmaps/`：Adobe CMap 映射文件，随 Debian poppler-data 提供，BSD-3-Clause，供 PDF.js 本地解析 CJK CID 字体使用。
- 许可证文本见 `vendor/LICENSE-pdfjs.txt`、`vendor/LICENSE-core-js.txt`、`vendor/LICENSE-jszip.txt` 与 `vendor/cmaps/COPYING`。
