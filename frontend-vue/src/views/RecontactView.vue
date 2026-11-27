<template>
  <section class="recontact-page">
    <header class="page-header">
      <h2 class="page-title">复聊板块</h2>
    </header>

    <div v-loading="optionsLoading" class="recontact-panel">
      <el-alert v-if="optionsError" :title="optionsError" type="error" :closable="false" show-icon />
      <div class="context-row">
        <el-select v-model="positionId" aria-label="岗位" placeholder="全部岗位" clearable filterable>
          <el-option v-for="position in filterPositions" :key="position.id" :label="position.name" :value="position.id" />
        </el-select>
        <el-select v-model="deviceCode" aria-label="企微账号" placeholder="全部企微账号" clearable filterable>
          <el-option v-for="device in options.devices" :key="device.code" :label="device.name || device.code" :value="device.code" />
        </el-select>
        <div v-if="accountAction" class="account-control">
          <el-button :disabled="accountAction.disabled || optionsLoading" :loading="accountSaving"
            @click="updateAccountRelease">{{ accountAction.label }}</el-button>
          <span v-if="accountAction.disabled" class="account-reason">等待企微账号在线并完成绑定</span>
        </div>
        <el-button :icon="Refresh" :loading="loading || optionsLoading" @click="refresh">刷新</el-button>
      </div>

      <el-tabs v-model="tab" class="recontact-tabs">
        <el-tab-pane name="automatic" label="自动复聊" lazy>
          <el-empty v-if="!positionId" description="选择岗位后配置自动复聊" :image-size="74" />
          <div v-else v-loading="loading" class="rules">
            <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
            <template v-else>
              <article v-for="rule in rules" :key="rule.stage" class="rule-card">
                <div class="rule-heading">
                  <h3>{{ stageLabels[rule.stage] }}</h3>
                  <el-tag :type="rule.enabled ? 'success' : 'info'" effect="plain">
                    {{ rule.enabled ? '已启用' : '已停用' }}
                  </el-tag>
                  <el-button v-if="options.can_edit_rules" type="primary" link @click="editRule(rule)">编辑规则</el-button>
                </div>
                <div class="rule-facts">
                  <span>等待 {{ rule.wait_minutes }} 分钟</span>
                  <span>{{ asClock(rule.start_minute) }}–{{ asClock(rule.end_minute) }}</span>
                  <span>{{ rule.parts.length }} 条消息</span>
                </div>
              </article>
            </template>
          </div>
        </el-tab-pane>

        <el-tab-pane name="customers" label="老客户复聊" lazy>
          <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
          <div class="list-toolbar">
            <label class="inline-control">
              <span>未联系满</span>
              <el-input-number v-model="days" :min="0" :max="3650" :precision="0" aria-label="最近未联系天数" @change="loadSection" />
              <span>天</span>
            </label>
            <div class="toolbar-actions">
              <el-button @click="templateDialog = true">管理模板</el-button>
              <el-button type="primary" :disabled="!selected.length || selected.length > 100 || !chosenCount || loading"
                :loading="previewing" @click="previewBatch">预览发送</el-button>
            </div>
          </div>
          <el-alert v-if="selected.length > 100" title="每批最多选 100 人，请缩小名单范围" type="warning" :closable="false" show-icon />

          <div v-if="selectedPositions.length" class="template-choices">
            <label v-for="id in selectedPositions" :key="id" class="template-choice">
              <span>{{ positionName(id) }}</span>
              <el-select v-model="templateChoices[id]" placeholder="选择本岗位模板" clearable filterable
                :aria-label="`${positionName(id)}模板`">
                <el-option v-for="template in templates.filter(item => item.position_id === id)" :key="template.id"
                  :label="template.name" :value="template.id" />
                <template #empty>该岗位暂无模板</template>
              </el-select>
            </label>
          </div>

          <el-table v-loading="loading" :data="candidates" row-key="id" :empty-text="loadError ? '名单读取失败' : '没有符合筛选条件的客户'"
            @selection-change="selectCustomers">
            <el-table-column type="selection" :selectable="(row: RecontactCandidate) => !row.reason" width="52" />
            <el-table-column prop="nickname" label="候选人" min-width="128" />
            <el-table-column label="岗位" min-width="130">
              <template #default="{ row }">{{ positionName(row.position_id) }}</template>
            </el-table-column>
            <el-table-column label="企微账号" min-width="130">
              <template #default="{ row }">{{ deviceName(row.device_code) }}</template>
            </el-table-column>
            <el-table-column label="最近联系" min-width="155">
              <template #default="{ row }">{{ recontactTime(row.last_contact_at) }}</template>
            </el-table-column>
            <el-table-column label="状态" min-width="180">
              <template #default="{ row }">{{ row.reason || '可复聊' }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="records" label="发送记录" lazy>
          <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
          <div class="list-toolbar">
            <el-select v-model="jobStatus" class="status-filter" placeholder="全部状态" aria-label="发送状态" clearable @change="loadSection">
              <el-option v-for="(label, status) in jobLabels" :key="status" :label="label" :value="status" />
            </el-select>
            <el-input v-model="recordKeyword" class="record-search" placeholder="搜索候选人" aria-label="搜索候选人"
              clearable @change="loadSection" />
          </div>

          <el-table v-loading="loading" :data="jobs" row-key="id" :empty-text="loadError ? '记录读取失败' : '暂无发送记录'">
            <el-table-column type="expand">
              <template #default="{ row }">
                <ol class="receipt-list">
                  <li v-for="(step, index) in row.steps" :key="index">
                    <strong>{{ kindLabels[step.kind as RecontactKind] }}</strong>
                    <span class="receipt-content">{{ step.content }}</span>
                    <el-tag :type="statusType(step.status)" size="small" effect="plain">{{ stepLabels[step.status] || step.status }}</el-tag>
                    <span>预计 {{ recontactTime(step.due_at) }}</span>
                    <span v-if="step.confirmed_at">回执 {{ recontactTime(step.confirmed_at) }}</span>
                    <span v-if="step.reason">{{ step.reason }}</span>
                  </li>
                </ol>
              </template>
            </el-table-column>
            <el-table-column label="候选人" min-width="120">
              <template #default="{ row }">
                <router-link :to="conversationLink(row)" class="conversation-link">{{ row.nickname || row.customer_id }}</router-link>
              </template>
            </el-table-column>
            <el-table-column label="岗位" min-width="120">
              <template #default="{ row }">{{ positionName(row.position_id) }}</template>
            </el-table-column>
            <el-table-column label="企微账号" min-width="115">
              <template #default="{ row }">{{ deviceName(row.device_code) }}</template>
            </el-table-column>
            <el-table-column label="复聊方式" min-width="100">
              <template #default="{ row }">{{ row.source === 'auto' || row.source === 'automatic' ? '自动复聊' : '老客户复聊' }}</template>
            </el-table-column>
            <el-table-column label="预计发送" min-width="148">
              <template #default="{ row }">{{ recontactTime(row.due_at) }}</template>
            </el-table-column>
            <el-table-column label="状态" min-width="130">
              <template #default="{ row }">
                <el-tag :type="statusType(row.status)" effect="plain" size="small">{{ jobLabels[row.status] || row.status }}</el-tag>
                <div v-if="row.reason" class="job-reason">{{ row.reason }}</div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="105">
              <template #default="{ row }">
                <el-button v-if="row.status === 'unknown'" type="primary" link @click="reviewJob = row">核对结果</el-button>
                <el-button v-else-if="row.status === 'failed'" type="primary" link @click="reviewJob = row">处理失败</el-button>
                <el-button v-else-if="row.status === 'scheduled'" type="primary" link @click="reviewJob = row">取消任务</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-dialog v-model="ruleDialog" title="编辑自动复聊" :width="dialogWidth" destroy-on-close>
      <el-form v-if="ruleDraft" label-position="top" @submit.prevent="saveRule">
        <div class="rule-form">
          <el-form-item label="触发阶段">{{ stageLabels[ruleDraft.stage] }}</el-form-item>
          <el-form-item label="自动复聊">
            <el-switch v-model="ruleDraft.enabled" active-text="启用" inactive-text="停用" />
          </el-form-item>
          <el-form-item label="等待回复（分钟）">
            <el-input-number v-model="ruleDraft.wait_minutes" :min="1" :max="10080" :precision="0" />
          </el-form-item>
          <el-form-item label="发送时段（北京时间）">
            <div class="time-controls">
              <el-time-select v-model="startAt" start="09:00" end="20:55" step="00:05" aria-label="最早发送时间" />
              <span>至</span>
              <el-time-select v-model="endAt" start="09:05" end="21:00" step="00:05" aria-label="最晚发送时间" />
            </div>
          </el-form-item>
        </div>
        <RecontactParts v-model="ruleDraft.parts" :assets="assetsFor(ruleDraft.position_id)" :locations="locationsFor(ruleDraft.position_id)" />
        <el-alert v-if="formError" class="form-note" :title="formError" type="error" :closable="false" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="ruleDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveRule">保存规则</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="templateDialog" :title="templateDraft ? (templateDraft.id ? '编辑模板' : '新建模板') : '管理模板'"
      :width="dialogWidth" @closed="templateDraft = null" destroy-on-close>
      <template v-if="templateDraft">
        <el-form label-position="top" @submit.prevent="saveTemplate">
          <el-form-item label="岗位">
            <el-select :model-value="templateDraft.position_id || undefined" placeholder="选择岗位" :disabled="!!templateDraft.id"
              filterable @update:model-value="changeTemplatePosition">
              <el-option v-for="position in options.positions" :key="position.id" :label="position.name" :value="position.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="模板名称">
            <el-input v-model="templateDraft.name" :maxlength="60" />
          </el-form-item>
          <RecontactParts v-model="templateDraft.parts" :assets="assetsFor(templateDraft.position_id)"
            :locations="locationsFor(templateDraft.position_id)" :disabled="!templateDraft.position_id" />
          <el-alert v-if="formError" class="form-note" :title="formError" type="error" :closable="false" show-icon />
        </el-form>
      </template>
      <el-table v-else :data="filteredTemplates" empty-text="暂无复聊模板">
        <el-table-column prop="name" label="模板名称" min-width="145" />
        <el-table-column label="岗位" min-width="140">
          <template #default="{ row }">{{ positionName(row.position_id) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="95">
          <template #default="{ row }"><el-button type="primary" link @click="editTemplate(row)">编辑</el-button></template>
        </el-table-column>
      </el-table>
      <template #footer>
        <template v-if="templateDraft">
          <el-button :disabled="saving" @click="templateDraft = null">返回模板列表</el-button>
          <el-button type="primary" :loading="saving" @click="saveTemplate">保存模板</el-button>
        </template>
        <el-button v-else type="primary" @click="editTemplate()">新建模板</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showPreview" title="确认复聊名单" :width="dialogWidth" :close-on-click-modal="!sending" :show-close="!sending">
      <template v-if="preview">
        <div class="preview-summary">{{ previewReady }} 人可发送 · {{ preview.items.length - previewReady }} 人跳过</div>
        <div v-for="customer in preview.items" :key="customer.id" class="preview-customer">
          <div class="preview-title">
            <strong>{{ customer.nickname || customer.id }}</strong>
            <span>{{ positionName(customer.position_id) }}</span>
            <span>{{ deviceName(customer.device_code) }}</span>
          </div>
          <p v-if="customer.reason" class="job-reason">{{ customer.reason }}</p>
          <ol v-else class="preview-messages">
            <li v-for="(part, index) in customer.parts" :key="index">
              <strong>{{ kindLabels[part.kind] }}</strong>
              <span>{{ part.value }}</span>
              <span v-if="index">间隔 {{ part.delay_ms / 1000 }} 秒</span>
            </li>
          </ol>
        </div>
      </template>
      <el-alert v-if="formError" class="form-note" :title="formError" type="error" :closable="false" show-icon />
      <template #footer>
        <el-button :disabled="sending" @click="showPreview = false">返回</el-button>
        <el-button type="primary" :loading="sending" :disabled="!previewReady" @click="sendBatch">确认发送 {{ previewReady }} 人</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showBatchResult" title="复聊任务已创建" :width="dialogWidth">
      <div v-if="batchResult">
        <p>已加入发送计划 {{ batchResult.created }} 人 · 跳过 {{ batchResult.skipped.length }} 人</p>
        <ul v-if="batchResult.skipped.length">
          <li v-for="item in batchResult.skipped" :key="item.id">{{ batchNames[item.id] || item.id }} · {{ item.reason }}</li>
        </ul>
      </div>
      <template #footer>
        <el-button type="primary" @click="showBatchResult = false; tab = 'records'">查看发送记录</el-button>
      </template>
    </el-dialog>

    <el-dialog :model-value="!!reviewJob" :title="reviewJob?.status === 'scheduled' ? '取消复聊任务' : '核对发送结果'"
      :width="dialogWidth" :show-close="!saving"
      @close="reviewJob = null">
      <p v-if="reviewJob?.status === 'scheduled'">取消后，剩余消息将停止发送。</p>
      <p v-else-if="reviewJob">请先核对企微对话，再选择当前消息的处理方式。</p>
      <el-alert v-if="formError" class="form-note" :title="formError" type="error" :closable="false" show-icon />
      <template #footer>
        <div class="review-actions">
          <el-button :disabled="saving" @click="finishReview('cancel')">取消剩余发送</el-button>
          <el-button v-if="reviewJob?.status !== 'scheduled'" :disabled="saving" @click="finishReview('not_sent')">确认未发，重新排队</el-button>
          <el-button v-if="reviewJob?.status === 'unknown'" type="primary" :loading="saving" @click="finishReview('sent')">确认已发，继续后续</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { isAxiosError } from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import RecontactParts from '../components/recontact/RecontactParts.vue'
import {
  accountRecontactAction, asClock, conversationRoute, recontactTime, selectedTemplateIds, toMinute,
} from '../components/recontact/recontact-view'
import {
  recontactApi, type RecontactCandidate, type RecontactJob, type RecontactKind, type RecontactOptions,
  type RecontactPart, type RecontactPreview, type RecontactResolution, type RecontactRule, type RecontactStage,
  type RecontactTemplate,
} from '../api/recontact'

type Tab = 'automatic' | 'customers' | 'records'
const route = useRoute()
const tab = ref<Tab>(route.query.tab === 'records' ? 'records' : 'automatic')
const positionId = ref<number | undefined>()
const deviceCode = ref<string | undefined>()
const days = ref<number | undefined>(3)
const jobStatus = ref(typeof route.query.status === 'string' ? route.query.status : '')
const recordKeyword = ref(typeof route.query.q === 'string' ? route.query.q : '')
const dialogWidth = 'min(690px, calc(100vw - 24px))'
const options = ref<RecontactOptions>({ positions: [], devices: [], assets: [], locations: [] })
const selectedAccount = computed(() => options.value.devices.find(item => item.code === deviceCode.value))
const accountAction = computed(() => accountRecontactAction(selectedAccount.value))
const accountSaving = ref(false)
const filterPositions = computed(() => {
  const assigned = selectedAccount.value?.position_ids
  return assigned ? options.value.positions.filter(item => assigned.includes(item.id)) : options.value.positions
})
const optionsLoading = ref(true)
const optionsError = ref('')
const loading = ref(false)
const loadError = ref('')
let requestId = 0

const stageLabels: Record<RecontactStage, string> = {
  work_location: '已回复上班地点',
  interview_invite: '已发面试邀约',
}
const kindLabels: Record<RecontactKind, string> = { text: '文字', image: '图片', video: '视频', location: '地点链接' }
const jobLabels: Record<string, string> = {
  scheduled: '待发送', sending: '发送中', sent: '已发出', cancelled: '已取消', failed: '发送失败', unknown: '待核对',
}
const stepLabels: Record<string, string> = { ...jobLabels, pending: '等待前序消息', queued: '已排队' }
const rules = ref<RecontactRule[]>([])
const candidates = ref<RecontactCandidate[]>([])
const selected = ref<RecontactCandidate[]>([])
const jobs = ref<RecontactJob[]>([])
const templates = ref<RecontactTemplate[]>([])
const templateChoices = ref<Record<number, number | undefined>>({})
const selectedPositions = computed(() => [...new Set(selected.value.map(row => row.position_id))])
const chosenTemplates = computed(() => selectedTemplateIds(selectedPositions.value, templateChoices.value))
const chosenCount = computed(() => Object.keys(chosenTemplates.value).length)
const filteredTemplates = computed(() => templates.value.filter(item => !positionId.value || item.position_id === positionId.value))

const ruleDialog = ref(false)
const ruleDraft = ref<RecontactRule | null>(null)
const startAt = ref('09:00')
const endAt = ref('21:00')
const templateDialog = ref(false)
const templateDraft = ref<RecontactTemplate | null>(null)
const saving = ref(false)
const formError = ref('')
const reviewJob = ref<RecontactJob | null>(null)
const showPreview = ref(false)
const preview = ref<RecontactPreview | null>(null)
const previewing = ref(false)
const sending = ref(false)
const previewReady = computed(() => preview.value?.items.filter(row => !row.reason).length || 0)
const showBatchResult = ref(false)
const batchResult = ref<{ created: number; skipped: { id: number; reason: string }[] } | null>(null)
const batchNames = ref<Record<number, string>>({})

function errorMessage(error: unknown, fallback: string) {
  if (!isAxiosError<{ detail?: unknown }>(error)) return fallback
  const detail = error.response?.data?.detail
  return typeof detail === 'string' && detail.trim() ? detail : fallback
}

function defaultRules(position_id: number): RecontactRule[] {
  return (Object.keys(stageLabels) as RecontactStage[]).map(stage => ({
    position_id, stage, enabled: false, wait_minutes: 30, start_minute: 540, end_minute: 1260, parts: [],
  }))
}

function positionName(id: number) {
  return options.value.positions.find(item => item.id === id)?.name || '—'
}

function deviceName(code: string) {
  return options.value.devices.find(item => item.code === code)?.name || code
}

function assetsFor(id: number) {
  return options.value.assets.filter(item => item.position_id === id || item.position_id === 0)
}

function locationsFor(id: number) {
  return options.value.locations.filter(item => item.position_id === id)
}

function statusType(status: string) {
  if (status === 'sent') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'unknown') return 'warning'
  if (status === 'sending' || status === 'queued') return 'primary'
  return 'info'
}

function conversationLink(row: RecontactJob) {
  return conversationRoute(row, {
    position_id: positionId.value ? String(positionId.value) : undefined,
    device_code: deviceCode.value,
    status: jobStatus.value,
    q: recordKeyword.value,
  })
}

async function loadSection() {
  if (optionsLoading.value) return
  const id = ++requestId
  const currentTab = tab.value
  const currentPosition = positionId.value || undefined
  const filters = { position_id: currentPosition, device_code: deviceCode.value || undefined }
  loading.value = true
  loadError.value = ''
  try {
    if (currentTab === 'automatic') {
      rules.value = []
      if (!currentPosition) return
      const { data } = await recontactApi.rules(currentPosition)
      if (id === requestId) {
        rules.value = defaultRules(currentPosition).map(rule => data.items.find(item => item.stage === rule.stage) || rule)
      }
    } else if (currentTab === 'customers') {
      selected.value = []
      candidates.value = []
      const [rows, available] = await Promise.all([
        recontactApi.candidates({ ...filters, days: days.value ?? 3 }), recontactApi.templates(),
      ])
      if (id === requestId) {
        candidates.value = rows.data.items
        templates.value = available.data.items
      }
    } else {
      jobs.value = []
      const { data } = await recontactApi.jobs({
        ...filters, status: jobStatus.value || undefined, q: recordKeyword.value.trim() || undefined,
      })
      if (id === requestId) jobs.value = data.items
    }
  } catch (error) {
    if (id === requestId) loadError.value = errorMessage(error, '复聊数据读取失败')
  } finally {
    if (id === requestId) loading.value = false
  }
}

async function fetchOptions(restoreFilters = false) {
  optionsLoading.value = true
  optionsError.value = ''
  try {
    const { data } = await recontactApi.options()
    options.value = data
    if (restoreFilters) {
      const linkedPosition = Number(route.query.position_id)
      if (data.positions.some(item => item.id === linkedPosition)) positionId.value = linkedPosition
      const linkedDevice = route.query.device_code
      if (typeof linkedDevice === 'string' && data.devices.some(item => item.code === linkedDevice)) deviceCode.value = linkedDevice
      await nextTick()
    }
  } catch (error) {
    optionsError.value = errorMessage(error, '岗位和企微账号读取失败')
  } finally {
    optionsLoading.value = false
    await loadSection()
  }
}

function refresh() {
  return fetchOptions()
}

async function updateAccountRelease() {
  const account = selectedAccount.value
  const action = accountAction.value
  if (!account || !action || action.disabled || optionsLoading.value || accountSaving.value) return
  if (action.enabled) {
    try {
      await ElMessageBox.confirm(
        `启用「${account.name || account.code}」后，符合已启用规则的候选人可能收到自动复聊消息。`,
        action.label,
        { type: 'warning', confirmButtonText: '确认启用', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  accountSaving.value = true
  try {
    const { data } = await recontactApi.setAccountEnabled(account.code, action.enabled)
    options.value.devices = options.value.devices.map(device => device.code === account.code
      ? { ...device, recontact_enabled: data.enabled }
      : device)
    ElMessage.success(data.enabled ? '账号复聊已启用' : '账号复聊已暂停')
    await fetchOptions()
  } catch (error) {
    ElMessage.error(errorMessage(error, '账号复聊状态保存失败'))
  } finally {
    accountSaving.value = false
  }
}

function partsPayload(parts: RecontactPart[]) {
  return parts.map((part, index) => ({ ...part, value: part.value.trim(), delay_ms: index === 0 ? 0 : part.delay_ms }))
}

function editRule(rule: RecontactRule) {
  if (!options.value.can_edit_rules) return
  ruleDraft.value = { ...rule, parts: partsPayload(rule.parts) }
  startAt.value = asClock(rule.start_minute)
  endAt.value = asClock(rule.end_minute)
  formError.value = ''
  ruleDialog.value = true
}

async function saveRule() {
  if (!options.value.can_edit_rules || !ruleDraft.value || saving.value) return
  const draft = ruleDraft.value
  const parts = partsPayload(draft.parts)
  const start = toMinute(startAt.value)
  const end = toMinute(endAt.value)
  formError.value = ''
  if (!Number.isInteger(draft.wait_minutes) || draft.wait_minutes < 1 || draft.wait_minutes > 10080) {
    formError.value = '等待时间请填写 1–10080 分钟'
    return
  }
  if (parts.some(part => !part.value) || (draft.enabled && !parts.length)) {
    formError.value = '请填写每条消息的内容，启用时至少添加一条消息'
    return
  }
  if (!(start >= 540 && start < end && end <= 1260)) {
    formError.value = '请在 09:00–21:00 内选择开始和结束时间'
    return
  }
  saving.value = true
  try {
    const { data } = await recontactApi.saveRule({ ...draft, start_minute: start, end_minute: end, parts })
    rules.value = rules.value.map(rule => rule.stage === data.item.stage ? data.item : rule)
    ruleDialog.value = false
    ElMessage.success('复聊规则已保存')
  } catch (error) {
    formError.value = errorMessage(error, '规则保存失败')
  } finally {
    saving.value = false
  }
}

function editTemplate(template?: RecontactTemplate) {
  formError.value = ''
  templateDraft.value = template
    ? { ...template, parts: partsPayload(template.parts) }
    : { id: 0, position_id: positionId.value || 0, name: '', parts: [] }
}

function changeTemplatePosition(id: number) {
  const draft = templateDraft.value
  if (!draft) return
  draft.position_id = id
  draft.parts = draft.parts.map(part => part.kind === 'text' ? part : { ...part, value: '' })
}

async function saveTemplate() {
  if (!templateDraft.value || saving.value) return
  const template = templateDraft.value
  const parts = partsPayload(template.parts)
  formError.value = ''
  if (!template.position_id || !template.name.trim() || !parts.length || parts.some(part => !part.value)) {
    formError.value = '请选岗位并填写模板名称和消息内容'
    return
  }
  saving.value = true
  try {
    const { data } = await recontactApi.saveTemplate({ ...template, name: template.name.trim(), parts })
    templates.value = [...templates.value.filter(row => row.id !== data.item.id), data.item]
    templateChoices.value[data.item.position_id] ??= data.item.id
    templateDraft.value = null
    ElMessage.success('复聊模板已保存')
  } catch (error) {
    formError.value = errorMessage(error, '模板保存失败')
  } finally {
    saving.value = false
  }
}

function selectCustomers(rows: RecontactCandidate[]) {
  selected.value = rows
  for (const row of rows) {
    const forPosition = templates.value.filter(item => item.position_id === row.position_id)
    if (forPosition.length === 1) templateChoices.value[row.position_id] ??= forPosition[0]?.id
  }
}

async function previewBatch() {
  if (!selected.value.length || selected.value.length > 100 || !chosenCount.value || previewing.value) return
  previewing.value = true
  formError.value = ''
  try {
    const id = requestId
    const { data } = await recontactApi.preview(selected.value.map(row => row.id), chosenTemplates.value, days.value ?? 3)
    if (id !== requestId) return
    preview.value = data
    batchNames.value = Object.fromEntries(data.items.map(row => [row.id, row.nickname]))
    showPreview.value = true
  } catch (error) {
    ElMessage.error(errorMessage(error, '发送名单预览失败'))
  } finally {
    previewing.value = false
  }
}

async function sendBatch() {
  if (!preview.value || !previewReady.value || sending.value) return
  sending.value = true
  formError.value = ''
  try {
    const { data } = await recontactApi.send(preview.value.token)
    batchResult.value = data
    showPreview.value = false
    showBatchResult.value = true
    await loadSection()
  } catch (error) {
    formError.value = errorMessage(error, '复聊任务创建失败')
  } finally {
    sending.value = false
  }
}

async function finishReview(resolution: RecontactResolution) {
  if (!reviewJob.value || saving.value) return
  saving.value = true
  formError.value = ''
  try {
    await recontactApi.review(reviewJob.value.id, resolution)
    reviewJob.value = null
    await loadSection()
  } catch (error) {
    formError.value = errorMessage(error, '核对结果保存失败')
  } finally {
    saving.value = false
  }
}

watch(deviceCode, () => {
  if (positionId.value && !filterPositions.value.some(item => item.id === positionId.value)) positionId.value = undefined
}, { flush: 'sync' })
watch([tab, positionId, deviceCode], loadSection)
watch([templateDialog, reviewJob], () => { formError.value = '' })
onMounted(() => void fetchOptions(true))
</script>

<style scoped>
.recontact-page { min-width: 0; }
.recontact-panel { background: var(--bd-bg-card, #fff); border: 1px solid var(--el-border-color-lighter); border-radius: 10px; padding: 18px 20px; }
.context-row, .list-toolbar, .inline-control, .toolbar-actions, .rule-heading, .rule-facts,
.time-controls, .preview-title, .review-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.context-row { margin-block: 2px 10px; }
.context-row .el-select { width: 220px; }
.account-control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.account-reason { color: var(--bd-text-secondary, #59677e); font-size: 13px; }
.recontact-tabs :deep(.el-tabs__content) { overflow: visible; }
.rules { display: grid; gap: 12px; min-height: 36px; }
.rule-card { border: 1px solid var(--el-border-color-lighter); border-radius: 8px; padding: 14px 16px; }
.rule-heading h3 { margin: 0 8px 0 0; font-size: 16px; }
.rule-heading .el-button { margin-inline-start: auto; }
.rule-facts { margin-top: 10px; color: var(--bd-text-secondary, #59677e); font-size: 13px; }
.list-toolbar { margin: 0 0 12px; }
.toolbar-actions { margin-inline-start: auto; }
.list-toolbar :deep(.el-input-number) { width: 107px; }
.status-filter, .record-search { width: 185px; }
.template-choices { display: flex; flex-wrap: wrap; gap: 12px; margin-block: 12px; }
.template-choice { display: grid; gap: 5px; min-width: 210px; font-size: 13px; }
.rule-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; }
.time-controls { gap: 6px; }
.time-controls .el-select { width: 110px; }
.form-note, .recontact-panel :deep(.el-alert) { margin-block: 10px; }
.job-reason { color: var(--bd-text-secondary, #59677e); font-size: 13px; overflow-wrap: anywhere; }
.conversation-link { color: var(--el-color-primary); text-decoration: underline; }
.receipt-list, .preview-messages { margin: 0; padding: 10px 22px 10px 38px; }
.receipt-list li, .preview-messages li { margin-block: 6px; }
.receipt-list li > *, .preview-messages li > * { margin-inline-end: 10px; }
.receipt-content, .preview-messages li span { white-space: pre-wrap; overflow-wrap: anywhere; }
.preview-summary { font-weight: 600; }
.preview-customer { padding-block: 12px; border-bottom: 1px solid var(--el-border-color-lighter); }
.preview-title > span { color: var(--bd-text-secondary, #59677e); }
.review-actions { justify-content: flex-end; }
.review-actions :deep(.el-button + .el-button), .toolbar-actions :deep(.el-button + .el-button) { margin-left: 0; }
@media (max-width: 680px) {
  .recontact-panel { padding-inline: 12px; }
  .context-row .el-select { flex: 1 1 145px; }
  .toolbar-actions { margin-inline-start: 0; }
  .rule-form { grid-template-columns: 1fr; }
  .review-actions { justify-content: flex-start; }
}
</style>
