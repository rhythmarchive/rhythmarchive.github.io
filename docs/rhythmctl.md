# rhythmctl

统一本地入口：

```text
npm run rhythmctl -- games
npm run rhythmctl -- probe --game arcaea --source <path>
npm run rhythmctl -- ingest --game arcaea --source <path> --version <version>
npm run rhythmctl -- extract --game arcaea --report <report.json> --base-version <old> --target-version <new> --base-apk <old.apk> --target-apk <new.apk>
npm run rhythmctl -- normalize --input <catalog-or-extractor-result> --game <id> --version <version>
npm run rhythmctl -- diff --current <manifest.json> --previous <manifest.json>
npm run rhythmctl -- review --delta <delta.json>
npm run rhythmctl -- approve --review <review.json> --reviewer <name>
npm run rhythmctl -- check-approval --review <review.json>
npm run rhythmctl -- storage diff --local <manifest.json> --published <manifest.json>
npm run rhythmctl -- release prepare --current <manifest.json> --previous <manifest.json> --review <review.json>
npm run rhythmctl -- verify [--catalog <catalog.json>]
npm run rhythmctl -- build
```

`probe`、`ingest` 和所有报告生成命令只在仓库 `temp/` 写入。`build` 默认运行本地 `site:build`；`--catalog-only` 只验证 Catalog。`release prepare` 的输出是 `READY_LOCAL_ONLY`，不会上传 ROS、删除远端对象或发布生产站点。

## 产物

默认 workflow root 是 `temp/rhythmctl/<game>/<version>/`，其中可包含 `state.json`、`probe.json`、`extraction-plan.json`、`extractor-result.json`、统一 Manifest、Delta 和审核包。CLI 可重复调用；稳定 snapshot 和 state 防止重复提取。
