# dsh-command-skill-list

[English](#english) | [中文](#中文)

---

## 中文

DSH 插件：在聊天框输入 `/skills`，列出 `~/.agents/skills` 里的所有用户可调用技能，**描述自动翻译为系统语言**（中↔英），选中后该条消息即使用该技能。

### 功能

- 输入 `/skills` 或 `/skills <过滤词>` 触发技能列表
- 描述自动翻译为系统语言（中文系统显示中文，英文系统显示英文）
- 翻译使用 DeepSeek API（OpenAI 兼容），带磁盘缓存，每条描述终身只翻一次
- 选中技能后插入 `/skillname `，由 DSH 内建机制加载该技能

### 安装

```bash
dsh plugin --profile web add github:weilantianhai/dsh-command-skill-list
```

### 配置翻译（可选）

如需启用描述翻译，设置 DeepSeek API Key：

**方式一：环境变量**
```bash
export DEEPSEEK_API_KEY=sk-xxx
```

**方式二：配置文件** `~/.dsh/plugins/command-skill-list/config.json`
```json
{
  "deepseekApiKey": "sk-xxx"
}
```

不配置则显示原始描述（不翻译）。

### 依赖

- DSH Web（`dsh web`）
- Node.js 18+（host 半使用 `fetch`）

---

## English

DSH plugin: type `/skills` in the chat to list all user-invocable skills in `~/.agents/skills`, with descriptions **auto-translated to your system language** (zh↔en). Selecting a skill loads it into the current message.

### Features

- `/skills` or `/skills <filter>` triggers the skill list
- Descriptions auto-translated to system language (zh for Chinese systems, en otherwise)
- Translation via DeepSeek API (OpenAI-compatible) with disk cache
- Picking a skill inserts `/skillname `, leveraging DSH's built-in injection

### Install

```bash
dsh plugin --profile web add github:weilantianhai/dsh-command-skill-list
```

### Configure Translation (optional)

Set a DeepSeek API key for description translation:

**Option 1: Environment variable**
```bash
export DEEPSEEK_API_KEY=sk-xxx
```

**Option 2: Config file** `~/.dsh/plugins/command-skill-list/config.json`
```json
{
  "deepseekApiKey": "sk-xxx"
}
```

Without a key, original descriptions are shown untranslated.

### Requirements

- DSH Web (`dsh web`)
- Node.js 18+ (host half uses `fetch`)
