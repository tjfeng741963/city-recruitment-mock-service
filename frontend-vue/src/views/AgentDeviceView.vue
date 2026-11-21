<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">微信账号</h2>
        <p class="page-desc">管理 AI 坐席设备，每个设备对应一个微信账号</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增设备</el-button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-value">{{ devices.length }}</div>
        <div class="stat-label">总设备</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ onlineCount }}</div>
        <div class="stat-label">启用中</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ inviteCount }}</div>
        <div class="stat-label">邀约版</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ followupCount }}</div>
        <div class="stat-label">跟进版</div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="keyword"
        class="search-input"
        placeholder="搜索设备名称 / 设备码 / 账号..."
        clearable
        :prefix-icon="Search"
      />
      <el-select v-model="modeFilter" class="status-select" placeholder="模式筛选" clearable>
        <el-option label="全部模式" value="" />
        <el-option label="邀约版" value="invite" />
        <el-option label="跟进版" value="followup" />
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
        <el-table-column label="设备名称" min-width="210">
          <template #default="{ row }">
            <div class="device-name">{{ row.name || row.device_name || row.device_code }}</div>
            <div v-if="row.factories && row.factories.length" class="factory-tags">
              <el-tag v-for="factory in row.factories" :key="factory.id" size="small" effect="plain">
                {{ factory.name }}
              </el-tag>
            </div>
            <span v-else class="muted factory-empty">未绑定工厂</span>
            <div v-if="row.position_id" class="position-label">
              岗位：{{ positionName(row.position_id) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="设备码" min-width="150">
          <template #default="{ row }">
            <div class="device-code">{{ row.device_code || '-' }}</div>
            <el-button v-if="!isOnline(row)" link type="primary" size="small" @click="openQr(row)">
              扫码登录
            </el-button>
            <span v-else class="online-mark">已登录</span>
          </template>
        </el-table-column>

        <el-table-column label="模式" width="100">
          <template #default="{ row }">
            <el-tag :type="row.mode === 'invite' ? 'warning' : 'success'" effect="light">
              {{ row.mode === 'invite' ? '邀约版' : '跟进版' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="分配账号" min-width="130">
          <template #default="{ row }">
            <span>{{ row.recruiter_id || '未分配' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="isOnline(row) ? 'success' : 'danger'" effect="light">
              {{ isOnline(row) ? '在线' : '离线' }}
            </el-tag>
            <div v-if="row.queue_depth" class="queue-note">队列 {{ row.queue_depth }}</div>
          </template>
        </el-table-column>

        <el-table-column label="最后在线" width="180">
          <template #default="{ row }">
            <span class="muted">{{ row.last_online ? formatDateTime(row.last_online) : '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button link type="primary" @click="openCopy(row)">复制</el-button>
            <el-dropdown trigger="click" @command="(cmd: string) => handleCommand(cmd, row)">
              <el-button link type="primary">更多</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="groups">查看群组</el-dropdown-item>
                  <el-dropdown-item command="workflow">工作流配置</el-dropdown-item>
                  <el-dropdown-item command="clear-unread">清空未读</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
            <el-button link type="danger" @click="removeDevice(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="暂无设备" />
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

    <!-- 新增 / 编辑 -->
    <el-dialog
      v-model="formVisible"
      :title="editingId ? '编辑设备' : '新增设备'"
      width="640px"
      :close-on-click-modal="false"
      @closed="resetForm"
    >
      <el-form label-width="110px">
        <el-form-item label="设备码" required>
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
        <el-form-item label="设备名称">
          <el-input v-model="form.name" placeholder="如：坐席设备-01" />
        </el-form-item>
        <el-form-item label="设备模式">
          <el-radio-group v-model="form.mode">
            <el-radio value="followup">跟进版</el-radio>
            <el-radio value="invite">邀约版</el-radio>
          </el-radio-group>
          <div class="form-hint">
            邀约版：邀约成功后完全沉默；跟进版：邀约后仍正常回复
          </div>
        </el-form-item>
        <el-form-item label="分配账号">
          <el-input v-model="form.recruiter_id" placeholder="如：hualin，留空=未分配" />
        </el-form-item>
        <el-form-item label="绑定工厂">
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
        <el-form-item label="绑定岗位">
          <el-select
            v-model="form.position_id"
            filterable
            clearable
            placeholder="请选择设备实际使用的岗位"
            style="width: 100%"
          >
            <el-option
              v-for="position in positionOptionsForForm"
              :key="position.id"
              :label="positionLabel(position)"
              :value="position.id"
            />
          </el-select>
          <div class="form-hint">工厂改变后必须同步选择岗位；留空时系统会自动选该工厂的第一个启用岗位。</div>
        </el-form-item>
        <el-form-item label="登记群聊">
          <el-input
            v-model="form.group_chat"
            placeholder="面试登记通知群（可选，设备上报群名）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveDevice">保存</el-button>
      </template>
    </el-dialog>

    <!-- 复制 -->
    <el-dialog v-model="copyVisible" title="复制设备" width="480px" @closed="copySource = null">
      <el-form label-width="100px">
        <el-form-item label="源设备码">
          <el-input :model-value="copySource?.device_code || ''" disabled />
        </el-form-item>
        <el-form-item label="新设备码" required>
          <el-input v-model="copyCode" placeholder="如：AG-002（不可重复）" />
        </el-form-item>
      </el-form>
      <p class="dialog-hint">复制会带过来设备名称（追加“-副本”）、模式、分配账号、工厂与工作流配置。</p>
      <template #footer>
        <el-button @click="copyVisible = false">取消</el-button>
        <el-button type="primary" :loading="copying" @click="confirmCopy">复制</el-button>
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
        <div v-if="qrLoading" class="qr-placeholder">正在读取二维码…</div>
        <img v-else-if="qrResult?.available && qrResult.image" class="qr-image" :src="qrResult.image" alt="登录二维码" />
        <div v-else class="qr-placeholder">
          <el-empty description="暂无可用二维码" :image-size="80" />
          <p v-if="qrDevice && isOnline(qrDevice)" class="dialog-hint">设备在线，没有待扫的二维码。</p>
          <p v-else class="dialog-hint">请确认设备端已启动扫码登录流程，页面每 3 秒自动刷新。</p>
        </div>
        <p v-if="qrError" class="qr-error">{{ qrError }}</p>
        <p v-if="qrResult?.captured_at" class="dialog-hint">
          二维码更新时间：{{ formatDateTime(qrResult.captured_at) }}
        </p>
        <div class="qr-refresh-row">
          <el-button :loading="qrLoading" @click="fetchQr" size="small">刷新二维码</el-button>
        </div>
        <div class="verify-row">
          <el-input
            v-model="verifyCode"
            placeholder="企微短信验证码（4-8 位数字）"
            maxlength="8"
            style="flex: 1"
          />
          <el-button type="primary" :loading="verifySubmitting" @click="submitVerifyCode">
            提交验证码
          </el-button>
        </div>
        <p class="dialog-hint">扫码后如企微要求短信验证码，在此提交，设备端会取走并自动输入。</p>
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

    <!-- 工作流 -->
    <el-dialog
      v-model="workflowVisible"
      :title="`工作流配置 · ${workflowDevice?.device_code || ''}`"
      width="720px"
      :close-on-click-modal="false"
      @closed="workflowDevice = null"
    >
      <div v-loading="workflowLoading">
        <p class="dialog-hint">
          工作流接口返回空时以设备 config 为准；可编辑 merge_delay_seconds / timeout / event_rules /
          reminder / quiet_hours 等字段。保存会同时写入 workflow 与设备 config。
        </p>
        <el-alert
          v-if="workflowError"
          type="error"
          :title="workflowError"
          show-icon
          :closable="false"
          class="load-error"
        />
        <el-input
          v-model="workflowText"
          type="textarea"
          :rows="18"
          spellcheck="false"
          class="workflow-editor"
        />
      </div>
      <template #footer>
        <el-button type="danger" plain :disabled="workflowLoading" @click="removeWorkflow">删除工作流</el-button>
        <el-button :disabled="workflowLoading" @click="formatWorkflow">格式化</el-button>
        <el-button @click="workflowVisible = false">取消</el-button>
        <el-button type="primary" :loading="workflowSaving" @click="saveWorkflow">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Search } from '@element-plus/icons-vue'
import { devicesApi, type AgentDeviceItem, type DeviceGroup } from '../api/agent'
import { positionsApi } from '../api/core'
import type { Factory, ServicePosition } from '../api/types'
import { formatDateTime } from '../utils/format'

const devices = ref<AgentDeviceItem[]>([])
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const modeFilter = ref('')
const onlineFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const factoryOptions = ref<Factory[]>([])
const positionOptions = ref<ServicePosition[]>([])

const onlineCount = computed(() => devices.value.filter((device) => isOnline(device)).length)
const inviteCount = computed(() => devices.value.filter((device) => device.mode === 'invite').length)
const followupCount = computed(() => devices.value.filter((device) => device.mode !== 'invite').length)

const filteredDevices = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  return devices.value.filter((device) => {
    if (modeFilter.value === 'invite' && device.mode !== 'invite') return false
    if (modeFilter.value === 'followup' && device.mode === 'invite') return false
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
watch([[keyword]], () => {
  page.value = 1
})

function isOnline(device: AgentDeviceItem): boolean {
  return Boolean(device.online || device.status)
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const { data } = await devicesApi.list({ page: 1, page_size: 1000 })
    devices.value = data.items || []
    if ((page.value - 1) * pageSize.value >= devices.value.length) page.value = 1
  } catch (err: any) {
    error.value = err?.response?.data?.detail || '设备列表加载失败'
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
  if (!form.factory_ids.length) return positionOptions.value
  const selected = new Set(form.factory_ids)
  return positionOptions.value.filter((position) => position.factory_id == null || selected.has(Number(position.factory_id)))
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
  device_code: string
  name: string
  mode: string
  recruiter_id: string
  factory_ids: number[]
  position_id: number | null
  group_chat: string
}

const formVisible = ref(false)
const saving = ref(false)
const editingId = ref<number | null>(null)

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

function emptyForm(): DeviceForm {
  return {
    device_code: '',
    name: '',
    mode: 'followup',
    recruiter_id: '',
    factory_ids: [],
    position_id: null,
    group_chat: '',
  }
}

function resetForm(): void {
  Object.assign(form, emptyForm())
  editingId.value = null
}

function openCreate(): void {
  resetForm()
  formVisible.value = true
}

function openEdit(row: AgentDeviceItem): void {
  editingId.value = row.id
  Object.assign(form, {
    device_code: row.device_code || '',
    name: row.name || row.device_name || '',
    mode: row.mode || 'followup',
    recruiter_id: row.recruiter_id || '',
    factory_ids: [...(row.factory_ids || [])],
    position_id: row.position_id ? Number(row.position_id) : null,
    group_chat: row.group_chat || '',
  })
  formVisible.value = true
}

async function saveDevice(): Promise<void> {
  if (!form.device_code.trim()) {
    ElMessage.warning('请输入设备码')
    return
  }
  saving.value = true
  const payload: Record<string, unknown> = {
    device_code: form.device_code.trim(),
    device_name: form.name.trim() || form.device_code.trim(),
    name: form.name.trim() || form.device_code.trim(),
    mode: form.mode,
    recruiter_id: form.recruiter_id.trim(),
    factory_ids: form.factory_ids,
    position_id: form.position_id,
    group_chat: form.group_chat.trim(),
  }
  try {
    if (editingId.value) {
      await devicesApi.update(editingId.value, payload)
      ElMessage.success('设备已更新')
    } else {
      await devicesApi.create(payload)
      ElMessage.success('设备已创建')
    }
    formVisible.value = false
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '保存失败')
  } finally {
    saving.value = false
  }
}

/* ---------- 复制 ---------- */
const copyVisible = ref(false)
const copying = ref(false)
const copySource = ref<AgentDeviceItem | null>(null)
const copyCode = ref('')

function openCopy(row: AgentDeviceItem): void {
  copySource.value = row
  copyCode.value = ''
  copyVisible.value = true
}

async function confirmCopy(): Promise<void> {
  const source = copySource.value
  if (!source) return
  const code = copyCode.value.trim()
  if (!code) {
    ElMessage.warning('请输入新设备码')
    return
  }
  copying.value = true
  try {
    await devicesApi.create({
      device_code: code,
      device_name: `${source.name || source.device_code}-副本`,
      name: `${source.name || source.device_code}-副本`,
      mode: source.mode || 'followup',
      recruiter_id: source.recruiter_id || '',
      factory_ids: source.factory_ids || [],
      position_id: source.position_id || null,
      group_chat: source.group_chat || '',
      config: source.config || {},
    })
    ElMessage.success('设备已复制')
    copyVisible.value = false
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '复制失败')
  } finally {
    copying.value = false
  }
}

/* ---------- 删除 ---------- */
async function removeDevice(row: AgentDeviceItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除设备「${row.name || row.device_code}」？删除后不可恢复。`,
      '删除设备',
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

/* ---------- 更多操作 ---------- */
function handleCommand(command: string, row: AgentDeviceItem): void {
  if (command === 'groups') openGroups(row)
  if (command === 'workflow') openWorkflow(row)
  if (command === 'clear-unread') clearUnread(row)
}

async function clearUnread(row: AgentDeviceItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认清除「${row.name || row.device_code}」下所有会话的未读状态？`,
      '清除未读',
      { type: 'warning', confirmButtonText: '清除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await devicesApi.clearUnread(row.id)
    ElMessage.success('未读已清除')
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '清除失败')
  }
}

/* ---------- 扫码登录 ---------- */
const qrVisible = ref(false)
const qrLoading = ref(false)
const qrResult = ref<{ available: boolean; image?: string; captured_at?: string } | null>(null)
const qrError = ref('')
const qrDevice = ref<AgentDeviceItem | null>(null)
const verifyCode = ref('')
const verifySubmitting = ref(false)
let qrTimer: ReturnType<typeof setInterval> | null = null

function openQr(row: AgentDeviceItem): void {
  qrDevice.value = row
  qrResult.value = null
  qrError.value = ''
  verifyCode.value = ''
  qrVisible.value = true
  void fetchQr()
  closeQrTimer()
  qrTimer = setInterval(() => void fetchQr(true), 3000)
}

async function fetchQr(silent = false): Promise<void> {
  const code = qrDevice.value?.device_code
  if (!code || !qrVisible.value) return
  if (!silent) qrLoading.value = true
  qrError.value = ''
  try {
    const { data } = await devicesApi.loginQr(code)
    qrResult.value = data
  } catch (err: any) {
    qrError.value = err?.response?.data?.detail || '二维码读取失败'
  } finally {
    if (!silent) qrLoading.value = false
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
  if (!code) return
  if (!/^\d{4,8}$/.test(value)) {
    ElMessage.warning('验证码必须是 4-8 位数字')
    return
  }
  verifySubmitting.value = true
  try {
    await devicesApi.verifyCodePost(code, { code: value })
    ElMessage.success('验证码已提交，等待设备取走')
    verifyCode.value = ''
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

/* ---------- 工作流 ---------- */
const workflowVisible = ref(false)
const workflowLoading = ref(false)
const workflowSaving = ref(false)
const workflowError = ref('')
const workflowText = ref('')
const workflowDevice = ref<AgentDeviceItem | null>(null)

async function openWorkflow(row: AgentDeviceItem): Promise<void> {
  workflowDevice.value = row
  workflowVisible.value = true
  workflowLoading.value = true
  workflowError.value = ''
  workflowText.value = ''
  try {
    const { data } = await devicesApi.workflowGet(row.id)
    const items = Array.isArray(data.items) ? data.items : []
    const source = items.length ? items[0] : row.config || {}
    workflowText.value = JSON.stringify(source, null, 2)
  } catch (err: any) {
    workflowError.value = err?.response?.data?.detail || '工作流加载失败'
    workflowText.value = JSON.stringify(row.config || {}, null, 2)
  } finally {
    workflowLoading.value = false
  }
}

function formatWorkflow(): void {
  try {
    workflowText.value = JSON.stringify(JSON.parse(workflowText.value || '{}'), null, 2)
  } catch {
    ElMessage.error('JSON 格式不合法')
  }
}

function parseWorkflow(): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(workflowText.value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ElMessage.error('工作流必须是 JSON 对象')
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    ElMessage.error('JSON 格式不合法')
    return null
  }
}

async function saveWorkflow(): Promise<void> {
  const device = workflowDevice.value
  if (!device) return
  const parsed = parseWorkflow()
  if (!parsed) return
  workflowSaving.value = true
  try {
    await devicesApi.workflowPut(device.id, parsed)
    await devicesApi.update(device.id, { config: parsed })
    ElMessage.success('工作流已保存')
    workflowVisible.value = false
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '保存失败')
  } finally {
    workflowSaving.value = false
  }
}

async function removeWorkflow(): Promise<void> {
  const device = workflowDevice.value
  if (!device) return
  try {
    await ElMessageBox.confirm('确定删除该设备的工作流配置？', '删除工作流', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  workflowSaving.value = true
  try {
    await devicesApi.workflowDelete(device.id)
    await devicesApi.update(device.id, { config: {} })
    ElMessage.success('工作流已删除')
    workflowVisible.value = false
    await load()
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.detail || '删除失败')
  } finally {
    workflowSaving.value = false
  }
}

onMounted(() => {
  void load()
  void loadFactories()
  void loadPositions()
})
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

.qr-placeholder {
  width: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--bd-border);
  border-radius: 8px;
  color: var(--bd-text-tertiary);
}

.qr-error {
  color: var(--bd-danger);
  font-size: 12px;
  margin: 0;
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
