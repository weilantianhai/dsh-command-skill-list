# dsh-command-skill-list

[English](#english) | [中文](#中文)

---

## 中文

DSH 插件：在聊天框输入 `/`（或 `/sk` 等任意 `skills` 前缀），列出 `~/.agents/skills` 里的所有用户可调用技能，**描述自动精简翻译为系统语言**（中↔英），选中后该条消息即使用该技能。

### 功能

- 输入 `/` 显示 `skills` 入口；输入 `/sk`、`/ski` 等任意前缀直接弹出完整技能列表
- 描述**精简翻译**为一句话摘要（中文 ≤ 24 字 / 英文 ≤ 15 词），一眼看清技能用途
- **优先复用 DSH 内置模型**（与当前会话同一供应商与凭据，零配置）；可选配置自定义 DeepSeek API Key 作为备用通道
- **技能自定义注释**：在设置页为任意技能填写注释，菜单直接显示注释（跳过翻译）；留空恢复自动翻译
- 翻译结果磁盘缓存（每条描述每种语言终身只翻一次），插件启动时后台预热两种语言，菜单打开基本秒出
- 分批并行翻译，批次失败自动回退到直连 API，再失败显示原文——任何一层失败都不会弄崩菜单
- 选中技能后插入 `/skillname `，由 DSH 内建机制加载该技能

### 安装

```bash
dsh plugin --profile web add github:weilantianhai/dsh-command-skill-list
```

### 设置页

安装后在 DSH 设置页会出现「技能翻译 / Skill Translation」栏：

- **翻译通道**：默认使用 DSH 内置模型（无需任何配置）；也可填入自定义 DeepSeek API Key
- **清空翻译缓存**：换语言或想强制重翻时使用
- **技能自定义注释**：列出全部已安装技能，每行一个输入框——填写后菜单显示注释（灰字），留空保存则清除注释、恢复自动翻译

### 配置文件

所有配置存于 `~/.dsh/plugins/command-skill-list/config.json`（也可通过设置页修改）：

```json
{
  "deepseekApiKey": "sk-xxx",
  "notes": {
    "tdd": "测试驱动开发：红-绿-重构",
    "code-review": "按仓库规范与需求规格双维度审查代码"
  }
}
```

- `deepseekApiKey`：可选，内置模型不可用时的备用翻译通道（也可用环境变量 `DEEPSEEK_API_KEY`）
- `notes`：可选，技能名 → 自定义注释；有注释的技能不再翻译

### 依赖

- DSH Web（`dsh web`）
- Node.js 18+（host 半使用 `fetch`）

---

## English

DSH plugin: type `/` (or any prefix like `/sk`) in the chat to list all user-invocable skills in `~/.agents/skills`, with descriptions **auto-distilled into concise one-line summaries in your system language** (zh↔en). Selecting a skill loads it into the current message.

### Features

- Bare `/` shows a `skills` entry; any prefix like `/sk` or `/ski` opens the full catalog directly
- Descriptions are **distilled to one-line summaries** (≤ 24 CJK chars / ≤ 15 words), not full translations
- **Uses the DSH built-in model first** (same provider and credentials as the session — zero config); an optional custom DeepSeek API key serves as the fallback channel
- **Custom skill notes**: annotate any skill in the settings page — the menu shows the note and skips translation; clear the note to restore auto-translation
- Disk-cached translations (one call per description per language, ever) with background prewarm of both locales at plugin start — menu opens instantly
- Parallel batch translation with automatic fallback (built-in model → direct API → original text); no failure ever breaks the menu
- Picking a skill inserts `/skillname `, leveraging DSH's built-in injection

### Install

```bash
dsh plugin --profile web add github:weilantianhai/dsh-command-skill-list
```

### Settings Page

After installing, a "Skill Translation" section appears in the DSH settings:

- **Translation channel**: the DSH built-in model by default (no configuration needed); optionally enter a custom DeepSeek API key
- **Clear translation cache**: useful after switching languages or forcing a re-translation
- **Skill notes**: lists every installed skill with an input per row — a saved note replaces the menu description; saving empty clears the note and restores auto-translation

### Config File

All settings live in `~/.dsh/plugins/command-skill-list/config.json` (editable via the settings page too):

```json
{
  "deepseekApiKey": "sk-xxx",
  "notes": {
    "tdd": "Test-driven development: red-green-refactor",
    "code-review": "Review code against repo standards and the spec"
  }
}
```

- `deepseekApiKey`: optional fallback translation channel when the built-in model is unavailable (or use the `DEEPSEEK_API_KEY` env var)
- `notes`: optional map of skill name → custom note; noted skills skip translation

### Requirements

- DSH Web (`dsh web`)
- Node.js 18+ (host half uses `fetch`)
