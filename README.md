# Glitter

Glitter 是一个面向 Obsidian 的灵感记录插件，帮助你在阅读、写作和整理笔记时，快速记录、分类整理、回看复用并插入灵感。

Glitter is an Obsidian plugin for quickly capturing, organizing, revisiting, and inserting ideas while you work in your vault.

<!-- Future media slot: product overview image or short demo -->

## Why Glitter / 为什么使用 Glitter

### 中文
灵感往往出现在最不想被打断的时候：写到一半、读到一半、整理资料到一半。Glitter 的目标，是让你先把想法收住，再决定之后如何整理，而不是被迫立刻新建一篇正式笔记。

你可以用 Glitter 在 Obsidian 里快速记录文本、链接、图片和视频；粘贴链接时，Glitter 还可以自动识别并补全相关信息。记录下来的灵感可以继续放进不同的灵感池中整理，也可以在写作时重新插回正文，避免好点子被埋没在零散草稿里。

### English
Ideas usually show up at the worst possible moment to break your flow: in the middle of writing, reading, or sorting notes. Glitter is designed to help you capture first and organize later, instead of forcing every thought to become a full note immediately.

With Glitter, you can quickly save text, links, images, and videos inside Obsidian. When you paste a link, Glitter can also recognize it and fill in relevant details automatically. Later, you can sort ideas into pools and insert them back into your notes as reusable snippets instead of losing them in scattered drafts.

## Quick Start / 快速上手

<!-- Future media slot: quick-start walkthrough -->

### 中文
1. 在 Obsidian 中打开 Glitter，并使用快速记录入口开始保存灵感。
2. 输入文本，或直接粘贴链接；如果你正在记录图片或视频，也可以一并保存到灵感里。
3. 选择合适的灵感池后保存；如果你希望这条灵感成为独立笔记，也可以选择为它创建 Markdown 文件。
4. 之后你可以在 Glitter 中搜索、浏览和回看这些灵感；写作时，还可以把某条灵感以片段形式插入当前笔记正文。

### English
1. Open Glitter in Obsidian and use its quick capture entry to save an idea.
2. Type text or paste a link directly; if your idea includes images or videos, you can save those too.
3. Choose the right pool and save it. If you want the idea to become its own note, you can also choose to create a Markdown file for it.
4. Later, you can search, browse, and revisit the idea in Glitter, or insert it into a note body as a snippet while writing.

## Feature Areas / 功能分区

<!-- Future media slot: feature overview gallery -->

### 中文
- **快速记录**：在不离开 Obsidian 的前提下，尽快把想法记下来，减少打断感。
- **多内容类型支持**：支持文本、链接、图片、视频等常见灵感内容；粘贴链接后可自动识别并补全基础信息。
- **灵感池整理**：把灵感放入不同的池中，便于分类、浏览、筛选与后续整理。
- **片段插入**：写笔记时，可以把已有灵感插入正文，方便引用、延展和继续写作。
- **可选创建文件**：并不是每条灵感都必须变成独立笔记；你可以按需决定是否创建 Markdown 文件。
- **回看与复用**：已经保存的灵感可以持续回看和再利用，而不是只停留在一次性速记里。

### English
- **Quick capture**: Save an idea quickly without leaving Obsidian or breaking your flow.
- **Support for multiple content types**: Work with text, links, images, and videos, with automatic recognition and basic detail filling when you paste a link.
- **Pools for organization**: Group ideas into different pools so they are easier to classify, browse, filter, and sort later.
- **Snippet insertion**: Insert an existing idea into a note body while writing so it can be referenced and expanded in context.
- **Optional file creation**: Not every idea needs to become a standalone note; you can decide whether a Markdown file should be created.
- **Revisit and reuse**: Saved ideas stay available for later review and reuse instead of disappearing into one-off capture notes.

## Design Philosophy / 设计理念

### 中文
Glitter 的设计核心不是“把一切都立刻结构化”，而是“先把灵感留住，再用更轻的方式慢慢整理”。

这意味着它会尽量减少记录时的阻力，同时保留之后整理和复用的空间：你可以先快速收集，再通过灵感池归类；可以先不建文件，等需要时再创建；可以先独立保存，之后再把灵感片段插入正文。整个过程都围绕同一个目标展开：让灵感更容易被再次看见、再次使用。

### English
Glitter is not built around the idea that everything should be structured immediately. Its core philosophy is to help you keep the idea first, then organize it in a lighter way over time.

That means reducing friction at capture time while leaving room for later structure and reuse. You can collect first, sort into pools later, skip file creation unless it is useful, and bring ideas back into note bodies as snippets when they are ready to become part of your writing. The goal is simple: make ideas easier to see again and easier to use again.

## Install & Update / 安装与更新

### 中文
**安装**

1. 从本仓库最新 Release 下载 Glitter 发布包。
2. 在你的 vault 中创建文件夹：`.obsidian/plugins/glitter-idea-plugin/`
3. 将发布包中的 `manifest.json`、`main.js` 和 `styles.css` 复制到这个文件夹中。
4. 重新打开 Obsidian，或重新加载社区插件。
5. 打开 **Settings → Community plugins**，启用 **Glitter**。

**更新**

1. 下载最新版本的 Glitter 发布包。
2. 用新的 `manifest.json`、`main.js` 和 `styles.css` 替换旧文件。
3. 重新加载 Obsidian，然后确认 Glitter 已正常启用。

### English
**Install**

1. Download the latest Glitter release package from this repository’s Releases page.
2. In your vault, create this folder: `.obsidian/plugins/glitter-idea-plugin/`
3. Copy `manifest.json`, `main.js`, and `styles.css` from the release package into that folder.
4. Restart Obsidian or reload community plugins.
5. Open **Settings → Community plugins** and enable **Glitter**.

**Update**

1. Download the newest Glitter release package.
2. Replace the existing `manifest.json`, `main.js`, and `styles.css` files with the new ones.
3. Reload Obsidian and confirm Glitter is enabled.

## FAQ / Notes / 常见问题与说明

### 中文
**Q: Glitter 适合记录哪些内容？**  
A: 适合快速记录文本、链接、图片和视频等内容；如果你粘贴的是链接，Glitter 还可以自动识别并补全相关信息。

**Q: 每条灵感都会自动创建一个 Markdown 文件吗？**  
A: 不会。是否创建文件是可选的，你可以按自己的整理方式决定。

**Q: Pool（灵感池）是做什么的？**  
A: 灵感池是用来分组整理灵感的。你可以按主题、项目、写作阶段或任何适合自己的方式来分类。

**Q: 我可以把已经保存的灵感重新放回笔记正文吗？**  
A: 可以。Glitter 支持把灵感作为片段插入笔记正文，方便在写作时继续展开和引用。

**Q: 这份 README 之后会补充演示图或视频吗？**  
A: 会。当前版本先聚焦于安装说明和功能说明，后续会在相同章节结构中补充截图与演示媒体。

### English
**Q: What kinds of content can Glitter capture?**  
A: Glitter is designed for quickly saving text, links, images, and videos. If you paste a link, it can also recognize it and fill in relevant details automatically.

**Q: Does every idea automatically become a Markdown file?**  
A: No. File creation is optional, so you can decide when an idea should stay lightweight and when it should become its own note.

**Q: What is a pool for?**  
A: A pool is a way to group and organize ideas. You can sort them by topic, project, writing stage, or any structure that fits your workflow.

**Q: Can I bring saved ideas back into my notes later?**  
A: Yes. Glitter supports inserting ideas into note bodies as snippets so they can be reused, referenced, and expanded while you write.

**Q: Will screenshots or demo media be added later?**  
A: Yes. This version focuses on installation and capability overview first, and visual walkthrough media can be added later within the same section structure.
