# Windows 断线恢复与备份

## 先核对断在哪一层

在生产网页记录设备编号、最后心跳和待同步数量。用 Windows 管理器核对发送进程、企业微信登录以及同步状态。若从原机恢复，在已登录的交互桌面从管理器启动，观察该设备恢复心跳及积压下降。对照网页消息和本地账本抽查断线时段。发送结果不明的记录留给人工核对。

## 备份和隔离演练

Windows 备份包括 `reply_log.db`、`state/flow_state.db`、`.report_state.json`，以及存在时的 `.greeted.json` 和 `state/flow.remote.json`。网站数据库和 Windows 运行数据各留一份独立副本，将备份目录同步到受限存储。账号、令牌和机器专用配置按现有凭据流程另行保管。

日常备份可以在线执行，SQLite 会将每个数据库当时已提交的 WAL 数据一起复制。跨文件备份各自取样，如用于正式交接，应先停止原机发送和同步，再采集一份。记录 UTC 备份目录和相关客户端版本。

```powershell
python scripts/backup-client-recovery.py windows C:\agent D:\city-backups\windows
python scripts/backup-client-recovery.py verify D:\city-backups\windows\20261122T010000000000Z
python scripts/backup-client-recovery.py restore D:\city-backups\windows\20261122T010000000000Z D:\restore-drill\trial-01
```

```bash
python3 scripts/backup-client-recovery.py server /srv/apps/city-recruitment-mock-service/source/data/app.sqlite /srv/backups/city-recruitment
python3 scripts/backup-client-recovery.py restore /srv/backups/city-recruitment/20261122T010000000000Z /srv/restore-drill/trial-01
```

将示例时间戳替换成备份命令输出的目录名。演练目录需尚未存在。还原完成后可以用 `verify` 再核对演练目录的 SHA-256 和 SQLite 完整性，再抽查回复账本中的 `acked` 与 `pending` 回执、流程步骤，以及 `.report_state.json` 里的游标和待传事件。只有清单文件生成后才把镜像作为完整结果。

## 备用机人工接管

1. 在原机停止回复进程并禁用登录自启。若原机无法登录，先通过云控制台停止实例或隔离其网络。保留旧磁盘和日志，确认原机无法继续处理同一企微账号后再启用备用机。
2. 在网络隔离的备用机装好已验证的客户端版本。把最新的 Windows 备份还原到新目录，检查账本、流程、游标和未确认回执。客户端保持停止，由管理员将整份已核对的运行状态迁入备用目录，凭据和配置按现有登记流程处理。
3. 在网页核对设备和岗位绑定。由管理员解除备用机的网络隔离并完成企业微信登录。先抽对断线前后的账本，查明 `unknown` 或待确认记录。管理员确认后，从新版管理器启动，再观察心跳、积压下降和网页消息入库。
4. 回切时先停止、隔离备用机，重新备份其最新运行状态，再用同样步骤交回主机。生产网站数据库需要恢复时，先停服务并交由仓库管理员执行。

恢复范围由最近的已验证备份和企微本机仍可读取的记录决定。原机在最后一份备份之后产生且未同步的消息，只有原机或其他可用副本仍能提供时才可补传。
