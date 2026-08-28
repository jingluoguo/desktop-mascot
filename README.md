# Desktop Mascot

一个运行在桌面角落的轻量互动宠物。它基于 Tauri 2 + React + TypeScript 构建，使用 `lively-mascot` 渲染角色，支持透明置顶窗口、鼠标跟随和实时设置同步。

## 功能

- 5 种角色：幽灵、豆芽、猫咪、机器人和果冻
- 2D / 3D 显示模式，以及可调节的角色大小
- 鼠标跟随、角色描边开关和主体 / 轮廓 / 强调色自定义
- 多组表情状态，可在仪表盘预览后应用
- 点击角色触发开心表情；右键打开设置仪表盘
- 系统托盘菜单：打开仪表盘、隐藏 / 显示宠物、退出应用
- 仪表盘支持中文 / English 和浅色 / 深色主题
- 设置保存在本地，并在宠物窗口与仪表盘之间即时同步

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

## Logo

应用 logo 源文件位于 [`src-tauri/icons/desktop-mascot-logo.svg`](src-tauri/icons/desktop-mascot-logo.svg)，网页 favicon 位于 [`public/favicon.svg`](public/favicon.svg)。Tauri 的 PNG、ICO 和 ICNS 图标会由该 SVG 生成并放在 `src-tauri/icons/` 中。

## 项目结构

```text
src/                 React 界面与宠物 / 仪表盘逻辑
src-tauri/src/       Tauri 原生窗口、托盘和命令
src-tauri/icons/     应用图标资源
public/              Vite 静态资源
```

## 许可

项目代码遵循仓库中的 [LICENSE](LICENSE) 文件。角色渲染由 [`lively-mascot`](https://github.com/jingluoguo/lively-mascot) 提供。
