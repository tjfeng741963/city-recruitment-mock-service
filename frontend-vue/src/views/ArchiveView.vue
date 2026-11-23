<template>
  <section class="archive-page">
    <div class="arch-grid">
      <div class="arch-left">
        <div class="arch-card">
          <div class="card-head">
            <b>面试登记清单（{{ items.length }} 条）</b>
            <el-button link type="primary" @click="openManual">手动登记</el-button>
          </div>
          <div v-if="loading" class="arch-empty">加载中…</div>
          <div v-else-if="!items.length" class="arch-empty">
            还没有登记记录。Agent 对话收集到客户姓名、电话、面试时间后会自动出现在这里并推送群聊。
          </div>
          <div v-else class="arch-list">
            <div
              v-for="item in items"
              :key="item.session_key"
              class="arch-item"
              :class="{ 'is-active': selected?.session_key === item.session_key }"
              @click="select(item)"
            >
              <div class="item-name">
                {{ item.name || '（未登记姓名）' }}
                <span class="item-time">{{ item.interview_date }} {{ item.interview_time }}</span>
              </div>
              <div class="item-meta">
                {{ item.customer_nickname || '-' }} · {{ item.device_code || '-' }} ·
                {{ statusText(item.notify_status) }}
              </div>
            </div>
          </div>
        </div>

        <div class="arch-card">
          <b>设备绑定群聊（登记完成后自动推送）</b>
          <p class="arch-hint">
            群聊清单由客户端从企微读取上报。选设备 → 选群聊 → 保存，登记完成自动推送。
          </p>
          <div v-for="device in devices" :key="device.id" class="arch-row">
            <span class="device-label">{{ device.device_code }}</span>
            <el-select
              v-model="device.group_chat"
              class="group-select"
              :placeholder="groupsLoaded ? '未绑定' : '加载中…'"
              @change="(value: string) => bindGroup(device, value)"
            >
              <el-option label="未绑定" value="" />
              <el-option v-for="group in groups[device.device_code] || []" :key="group" :label="group" :value="group" />
            </el-select>
          </div>
          <div v-if="!devices.length" class="arch-empty">暂无设备</div>
        </div>
      </div>

      <div class="arch-right">
        <div v-if="selected" class="arch-card archive-details">
          <div>
            <b>登记详情</b>
            <div class="arch-kv">
              <div class="k">姓名</div>
              <div class="v">{{ selected.name || '-' }}</div>
              <div class="k">电话</div>
              <div class="v">{{ selected.phone || '-' }}</div>
              <div class="k">备注</div>
              <div class="v">
                {{ selected.remark || selected.customer_nickname || '-' }}
                <el-button link type="primary" size="small" @click="editRemark">修改</el-button>
              </div>
              <div class="k">城市</div>
              <div class="v">{{ selected.city || '-' }}</div>
              <div class="k">面试时间</div>
              <div class="v">{{ selected.interview_date }} {{ selected.interview_time }}</div>
              <div class="k">客户</div>
              <div class="v">{{ selected.customer_nickname || '-' }}</div>
              <div class="k">设备</div>
              <div class="v">
                {{ selected.device_code || '-' }}
                <template v-if="selected.group_chat">（群聊：{{ selected.group_chat }}）</template>
              </div>
              <div class="k">确认</div>
              <div class="v">
                <span :class="selected.interview_confirmed ? 'tag-ok' : 'tag-wait'">
                  {{ selected.interview_confirmed ? '已确认' : '待确认' }}
                </span>
              </div>
              <div class="k">群聊通知</div>
              <div class="v">
                <span class="pill" :class="`pill-${statusKey(selected.notify_status).replace(/_/g, '-')}`">
                  {{ statusText(selected.notify_status) }}
                </span>
              </div>
              <div class="k">更新时间</div>
              <div class="v">{{ selected.updated_at || '-' }}</div>

            </div>

            <div class="arrival-block">
              <b class="arrival-title">到达状态</b>
              <el-select
                :model-value="selected.arrival_status || ''"
                class="arrival-select"
                @change="(value: string) => setArrival(value)"
              >
                <el-option label="待定" value="" />
                <el-option label="正常到达" value="arrived" />
                <el-option label="爽约" value="noshow" />
              </el-select>
            </div>
          </div>

          <section class="followup-panel" aria-labelledby="followup-title">
            <div class="followup-head">
              <h2 id="followup-title">AI 跟进摘要</h2>
              <el-button
                v-if="selected.has_conversation"
                type="primary"
                plain
                :loading="currentFollowup?.loading"
                @click="generateFollowup"
              >
                {{ currentFollowup?.summary ? '重新生成' : '生成摘要' }}
              </el-button>
            </div>
            <div aria-live="polite" :aria-busy="currentFollowup?.loading || false">
              <p v-if="!selected.has_conversation" class="followup-hint">暂无可分析的对话</p>
              <template v-else>
                <p v-if="currentFollowup?.loading" class="followup-hint">正在整理关联对话…</p>
                <p v-if="currentFollowup?.error" class="followup-error" role="alert">{{ currentFollowup.error }}</p>
                <template v-if="currentFollowup?.summary">
                  <dl class="followup-facts">
                    <div><dt>求职意向</dt><dd>{{ currentFollowup.summary.intent || '未明确' }}</dd></div>
                    <div><dt>已聊清楚</dt><dd>{{ currentFollowup.summary.discussed || '暂未确认' }}</dd></div>
                    <div v-if="currentFollowup.summary.experience">
                      <dt>工作经历与到岗</dt><dd>{{ currentFollowup.summary.experience }}</dd>
                    </div>
                    <div><dt>下次确认</dt><dd>{{ currentFollowup.summary.next_question || '暂无建议' }}</dd></div>
                  </dl>
                  <figure v-if="currentFollowup.summary.quote" class="followup-quote">
                    <figcaption>候选人原话</figcaption>
                    <blockquote>“{{ currentFollowup.summary.quote }}”</blockquote>
                  </figure>
                  <p class="followup-hint">根据近期对话生成，仅供跟进参考。</p>
                </template>
                <p v-else-if="!currentFollowup?.loading && !currentFollowup?.error" class="followup-hint">
                  整理候选人的求职意向、已确认事项和下次要问的问题。
                </p>
              </template>
            </div>
          </section>
        </div>
        <div v-else class="arch-card arch-empty">选择左侧一条登记查看详情</div>
      </div>
    </div>

    <el-dialog v-model="manualVisible" title="手动登记" width="520px">
      <el-form :model="manualForm" label-position="top">
        <el-form-item label="姓名" required>
          <el-input v-model="manualForm.name" placeholder="客户姓名" maxlength="32" />
        </el-form-item>
        <el-form-item label="电话" required>
          <el-input v-model="manualForm.phone" placeholder="手机号" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注（微信名称）">
          <el-input
            v-model="manualForm.remark"
            placeholder="群里认人用的微信名称，如：阿三 / 龙华老李介绍"
            maxlength="64"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="面试日期">
          <el-date-picker v-model="manualForm.interview_date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="面试时间">
          <el-time-picker v-model="manualForm.interview_time" format="HH:mm" value-format="HH:mm" placeholder="选择时间" />
        </el-form-item>
        <el-form-item label="城市">
          <el-input v-model="manualForm.city" placeholder="如：广州" maxlength="32" />
        </el-form-item>
        <el-form-item label="设备">
          <el-select v-model="manualForm.device_code" clearable placeholder="选择设备（可选）" class="full">
            <el-option v-for="device in devices" :key="device.id" :label="device.device_code" :value="device.device_code" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="manualVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitManual">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import http from '../api/http'
import { archiveApi, type ArchiveFollowupSummary } from '../api/agent'

interface ArchiveItem {
  session_key: string
  customer_nickname?: string
  device_code?: string
  group_chat?: string
  name?: string
  phone?: string
  /** 备注 = 群通知里姓名后面那段微信名称 */
  remark?: string
  city?: string
  interview_date?: string
  interview_time?: string
  interview_confirmed?: boolean
  arrival_status?: string
  notify_status?: string
  updated_at?: string
  has_conversation?: boolean
}

interface DeviceRow {
  id: number
  device_code: string
  group_chat?: string
}

const items = ref<ArchiveItem[]>([])
const devices = ref<DeviceRow[]>([])
const selected = ref<ArchiveItem | null>(null)
const followups = reactive(new Map<string, { summary?: ArchiveFollowupSummary; loading?: boolean; error?: string }>())
const currentFollowup = computed(() => selected.value ? followups.get(selected.value.session_key) : undefined)
const groups = ref<Record<string, string[]>>({})
const groupsLoaded = ref(false)
const loading = ref(false)
const saving = ref(false)
const manualVisible = ref(false)

const manualForm = reactive({
  name: '',
  phone: '',
  remark: '',
  interview_date: '',
  interview_time: '',
  city: '',
  device_code: '',
})

const STATUS_TEXT: Record<string, string> = {
  sent: '已推送群聊',
  queued: '待设备发送',
  claimed: '设备发送中',
  failed: '推送失败',
  unknown: '发送结果待核对',
  no_group: '未绑群聊',
  group_unavailable: '未确认目标群',
  incomplete: '信息未齐',
  pending: '待推送',
}

function statusKey(status?: string): string {
  const key = String(status || 'pending').replace(/-/g, '_')
  return Object.hasOwn(STATUS_TEXT, key) ? key : 'pending'
}

function statusText(status?: string): string {
  return STATUS_TEXT[statusKey(status)] || String(status || '待推送')
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const { data } = await http.get<{ items?: ArchiveItem[] }>('/api/v1/agent/archive/list')
    items.value = data.items || []
    if (!selected.value && items.value.length) selected.value = items.value[0]
    else if (selected.value) {
      const fresh = items.value.find((i) => i.session_key === selected.value?.session_key)
      if (fresh) selected.value = fresh
    }
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '面试登记加载失败')
  } finally {
    loading.value = false
  }
}

async function loadDevices(): Promise<void> {
  try {
    const { data } = await http.get<{ items?: DeviceRow[] }>('/api/v1/agent/devices')
    devices.value = data.items || []
    groupsLoaded.value = true
    await Promise.all(devices.value.map((device) => loadGroups(device.device_code)))
  } catch {
    devices.value = []
    groupsLoaded.value = true
  }
}

async function loadGroups(code: string): Promise<void> {
  try {
    const { data } = await http.get<{ items?: Array<{ name: string }> }>(
      `/api/v1/agent/devices/${code}/groups`,
    )
    groups.value = {
      ...groups.value,
      [code]: (data.items || []).map((g) => g.name).filter(Boolean),
    }
  } catch {
    groups.value = { ...groups.value, [code]: [] }
  }
}

function select(item: ArchiveItem): void {
  selected.value = item
}

async function generateFollowup(): Promise<void> {
  const record = selected.value
  if (!record?.has_conversation) return
  const key = record.session_key
  const previous = followups.get(key)
  if (previous?.loading) return
  followups.set(key, { summary: previous?.summary, loading: true })
  try {
    const { data } = await archiveApi.followupSummary(key)
    followups.set(key, { summary: data })
  } catch (error) {
    const response = (error as { response?: { data?: { detail?: string } } })?.response
    followups.set(key, { summary: previous?.summary, error: response?.data?.detail || '摘要暂未生成，请重试' })
  }
}

async function bindGroup(device: DeviceRow, value: string): Promise<void> {
  const previous = device.group_chat
  device.group_chat = value
  try {
    await http.put(`/api/v1/agent/devices/${device.id}`, { group_chat: value })
    ElMessage.success(value ? `已绑定群聊：${value}` : '已取消绑定')
    await load()
  } catch (error: any) {
    device.group_chat = previous
    ElMessage.error(error?.response?.data?.detail || '群聊绑定保存失败')
  }
}

// 备注 = 群通知里姓名后面那段「微信名称」。改完只影响之后的推送，
// 已经发到群里的那条不会重发（重发只会刷屏）。
async function editRemark(): Promise<void> {
  if (!selected.value) return
  const key = selected.value.session_key
  try {
    const { value } = await ElMessageBox.prompt(
      '备注会跟在姓名后面一起发到群里，用来对齐客户在企微里的名字。',
      '修改备注（微信名称）',
      {
        inputValue: selected.value.remark || selected.value.customer_nickname || '',
        inputPlaceholder: '如：阿三 / 龙华老李介绍',
        inputValidator: (input: string) => (input || '').trim().length <= 64 || '最多 64 个字',
        confirmButtonText: '保存',
        cancelButtonText: '取消',
      },
    )
    const { data } = await archiveApi.setRemark(key, (value || '').trim())
    if (selected.value && selected.value.session_key === key) selected.value.remark = data.remark
    ElMessage.success('备注已保存，之后的群通知会带上')
    await load()
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error?.response?.data?.detail || '备注保存失败')
  }
}

async function setArrival(value: string): Promise<void> {
  if (!selected.value) return
  const key = selected.value.session_key
  try {
    await http.put(`/api/v1/agent/archive/${encodeURIComponent(key)}/arrival`, {
      arrival_status: value,
    })
    selected.value.arrival_status = value
    ElMessage.success('到达状态已更新')
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '更新失败')
  }
}

function openManual(): void {
  Object.assign(manualForm, {
    name: '',
    phone: '',
    remark: '',
    interview_date: '',
    interview_time: '',
    city: '',
    device_code: '',
  })
  manualVisible.value = true
}

async function submitManual(): Promise<void> {
  if (!manualForm.name.trim() || !manualForm.phone.trim()) {
    ElMessage.warning('姓名和电话必填')
    return
  }
  if (!manualForm.interview_date && !manualForm.interview_time) {
    ElMessage.warning('面试日期与时间至少填一项')
    return
  }
  saving.value = true
  try {
    await archiveApi.manual({ ...manualForm })
    ElMessage.success('登记已保存')
    manualVisible.value = false
    await load()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await Promise.all([load(), loadDevices()])
})
</script>

<style scoped>
.archive-page {
  min-height: calc(100vh - 130px);
}

.arch-grid {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.arch-left {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.arch-card {
  background: #fff;
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 14px;
  padding: 14px 16px;
}

.arch-card b {
  font-size: 13px;
  color: var(--bd-text-primary);
}

.arch-right {
  container-type: inline-size;
  min-width: 0;
}

.archive-details {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

@container (min-width: 680px) {
  .archive-details {
    grid-template-columns: minmax(240px, 5fr) minmax(340px, 7fr);
  }
}

.followup-panel {
  padding: 16px;
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 12px;
  background: var(--el-fill-color-light);
  color: var(--bd-text-primary);
  overflow-wrap: anywhere;
}

.followup-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  column-gap: 12px;
  row-gap: 8px;
}

.followup-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}

.followup-facts {
  display: grid;
  gap: 10px;
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.followup-facts > div {
  display: grid;
  grid-template-columns: 7em minmax(0, 1fr);
  gap: 8px;
}

.followup-facts dt,
.followup-quote figcaption,
.followup-hint {
  color: var(--el-text-color-secondary);
}

.followup-facts dd,
.followup-quote blockquote {
  margin: 0;
}

.followup-quote {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--bd-border, #e8ecf3);
  font-size: 13px;
  line-height: 1.65;
}

.followup-quote figcaption {
  margin-bottom: 3px;
}

.followup-hint,
.followup-error {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.6;
}

.followup-error {
  color: var(--el-color-danger-dark-2);
}

.card-head :deep(.el-button.is-link) {
  padding: 0 !important;
  height: auto;
  background: transparent !important;
  border-color: transparent !important;
  font-size: 12.5px;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.arch-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52vh;
  overflow: auto;
}

.arch-item {
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.arch-item:hover {
  border-color: var(--bd-primary, #0b57d0);
}

.arch-item.is-active {
  border-color: var(--bd-primary, #0b57d0);
  background: rgba(11, 87, 208, 0.06);
}

.item-name {
  font-size: 13px;
  color: var(--bd-text-primary);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.item-time {
  font-size: 12px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.item-meta {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.arch-hint {
  margin: 8px 0 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--bd-text-tertiary, #8a94a6);
}

.arch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.device-label {
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 600;
  color: var(--bd-text-secondary, #5f6b7a);
}

.group-select {
  flex: 1 1 140px;
}

.arch-empty {
  padding: 20px 4px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--bd-text-tertiary, #8a94a6);
}

.arch-kv {
  margin-top: 12px;
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  row-gap: 9px;
  column-gap: 10px;
  font-size: 12.5px;
}

.arch-kv .k {
  color: var(--bd-text-tertiary, #8a94a6);
}

.arch-kv .v {
  color: var(--bd-text-primary);
  word-break: break-word;
}

.pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11.5px;
  background: #f2f4f8;
  color: #5f6b7a;
}

.pill-sent {
  background: #e8f8ee;
  color: #12a150;
}

.pill-queued,
.pill-pending {
  background: #fff5e6;
  color: #b26a00;
}

.pill-failed {
  background: #fdecec;
  color: #d93026;
}

.pill-incomplete,
.pill-no-group {
  background: #f2f4f8;
  color: #6b7280;
}

.tag-ok {
  color: #12a150;
}

.tag-wait {
  color: #b26a00;
}

.arrival-block {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.arrival-title {
  font-size: 12.5px;
}

.arrival-select {
  width: 180px;
}

.full {
  width: 100%;
}

@media (max-width: 1100px) {
  .arch-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
