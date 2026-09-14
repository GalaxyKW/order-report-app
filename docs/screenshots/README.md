# 界面截图

这些图片展示 0.1.4 的真实界面，由 Chrome 加载仓库中的 `public/` 页面后直接截图，不是设计稿、合成页面或 Android 真机截图。

| 图片 | 内容 | 原始尺寸 |
| --- | --- | --- |
| `dashboard-desktop.png` | 桌面经营总览 | 1440 × 1100 |
| `dashboard-mobile.png` | 手机总览与底部导航 | 390 × 900 |
| `reports-mobile.png` | 手机报单与返利对照 | 390 × 900 |
| `rebate-mobile.png` | 实际返利编辑与退款份额预览 | 390 × 900 |

## 隐私与来源

- 所有商品、数量、金额、日期和 `DEMO-001/002` 单号均来自手写的 [`readme-demo-data.js`](../../scripts/readme-demo-data.js)，没有读取或改写真实数据库、导出数据或用户设置。
- 每次运行创建全新的临时浏览器配置，只加载固定白名单中的应用静态资源；不启动业务后台，不读取 `.env`、令牌文件或日常浏览器配置。
- 浏览器请求拦截与静态服务白名单共同限制访问；业务接口和外部请求不可达，另禁用截图页的 Service Worker、iframe 等派生网络上下文。
- 连接地址与令牌在演示数据中为空；不截图设置或备份页。顶部「离线」是隔离环境无法同步的真实状态，没有伪造「已同步」标记。
- 图片直接保存浏览器返回的 PNG，不对界面进行拼接或修改；没有真实姓名、联系方式、地址或账户信息。

## 重新生成

安装项目依赖和 Chrome 后，在项目根目录运行：

```bash
ORDER_REPORT_CSS_BROWSER=/usr/bin/google-chrome npm run screenshots:readme
```

该命令先构建最新前端，再使用 [`capture-readme.js`](../../scripts/capture-readme.js) 生成四张固定路径的 PNG。会检查界面横向溢出、脚本异常、资源和图片尺寸；运行结束后清理自己的临时浏览器配置。它只覆盖本目录的四张演示图片，不接触业务数据。

生成后请逐张检查可读性与隐私，再提交图片及 README。可运行 `node test/readme-demo-data.test.js` 验证虚构数据、图片尺寸和 PNG 隐私元数据约束。
