<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">候选人员管理</h2>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ stats.total }}</div>
        <div class="stat-label">候选总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.invited }}</div>
        <div class="stat-label">报名成功</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.disqualified }}</div>
        <div class="stat-label">不符合</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.checked_in }}</div>
        <div class="stat-label">已签到</div>
      </div>
    </div>

    <el-tabs v-model="activeTab" class="candidate-tabs">
      <el-tab-pane :label="`全部（${stats.total}）`" name="all" />
      <el-tab-pane :label="`沟通中（${stats.communicating || 0}）`" name="communicating" />
      <el-tab-pane :label="`待完善（${stats.pending_information || 0}）`" name="pending_information" />
      <el-tab-pane label="报名成功" name="invited" />
      <el-tab-pane label="不符合" name="disqualified" />
      <el-tab-pane label="已签到" name="checked_in" />
    </el-tabs>

    <div class="filter-bar">
      <el-select
        v-model="recruiterFilter"
        class="recruiter-select"
        placeholder="选择招聘经理"
        clearable
      >
        <el-option v-for="item in recruiterOptions" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-date-picker
        v-model="eventDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="筛选事件日期"
        class="date-select"
      />
      <el-date-picker
        v-if="['all','invited'].includes(activeTab)"
        v-model="interviewDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="筛选面试日期"
        class="date-select"
      />
      <el-tooltip content="导出功能待接入" placement="top">
        <span>
          <el-button :icon="Download" disabled>导出 CSV</el-button>
        </span>
      </el-tooltip>
      <span class="count-note">共 <strong>{{ total }}</strong> 条</span>
    </div>

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="rows" row-key="id">
        <el-table-column prop="device_name" label="设备" min-width="130" />
        <el-table-column prop="nickname" label="昵称" min-width="120" show-overflow-tooltip />
        <el-table-column label="招聘状态" width="105"><template #default="{row}"><el-tag size="small" :type="row.status === 'invited' || row.status === 'checked_in' ? 'success' : 'info'">{{ candidateStatus(row.status) }}</el-tag></template></el-table-column>
        <el-table-column prop="name" label="姓名" width="100"><template #default="{row}">{{ row.name || '待补充' }}</template></el-table-column>
        <el-table-column label="微信名称" width="130" show-overflow-tooltip>
          <template #default="{row}">{{ row.remark || row.nickname || '-' }}</template>
        </el-table-column>
        <el-table-column prop="phone" label="电话" width="140" />
        <el-table-column prop="event_at" label="事件时间" width="175" />
        <el-table-column label="面试日期" width="130"><template #default="{row}">{{ row.interview_date || '-' }}<div class="muted-value">{{ row.interview_time }}</div></template></el-table-column>
        <el-table-column prop="factory_name" label="面试工厂" min-width="200" show-overflow-tooltip />
        <el-table-column label="城市/区县" min-width="190"><template #default="{row}">{{ [row.province,row.city,row.district].filter(Boolean).join('/') || '-' }}</template></el-table-column>
        <el-table-column label="提醒状态" width="110"><template #default="{row}"><el-tag size="small" :type="row.remind_status === 'sent' ? 'success' : 'info'">{{ reminderLabel(row.remind_status) }}</el-tag></template></el-table-column>
        <el-table-column prop="created_at" label="记录时间" width="175" />
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{row}"><el-button v-if="row.has_conversation" link type="primary" @click="openHistory(row)">对话记录</el-button><span v-else class="muted-value">{{ row.association_status === 'ambiguous' ? '会话待核对' : '无关联对话' }}</span></template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无候选记录，Agent 对话登记信息后会自动出现在这里" />
        </template>
      </el-table>
    </div>
    <div class="candidate-pagination"><el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="total, prev, pager, next" @current-change="load" /></div>
    <el-drawer v-model="historyVisible" :title="`对话记录 · ${historyCandidate?.nickname || historyCandidate?.name || ''}`" size="680px">
      <p class="history-note">只读记录</p>
      <el-button v-if="historyMore" :loading="historyLoading" @click="loadHistory(true)">加载更早消息</el-button>
      <el-alert v-if="historyError" :title="historyError" type="error" :closable="false" />
      <el-empty v-if="!historyLoading && !historyMessages.length && !historyError" description="暂无消息记录" />
      <div v-for="message in historyMessages" :key="message.id" class="history-message" :class="message.direction">
        <small>{{ message.direction === 'inbound' ? '候选人' : '招聘方' }} · {{ message.created_at }}</small>
        <div>{{ message.content }}</div><small v-if="message.direction !== 'inbound'">{{ message.status }}</small>
      </div>
      <p v-if="historyLoading">加载中…</p>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import http from '../api/http'

/**
 * 2026-11-20：接上 /api/v1/agent/candidates。
 * 该接口由面试登记（agent_archive）聚合而来，之前一直 404，页面是空壳。
 */
interface CandidateRow {
  id: string
  device_code:string
  customer_id:string
  province:string
  district:string
  has_conversation:boolean
  association_status:string
  remind_status:string
  status:string
  device_name: string
  recruiter_id: string
  nickname: string
  name: string
  phone: string
  /** 备注 = 群通知里姓名后面那段微信名称（来自面试登记的 remark） */
  remark?: string
  event_at: string
  interview_date: string
  factory_name: string
  interview_time: string
  city: string
  summary: string
  created_at: string
}

interface CandidateStats {
  total: number
  invited: number
  disqualified: number
  checked_in: number
  communicating: number
  pending_information: number
}

const historyVisible=ref(false),historyLoading=ref(false),historyError=ref(''),historyMore=ref(false)
const historyCandidate=ref<CandidateRow|null>(null)
const historyMessages=ref<Array<{id:number;direction:string;content:string;status:string;created_at:string}>>([])
function candidateStatus(status:string):string { return ({communicating:'沟通中',pending_information:'待完善',invited:'报名成功',disqualified:'不符合',checked_in:'已签到'} as Record<string,string>)[status] || '待核对' }
let historySeq=0
function reminderLabel(status:string):string {return ({not_reminded:'未提醒',queued:'待发送',claimed:'发送中',sent:'已提醒',succeeded:'已提醒',failed:'提醒失败',unknown:'结果待核实'} as Record<string,string>)[status] || '未提醒'}
async function openHistory(row:CandidateRow) { historyCandidate.value=row;historyMessages.value=[];historyVisible.value=true;await loadHistory() }
async function loadHistory(earlier=false) {
  const row=historyCandidate.value;if(!row)return
  const seq=++historySeq;historyLoading.value=true;historyError.value=''
  try {
    const {data}=await http.get(`/api/v1/agent/candidates/${encodeURIComponent(row.id)}/messages`,{params:{before_id:earlier?historyMessages.value[0]?.id:undefined}})
    if(seq!==historySeq)return
    historyMessages.value=earlier?[...data.items,...historyMessages.value]:data.items
    historyMore.value=!!data.has_more
  }catch(error:any){if(seq===historySeq)historyError.value=error?.response?.data?.detail || '对话记录读取失败'}
  finally{if(seq===historySeq)historyLoading.value=false}
}
watch(historyVisible,visible=>{if(!visible)historySeq++})
let timer:ReturnType<typeof setInterval>|undefined
const loading = ref(false)
const activeTab = ref('all')
const recruiterFilter = ref('')
const eventDate = ref('')
const interviewDate = ref('')
const rows = ref<CandidateRow[]>([])
const total = ref(0)
const stats = reactive<CandidateStats>({ total: 0, invited: 0, disqualified: 0, checked_in: 0, communicating:0, pending_information:0 })
const recruiterOptions = ref<Array<{ label: string; value: string }>>([])
const page = ref(1)
const pageSize = ref(50)
let listSeq=0

async function load(): Promise<void> {
  const seq=++listSeq
  loading.value = true
  try {
    const { data } = await http.get<{
      items?: CandidateRow[]
      total?: number
      stats?: CandidateStats
    }>('/api/v1/agent/candidates', {
      params: {
        status: activeTab.value,
        recruiter_id: recruiterFilter.value || undefined,
        event_date: eventDate.value || undefined,
        interview_date: ['all','invited'].includes(activeTab.value) ? interviewDate.value || undefined : undefined,
        page: page.value,
        page_size: pageSize.value,
      },
    })
    if(seq!==listSeq)return
    rows.value = data.items || []
    total.value = Number(data.total || 0)
    if (data.stats) Object.assign(stats, data.stats)
    const seen = new Set<string>()
    for (const row of rows.value) {
      const value = String(row.recruiter_id || '').trim()
      if (value) seen.add(value)
    }
    for (const option of recruiterOptions.value) seen.add(option.value)
    recruiterOptions.value = [...seen].map((value) => ({ label: value, value }))
  } catch (error: any) {
    if(seq!==listSeq)return
    rows.value = []
    ElMessage.error(error?.response?.data?.detail || '候选人员加载失败')
  } finally {
    if(seq===listSeq)loading.value = false
  }
}

watch([activeTab, recruiterFilter, eventDate, interviewDate], () => {
  page.value = 1
  load()
})

onMounted(()=>{void load();timer=setInterval(()=>{if(!document.hidden&&!loading.value)void load()},15000)})
onBeforeUnmount(()=>{if(timer)clearInterval(timer);historySeq++;listSeq++})
</script>

<style scoped>
.candidate-pagination{display:flex;justify-content:flex-end;margin-top:14px}.history-note{color:var(--bd-text-tertiary);font-size:12px}.history-message{padding:12px;margin:12px 0;border:1px solid var(--bd-border);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere}.history-message.outbound{background:var(--el-color-primary-light-9)}.history-message small{display:block;color:var(--bd-text-tertiary);margin-bottom:6px}

.degrade-alert {
  margin-bottom: 16px;
}

.muted-value {
  color: var(--bd-text-tertiary);
}

.candidate-tabs {
  margin-bottom: 4px;
}

.recruiter-select {
  width: 240px;
}

.date-select {
  width: 170px;
}

.count-note {
  margin-left: 4px;
  font-size: 13px;
  color: var(--bd-text-tertiary);
}
</style>
