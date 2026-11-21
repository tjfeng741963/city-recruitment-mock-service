export interface ConfigPullEvidence {
  position_id: number | null
  version: string | number | null
  status?: string | null
  state: string
  synced_at: string | null
  checked_at: string | null
  error: string
}
export interface ConfigSyncEvidence {
  available: boolean
  device_code: string
  reply_provider?: string | null
  bridge_state?: string | null
  client_commit?: string | null
  server_received_at?: string
  flow?: ConfigPullEvidence | null
  opening?: ConfigPullEvidence | null
}

export function configurationSyncView(
  evidence: ConfigSyncEvidence | null | undefined,
  expected: { mode: 'flow' | 'opening'; positionId: number; version: string | number | null; flowVersion?: number; flowStatus?: 'enabled' | 'disabled' },
  now = Date.now(),
): { state: 'unknown' | 'synced' | 'pending' | 'stale' | 'blocked' | 'not_applicable' | 'not_ready'; label: string; time?: string; detail: string } {
  if (evidence?.reply_provider === 'dify') {
    return { state: 'not_applicable', label: 'Dify 接待', detail: '该设备由 Dify 管理开场与对话。' }
  }
  if (!evidence?.available) return {state:'unknown',label:'客户端同步未核实',detail:'尚未收到配置拉取摘要；旧客户端或未运行客户端不会自动标成已同步。'}
  if(expected.mode==='opening') {
    const route=configurationSyncView({...evidence, bridge_state:undefined},{mode:'flow',positionId:expected.positionId,version:expected.flowVersion??null,flowStatus:'disabled'},now)
    if(route.state!=='synced')return route
    if(evidence.flow?.status!=='disabled')return {state:'pending',label:'等待客户端确认旧开场路径',time:evidence.flow?.synced_at||undefined,detail:'客户端仍报告启用的节点流程，不能据开场版本一致判断当前已走旧开场。'}
  }
  const pull=evidence[expected.mode]
  if(pull?.state==='blocked') return {state:'blocked',label:'鉴权失败，已阻断发送',time:pull.checked_at||undefined,detail:'设备拉取鉴权失败，需要核对设备授权。'}
  if(!pull || pull.version === null || !pull.synced_at) return {state:'unknown',label:'客户端尚未成功拉取',detail:'已有客户端报告，但当前路径还没有成功拉取记录。'}
  const received=Date.parse(String(evidence.server_received_at||''))
  const checked=Date.parse(String(pull.checked_at||''))
  if(pull.state!=='synced'||!Number.isFinite(received)||!Number.isFinite(checked)||now-received>150000||now-checked>150000)
    return {state:'stale',label:'同步异常或报告已陈旧',time:pull.synced_at,detail:`保留最后成功版本，当前检查状态：${pull.error||pull.state||'unknown'}；不能据旧报告判断已生效。`}
  if(pull.position_id!==expected.positionId||expected.version===null||String(pull.version)!==String(expected.version)||
    (expected.mode==='flow' && expected.flowStatus && pull.status!==expected.flowStatus))
    return {state:'pending',label:'等待客户端拉取当前版本',time:pull.synced_at,detail:pull.position_id!==expected.positionId?'客户端报告的岗位与当前岗位不同。':'客户端版本与服务器保存版本不同；新会话尚不能确认使用新版。'}
  if(expected.mode==='flow' && expected.flowVersion===undefined && pull.status!=='enabled' && pull.status!=='disabled')
    return {state:'unknown',label:'客户端路径状态未核实',time:pull.synced_at,detail:'尚未报告明确的节点启停状态。'}
  if (evidence.bridge_state !== undefined && evidence.bridge_state !== 'online') {
    const readiness = evidence.bridge_state === 'offline' ? '企微离线'
      : evidence.bridge_state === 'scanning' ? '企微待扫码' : '企微状态未知'
    return { state: 'not_ready', label: '已拉取 · ' + readiness, time: pull.synced_at, detail: '客户端已拉取当前配置，等待企微就绪。' }
  }
  return {state:'synced',label:'客户端已拉取当前版本',time:pull.synced_at,detail:'岗位与配置版本匹配，仅证明配置已拉取；发送就绪和客户送达需另行核验。'}
}
