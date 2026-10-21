# Xboard面板桌面仪表盘

Windows Electron 小组件，读取 Xboard 管理后台的今日收入、待处理工单和待处理佣金订单数。

## 开发运行

安装 Node.js 20 或更高版本后，在本目录执行：

```powershell
npm install
npm start
```

## 生成安装包

```powershell
npm run dist
```

安装程序位于 `release/`。小组件启动时会先显示，再后台连接面板。桌面层优先使用 Windows Explorer 的 WorkerW 桌面宿主，并兼容直接由 Progman 承载桌面图标的配置；如果 Explorer 暂未就绪，小组件会保持为普通非置顶窗口并在后台自动重试，不会覆盖其它应用，也不需要手动切换显示模式。需要始终显示在应用上方时，可在设置中明确选择“透明浮窗”。管理员授权值由 Electron `safeStorage` 加密保存；显示设置保存与连接信息更新相互独立，保存显示设置不会触发网络请求或读取授权值。

## 首次设置

- 面板地址填写 HTTPS 根地址，例如 `https://panel.example.com`。
- 后台安全路径取自后台 URL 的域名后路径，不含首尾斜杠和 `#`。
- 授权值是后台浏览器开发者工具「应用程序 → 本地存储 → 当前域名」中 `XBOARD_ACCESS_TOKEN` JSON 的 `value`，包括 `Bearer ` 前缀。不要分享该值；如果它已泄露，退出后台并重新登录以更换令牌。
- 今日收入按 Xboard 的“分”换算成人民币；待处理佣金显示符合面板统计条件的待结算订单笔数，不代表佣金金额。

统计每 1 分钟在后台静默刷新，也可通过系统托盘菜单手动刷新。数据仅经 HTTPS 直接请求你填写的面板，不会发往第三方服务。

## 贡献者

- @chaoa23 — 项目维护者
- OpenAI Codex — 协助项目开发与发布
