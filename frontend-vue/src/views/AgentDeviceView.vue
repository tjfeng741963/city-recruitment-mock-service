<template>
  <section data-device-settings-native>
    <div class="page-header">
      <div>
        <h2 class="page-title">微信账号</h2>
        <p class="page-desc">连接企业微信，选择接待岗位和 AI 工作流，设置报名通知群</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">连接新账号</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ receptionDevices.length }}</div>
        <div class="stat-label">接待账号</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ onlineCount }}</div>
        <div class="stat-label">客户端在线</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ receptionDevices.length - onlineCount }}</div>
        <div class="stat-label">客户端离线</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ testCount }}</div>
        <div class="stat-label">网页测试</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索账号备注 / 客户端标识 / 负责人"
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="providerFilter" class="status-select" placeholder="回复来源" clearable>
        <el-option label="系统 Agent" value="agent" />
        <el-option label="Dify 工作流" value="dify" />
      </el-select>
      <el-select v-model="kindFilter" class="status-select" placeholder="账号类型" clearable>
        <el-option label="接待账号" value="reception" />
        <el-option label="网页测试" value="test" />
      </el-select>
      <el-select v-model="onlineFilter" class="status-select" placeholder="状态筛选" clearable>
        <el-option label="全部状态" value="" />
        <el-option label="在线" value="online" />
        <el-option label="离线" value="offline" />
      </el-select>
    </div>

    <el-alert
      v-if="error"
      class="load-error"
      type="error"
      :title="error"
      show-icon
      :closable="false"
    />

    <div class="table-wrapper">
      <el-table v-loading="loading" :data="pagedDevices" row-key="id">
        <el-table-column label="账号与接待岗位" min-width="210">
          <template #default="{ row }">
            <div class="device-name">{{ row.name || row.device_name || row.device_code }}</div>
            <el-tag v-if="isWebTestDevice(row)" size="small" type="info">网页测试 · 未连接企微</el-tag>
            <div v-if="row.reply_provider === 'dify' && row.factories?.length" class="factory-tags">
              <el-tag v-for="factory in row.factories" :key="factory.id" size="small" effect="plain">
                {{ factory.name }}
              </el-tag>
            </div>
            <span v-if="!row.position_id" class="muted factory-empty">尚未选择接待岗位</span>
            <div v-if="row.position_id" class="position-label">
              {{ row.reply_provider === 'dify' ? '默认岗位' : '接待岗位' }}：{{ positionName(row.position_id) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="客户端标识" min-width="150">
          <template #default="{ row }">
            <div class="device-code">{{ row.device_code || '-' }}</div>
            <span v-if="isWebTestDevice(row)" class="muted">仅网页测试</span>
            <el-button v-else-if="!isOnline(row)" link type="primary" size="small" @click="openQr(row)">
              扫码登录
            </el-button>
            <el-button v-else link type="success" size="small" class="online-mark" @click="openQr(row)" title="查看企微登录状态">客户端已连接</el-button>
          </template>
        </el-table-column>

        <el-table-column label="回复来源" width="216">
          <template #default="{ row }">
            <ReplyModeSwitch v-if="canSwitchMode && row.device_code && !isWebTestDevice(row)"
              :key="row.device_code" :device-code="row.device_code" :current-provider="row.reply_provider"
              @confirmed="load(true)" />
            <el-tag v-else :type="row.reply_provider === 'dify' ? 'warning' : 'info'" effect="light">
              {{ row.reply_provider === 'dify' ? 'Dify 工作流' : row.reply_provider === 'agent' ? '系统 Agent' : '待确认' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="负责人" min-width="130">
          <template #default="{ row }">
            <span>{{ row.recruiter_id || '未分配' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="客户端连接" min-width="164">
          <template #default="{ row }">
            <template v-if="row.windows_runtime && !isWebTestDevice(row)">
              <div class="queue-note">{{ row.windows_runtime.connected ? 'Win 已连接' : 'Win 心跳超时' }} · {{ row.windows_runtime.wecom_available ? '企微可用' : '企微不可用' }}</div>
              <el-tag :type="row.windows_runtime.reply_ready ? 'success' : 'warning'" effect="light">
                {{ row.windows_runtime.reply_ready ? '自动回复就绪' : (runtimeReasons[row.windows_runtime.reason] || '自动回复暂停') }}
              </el-tag>
              <div v-if="row.windows_runtime.sync === 'catching_up'" class="queue-note">正在补同步 · 积压 {{ row.windows_runtime.backlog }}</div>
              <div v-else-if="row.windows_runtime.sync === 'error'" class="queue-note">同步异常，等待重试</div>
            </template>
            <el-tag v-else :type="isWebTestDevice(row) ? 'info' : isOnline(row) ? 'success' : 'danger'" effect="light">
              {{ isWebTestDevice(row) ? '无需连接' : isOnline(row) ? '回复在线' : row.bridge_state === 'scanning' ? '等待扫码' : '离线' }}
            </el-tag>
            <div v-if="row.queue_depth" class="queue-note">队列 {{ row.queue_depth }}</div>
          </template>
        </el-table-column>

        <el-table-column label="最近心跳" width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.last_heartbeat_at ? formatDateTime(row.last_heartbeat_at) : row.last_online ? formatDateTime(row.last_online) : '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">接待设置</el-button>
            <el-tooltip :content="deviceWorkflowEntry(row).reason || (row.reply_provider === 'dify' ? '进入该账号的 Dify 配置与测试' : '编辑该岗位的话术流程')">
              <span><el-button link type="primary" :disabled="!deviceWorkflowEntry(row).href" @click="openWorkflow(row)">工作流配置</el-button></span>
            </el-tooltip>
            <el-dropdown trigger="click" @command="(cmd: string) => handleCommand(cmd, row)">
              <el-button link type="primary">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="groups">查看群组</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除账号配置</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="暂无符合条件的账号" />
        </template>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50]"
          :total="filteredDevices.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </div>

    <el-alert v-if="receptionError" type="error" :closable="false" show-icon class="load-error">
      <template #title>{{ receptionError }}</template>
      <el-button v-if="receptionCityId" link type="primary" @click="returnToReception()">返回城市设置</el-button>
    </el-alert>

    <!-- 新增 / 编辑 -->
    <el-dialog
      v-model="formVisible"
      :title="editingId ? '接待设置' : '连接新账号'"
      width="640px"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @closed="closeDeviceForm"
    >
      <el-alert v-if="receptionPosition" title="第 3 步 · 确认接待设置" type="info" :closable="false" class="load-error">
        <div>将「{{ positionLabel(receptionPosition) }}」绑定为此账号的接待岗位。保存后返回城市查看绑定状态。</div>
        <div v-if="receptionPreviousPositionId && receptionPreviousPositionId !== receptionPosition.id">
          原绑定为「{{ positionName(receptionPreviousPositionId) }}」，保存后将替换为所选岗位。
        </div>
      </el-alert>
      <el-alert v-else title="先选择接待岗位，再配置对应工作流。客户端连接状态和消息收发可在各自页面核对。" type="info" :closable="false" class="load-error" />
      <el-form label-width="110px">
        <el-form-item label="客户端标识" required>
          <div class="code-row">
            <el-input
              v-model="form.device_code"
              placeholder="如：AG-001"
              :disabled="Boolean(editingId)"
            />
            <el-button
              v-if="!editingId"
              class="code-gen"
              @click="form.device_code = generateDeviceCode()"
            >
              自动生成
            </el-button>
          </div>
        </el-form-item>
        <el-form-item label="账号备注">
          <el-input v-model="form.name" placeholder="如：广州安检招聘号" />
        </el-form-item>
        <el-form-item label="负责人">
          <el-input v-model="form.recruiter_id" placeholder="填写已有招聘人员的账号，留空为未分配" />
        </el-form-item>
        <el-form-item v-if="form.provider === 'dify'" label="接待工厂（可多选）">
          <el-select
            v-model="form.factory_ids"
            multiple
            filterable
            clearable
            collapse-tags
            placeholder="不选=不绑定工厂"
            style="width: 100%"
          >
            <el-option
              v-for="factory in factoryOptions"
              :key="factory.id"
              :label="`${factory.factory_name}${factory.city_name ? `（${factory.city_name}）` : ''}`"
              :value="factory.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item :label="form.provider === 'dify' ? '默认岗位' : '接待岗位'">
          <el-select
            v-model="form.position_id"
            filterable
            clearable
            :disabled="Boolean(receptionPosition)"
            placeholder="请选择设备实际使用的岗位"
            style="width: 100%"
          >
            <el-option
              v-for="position in receptionPosition ? [receptionPosition] : positionOptionsForForm"
              :key="position.id"
              :label="positionLabel(position)"
              :value="position.id"
            />
          </el-select>
          <div v-if="receptionFactoryConflict" class="form-hint" role="alert">
            此岗位所属工厂不在当前绑定范围内。请在上方加入该工厂，或返回上一步换一个账号。
          </div>
          <div v-else-if="!receptionPosition" class="form-hint">
            {{ form.provider === 'dify' ? 'Dify 可按所选工厂推荐多个岗位。默认岗位用于开始接待。' : '系统 Agent 使用这里选择的一个岗位。' }}
          </div>
        </el-form-item>
        <el-form-item label="报名通知群">
          <el-input
            v-model="form.group_chat"
            placeholder="面试登记通知群（可选，设备上报群名）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="formVisible = false">{{ receptionPosition ? '返回上一步' : '取消' }}</el-button>
        <el-button type="primary" :loading="saving" :disabled="receptionFactoryConflict" @click="saveDevice">
          {{ receptionPosition ? '保存并返回城市' : '保存' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 扫码登录 -->
    <el-dialog
      v-model="qrVisible"
      :title="`扫码登录 · ${qrDevice?.name || qrDevice?.device_code || ''}`"
      width="480px"
      @closed="closeQr"
    >
      <div class="qr-body">
        <div class="qr-status" role="status" aria-live="polite">
          <el-alert :title="qrFeedback.title" :description="qrFeedback.detail"
            :type="qrFeedback.type" show-icon :closable="false" />
        </div>
        <template v-if="showQrImage">
          <img class="qr-image" :src="qrResult?.image" alt="企微登录窗口截图" />
          <p v-if="qrResult?.captured_at" class="dialog-hint">截图更新于 {{ qrAgeText }}</p>
        </template>
        <!-- 过期时整块可点：用户第一反应就是去点那张过期的图 -->
        <div
          v-if="qrFeedback.key === 'expired'"
          class="qr-expired-hit"
          role="button"
          tabindex="0"
          @click="requestQrRefresh"
          @keydown.enter="requestQrRefresh"
        >
          <span>二维码已过期 · 点这里让客户端换一张</span>
        </div>
        <p
          v-if="qrLastRefresh"
          class="qr-refresh-note"
          :class="`is-${qrLastRefresh.tone}`"
        >{{ qrLastRefresh.text }}</p>
        <div v-if="qrFeedback.key !== 'disabled'" class="qr-refresh-row">
          <el-button
            :loading="qrRefreshing"
            :disabled="qrRefreshing"
            @click="requestQrRefresh"
            size="small"
          >刷新二维码</el-button>
          <span class="qr-refresh-hint">{{ qrRefreshHint }}</span>
        </div>
        <div v-if="canSubmitVerifyCode" class="verify-row">
          <el-input
            v-model="verifyCode"
            placeholder="企微验证码（通常为六位）"
            maxlength="8"
            inputmode="numeric"
            autocomplete="off"
            :disabled="verificationInProgress"
            style="flex: 1"
            @keydown.enter.prevent="submitVerifyCode"
          />
          <el-button type="primary" :loading="verifySubmitting" :disabled="verificationInProgress" @click="submitVerifyCode">
            提交验证码
          </el-button>
        </div>
        <p v-if="canSubmitVerifyCode && !verificationInProgress" class="dialog-hint">
          Win 弹出验证码窗口时，输入手机企业微信显示的验证码。若企微要求短信验证，请输入短信中的验证码。
        </p>
        <p v-if="qrFeedback.key !== 'disabled'" class="dialog-hint">
          如果 Win 弹出带倒计时的「设备环境异常」安全验证，请在 Windows 上打开企微验证窗口，
          用手机企业微信扫窗口内的码，并按屏幕提示完成。超时退出后，请在 Win 重新登录，再完成验证。
        </p>
      </div>
      <template #footer>
      </template>
    </el-dialog>

    <!-- 群组抽屉 -->
    <el-drawer v-model="groupsVisible" :title="`设备群组 · ${groupDevice?.device_code || ''}`" size="420px">
      <div v-loading="groupLoading" class="drawer-body">
        <el-alert
          v-if="groupError"
          type="error"
          :title="groupError"
          show-icon
          :closable="false"
          class="load-error"
        />
        <div v-if="groups.length" class="group-list">
          <div v-for="(group, index) in groups" :key="group.id ?? group.chat_id ?? index" class="group-item">
            <span class="group-name">{{ group.name || group.chat_id || `群聊 ${index + 1}` }}</span>
            <span v-if="group.member_count" class="muted">{{ group.member_count }} 人</span>
          </div>
        </div>
        <el-empty v-else-if="!groupLoading" description="暂未上报群聊" />
      </div>
    </el-drawer>

  </section>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import ReplyModeSwitch from '../components/agent/ReplyModeSwitch.vue'
import { deviceWorkflowEntry, isWebTestDevice, deviceOnline } from '../components/agent/device-workflow-entry'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { devicesApi, type AgentDeviceItem, type DeviceGroup, type LoginQrResult } from '../api/agent'
import { positionsApi } from '../api/core'
import type { Factory, ServicePosition } from '../api/types'
import { formatDateTime } from '../utils/format'
import {
  cityReceptionAccounts, cityReceptionPositions, cityReceptionReturnLink, positionMatchesFactories,
  readCityReceptionContext, readCityReceptionId,
} from '../components/basic/city-reception'

const auth = useAuthStore()
const canSwitchMode = computed(() => auth.user?.role === 'admin')
const runtimeReasons: Record<string, string> = {
  heartbeat_timeout: '自动回复离线', loop_stalled: '回复进程无进展', wechat_login: '等待企微扫码',
  wechat_unavailable: '等待企微就绪', desktop_unavailable: '等待交互桌面', authorization: '设备鉴权失败',
  starting: '等待客户端初始化', reply_paused: '自动回复暂停', auto_send_failed: '自动回复失败，待核对',
}
const devices = ref<AgentDeviceItem[]>([])
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const router = useRouter()
const route = useRoute()
const receptionContext = readCityReceptionContext(route.query)
const receptionCityId = readCityReceptionId(route.query.reception_city)
const receptionPosition = ref<ServicePosition | null>(null)
const receptionPreviousPositionId = ref<number | null>(null)
const receptionError = ref('')
const providerFilter = ref('')
const kindFilter = ref('')
const onlineFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const factoryOptions = ref<Factory[]>([])
const positionOptions = ref<ServicePosition[]>([])

const receptionDevices = computed(() => devices.value.filter(device => !isWebTestDevice(device)))
const testCount = computed(() => devices.value.filter(isWebTestDevice).length)
const onlineCount = computed(() => receptionDevices.value.filter(isOnline).length)

const filteredDevices = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return devices.value.filter((device) => {
    if (providerFilter.value && device.reply_provider !== providerFilter.value) return false
    if (kindFilter.value === 'test' && !isWebTestDevice(device)) return false
    if (kindFilter.value === 'reception' && isWebTestDevice(device)) return false
    if (onlineFilter.value && isWebTestDevice(device)) return false
    if (onlineFilter.value === 'online' && !isOnline(device)) return false
    if (onlineFilter.value === 'offline' && isOnline(device)) return false
    if (!key) return true
    return [device.name, device.device_name, device.device_code, device.recruiter_id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(key))
  })
})

const pagedDevices = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filteredDevices.value.slice(start, start + pageSize.value)
})


// 筛选变化时回到第 1 页，避免停在空页
watch([keyword, providerFilter, kindFilter, onlineFilter], () => {
  page.value = 1
})

function isOnline(device: AgentDeviceItem): boolean {
  return deviceOnline(device)
}

let devicePoll: ReturnType<typeof setInterval> | undefined
let latestDeviceRequest = 0

async function load(silent = false): Promise<void> {
  const request = ++latestDeviceRequest
  if (!silent) {
    loading.value = true
    error.value = ''
  }
  try {
    const { data } = await devicesApi.list({ page: 1, page_size: 1000 })
    if (request !== latestDeviceRequest) return
    const next = data.items || []
    const previouslyReady = new Set(devices.value.filter(device => device.windows_runtime?.reply_ready).map(device => device.device_code))
    for (const device of next) {
      if (previouslyReady.has(device.device_code) && device.windows_runtime && !device.windows_runtime.reply_ready) {
        ElMessage.warning((device.name || device.device_code) + '：' + (runtimeReasons[device.windows_runtime.reason] || '自动回复暂停'))
      }
    }
    devices.value = next
    if ((page.value - 1) * pageSize.value >= devices.value.length) page.value = 1
  } catch (err: any) {
    if (!silent) error.value = err?.response?.data?.detail || '设备列表加载失败'
  } finally {
    loading.value = false
  }
}

async function loadFactories(): Promise<void> {
  try {
    const { data } = await devicesApi.factoryOptions()
    factoryOptions.value = data.items || []
  } catch {
    factoryOptions.value = []
  }
}

async function loadPositions(): Promise<void> {
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 1000 })
    positionOptions.value = (data.items || []).filter((position) => position.is_active !== false)
  } catch {
    positionOptions.value = []
  }
}

const positionOptionsForForm = computed(() => {
  return form.provider === 'dify'
    ? positionOptions.value.filter(position => positionMatchesFactories(position, form.factory_ids))
    : positionOptions.value
})

function positionLabel(position: ServicePosition): string {
  const factory = factoryOptions.value.find((item) => Number(item.id) === Number(position.factory_id))
  return `${position.position_name || `岗位 ${position.id}`}${factory ? ` · ${factory.factory_name}` : ''}${position.city_name ? `（${position.city_name}）` : ''}`
}

function positionName(positionId: number | null | undefined): string {
  if (!positionId) return ''
  const position = positionOptions.value.find((item) => Number(item.id) === Number(positionId))
  return position ? positionLabel(position) : `岗位 ${positionId}`
}

/* ---------- 新增 / 编辑 ---------- */
interface DeviceForm {
  provider: 'agent' | 'dify'
  device_code: string
  name: string
  recruiter_id: string
  factory_ids: number[]
  position_id: number | null
  group_chat: string
}

const formVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)
// 打开「接待设置」时记下当时的岗位，保存时用来判断是否真的换了岗位
const originalPositionId = ref<number | null>(null)

/** 与 theme/device-code.js 同规则：AG- 前缀 + 6 位大写字母数字（crypto 随机） */
function generateDeviceCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  // 与 theme/device-code.js 同字母表：去掉容易看错的 0/O/1/I/L
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return `AG-${out}`
}
const form = reactive<DeviceForm>(emptyForm())
const receptionFactoryConflict = computed(() => Boolean(
  form.provider === 'dify' && receptionPosition.value && !positionMatchesFactories(receptionPosition.value, form.factory_ids),
))

function emptyForm(): DeviceForm {
  return {
    provider: 'agent',
    device_code: '',
    name: '',
    recruiter_id: '',
    factory_ids: [],
    position_id: null,
    group_chat: '',
  }
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  editingId.value = null
  originalPositionId.value = null
}

function returnToReception(resume = true): void {
  if (!receptionCityId) return
  void router.replace(cityReceptionReturnLink(receptionCityId, resume ? receptionContext?.positionId : undefined))
}

function closeDeviceForm(): void {
  if (receptionPosition.value) returnToReception()
  else resetForm()
}

function openCreate(): void {
  resetForm()
  formVisible.value = true
}

function openEdit(row: AgentDeviceItem): void {
  editingId.value = row.id
  originalPositionId.value = row.position_id ? Number(row.position_id) : null
  Object.assign(form, {
    provider: row.reply_provider === 'dify' ? 'dify' : 'agent',
    device_code: row.device_code || '',
    name: row.name || row.device_name || '',
    recruiter_id: row.recruiter_id || '',
    factory_ids: [...(row.factory_ids || [])],
    position_id: row.position_id ? Number(row.position_id) : null,
    group_chat: row.group_chat || '',
  })
  formVisible.value = true
}

async function openCityReception(): Promise<void> {
  if (!receptionContext) {
    if (route.query.reception_city !== undefined) receptionError.value = '接待设置链接缺少城市、岗位或账号，请从城市重新进入。'
    return
  }
  const { cityId, positionId, accountId } = receptionContext
  if (error.value) {
    receptionError.value = '账号加载失败，请返回城市后重试。'
    return
  }
  try {
    const { data } = await positionsApi.get(positionId)
    if (formVisible.value) return
    if (!cityReceptionPositions([data], cityId).length) {
      receptionError.value = '所选岗位已停用或不在这个城市，请返回城市重新选择。'
      return
    }
    if (accountId === 'new') {
      if (!canSwitchMode.value) {
        receptionError.value = '请联系管理员连接新的接待账号。'
        return
      }
      openCreate()
      form.device_code = generateDeviceCode()
    } else {
      const account = cityReceptionAccounts(devices.value).find(device => device.id === accountId)
      if (!account) {
        receptionError.value = '所选账号已不可用，请返回城市重新选择。'
        return
      }
      receptionPreviousPositionId.value = account.position_id ? Number(account.position_id) : null
      openEdit(account)
    }
    receptionPosition.value = data
    form.position_id = data.id
  } catch {
    receptionError.value = '无法读取所选岗位，请返回城市重新选择。'
  }
}

async function saveDevice(): Promise<void> {
  if (saving.value || receptionFactoryConflict.value) return
  if (!form.device_code.trim()) {
    ElMessage.warning('请输入客户端标识')
    return
  }
  // 换岗位等于换业务：历史对话不再沿用旧岗位的话术，所以要先说清楚再动手
  const nextPositionId = form.position_id ? Number(form.position_id) : null
  const positionChanged = editingId.value !== null
    && nextPositionId !== null
    && nextPositionId !== originalPositionId.value
  if (positionChanged) {
    try {
      await ElMessageBox.confirm(
        `切换接待岗位后，该账号所有会话会标记为已读，之后只按「${positionName(nextPositionId)}」的岗位信息回复。` +
        '企微里的历史聊天不会删除，也不影响客户看到的记录。',
        '切换接待岗位',
        { type: 'warning', confirmButtonText: '切换并标记已读', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  saving.value = true
  const payload: Record<string, unknown> = {
    device_code: form.device_code.trim(),
    device_name: form.name.trim() || form.device_code.trim(),
    name: form.name.trim() || form.device_code.trim(),
    recruiter_id: form.recruiter_id.trim(),
    ...(form.provider === 'dify' ? { factory_ids: form.factory_ids } : {}),
    ...(editingId.value ? { expected_reply_provider: form.provider } : {}),
    position_id: form.position_id,
    group_chat: form.group_chat.trim(),
  }
  try {
    if (editingId.value) {
      await devicesApi.update(editingId.value, payload)
      if (positionChanged) {
        // 岗位已换：把所有会话的未读清零，作为「新的开始」
        const cleared = await devicesApi.clearUnread(editingId.value).then(() => true).catch(() => false)
        ElMessage.success(
          cleared
            ? '接待岗位已切换，全部会话已标记已读，之后按新岗位信息回复。'
            : '接待岗位已切换，但标记已读失败，请到对话管理手动清一次未读。',
        )
      } else {
        ElMessage.success('接待设置已保存。实际收发请在对话管理核对。')
      }
    } else {
      await devicesApi.create(payload)
      ElMessage.success('账号配置已创建，还需连接云电脑客户端并登录企业微信')
    }
    if (receptionPosition.value) {
      returnToReception(false)
      return
    }
    formVisible.value = false
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

/* ---------- 删除 ---------- */
async function removeDevice(row: AgentDeviceItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除账号配置「${row.name || row.device_code}」？这会删除后台接待配置，不会退出企业微信，也不会关闭云电脑。`,
      '删除账号配置',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await devicesApi.remove(row.id)
    ElMessage.success('已删除')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '删除失败')
  }
}

/* ---------- 账号操作 ---------- */
function handleCommand(command: string, row: AgentDeviceItem): void {
  if (command === 'groups') void openGroups(row)
  if (command === 'delete') void removeDevice(row)
}

function openWorkflow(row: AgentDeviceItem): void {
  const entry = deviceWorkflowEntry(row)
  if (!entry.href) { ElMessage.warning(entry.reason); return }
  void router.push(entry.href)
}

/* ---------- 扫码登录 ---------- */
const qrVisible = ref(false)
const qrLoading = ref(false)
const qrResult = ref<LoginQrResult | null>(null)
const qrError = ref('')
const qrDevice = ref<AgentDeviceItem | null>(null)
const verifyCode = ref('')
const verifySubmitting = ref(false)
const verificationInProgress = computed(() =>
  qrResult.value?.verification_status === 'pending' || qrResult.value?.verification_status === 'received')
const loginWasConfirmed = ref(false)
let qrRequest: AbortController | undefined
let qrTimer: ReturnType<typeof setInterval> | null = null

const qrFeedback = computed(() => {
  const feedback = (key: string, title: string, detail: string, type: 'success' | 'warning' | 'info' | 'error' = 'info') =>
    ({ key, title, detail, type })
  if (qrError.value) return feedback('error', '登录状态读取失败', qrError.value, 'error')
  if (!qrResult.value) return feedback('loading', '正在确认登录状态', '等待 Windows 客户端上报。')
  switch (qrResult.value.login_status) {
    case 'logged_in':
      return feedback('success', '企微登录成功', 'Windows 客户端已确认登录。自动回复状态可在微信账号列表查看。', 'success')
    case 'authorization_failed':
      return feedback('failed', '设备鉴权失败', '请在 Windows 检查设备配对，再刷新状态。', 'error')
    case 'device_disabled':
      return feedback('disabled', '登录失败 · 设备已停用', '启用该设备后可以重新扫码。', 'error')
    case 'disconnected':
      return feedback('disconnected', loginWasConfirmed.value ? '登录连接已中断' : '登录暂未确认',
        '未收到新的 Windows 心跳。请查看 Win 上的企微窗口。', 'warning')
  }
  switch (qrResult.value.verification_status) {
    case 'pending':
      return feedback('verification', '验证码已提交，等待 Windows 取码', '请保留 Win 上的企微验证码窗口。')
    case 'received':
      return feedback('verification', '验证码已下发到 Windows', '正在等待企微确认登录。')
    case 'expired':
      return feedback('verification', 'Windows 取码超时', '请确认 Win 仍显示验证码窗口，再提交当前的验证码。', 'warning')
    case 'unconfirmed':
      return feedback('verification', '企微尚未确认登录', '请在 Win 查看验证结果。若企微要求重试，请提交当前窗口对应的新验证码。', 'warning')
  }
  if (qrResult.value.login_status === 'qr_expired') {
    return feedback('expired', '登录截图已过期', '等待 Windows 客户端上传新的截图。', 'warning')
  }
  if (qrResult.value.available && qrResult.value.image) {
    return feedback('scan', '等待完成企微登录', '如果截图显示二维码，请扫码。如果提示在手机上确认，请打开手机企业微信继续。')
  }
  return feedback('waiting', loginWasConfirmed.value ? '企微需要重新确认登录' : '等待 Windows 上传登录截图',
    '请确认 Win 上已打开企微登录窗口。', loginWasConfirmed.value ? 'warning' : 'info')
})

const showQrImage = computed(() => ['scan', 'verification'].includes(qrFeedback.value.key) && !!qrResult.value?.image)
const canSubmitVerifyCode = computed(() => ['scan', 'waiting', 'expired', 'verification'].includes(qrFeedback.value.key))

// ── 刷新二维码：驱动客户端重拍，而不是重读缓存 ─────────────────────
// 以前按钮只重发 GET，客户端 30 秒才推一次，点了像没反应。现在改为调
// refreshLoginQr：服务端写一条 refresh_login_qr 指令，客户端点登录窗的
// 「刷新」再立即上传新帧，网页下一次轮询就能看到。
const qrRefreshing = ref(false)
const qrRefreshAt = ref(0)
const clockTick = ref(0)
let qrClock: ReturnType<typeof setInterval> | null = null

const qrAgeText = computed(() => {
  void clockTick.value
  const at = qrResult.value?.captured_at ? Date.parse(qrResult.value.captured_at) : 0
  if (!at || Number.isNaN(at)) return '时间未知'
  return formatAgo(Math.max(0, Math.round((Date.now() - at) / 1000)))
})

function formatAgo(sec: number): string {
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分 ${sec % 60} 秒前`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分前`
}

// 上一轮刷新指令的结果：失败原因必须让运营看见（「没找到登录窗」这类
// 问题以前只写客户端日志，网页只能靠「图没变」猜）。
const qrLastRefresh = computed<{ tone: 'error' | 'ok' | 'info'; text: string } | null>(() => {
  void clockTick.value
  const row = qrResult.value?.last_refresh
  if (!row) return null
  const at = row.at ? Date.parse(row.at) : 0
  const sec = at && !Number.isNaN(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : 0
  const when = at && !Number.isNaN(at) ? `（${formatAgo(sec)}）` : ''
  if (row.status === 'failed') {
    return { tone: 'error', text: `上次刷新失败${when}：${row.error || '客户端未说明原因'}` }
  }
  if (row.status === 'succeeded') {
    // 成功提示只留 2 分钟，之后不再占位置
    if (at && sec > 120) return null
    const note = (row.error || '').trim()
    // 客户端说明「码还有效、企微没有刷新可点」时用浅色提示，
    // 不把它当成"换了一张新码"，免得用户再问"怎么还是同一张"。
    if (note.includes('无需点击')) return { tone: 'info', text: `二维码当前有效，无需刷新${when}` }
    return { tone: 'ok', text: note ? `上次刷新成功${when}：${note}` : `上次刷新成功${when}` }
  }
  // queued / claimed
  if (at && sec > 300) return null
  return { tone: 'info', text: `刷新指令已下发${when}，客户端正在处理…` }
})

const qrRefreshHint = computed(() => {
  void clockTick.value
  if (qrRefreshing.value) return '正在通知客户端刷新…'
  if (qrRefreshAt.value) {
    const sec = Math.round((Date.now() - qrRefreshAt.value) / 1000)
    if (sec < 60) return `${sec} 秒前已请求，客户端每 10 秒领一次指令`
  }
  return '客户端每 30 秒自动上传一次'
})

async function requestQrRefresh(): Promise<void> {
  const code = qrDevice.value?.device_code
  if (!code || qrRefreshing.value) return
  qrRefreshing.value = true
  try {
    const { data } = await devicesApi.refreshLoginQr(code)
    qrRefreshAt.value = Date.now()
    if (data.deduped) {
      ElMessage.info('刚刚已经请求过，客户端正在刷新，请等 3-5 秒')
    } else {
      ElMessage.success('已通知客户端刷新二维码，正在获取新码…')
    }
    // 指令落地有延迟：3 秒后主动拉一次，比干等轮询更早看到新码
    setTimeout(() => { void fetchQr() }, 3000)
  } catch (err: any) {
    ElMessage.warning(err?.response?.data?.detail || '请求刷新失败，请稍后重试')
  } finally {
    qrRefreshing.value = false
  }
}

function startQrClock(): void {
  stopQrClock()
  qrClock = setInterval(() => { clockTick.value += 1 }, 1000)
}
function stopQrClock(): void {
  if (qrClock) {
    clearInterval(qrClock)
    qrClock = null
  }
}

function openQr(row: AgentDeviceItem): void {
  closeQrTimer()
  qrDevice.value = row
  qrRefreshAt.value = 0
  startQrClock()
  qrResult.value = null
  qrError.value = ''
  verifyCode.value = ''
  loginWasConfirmed.value = false
  qrVisible.value = true
  void fetchQr()
  qrTimer = setInterval(() => void fetchQr(true), 3000)
}

async function fetchQr(silent = false): Promise<void> {
  const code = qrDevice.value?.device_code
  if (!code || !qrVisible.value || qrRequest) return
  const request = new AbortController()
  qrRequest = request
  if (!silent) qrLoading.value = true
  try {
    const { data } = await devicesApi.loginQr(code, request.signal)
    if (request.signal.aborted || !qrVisible.value || qrDevice.value?.device_code !== code) return
    qrError.value = ''
    qrResult.value = data
    if (data.login_status === 'logged_in') {
      verifyCode.value = ''
      if (!loginWasConfirmed.value) void load(true)
      loginWasConfirmed.value = true
    }
  } catch (err: any) {
    if (!request.signal.aborted) {
      qrError.value = err?.response?.data?.detail || '暂时无法确认，请稍后重试。'
    }
  } finally {
    if (qrRequest === request) {
      qrRequest = undefined
      qrLoading.value = false
    }
  }
}

// 点 X / Esc 关闭弹窗时也要停轮询，否则定时器会一直空转
watch(qrVisible, (visible) => {
  if (!visible) closeQrTimer()
})

onUnmounted(() => {
  closeQrTimer()
})

function closeQrTimer(): void {
  qrRequest?.abort()
  qrRequest = undefined
  qrLoading.value = false
  qrRefreshing.value = false
  stopQrClock()
  if (qrTimer) {
    clearInterval(qrTimer)
    qrTimer = null
  }
}

function closeQr(): void {
  closeQrTimer()
  qrDevice.value = null
  qrResult.value = null
}

async function submitVerifyCode(): Promise<void> {
  const code = qrDevice.value?.device_code
  const value = verifyCode.value.trim()
  if (!code || !canSubmitVerifyCode.value || verifySubmitting.value || verificationInProgress.value) return
  if (!/^\d{4,8}$/.test(value)) {
    ElMessage.warning('验证码必须是 4-8 位数字')
    return
  }
  verifySubmitting.value = true
  try {
    const { data } = await devicesApi.verifyCodePost(code, { code: value })
    if (qrVisible.value && qrDevice.value?.device_code === code && qrResult.value?.login_status !== 'logged_in' && qrResult.value) {
      qrRequest?.abort()
      qrRequest = undefined
      qrResult.value = { ...qrResult.value, verification_status: data.verification_status }
      verifyCode.value = ''
      void fetchQr()
    }
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '验证码提交失败')
  } finally {
    verifySubmitting.value = false
  }
}

/* ---------- 群组 ---------- */
const groupsVisible = ref(false)
const groupLoading = ref(false)
const groupError = ref('')
const groups = ref<DeviceGroup[]>([])
const groupDevice = ref<AgentDeviceItem | null>(null)

async function openGroups(row: AgentDeviceItem): Promise<void> {
  groupDevice.value = row
  groups.value = []
  groupError.value = ''
  groupsVisible.value = true
  groupLoading.value = true
  try {
    const { data } = await devicesApi.groups(row.device_code)
    groups.value = data.items || []
  } catch (err: any) {
    groupError.value = err?.response?.data?.detail || '群组加载失败'
  } finally {
    groupLoading.value = false
  }
}

onMounted(() => {
  const initialLoad = Promise.all([load(), loadFactories(), loadPositions()])
  if (route.query.reception_city !== undefined) void initialLoad.then(openCityReception)
  devicePoll = setInterval(() => { if (!loading.value) void load(true) }, 15000)
})
onUnmounted(() => { clearInterval(devicePoll); latestDeviceRequest += 1 })
</script>

<style scoped>
.online-mark {
  font-size: 12px;
  color: var(--el-color-success, #12a150);
}

.online-mark {
  font-size: 12px;
  color: var(--el-color-success, #12a150);
}

.code-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.code-gen {
  flex: 0 0 auto;
}

.device-name {
  font-weight: 600;
  color: var(--bd-text-primary);
}

.factory-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}

.factory-tags :deep(.el-tag) {
  font-size: 11px;
}

.factory-empty {
  display: inline-block;
  margin-top: 3px;
  font-size: 11px;
}

.position-label {
  margin-top: 4px;
  color: var(--bd-text-secondary);
  font-size: 11px;
}

.device-code {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  color: var(--bd-text-primary);
}

.queue-note {
  margin-top: 2px;
  font-size: 11px;
  color: var(--bd-warning);
}

.load-error {
  margin-bottom: 12px;
}

.search-input {
  width: 280px;
}

.status-select {
  width: 140px;
}

.form-hint,
.dialog-hint {
  color: var(--bd-text-tertiary);
  font-size: 12px;
  line-height: 1.6;
}

.dialog-hint {
  margin: 4px 0 0;
}

.qr-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.qr-image {
  width: 220px;
  height: 220px;
  object-fit: contain;
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  background: #fff;
}

/* 过期时整块可点：不需要用户去找按钮 */
.qr-expired-hit {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 8px 0;
  padding: 10px 14px;
  border: 1px dashed var(--el-color-warning);
  border-radius: 8px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.qr-expired-hit:hover {
  background: var(--el-color-warning-light-8);
  border-color: var(--el-color-warning-dark-2);
}

.qr-refresh-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.qr-refresh-hint {
  font-size: 12px;
  color: var(--bd-text-secondary, #909399);
}

.qr-refresh-note {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
}

.qr-refresh-note.is-error {
  color: var(--el-color-danger);
  font-weight: 500;
}

.qr-refresh-note.is-ok {
  color: var(--el-color-success);
}

.qr-refresh-note.is-info {
  color: var(--bd-text-secondary, #909399);
}



.verify-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.drawer-body {
  min-height: 200px;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  background: #fff;
}

.group-name {
  font-size: 13px;
  color: var(--bd-text-primary);
}

.workflow-editor :deep(textarea) {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
}
</style>
