# 灶间手账 🍳

一个只记录「**亲手做成功过的菜**」的本地菜谱页面。每道菜就是一段 Markdown：头部 frontmatter 记基本信息，正文按「材料 / 步骤 / 心得」三节填写。

纯静态、零构建、无后端，数据全部存在本机浏览器 localStorage 里。

## 打开方式

任选其一：

```bash
# 方式一：直接双击 index.html（支持 file:// 打开，但浏览器禁止本地 fetch，首次看不到示例菜谱）
# 方式二：起个本地服务（推荐）
cd recipe-book
python3 -m http.server 8412
# 浏览器访问 http://127.0.0.1:8412/
```

## 录入模板

点「记一道新菜」会自动带上模板，照着填即可；页脚「查看录入模板」可随时查看/复制。

```markdown
---
名称: 番茄炒蛋
标签: 家常菜, 快手菜
难度: 简单
用时: 15 分钟
日期: 2026-10-12
成功指数: 5
---

## 材料
- 鸡蛋 3 个
- 番茄 2 个

## 步骤
1. ……
2. ……

## 心得
- 成功的关键：……
```

frontmatter 字段：`标签` 逗号分隔可多个；`成功指数` 1–5；不写 frontmatter 只写正文也能导入（菜名取文件名）。

## 功能

- **卡片墙**：按日期排序，支持按菜名 / 标签 / 材料搜索，按标签筛选
- **详情页**：材料自动变成**可勾选的备菜清单**（勾选状态会记住），步骤自动编号
- **烹饪模式**：详情页点「开始做」，大字逐步显示，空格 / 点击 / 方向键翻步，适合在厨房支个手机跟着做
- **Markdown 全打通**：每道菜可复制 / 下载为 `.md`；支持导入 `.md` 文件或直接粘贴；编辑器带实时预览
- **备份**：右上角「备份」可导出全部数据为 JSON，也可导入 JSON 恢复
- **打印**：详情页 Ctrl+P 可打印成一张菜谱卡

## 数据存档：GitHub 仓库（推荐）

菜谱数据默认存本机浏览器 localStorage；配置 GitHub 同步后，**每道菜会存成仓库 `recipes/` 目录下的一个 `.md` 文件**（如 `recipes/番茄炒蛋.md`，带 frontmatter），随仓库一起版本化——这就是正式存档，本机数据只是工作副本。

**接上 GitHub（不需要新建仓库，就用本项目自己的仓库）：**

1. 把本目录推上 GitHub（`recipes/` 目录已在项目里建好）；
2. 页面右上角「GitHub」→ 同步设置，填仓库 `owner/repo`、目录（默认 `recipes`）、分支（默认 `main`）；
3. Token：GitHub → Settings → Developer settings → **Fine-grained tokens**，只勾选本仓库的 **Contents: Read and write**。填入后「测试连接」→「保存并同步」。

之后的行为：

- 打开页面自动拉取远端；增删改菜谱后自动推送（改动 12 秒后静默推送，也可「立即同步」）
- 两边都改了同一道菜 → 更新时间新的赢；在 GitHub 网页上直接改 `.md`、删文件，本地会跟着合并/删除
- 改菜名 = 推新文件 + 删旧文件；每道菜在 git 历史里有独立的修改记录
- 没配 Token 也能连公开仓库，但只能拉取不能推送
- Token 只存本机浏览器 localStorage，不写进菜谱数据、不进仓库

选型说明：没有用 README 当数据库（单文件会无限膨胀、没法按菜编辑），也没有用 Issues（正文格式不可控、导出迁移麻烦）——应用里每道菜本来就是一段带 frontmatter 的完整 Markdown，**一道菜一个文件是零转换的自然映射**，GitHub 网页端还能直接编辑。

> 注意：localStorage 按"打开方式"隔离，固定用同一种方式打开（如一直用 `127.0.0.1:8412`）。清浏览器数据前先确认已同步过，或用「备份 → 导出 JSON」。

## 在线访问：GitHub Pages

仓库带了一个 Pages 部署工作流（`.github/workflows/pages.yml`）：push 到 `main` 自动把整站发布到 **https://vhxubo.github.io/recipe-book/**，`workflow_dispatch` 可手动触发。

首次使用需在仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**（若首次运行报 Pages 未启用，检查这里）。之后每次推送——包括菜谱同步产生的提交——都会自动重新发布，线上永远是最新的菜谱。

推荐把 Pages 地址当作日常入口：页面是相对路径引用，部署在子路径 `/recipe-book/` 下无需任何配置；换设备直接开网页，配好同步后大家看到同一份数据。

> 注意：Pages 域名（vhxubo.github.io）和本地 127.0.0.1 是不同的 localStorage 空间，两边各自配置一次同步即可指向同一份仓库数据。

## 文件结构

```
recipe-book/
├── index.html          # 页面结构
├── style.css           # 灶台瓷砖 × 青花蓝 × 朱砂印章
├── app.js              # 存储 / 模板解析 / 渲染 / 导入导出 / 烹饪模式
├── gh.js               # GitHub Contents API 同步（拉取/推送/删除/冲突合并）
├── recipes/            # 菜谱存档目录：内置示例是静态 .md（清单 index.json），同步后一道菜一个 .md
├── .github/workflows/pages.yml  # Pages 自动部署
└── vendor/marked.min.js  # 本地化的 Markdown 渲染库（离线可用）
```

内置的 4 道示例菜谱（番茄炒蛋、可乐鸡翅、蒜蓉西兰花、紫菜蛋花汤）就是 `recipes/` 目录下的静态 `.md` 文件，清单在 `recipes/index.json`，首次通过 http(s) 打开时自动加载。想修改默认菜谱直接编辑这些文件；在页面上删掉后不会再出现（有一次性标记）。
