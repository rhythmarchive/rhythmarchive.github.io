# Phase 2B contract override

The Phase 2A conversion notes below are historical context. The implemented Phase 2B workflow keeps `_optimization.png`, treats `downloadFilename` as a Rendition-level field independent of Object identity, and records `renditionRole = upscaled` explicitly in local processing state. See `docs/design/phase2b/04-upscale-reconciliation.md`.

# `_optimization.png` → JPEG Conversion Contract

## 1. 发现规则

新工作流的外部工具输出约定是 `<basename>_optimization.png`。扫描只把 suffix 当作发现线索：

- 主规则：`_optimization.png`；
- 兼容历史资产：`_opt.jpg`、`.jpg_opt.jpg` 及同类扩展名；
- 归一化：去最后扩展名、去 optimization/opt suffix、NFC、小写。

文件名不是永久身份。扫描先在 `metadata/batch.json` 的可选 sidecar mapping 和 Candidate 的 `source/suggested/reviewed/final` aliases 中查找，再用 normalized stem 做兼容匹配；不带 optimization/opt suffix 的文件只记录为 unmatched，不会被当作超分输出。

## 2. 如何匹配 original

系统为每个 Candidate 保存 `upscale-input` 的 CandidateFile、已知 filename aliases 和可选 manifest mapping。对每一个 `upscale-output`：

1. 计算 normalized stem；
2. 与同一 Batch 的 source/suggested/reviewed/final stem 比较；
3. 唯一命中时写 `state=matched`、`matchedBy=filename-alias`；
4. 多个 Candidate 命中时写 `ambiguous` 并阻塞；
5. 没有命中时写 `unmatched` 并进入人工处理；
6. 通过 manifest sidecar 明确绑定时，记录 `matchedBy=manifest`，优先于文件名。

因此原图从 `Testify.jpg` 改名为 `Testify Reviewed.jpg` 后生成 `Testify Reviewed_optimization.png`，仍匹配原 Candidate；Candidate ID 不变。若用户在 output 生成后才改名，旧 basename 仍保存在 aliases 中，也不会丢失关系。

## 3. 一个 original 对多个 optimization

允许一个 original 对多个 optimization attempts，但只允许一个被选为当前 upscaled Rendition。所有 attempts 都保留在 Candidate processing 中，直到人工选择/拒绝；不能按文件更新时间、文件大小或第一个扫描结果自动选择。多个 output 的状态必须显示为“需要人工选择”，未选择前不得 `UPSCALE_CONVERTED`、`FINAL_REVIEW` 或 `READY`。

## 4. 推荐转换参数

旧项目真实实现的 baseline 是 Sharp、`toColorspace("srgb")`、JPEG quality 95、`mozjpeg=false`、`chromaSubsampling="4:4:4"`、白底 flatten，并默认删除 optimization 输入。Phase 2A 保留有证据的编码基线，但修改安全合同：

```text
quality           = 95
chromaSubsampling = 4:4:4
progressive       = true
mozjpeg           = false
colorspace        = sRGB
alphaPolicy       = block (default)
source PNG        = always retained
```

Progressive JPEG 只改变扫描顺序，通常不改变解码像素；`4:4:4` 保留彩色边缘，适合曲绘中高对比文字/线稿。暂不切换 mozjpeg，避免在没有基准和运行环境确认时改变编码器。quality 95 是历史工作流已有且本轮测量验证的主要 baseline，不把 92 当作默认节省空间。

Sharp pipeline 只转为 sRGB 并默认丢弃不必要的 EXIF/GPS 等来源 metadata；Object provenance 保存审计信息，JPG 不依赖原始本机 metadata。最终 output 的 `displayFilename` 可以是 `Testify Reviewed.jpg`，内部记录固定为 `renditionType="upscaled"`、`origin="derived"`、`generatedBy="converter"` 和 `sourceRenditionId=original`，绝不依赖 `_opt.jpg` 命名。

## 5. 本轮实验结果

实验输入是从历史 AI JPG 复制到 V2 fixture 后派生出的 3072×3072 PNG；没有读取后写回或修改 `E:\曲绘`。输入 PNG：17,965,264 B。基础像素指标是输入 PNG 与输出 JPEG 的 RGB raw buffer 比较：

| quality | JPG bytes | 相对 PNG 节省 | mean absolute channel diff | max diff | pixels diff > 5 | 视觉检查 |
|---:|---:|---:|---:|---:|---:|---|
| 92 | 3,843,988 | 78.60% | 1.2216 | 41 | 5.4620% | 未见明显大范围 artifact，但数值误差明显更高 |
| 95 | 4,498,957 | 74.96% | 0.1380 | 8 | 0.0002% | 未见明显 artifact，细线和文字保持良好 |
| 97 | 5,268,025 | 70.68% | 0.4515 | 14 | 0.1230% | 未见明显 artifact，但体积增加且本 fixture 数值不优于 95 |

结果文件：`docs/design/upscale-experiment-2026-08-14.json`。这是一个代表性历史图像派生 fixture，不是所有 AI 输出的质量保证；真实批次仍要做人工预览。基于旧参数、节省空间目标和该实验，Phase 2A 推荐 quality 95，不承诺“肉眼完全无损”，而是把人工 final review 作为发布门槛。

## 6. Alpha 安全

转换前用 Sharp metadata 检测 alpha channel，再用 image stats 判断是否存在实际透明像素：

- 无 alpha 或 alpha channel 全部 opaque：可以直接输出 JPEG；
- 存在实际透明：默认 `block`，不静默套白底；
- 用户明确选择 `flatten-white` 或 `flatten-explicit` 并确认背景策略后，才允许 flatten；
- flatten 策略、背景颜色和人工决定应进入 conversion record。

本轮透明 64×64 PNG fixture 被默认安全拦截；同一输入在明确 `flatten-white` 后转换成功，源 PNG 仍保留。普通曲绘理论上通常不需要透明，但系统不凭类别猜测并覆盖实际 alpha。

## 7. 失败恢复和非破坏性

转换要求输出是 `processed/` 下的 `.jpg/.jpeg`，拒绝 input/output 同路径；写入同目录临时 `.partial-*` 文件，先验证 JPEG format、尺寸、size/hash，再以可恢复的备份交换方式替换 output。失败时清理 partial output、尝试恢复旧 output，但保留 input PNG、work original、raw original 和 Candidate 状态；可修复参数后重试。已有 output 默认不覆盖，只有明确 staging overwrite 才替换。

转换成功绝不删除 `_optimization.png`。PNG 只有在未来同时满足以下条件后才可清理：

1. PublishRun 成功；
2. ROS Object 创建完成且 HEAD/范围/hash 验证通过；
3. Catalog commit 成功并指向已验证 JPG；
4. ReleaseManifest 已保存；
5. 没有未完成 review、rollback 或 retention 约束；
6. 人工批准本次 staging cleanup。

Phase 2A 不执行 ROS 或 cleanup，因此不会清理任何源 PNG。
