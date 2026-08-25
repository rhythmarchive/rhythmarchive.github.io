# 已有游戏版本更新

## 触发条件

已有游戏提供新 APK、新安装目录、新资源包或新版本 Manifest。

## 执行规则

- 读取既有 Game Profile 和上一正式统一 Manifest；默认增量解析，不从头重新逆向。
- 只有 marker 大量消失、adapter 解析失败、关键身份映射失效等明确异常才重新 reconnaissance，并把 blocker 写入 state。
- 候选必须通过 `NEW/CHANGED/REMOVED/UNCHANGED` diff；`REMOVED` 只生成审核项，不删除 Catalog 或远端对象。
- 复用稳定 source identity、Object hash 和 remote key，避免无意义全量上传。

## 执行入口

`rhythmctl extract`（对已有 adapter）、`normalize`、`diff --previous`、`review`、`check-approval`、`release prepare`。工作状态位于 `temp/rhythmctl/<game>/<version>/state.json`，重新打开任务时先读取它。
