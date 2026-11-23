<template>
  <section>
    <div class="page-header">
      <div>
        <h2 class="page-title">全局设置</h2>
        <p class="page-desc">配置公司名称、年龄要求等全局参数</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadAll">刷新</el-button>
      </div>
    </div>

    <el-alert
      v-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      class="page-alert"
    >
      <template #default>
        <el-button link type="primary" @click="loadAll">重新加载</el-button>
      </template>
    </el-alert>

    <div class="settings-page">
      <!-- 全局参数 -->
      <div v-loading="loading" class="settings-card">
        <h3 class="block-title">基本信息</h3>
        <el-form label-width="110px" label-position="left" class="settings-form">
          <el-form-item label="公司名称">
            <el-input v-model="form.company_name" placeholder="如：轨道交通集团" maxlength="64" />
          </el-form-item>
        </el-form>

        <h3 class="block-title">年龄要求</h3>
        <el-form label-width="110px" label-position="left" class="settings-form">
          <el-form-item label="年龄范围说明">
            <el-input v-model="form.age_range" placeholder="如：18-35岁" maxlength="64" />
          </el-form-item>
          <el-form-item label="最小年龄">
            <el-input-number v-model="form.age_min" :min="0" :max="99" controls-position="right" />
          </el-form-item>
          <el-form-item label="最大年龄">
            <el-input-number v-model="form.age_max" :min="0" :max="99" controls-position="right" />
          </el-form-item>
        </el-form>

        <div class="block-actions">
          <el-button type="primary" :loading="savingSettings" @click="saveSettings">
            保存设置
          </el-button>
        </div>
      </div>

      <!-- Agent 配置 -->
      <div v-loading="loadingAgent" class="settings-card">
        <h3 class="block-title">Agent 服务配置</h3>
        <el-form label-width="110px" label-position="left" class="settings-form">
          <el-form-item label="Agent 地址">
            <div class="inline-field">
              <el-input
                v-model="agentBaseUrl"
                placeholder="如：http://47.107.245.246:8091"
                class="agent-input"
              />
              <el-button
                :loading="savingAgent"
                :disabled="!agentBaseUrl.trim()"
                @click="saveAgent"
              >
                保存
              </el-button>
            </div>
          </el-form-item>
        </el-form>
        <p v-if="agentIsDefault" class="section-hint">当前使用默认 Agent 地址。</p>

        <template v-if="auth.user?.role === 'admin'">
          <el-divider />
          <AgentModelSettingsPanel ref="agentModelPanel" />
        </template>

        <el-divider />

        <h3 class="block-title">一键同步</h3>
        <p class="section-desc">
          将 city-config-web 的最新配置和知识库同步到 Agent，立即生效（无需重启容器）。
        </p>
        <el-button type="primary" :icon="Refresh" :loading="syncing" @click="syncAgent">
          一键同步
        </el-button>
        <el-alert
          v-if="syncMessage"
          :title="syncMessage"
          :type="syncOk ? 'success' : 'error'"
          show-icon
          :closable="false"
          class="inline-alert"
        />
      </div>

      <!-- 数据初始化 -->
      <div class="settings-card">
        <h3 class="block-title">数据初始化</h3>
        <p class="section-desc">
          下载模板Excel，填写工厂和城市区域数据后导入，快速初始化账号配置。
        </p>
        <div class="block-actions left">
          <el-button :icon="Download" :loading="downloading" @click="downloadTemplate">
            下载模板
          </el-button>
          <el-upload
            :show-file-list="false"
            accept=".xlsx,.xls"
            :before-upload="beforeImport"
            :http-request="handleImport"
            :disabled="importing"
          >
            <el-button type="primary" :icon="Upload" :loading="importing">导入数据</el-button>
          </el-upload>
        </div>
        <el-alert
          v-if="importMessage"
          :title="importMessage"
          :type="importOk ? 'success' : 'error'"
          show-icon
          :closable="false"
          class="inline-alert"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadRequestOptions } from 'element-plus'
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import {
  apiErrorMessage,
  settingsApi,
  type ImportResult,
  type SyncResult,
} from '../api/system'
import { downloadBlob } from '../utils/format'
import { useAuthStore } from '../stores/auth'
import AgentModelSettingsPanel from '../components/system/AgentModelSettingsPanel.vue'

const auth = useAuthStore()
const agentModelPanel = ref<InstanceType<typeof AgentModelSettingsPanel> | null>(null)

const loading = ref(false)
const loadError = ref('')
const savingSettings = ref(false)

const loadingAgent = ref(false)
const savingAgent = ref(false)
const agentBaseUrl = ref('')
const agentIsDefault = ref(false)
const syncing = ref(false)
const syncMessage = ref('')
const syncOk = ref(true)

const downloading = ref(false)
const importing = ref(false)
const importMessage = ref('')
const importOk = ref(true)

const form = reactive({
  company_name: '',
  age_range: '',
  age_min: 0,
  age_max: 0,
})

/** 保留后端返回的其它设置键，避免 PUT 覆盖丢失 */
let rawSettings: Record<string, unknown> = {}

async function loadSettings(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const { data } = await settingsApi.get()
    rawSettings = data as unknown as Record<string, unknown>
    form.company_name = data.company_name || ''
    form.age_range = data.requirements?.age_range || ''
    form.age_min = Number(data.requirements?.age_limit?.min ?? 0)
    form.age_max = Number(data.requirements?.age_limit?.max ?? 0)
  } catch (error) {
    loadError.value = apiErrorMessage(error, '全局设置加载失败')
  } finally {
    loading.value = false
  }
}

async function loadAgent(): Promise<void> {
  loadingAgent.value = true
  try {
    const { data } = await settingsApi.agentGet()
    agentBaseUrl.value = data.agent_base_url || ''
    agentIsDefault.value = data.is_default !== false && !data.agent_base_url
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, 'Agent 配置加载失败'))
  } finally {
    loadingAgent.value = false
  }
}

function loadAll(): void {
  void loadSettings()
  void loadAgent()
  void agentModelPanel.value?.load()
}

async function saveSettings(): Promise<void> {
  if (form.age_min > form.age_max) {
    ElMessage.warning('最小年龄不能大于最大年龄')
    return
  }
  savingSettings.value = true
  try {
    await settingsApi.save({
      ...(rawSettings as object),
      company_name: form.company_name.trim(),
      requirements: {
        age_range: form.age_range.trim(),
        age_limit: { min: form.age_min, max: form.age_max },
      },
    })
    ElMessage.success('设置已保存')
    await loadSettings()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '设置保存失败'))
  } finally {
    savingSettings.value = false
  }
}

async function saveAgent(): Promise<void> {
  const url = agentBaseUrl.value.trim()
  if (!url) {
    ElMessage.warning('请填写 Agent 地址')
    return
  }
  savingAgent.value = true
  try {
    const { data } = await settingsApi.agentSave(url)
    agentBaseUrl.value = data.agent_base_url || url
    ElMessage.success('Agent 地址已保存')
    await loadAgent()
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, 'Agent 地址保存失败'))
  } finally {
    savingAgent.value = false
  }
}

async function syncAgent(): Promise<void> {
  syncing.value = true
  syncMessage.value = ''
  try {
    const { data } = await settingsApi.sync()
    const result = data as SyncResult
    syncOk.value = result.success !== false
    const keys = Array.isArray(result.synced) ? result.synced : []
    syncMessage.value = syncOk.value
      ? `同步完成${keys.length ? `，已同步：${keys.join('、')}` : ''}`
      : '同步失败，请稍后重试'
    if (syncOk.value) ElMessage.success('一键同步完成')
    else ElMessage.error(syncMessage.value)
  } catch (error) {
    syncOk.value = false
    syncMessage.value = apiErrorMessage(error, '一键同步失败')
    ElMessage.error(syncMessage.value)
  } finally {
    syncing.value = false
  }
}

async function downloadTemplate(): Promise<void> {
  downloading.value = true
  try {
    const { data } = await settingsApi.downloadTemplate()
    downloadBlob(data, '导入模板.xlsx')
    ElMessage.success('模板已开始下载')
  } catch (error) {
    ElMessage.error(apiErrorMessage(error, '模板下载失败'))
  } finally {
    downloading.value = false
  }
}

async function beforeImport(file: File): Promise<boolean> {
  const name = file.name.toLowerCase()
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    ElMessage.warning('请选择 Excel 文件（.xlsx / .xls）')
    return false
  }
  try {
    await ElMessageBox.confirm(
      `导入将写入「${file.name}」中的工厂与城市数据，可能覆盖同名记录，确定继续吗？`,
      '导入确认',
      { type: 'warning', confirmButtonText: '开始导入', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false
  }
}

async function handleImport(options: UploadRequestOptions): Promise<void> {
  importing.value = true
  importMessage.value = ''
  try {
    const { data } = await settingsApi.importFile(options.file as File)
    const result = data as ImportResult
    importOk.value = result.success !== false
    const total = Number(result.total ?? 0)
    const created = Number(result.created ?? 0)
    const updated = Number(result.updated ?? 0)
    importMessage.value = importOk.value
      ? `导入完成：共 ${total} 条，新增 ${created} 条，更新 ${updated} 条`
      : '导入失败，请检查文件内容'
    if (importOk.value) ElMessage.success('数据导入完成')
    else ElMessage.error(importMessage.value)
    options.onSuccess?.(data)
  } catch (error) {
    importOk.value = false
    importMessage.value = apiErrorMessage(error, '数据导入失败')
    ElMessage.error(importMessage.value)
    // el-upload 的 onError 需要 UploadAjaxError，这里已经自行展示错误，仅通知组件结束状态
    options.onError?.(error as Parameters<NonNullable<typeof options.onError>>[0])
  } finally {
    importing.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
.page-alert {
  margin-bottom: 16px;
}

.settings-card {
  padding: 24px 28px;
  margin-bottom: 20px;
}

.block-title {
  position: relative;
  margin: 0 0 18px;
  padding-left: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--bd-text-primary);
  line-height: 1.4;
}

.block-title::before {
  content: '';
  position: absolute;
  left: 0;
  top: 3px;
  bottom: 3px;
  width: 3px;
  border-radius: 3px;
  background: var(--bd-primary);
}

.settings-form {
  max-width: 560px;
}

.settings-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.inline-field {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.agent-input {
  flex: 1;
}

.block-actions {
  display: flex;
  justify-content: flex-start;
  gap: 10px;
}

.block-actions.left {
  align-items: center;
}

.section-desc {
  margin: 0 0 14px;
  color: var(--bd-text-tertiary);
  font-size: 13px;
  line-height: 1.6;
}

.section-hint {
  margin: 0;
  color: var(--bd-text-tertiary);
  font-size: 12px;
}

.inline-alert {
  margin-top: 14px;
}

:deep(.el-upload) {
  display: inline-flex;
}
</style>
