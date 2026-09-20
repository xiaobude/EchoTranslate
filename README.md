# EchoTranslate 🌐

> 完全基于本地 LocalLLM（如 llama.cpp / llama-server）、服务自主可控、100% 保护隐私的浏览器实时翻译扩展。
> 深度对标 **谷歌翻译** 与 **沉浸式翻译**，完美解决技术长文与单页应用（GitHub / Reddit / 技术博客）浏览翻译需求。

---

## ✨ 核心特性

- 🔒 **100% 隐私自主可控**：无需网络连接外部翻译服务，所有网页文本仅在本地 GPU 显存中推理，绝不泄露任何数据。
- ⚡ **极速毫秒级响应**：本地环回 API 零网络延迟，搭配 `</think>` 旁路跳过长思维链，单句首字延迟低至 200~400ms，速度超越云端服务。
- 🎯 **原地就地无损替换**：像谷歌翻译一样直接就地替换英文文本，保留所有原网页标签、排版、链接与 Web Components（如 Reddit 的 `slot="title"`），排版完全不崩。
- 🔍 **原文悬停提示 (Hover Tooltip)**：鼠标悬停在中文译文上，浏览器原生气泡直接浮现英文原文，核对专业术语极其方便。
- 🚀 **SPA 路由与无限滚动感知**：在 Reddit 等单页应用中点击任意话题，自动感知路由变化并自动翻译新正文与评论；向下滚动加载新内容自动增量补译。
- 🤖 **英文网站智能自动检测**：自动识别英文网页，打开页面无需点击自动开译；遇到知乎、B站等中文站点自动静默不打扰。
- 🐧 **跨平台与全浏览器双兼容**：一套代码同时原生支持 **Windows / Linux Mint**，以及 **Chrome / Edge / Brave / Firefox**。

---

## 🛠️ 本地 LocalLLM 服务配置

推荐使用 [llama.cpp](https://github.com/ggml-org/llama.cpp) 原生的 `llama-server` 提供 OpenAI 兼容端点：

```bash
# 启动本地推理服务示例 (4并发槽位, 32k上下文)
llama-server.exe -m /path/to/NeoHorse-1-4b.gguf -c 32768 -np 4 --port 8080
```

- **默认接口端点**：`http://localhost:8080/v1/chat/completions`
- **默认模型名称**：`NeoHorse-1-4b` (或任何兼容 OpenAI 格式的模型)

---

## 📦 安装与使用

### 1. Chrome / Edge / Brave 浏览器
1. 打开扩展管理页：
   - Edge: `edge://extensions/`
   - Chrome: `chrome://extensions/`
2. 打开右上角 **“开发者模式”**；
3. 点击 **“加载已解压的扩展程序”**；
4. 选择本项目根目录即可启用。

### 2. Firefox (火狐) 浏览器
1. 地址栏输入 `about:debugging` 按回车；
2. 点击左侧 **“此 Firefox” (This Firefox)**；
3. 点击 **“临时载入附加组件...” (Load Temporary Add-on)**；
4. 选中本项目目录下的 `manifest.json` 即可启用。

---

## ⚙️ 设置面板

点击插件图标右上角的齿轮 ⚙️ 进入详细配置：
- 自定义 API 地址、模型名称与请求超时时间
- 自定义翻译 Prompt 模板
- 最大并发数调节（1~5）
- 一键清空本地持久化翻译缓存

---

## 📄 开源许可

MIT License
