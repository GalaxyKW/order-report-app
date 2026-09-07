# Android 网页组件恢复验收

此清单验证 `MainActivity` 的原生恢复页面和 WebView 生命周期。Java 编译、Android Lint、`npm test` 均不能替代这些设备测试。测试应使用仅含虚构记录的专用设备或模拟器，不对存有真实记录的手机执行停用组件、进程终止或清数据操作。

## 0.1.2 启动修复和诊断入口

原生框架生命周期回归在未修复版本的 API 35 冷启动中复现了 `PhoneWindow.getInsetsController()` 空指针：`onCreate()` 在 `setContentView()` 之前配置系统栏，框架尚未创建 `DecorView`。修复将系统栏配置移到内容视图安装之后，而不是只检查 API 版本或返回的控制器是否为空。

另在 API 26 中复现了导出偏好 `jobId` 类型异常导致的启动 `ClassCastException`。遇到无法读取的导出恢复状态，现在保留原偏好和缓存、暂停新的文件导出并显示提示；不清业务数据，不阻止其他离线操作。

Debug APK 额外包含“报单管家诊断”桌面入口，Release 不包含该 Activity。若主入口仍闪退：

1. 确认安装版本为 0.1.2，同签名覆盖安装，不卸载或清除数据。
2. 打开“报单管家诊断”，点击“尝试打开主界面”。
3. 若退出，再次打开“报单管家诊断”，点击“复制诊断信息”反馈。

该入口不创建或查询 WebView，不依赖 MainActivity 类加载。Application 在 Activity 之前安装未捕获异常记录器；仅在应用私有目录保存限长的异常类型/栈位置、固定启动阶段和版本信息，随后继续交由 Android 默认崩溃处理器终止进程。Android 11+另读取本应用最近的系统退出原因；不读取退出描述/trace、不记录异常消息、订单、URL或令牌，不自动上传。原生信号崩溃不一定有 Java 栈，需结合系统退出原因或 Logcat。

原生回归运行命令（需要开发依赖网络下载，以及运行 API 36 测试的 JDK/JRE 21）：

```bash
cd android
./gradlew testDebugUnitTest -PtestJavaExecutable=/path/to/java-21/bin/java
```

`MainActivityStartupTest` 使用 API 26/28/30/33/35/36 的 Android 框架实现，检查正常启动、重建、损坏导出状态保护和独立诊断入口。Robolectric 的 WebView 使用测试替身，不运行真实 Chromium，因此这些结果仍不能替代厂商设备测试。

## 版本与显示条件

至少覆盖 API 26、30、33、35、36；每个版本记录手机/模拟器型号、Android 版本、实际 WebView 包名及版本。API 26 仍是 APK 安装下限。API 35/36 分别覆盖手势/三键导航、软键盘、横屏和大字体；原生恢复页应可滚动，按钮不被系统栏遮住。

## 正常启动与保存

1. 安装 Debug APK，使用虚构记录完成录入、修改、保存和查询。
2. 断网，退出后重新打开；已保存记录仍可读取。
3. 保存 JSON 导出，分别测试取消文件选择、成功保存和从后台返回。重复测试旋转或系统重建 Activity，导出结果只能提示一次。
4. 验证返回键能关闭网页弹窗，并在页面不处理返回时退出/返回桌面；API 33 及以上同时验证手势返回。

## 启动组件不可用

在可还原的测试模拟器上，通过系统提供的管理方式暂时停用可选 WebView 提供程序；有备用组件的系统可能自动切换，此时不算触发了该场景。也可在调试器中临时替换 `startWebView` 内创建组件的操作，使其抛出 `IllegalStateException` 或 `UnsatisfiedLinkError`，仅用于本机测试，不提交或分发故障注入代码。

预期：

- 显示原生“暂时无法显示页面”，不会仅白屏或回桌面。
- 页面包含重试、系统网页组件设置、应用设置、Android/设备/WebView 版本信息。
- 未检测到提供程序时，仍能打开系统网页组件选择页；设备没有对应设置 Activity 时回退到系统设置。
- “复制诊断信息”仅包含错误类型、系统/设备/WebView 信息，不含订单、令牌、服务器地址或导出内容。
- 连续点击重试，仍然停留在可操作的恢复页，不启动后台自动重载。
- 恢复组件后手动重试可以打开业务页；已保存的虚构记录保留。
- 恢复页期间重建 Activity，仍显示恢复页，不绕过手动重试直接加载失败页面。

## 渲染进程退出

使用专用 Debug 设备，在调试器的主线程上下文对当前 `webView` 调用 `loadUrl("chrome://crash")`。这是 Android 官方提供的渲染器故障测试方法，应用本身没有开放此 URL 的入口。见 [WebViewClient.onRenderProcessGone](https://developer.android.com/reference/android/webkit/WebViewClient#onRenderProcessGone(android.webkit.WebView,%20android.webkit.RenderProcessGoneDetail))。

预期：

- `onRenderProcessGone` 返回 `true`，宿主 Activity 保持运行并显示原生恢复页。
- 旧 WebView 从视图树移除、引用清空并销毁，不再向旧实例执行脚本。
- 等待一段时间不会自动创建新 WebView；点击“重新打开页面”才创建新实例。
- 已保存记录恢复，未保存表单可以丢失，但恢复页明确告知。
- 在准备导出、文件选择器打开、文件复制及结果回调等待期间分别触发；后台导出不会被误取消，成功/失败结果在页面恢复后投递，不重复保存文件。
- 快速重试后到达的旧页面回调不能覆盖新页面的就绪状态或取消新导出结果的投递。

若测试环境能够独立终止 WebView 渲染器而不终止宿主，也验证 `didCrash() == false` 的内存回收提示。不要把直接杀掉整个应用进程当作此回调测试。

## 打印和诊断限制

- 无打印服务的测试设备应显示“手机未提供打印服务”；服务异常时提示重试，不能导致进程退出。
- 日志标签 `OrderReportWebView` 仅记录阶段/异常类名或渲染器退出类型。应用无法接管系统杀死整个宿主进程、VM 内存耗尽或操作系统本身的故障；不能据本清单声称所有厂商和所有系统版本均已验证。
