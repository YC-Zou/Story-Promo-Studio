# 刘看山设计预览素材

设计规范与正式页面共用的刘看山呈现资源。角色方向由项目方确认；对外发布前仍需由项目方确认角色素材的使用授权。

- `greeting.gif`：原始打招呼动画，未编辑。
- `idle.gif`：原始待机动画，未编辑。
- `working.gif`：原始电脑动画，未编辑。
- `*-still.png`：相应 GIF 的静态抽帧，分别取 1 秒、1 秒、2 秒，用于暂停及减少动态模式。
- `creative-poses.png`：内置 imagegen 生成的一张三联姿态图，阅读、分镜整理、绘图。网页以 CSS 分区展示，未进行栅格裁剪或重新绘制。

## 生成提示词

Use case: stylized-concept. Create one horizontal 3:1 production character pose sheet for a Zhihu story creator workbench. Input image is the strict character identity reference of Liu Kanshan: preserve EXACT distinctive tall seamless white body/head, two pointed ears, very large spherical black nose, tiny black oval eyes, skinny black arms and black legs, tiny white tail, smooth matte soft 3D material. No redesign into another animal, no scarf, no clothing. THREE equally sized square cells arranged horizontally, no cell borders, pure WHITE background. Each cell contains one full-body version of the SAME character with ample margins, same scale and camera, feet baseline consistent. Left cell: looking down attentively while holding an open cobalt-blue book with white pages, arms holding book, nose and eyes unobstructed. Center cell: standing beside a small waist-height minimal white work table, carefully arranging three storyboard paper panels, one hand holding a panel, quiet focused pose. Right cell: standing at a small drawing easel, hand holding blue pencil touching a clean storyboard sketch, calm focused drawing pose. Props only blue #1772F6, white and pale cool gray. Premium soft studio lighting and gentle ground contact shadows, refined clean 3D rendering, tactile but not fuzzy, faithful to reference. All ears, feet and props fully inside own cell, no overlaps between cells. No text, letters, UI, labels, logos, extra characters, decorative floating dots, watermarks. This is one cohesive pose-sheet illustration to display/crop by CSS, with centers exactly at 1/6, 1/2 and 5/6 of width.

参考：用户目录 `看山三视图/33f11967cc145627560c3db70c7d3ab8.jpg`。生成方式：内置工具，不调用项目的比赛 API。

## 第二版已知限制（历史记录，不用于正式页面）

原 GIF 仅 320px，边缘与色阶保留源素材特征，因此没有纳入本次 GitHub 交付。正式页面使用下述程序化动作和高清静态回退图。


## 第三版实时动作

页面已不再播放原 GIF。新增 ../kanshan-motion.js 以用户三视图为参考重建 3D 网格与动作，并使用固定版本 Three.js 0.180.0（许可见 ../vendor/THREE-LICENSE.txt）。这不是官方模型，不是对 GIF 的高清修复。

新增 empty-hd.png、success-hd.png、failure-hd.png、export-hd.png、reading-hd.png、storyboard-hd.png、drawing-hd.png、music-hd.png 均为预览中程序化模型的浏览器原生渲染截图，实际 562×562（元素截图边界取整），用于 WebGL 不可用时回退；不由 imagegen 生成。第二版 creative-poses.png 保持不变。

实时动作与静态图共享同一套造型。新增模型以代码形式保存在相邻 kanshan-motion.js 中，不需要外部模型文件或 API Key。

## 第四版持竿品牌

新增 brand-hd.png（持竿静态标识）、fishing-hd.png（文案等待）、hook-done-hd.png（提卡结束姿态）；empty-hd.png 更新为持竿招呼。均为同一程序化模型的原生浏览器截图，未使用图像生成 API。

提卡使用带蓝色夹扣的小纸卡，只有文案完成示例才出现。静态 Logo 与等待不带成果卡，不含鱼或读者隐喻。渲染模块中的完成动作单次播放；本轮品牌、角色与动作方向已经用户确认。
