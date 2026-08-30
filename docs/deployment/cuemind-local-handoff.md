# CueMind 本地交接

## 部署

```bash
./scripts/verify-offline.sh
docker compose build
./scripts/cuemind-service.sh start
curl -f http://127.0.0.1:3000/
```

模型通过 `CUEMIND_MODEL_DIR` 只读挂载，数据和本地 Trace 使用 Docker volume 保存。运行时不上传遥测或知识内容。

## 生命周期

使用 `./scripts/cuemind-service.sh stop|restart|upgrade|rollback` 管理服务。升级前保存当前镜像标签和报告目录；回滚由人工指定 `CUEMIND_IMAGE_TAG`，禁止自动换模。

## 断网与故障演练

断网后运行 `scripts/run-offline-eval.sh`，确认治理、重放和报告流程可执行。演练模型超时、容器重启、磁盘不可写和显存不足，并记录降级终态、恢复时间和报告路径。

## 发布责任

候选模型、配置快照、冻结集报告和回滚点必须由人工审核人确认后发布。`.cuemind-release.json`、评测报告和治理审计记录随发布产物归档。
