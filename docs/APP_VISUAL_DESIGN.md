# 应用图标与界面设计（0.1.3）

## 视觉方向

延续森林绿、暖白和琥珀色，使用「报单 + 包裹」作为应用标志；图标由内置 imagegen 生成并定向编辑背景，界面小图标使用内联 SVG，不依赖外部字体或 CDN。

- 原图：`assets/branding/app-icon-source.png`。
- 网页/PWA：`public/icons/app-icon.png`（512）、`app-icon-192.png`、`app-icon-64.png`。
- Android：彩色自适应图标使用同一图像，API 33+ 的单色图标使用独立矢量资源。
- 页面背景保留 `#F5F3EE`，与 Android 启动窗口一致；重点卡片使用 `#205B46` 森林绿。
- 导航保留六个分类与文字标签，当前页同步 `aria-current`；SVG 不重复朗读。
- 短标签和金额不强制断行；窄屏统计卡重排，极长金额可在卡片内横向查看而不截断数值。
- 本次只调整展示、资源和版本，不改变业务公式、本机存储键、同步行为或 WebView 数据来源。

## 图标导出

在项目根目录用 JDK 17 执行 `npm run build:icons`，只进行机械缩放，保留原图构图及 alpha，并将同一 512px 图像复制到 Android 彩色图标资源。生成的图片随源代码提交，无需使用者调用图像模型。更换原图后运行该命令，再执行 `npm run android:assets`。

## 最终提示词记录

使用模式：内置 imagegen（非 CLI/API fallback）。

### 初次生成

```text
Use case: logo-brand
Asset type: production Android launcher icon for the Chinese offline order and inventory app 报单管家. One finished square icon image, not a mockup or icon sheet.
Primary request: Design an original, elegant and immediately legible app symbol combining a warm ivory order receipt with a small amber parcel in one compact cohesive mark. The receipt has two short dark-green horizontal entries; the parcel has a simple folded lid/check-shaped highlight suggesting completed orders. The mark should feel friendly, organized and trustworthy, with subtly tactile rounded paper edges and a very restrained soft shadow, almost flat rather than glossy 3D.
Scene/backdrop: full-bleed solid forest green #205B46 filling every pixel to all four edges; no rounded outer tile, no outside border, no white margin.
Color palette: match the existing app's forest green, warm ivory #FFFDF7 and muted amber #DCA85D.
Composition/framing: exactly square, preferably 1024x1024; optically centered bold simple silhouette; ALL of the receipt and parcel, including its shadow, must fit inside the central 56 percent of the canvas width and height to survive Android adaptive circular icon cropping. Generous uninterrupted forest-green space around the mark. Crisp edges readable at 32 pixels.
Text: none. No letters or numerals.
Constraints: one original symbol; no phone frame, grid, captions, watermark, branding from other apps, tiny details, photographic scene or decorative sparkles.
```

### 定向背景编辑

```text
Use case: precise-object-edit
Input image: the existing receipt-and-parcel icon is the edit target.
Change ONLY the background: replace ALL transparent/black outer background, green halo and stray green speck below with ONE perfectly solid opaque forest green #205B46 covering the ENTIRE square canvas from edge to edge. This is a finished app icon tile, not a transparent cutout. Every corner must be opaque forest green; alpha must be fully opaque throughout the image. Keep the receipt and parcel unchanged in appearance, position, size, colors, highlights and proportions. Preserve the generous green margins and the centered symbol occupying roughly the middle 56 percent. No rounded tile corners, no frame, no white margin. No text or other elements. Output a single complete square image.
```
