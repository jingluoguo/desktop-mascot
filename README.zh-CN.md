[English](./README.md) | **简体中文**

# Desktop Mascot

一个运行在桌面角落的轻量互动宠物。它基于 Tauri 2 + React + TypeScript 构建，使用 `lively-mascot` 渲染角色，支持透明置顶窗口、鼠标跟随和实时设置同步。

![五个内置角色：幽灵、豆芽、猫咪、机器人、果冻](landing/media/characters.png)

内置角色，由 `lively-mascot` 实时渲染。

![幽灵角色依次展示睡眠、待机、开心、心动、灵光一现等表情](landing/media/demo.gif)

## 相关文档

- [路线图](./ROADMAP.zh-CN.md) — 项目方向与后续计划
- [更新日志](./CHANGELOG.zh-CN.md) — 各版本的重要变更

## 功能

- 5 种角色：幽灵、豆芽、猫咪、机器人和果冻
- 2D / 3D 显示模式，以及可调节的角色大小
- 鼠标跟随、角色描边开关和主体 / 轮廓 / 强调色自定义
- 多组表情状态，可在仪表盘预览后应用
- 点击角色触发开心表情；右键打开设置仪表盘
- 系统托盘菜单：打开仪表盘、隐藏 / 显示宠物、退出应用
- 仪表盘支持中文 / English 和浅色 / 深色主题
- 设置保存在本地，并在宠物窗口与仪表盘之间即时同步
- 支持导入 `lively-mascot` 0.3.1 图片模型 Skill 生成的 `model.js`、`model.css` 和 `model.json`
- 用户模型保存在系统应用数据目录，不写入安装包或前端构建目录，升级应用后仍会保留

## 环境要求

- Node.js 18+
- Rust stable（Tauri 2）
- macOS、Windows 或 Linux 桌面环境

首次使用请确保已安装 Tauri 的系统依赖，详见 [Tauri prerequisites](https://tauri.app/start/prerequisites/)。

## 开发

```bash
# 安装前端依赖
yarn install

# 启动 Vite 开发服务器
yarn dev

# 启动 Tauri 桌面开发模式
yarn tauri dev
```

浏览器预览可以访问 Vite 地址，但窗口大小、系统鼠标坐标、托盘和窗口定位等原生能力只会在 `yarn tauri dev` 中完整生效。

## 构建

```bash
# 类型检查并构建前端
yarn build

# 构建可分发的桌面安装包
yarn tauri build
```

构建产物由 Tauri 输出到 `src-tauri/target/release/bundle/`。

正式发布的安装包目前只覆盖 macOS（Apple Silicon 与 Intel）和 Windows。Linux 在工具链层面是支持的，可以用 `yarn tauri build` 自行构建，但暂未发布 Linux 安装包。

## 项目落地页

落地页位于 [`landing/`](landing/)，是一个不依赖构建步骤的静态站点。提交到 `master` 后，GitHub Actions 会自动发布它。

首次发布时，请在仓库 **Settings → Pages → Build and deployment** 中将 Source 设为 **GitHub Actions**。随后可通过 `https://jingluoguo.github.io/desktop-mascot/` 访问。

## 应用内更新

应用发布版启动时会先读取 `AUTHOR_DATA_URL` 中 `desktop-mascot` 项的版本。只有远程版本高于当前版本时，才会继续检查 `jingluoguo/desktop-mascot` 的最新 GitHub Release；存在当前平台经过签名的更新包时，应用会自动下载，下载完成后由用户确认重启并安装。

首次发布前，需要将本机 `src-tauri/.tauri/updater.key` 的完整内容配置为仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`。该文件通常是一行 Base64 文本，不能只复制 Base64 解码后的内容、`updater.key.pub` 公钥或其中一行。如生成密钥时设置了密码，还需将同一个密码配置为 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。私钥已被 `.gitignore` 排除，不能提交到仓库。Workflow 会在构建前校验密钥格式。

## Logo

应用 logo 源文件位于 [`src-tauri/icons/desktop-mascot-logo.svg`](src-tauri/icons/desktop-mascot-logo.svg)，网页 favicon 位于 [`public/favicon.svg`](public/favicon.svg)。Tauri 的 PNG、ICO 和 ICNS 图标会由该 SVG 生成并放在 `src-tauri/icons/` 中。

## 项目结构

```text
src/                 React 界面与宠物 / 仪表盘逻辑
src-tauri/src/       Tauri 原生窗口、托盘和命令
src-tauri/icons/     应用图标资源
public/              Vite 静态资源
```

## 导入自定义模型

在仪表盘的“角色模型”区域，可以将 `.livelymodel` 文件拖入导入区域，也可以点击选择文件。`.livelymodel` 是 ZIP 格式的模型包，必须包含 `model.js`、`model.css` 和 `model.json`；也支持同时选择这三个文件。文件应由 `lively-mascot` 内的图片模型 Skill 生成，并且 `model.json` 中的 `id` 需要与模型定义一致。

用户模型可以导出为 `.livelymodel`、覆盖导入或删除。内置模型不能被删除或覆盖。应用会把用户模型复制到系统应用数据目录下的 `models/`，因此安装新版本时不会覆盖。

模型包还可以在 `model.json` 中声明可用互动反应。未声明该字段的模型会兼容所有内置表情；声明后，桌宠只会为对应触发方式执行列出的表情，其他配置会安全地保持当前状态。

```json
{
  "interactions": {
    "click": ["10", "16"],
    "doubleClick": ["16"],
    "hover": ["11"],
    "drag": ["38"]
  }
}
```

可用触发方式为 `click`、`doubleClick`、`hover` 和 `drag`。表情 ID 取自 `lively-mascot` 的 `emotions` 注册表，也可以是模型包定义的自定义表情。上面用到的四个 ID 分别是 `10`（开心）、`11`（好奇）、`16`（心动）、`38`（灵光一现）；内置注册表共 40 个表情，ID 为 `00`–`39` 的两位数字串。

## 许可

项目代码遵循仓库中的 [LICENSE](LICENSE) 文件。角色渲染由 [`lively-mascot`](https://github.com/jingluoguo/lively-mascot) 提供。
