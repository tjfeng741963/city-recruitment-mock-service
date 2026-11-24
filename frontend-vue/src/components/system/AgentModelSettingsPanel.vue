<template>
  <section v-loading="busy === 'load'" aria-labelledby="agent-model-heading">
    <h3 id="agent-model-heading">系统 Agent 大模型</h3>
    <p v-if="active" class="active-model">
      当前模型 <strong>{{ active.model }}</strong>
      <el-tag size="small" effect="plain">{{ active.source === 'settings' ? '网页配置' : '服务器配置' }}</el-tag>
      <span v-if="!active.key_configured">尚未配置 Key</span>
    </p>
    <el-alert v-if="!secure" type="warning" :closable="false" show-icon
      title="请通过 HTTPS 打开设置，再填写 API Key。">
      <el-link v-if="active?.settings_https_url" :href="active.settings_https_url" type="primary">
        打开 HTTPS 设置
      </el-link>
    </el-alert>
    <el-form label-width="110px" label-position="left" :disabled="!secure || !!busy || !active" class="model-form">
      <el-form-item label="模型 API URL" for="agent-model-url">
        <el-input id="agent-model-url" v-model="baseUrl" placeholder="https://api.example.com/v1" maxlength="512" />
      </el-form-item>
      <el-form-item label="API Key" for="agent-model-key">
        <div class="model-inline">
          <el-input id="agent-model-key" v-model="apiKey" type="password" autocomplete="new-password"
            :placeholder="reuseKey ? '留空使用当前 Key' : '输入供应商的 API Key'" maxlength="2048" />
          <el-button :disabled="!canConnect" :loading="busy === 'discover'" @click="discover">探测模型</el-button>
        </div>
      </el-form-item>
      <el-form-item label="模型" for="agent-model-id">
        <el-select v-if="models.length && !manual" id="agent-model-id" v-model="model" filterable
          :placeholder="'请选择模型（找到 ' + models.length + ' 个）'">
          <el-option v-for="id in models" :key="id" :label="id" :value="id" />
        </el-select>
        <el-input v-else id="agent-model-id" v-model="model" placeholder="输入非思考模型 ID" maxlength="200" />
        <el-button v-if="models.length" link type="primary" @click="manual = !manual">
          {{ manual ? '从列表选择' : '手动填写' }}
        </el-button>
      </el-form-item>
      <div class="model-actions">
        <el-button :disabled="!canConnect || !model.trim()" :loading="busy === 'test'" @click="test">测试模型</el-button>
        <el-button type="primary" :disabled="!testId" :loading="busy === 'save'" @click="save">保存并启用</el-button>
      </div>
    </el-form>
    <el-alert v-if="notice" class="model-notice" :title="notice.text" :type="notice.type" :closable="false" show-icon />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiErrorMessage, settingsApi, type AgentModelSettings } from '../../api/system'

const secure = window.location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const active = ref<AgentModelSettings>()
const baseUrl = ref('')
const apiKey = ref('')
const model = ref('')
const models = ref<string[]>([])
const manual = ref(false)
const testId = ref('')
const busy = ref<'load' | 'discover' | 'test' | 'save'>()
const notice = ref<{ text: string; type: 'success' | 'error' | 'info' }>()
const reuseKey = computed(() => !!active.value?.key_configured &&
  baseUrl.value.trim().replace(/\/+$/, '') === active.value.base_url.replace(/\/+$/, ''))
const canConnect = computed(() => secure && !!baseUrl.value.trim() && (!!apiKey.value.trim() || reuseKey.value))

watch([baseUrl, apiKey], () => {
  models.value = []
  manual.value = false
}, { flush: 'sync' })
watch([baseUrl, apiKey, model], () => {
  testId.value = ''
  notice.value = undefined
}, { flush: 'sync' })

function populate(data: AgentModelSettings) {
  active.value = data
  baseUrl.value = data.base_url
  apiKey.value = ''
  model.value = data.model
  models.value = []
  manual.value = false
  testId.value = ''
}

async function run(action: NonNullable<typeof busy.value>, work: () => Promise<void>, fallback: string) {
  if (busy.value) return
  busy.value = action
  notice.value = undefined
  try { await work() }
  catch (error) {
    notice.value = { type: 'error', text: apiErrorMessage(error, fallback) }
  } finally {
    busy.value = undefined
  }
}

function load() {
  return run('load', async () => populate((await settingsApi.agentModel()).data), '模型配置加载失败')
}

function credentials() {
  return { base_url: baseUrl.value.trim(), api_key: apiKey.value.trim() || undefined }
}

function draft() {
  return { ...credentials(), model: model.value.trim(), revision: active.value!.revision }
}

function discover() {
  return run('discover', async () => {
    const { data } = await settingsApi.discoverAgentModels(credentials())
    models.value = data.models
    manual.value = false
    if (data.models.length && !data.models.includes(model.value)) model.value = ''
    notice.value = data.models.length
      ? { type: 'info', text: `发现 ${data.models.length} 个模型。请选择一个非思考模型并测试。` }
      : { type: 'info', text: '供应商未返回模型。可以手动填写模型 ID 后测试。' }
  }, '探测模型失败')
}

function test() {
  return run('test', async () => {
    testId.value = ''
    const { data } = await settingsApi.testAgentModel(draft())
    testId.value = data.test_id
    notice.value = { type: 'success', text: `测试通过，用时 ${data.latency_ms} 毫秒。可保存并启用。` }
  }, '模型测试失败')
}

function save() {
  return run('save', async () => {
    const { data } = await settingsApi.saveAgentModel({ ...draft(), test_id: testId.value })
    populate(data)
    notice.value = { type: 'success', text: `${data.model} 已启用，将用于系统 Agent 的下一次回复。` }
  }, '模型保存失败')
}

defineExpose({ load })
onMounted(load)
</script>

<style scoped>
h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.active-model { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 16px; color: var(--el-text-color-secondary); }
.active-model strong { color: var(--el-text-color-primary); overflow-wrap: anywhere; }
.model-form { margin-top: 14px; max-width: 720px; }
.model-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
.model-inline .el-input { flex: 1 1 200px; }
.model-form :deep(.el-select) { width: 100%; }
.model-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.model-actions .el-button { margin: 0; }
.model-notice { margin-top: 14px; }
</style>
