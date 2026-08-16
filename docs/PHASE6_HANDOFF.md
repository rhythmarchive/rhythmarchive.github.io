# Phase 6 handoff

## 1. 日常创建 Update

在 Admin 的 `创建更新` 中选择游戏、旧版本 APK、新版本 APK 和版本号；版本号可从文件名读取。工作目录使用 `.runtime/updates/<update-id>/`。如果手边只有同一份 APK，可勾选同源比较来验证 no-op 流程；正常更新仍需要旧 APK 和新 APK。

## 2. Arcaea / Phigros diff

提取结果先保存在 Update workspace，再按稳定 source identity 比较。优先使用 extractor 提供的 songId、asset key、bundle/path identity 或其他 external identity，不以文件名猜测正式 Resource。结果分为新增、内容变化、metadata 变化、未变化、待确认和当前源中消失；未变化默认不在 Review 主列表展开。

## 3. Phigros 同名 bundle 变化

`tools/phase6-phigros-diff.py` 将新版本 source inventory 与候选文件分开保存。bundle hash 只用于快速筛选；同一 bundle/path 仍按 Unity object path id（或 object name）解码实际图片内容并比较 image content hash，因此同名 bundle 内图片变化会进入 `content-changed`。

## 4. ArSrNaUIESRGAN 实际发现

安装包是 Electron 应用，UI 通过 `child_process.spawn` 顺序调用本地 `realesrgan-ncnn-vulkan.exe`，没有发现需要 UI automation 的隐藏步骤。默认模型是 `realesrgan-x4plus-anime`。

## 5. 实际 executable

`D:\Users\30578\AppData\Local\Programs\ArSrNaUIESRGAN\resources\assets\realsgan\realesrgan-ncnn-vulkan.exe`

## 6. 实际 model

模型目录：`D:\Users\30578\AppData\Local\Programs\ArSrNaUIESRGAN\resources\assets\realsgan\models`

模型名：`realesrgan-x4plus-anime`，对应 `.bin` 和 `.param` 文件。

## 7. UI 默认参数

UI 实际传入 `-i`、`-o`、`-n` 三个参数；没有额外传入 scale、tile、GPU 或线程参数。CLI 默认因此为 x4、tile 0、自动 GPU、jobs `1:2:2`，输出 PNG。配置允许迁移 executable、model 目录和模型名；默认值保持当前安装位置。

## 8. Phase 6 CLI command

```text
realesrgan-ncnn-vulkan.exe -i <input> -o <output> -n realesrgan-x4plus-anime
```

当 model 目录不是 executable 同级的 `models` 时，adapter 额外加入 `-m <model-dir>`。

## 9. 单张真实验证

使用一张非正式 Arcaea jacket 脱离 GUI 运行一次：输入 768x768 JPEG，输出为 3072x3072 PNG，exit code 0，图片可读取且无异常 alpha。输出大小为 10,530,921 bytes；本机找到的历史 UI JPEG 结果同为 3072x3072，adapter 不要求压缩后 bit-identical。CLI stderr 包含 GPU 探测及一条 decode warning，但输出验证成功。

## 10. Arcaea 曲绘超分入口

只有 domain 层判定为 `game=arcaea` 且 jacket（或现有正式等价曲绘类型）的候选会进入超分。Review 确认后在 Admin 选择 `开始超分`，批量默认顺序执行；无真实 alpha 时转为 q95 JPEG，有真实 alpha 时保留为 processed PNG；preview source 优先使用已采用的 upscaled rendition。

## 11. 超分失败

单张失败会记录简短错误并继续其他候选；Admin 支持重试，也支持跳过超分、仅发布原图。替换 original binary 会使旧超分失效并回到待超分；只改标题、artist 或文件名不会触发重跑。

## 12. 增量 ROS publish 与幂等

Publish plan 只针对本次 active candidate 的 original、upscaled 和变化后的 320/640/1280 preview binary 编码，计算 SHA-256 并派生 Object key。Catalog 已知 Object 直接跳过；新 SHA 只 HEAD 对应 key，缺失时上传并验证。workspace 保存 publish result，同一 Update 重开或重跑不会重复创建候选、重复上传已存在 Object 或重复执行已完成超分。

## 13. Catalog 安全

上传和本次 Object 验证全部成功后，才生成并 validate 新 Catalog 与 Release/Update Manifest，再通过临时文件 atomic replace。上传中途失败时正式 Catalog 不变，workspace 保留以便修复继续。新版本缺失的历史 Resource/Object 只写入本次 manifest 的 `removedFromCurrentSource`，不会删除、隐藏或 GC。

## 14. Targeted validation

- `npm run typecheck`：通过
- `npm test`：73 passed
- `node --check packages/admin/public/admin.js`：通过
- `python -m py_compile tools/phase6-phigros-diff.py`：通过
- Admin no-op：0 binary changes、0 candidates、0 upload objects、0 bytes
- 真实 Real-ESRGAN：单图 x4 输出验证通过

## 15. 当前 blocker

当前工作区没有可用于真实增量发布的旧/新 APK pair，因此尚未执行真实新版本 extraction 和正式 ROS/Catalog publish；也没有执行真实 ROS 写入。现有历史 Catalog 资源多数没有稳定 external identity，系统不会用文件名猜测绑定，涉及这些旧资源的候选需要在 Review 中人工确认或补充映射。完成一次真实 APK pair 的受控 Review 和用户明确批准的 publish 后，才可把整条链标记为真实日常更新已验收。
