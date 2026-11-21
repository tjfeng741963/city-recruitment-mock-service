<template>
  <el-drawer
    :model-value="modelValue"
    size="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load(true)"
  >
    <template #header>
      <div class="drawer-head">
        <b>Agent 配置</b>
        <span class="head-sub">{{ position?.position_name }}</span>
      </div>
    </template>

    <el-tabs v-model="tab">
      <el-tab-pane label="人设" name="persona">
        <el-alert
          class="persona-note"
          type="info"
          show-icon
          :closable="false"
          title="人设决定 Agent 的身份、语气和话术边界"
          description="厂名、工价、地点、面试时间由系统自动注入，不要写在这段文字里——岗位数据一改，人设里写死的数字就会和事实对不上。"
        />
        <div class="field">
          <div class="field-label">
            <span>人设正文</span>
            <span class="char-count">{{ persona.length }} 字</span>
          </div>
          <el-input
            v-model="persona"
            type="textarea"
            :rows="14"
            :disabled="loading"
            placeholder="例如：你是陈姐，在广东做工厂招工十几年……&#10;&#10;写清楚：你是谁、怎么称呼客户、能用什么语气、哪些话绝对不能说。"
          />
        </div>
        <div class="foot">
          <span v-if="personaDirty" class="dirty-hint">未保存</span>
          <el-button type="primary" :loading="savingPersona" @click="savePersona">保存人设</el-button>
        </div>
      </el-tab-pane>

      <el-tab-pane :label="`开场（${openings.length}）`" name="opening">
        <div class="opening-toolbar">
          <el-button size="small" class="pill-btn" @click="startAdd('text')">+ 文本</el-button>
          <el-button size="small" class="pill-btn" @click="startAdd('image')">+ 图片</el-button>
          <el-button size="small" class="pill-btn" @click="startAdd('video')">+ 视频</el-button>
          <span class="opening-hint">按顺序发送；设置每条发送后的最少等待，客户端安全冷却可能更长</span>
        </div>

        <div v-if="draft" ref="editorRef" class="opening-edit">
          <div class="edit-head">
            <span class="kind-tag">
              {{ KIND_LABEL[draft.kind] }} ·
              {{ draft.id ? `编辑第 ${draft.seq ?? ''} 条` : '新增一条' }}
            </span>
            <el-button link size="small" @click="draft = null">取消</el-button>
          </div>
          <el-input
            v-if="draft.kind === 'text'"
            v-model="draft.content"
            type="textarea"
            :rows="5"
            placeholder="可以引用岗位字段，例如：{{factory}} 在招 {{job_title}}，工价 {{wage}}。"
          />
          <template v-else>
            <div class="media-row">
              <el-select v-model="draft.media_name" class="media-select" filterable placeholder="选择素材">
                <el-option
                  v-for="item in mediaOf(draft.kind)"
                  :key="item.name"
                  :label="item.name"
                  :value="item.name"
                />
              </el-select>
              <el-button :loading="uploading" @click="pickMedia()">上传素材</el-button>
              <input ref="fileInput" type="file" class="hidden-input" :accept="acceptOf(draft.kind)" @change="onMediaFile" />
            </div>
            <el-input v-model="draft.content" placeholder="配文（可选）" class="media-caption" />
          </template>
          <el-form-item label="间隔（秒）" class="delay-row">
            <el-input-number v-model="delaySeconds" :min="2" :max="120" controls-position="right" />
          </el-form-item>
          <div class="edit-tools">
            <el-button type="primary" :loading="savingOpening" @click="saveDraft">保存</el-button>
          </div>
        </div>

        <div v-if="loading" class="opening-empty">加载中…</div>
        <div v-else-if="!openings.length" class="opening-empty">
          还没有开场。客户首次对话时 Agent 会按顺序发送这里的内容。
        </div>

        <div
          v-for="(entry, index) in openings"
          :key="entry.id"
          class="opening-card"
          :class="{ 'is-editing': draft?.id === entry.id }"
        >
          <div class="opening-head">
            <span class="kind-tag" :class="entry.kind">{{ KIND_LABEL[entry.kind] }} · 第 {{ index + 1 }} 条</span>
            <div class="opening-tools">
              <el-button link size="small" :disabled="index === 0" title="上移" @click="move(index, -1)">↑</el-button>
              <el-button
                link
                size="small"
                :disabled="index === openings.length - 1"
                title="下移"
                @click="move(index, 1)"
              >
                ↓
              </el-button>
              <el-button link size="small" @click="startEdit(entry)">编辑</el-button>
              <el-button link size="small" type="danger" @click="removeEntry(entry)">删除</el-button>
            </div>
          </div>
          <div class="opening-body">
            <template v-if="entry.kind === 'text'">{{ entry.content }}</template>
            <template v-else>
              素材：<b>{{ entry.media_name || '未设置' }}</b>
              <span v-if="entry.content" class="opening-caption">配文：{{ entry.content }}</span>
            </template>
          </div>
          <div class="opening-delay">间隔 {{ Math.round((entry.delay_ms || 0) / 1000) }} 秒后发下一条</div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="流程图" name="flow">
        <el-alert
          class="persona-note"
          type="info"
          show-icon
          :closable="false"
          title="按岗位查看真实招聘流程"
          description="流程图页面统一管理节点顺序、客户回复条件和后续分支。"
        />
        <div v-if="flowLoading" class="opening-empty">流程加载中…</div>
        <div v-else class="flow-summary">
          <template v-if="flow">
            <div class="flow-toolbar">
              <el-tag :type="flow.status === 'enabled' ? 'success' : 'info'">
                {{ flow.status === 'enabled' ? '新会话已启用' : '已停用' }}
              </el-tag>
              <span class="opening-hint">版本 v{{ flow.version }} · {{ flow.nodes.length }} 个节点</span>
            </div>
            <div class="opening-empty">
              {{ flow.nodes.length ? '节点和连接请在统一流程图页面中查看与编辑。' : '该岗位还没有流程图，可在流程图页面新建停用草稿或从开场迁移。' }}
            </div>
          </template>
          <div v-else class="opening-empty">尚未读取到该岗位的流程状态。</div>
          <div class="flow-actions">
            <el-button type="primary" :disabled="!position" @click="openFlowEditor">打开流程图</el-button>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { agentApi, type AgentFlow } from '../../api/agent'
import { mediaApi } from '../../api/core'
import type { ServicePosition } from '../../api/types'
import { drawerTabForLoad, type AgentDrawerTab } from '../agent/flow-edit-entry'

interface PersonaOpening {
  id: number
  kind: 'text' | 'image' | 'video'
  content: string
  media_name?: string
  delay_ms: number
  seq?: number
}

interface PersonaGetResult {
  persona?: { content?: string; status?: string }
  openings?: PersonaOpening[]
}

interface MediaItem {
  id: number
  name: string
  kind: 'image' | 'video' | string
}

interface OpeningDraft {
  id: number | null
  kind: 'text' | 'image' | 'video'
  content: string
  media_name: string
  delay_ms: number
  seq?: number
}

const KIND_LABEL: Record<string, string> = { text: '文本', image: '图片', video: '视频' }
const MIN_DELAY_MS = 2000
const MAX_BYTES = 20 * 1024 * 1024

const props = withDefaults(defineProps<{ modelValue: boolean; position: ServicePosition | null; initialTab?: AgentDrawerTab }>(), { initialTab: 'persona' })
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void; (e: 'changed'): void }>()
const router = useRouter()

const tab = ref<AgentDrawerTab>('persona')
const loading = ref(false)
const persona = ref('')
const savedPersona = ref('')
const openings = ref<PersonaOpening[]>([])
const mediaItems = ref<MediaItem[]>([])
const savingPersona = ref(false)
const savingOpening = ref(false)
const uploading = ref(false)
const draft = ref<OpeningDraft | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const editorRef = ref<HTMLElement | null>(null)
const flow = ref<AgentFlow | null>(null)
const flowLoading = ref(false)

const personaDirty = computed(() => persona.value !== savedPersona.value)
const delaySeconds = computed({
  get: () => Math.round((draft.value?.delay_ms || MIN_DELAY_MS) / 1000),
  set: (value: number) => {
    if (draft.value) draft.value.delay_ms = Math.max(MIN_DELAY_MS, Math.round(value * 1000))
  },
})

function mediaOf(kind: string): MediaItem[] {
  return mediaItems.value.filter((item) => item.kind === kind)
}

function acceptOf(kind: string): string {
  return kind === 'image' ? 'image/*' : 'video/*'
}

async function load(opening = false): Promise<void> {
  if (!props.position) return
  loading.value = true
  draft.value = null
  flowLoading.value = true
  tab.value = drawerTabForLoad(tab.value, props.initialTab, opening)
  try {
    const [personaResult, flowResult] = await Promise.all([
      agentApi.personaGet(props.position.id),
      agentApi.flowGet(props.position.id),
    ])
    const { data } = personaResult
    persona.value = String(data.persona?.content || '')
    savedPersona.value = persona.value
    openings.value = (Array.isArray(data.openings) ? data.openings : []) as unknown as PersonaOpening[]
    flow.value = flowResult.data
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || 'Agent 配置加载失败')
  } finally {
    loading.value = false
    flowLoading.value = false
  }
}

function revealEditor(): void {
  void nextTick(() => {
    editorRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

function openFlowEditor(): void {
  if (!props.position) return
  emit('update:modelValue', false)
  void router.push({ name: 'recruitment-flow', query: { position_id: String(props.position.id) } })
}

async function loadMedia(): Promise<void> {
  try {
    const { data } = await mediaApi.list()
    mediaItems.value = ((data.items || []) as unknown) as MediaItem[]
  } catch {
    mediaItems.value = []
  }
}

async function savePersona(): Promise<void> {
  if (!props.position) return
  savingPersona.value = true
  try {
    await agentApi.personaSave({ position_id: props.position.id, content: persona.value })
    savedPersona.value = persona.value
    ElMessage.success('人设已保存')
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '人设保存失败')
  } finally {
    savingPersona.value = false
  }
}

function startAdd(kind: 'text' | 'image' | 'video'): void {
  void loadMedia()
  draft.value = { id: null, kind, content: '', media_name: '', delay_ms: MIN_DELAY_MS }
  revealEditor()
}

function startEdit(entry: PersonaOpening): void {
  void loadMedia()
  draft.value = {
    id: entry.id,
    kind: entry.kind,
    content: entry.content || '',
    media_name: entry.media_name || '',
    delay_ms: entry.delay_ms || MIN_DELAY_MS,
    seq: entry.seq,
  }
  revealEditor()
}

function pickMedia(): void {
  fileInput.value?.click()
}

async function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result)
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

async function onMediaFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !draft.value) return
  if (file.size > MAX_BYTES) {
    ElMessage.error('文件超过 20MB，请先压缩')
    return
  }
  const kind = file.type.startsWith('video') ? 'video' : 'image'
  uploading.value = true
  try {
    const data_base64 = await readAsBase64(file)
    const { data } = await mediaApi.add({ name: file.name, kind, position_id: 0, data_base64 })
    await loadMedia()
    if (draft.value) draft.value.media_name = String(data?.name || file.name)
    ElMessage.success('素材已上传')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '上传失败')
  } finally {
    uploading.value = false
  }
}

async function saveDraft(): Promise<void> {
  const entry = draft.value
  if (!entry || !props.position) return
  if (entry.kind === 'text' && !entry.content.trim()) {
    ElMessage.warning('正文不能为空')
    return
  }
  if (entry.kind !== 'text' && !entry.media_name) {
    ElMessage.warning('请选择素材')
    return
  }
  savingOpening.value = true
  try {
    const payload = {
      position_id: props.position.id,
      kind: entry.kind,
      content: entry.content,
      media_name: entry.media_name,
      delay_ms: entry.delay_ms,
    }
    if (entry.id) await agentApi.updateOpening(entry.id, payload)
    else await agentApi.createOpening(payload)
    ElMessage.success(entry.id ? '已保存' : '已添加')
    draft.value = null
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '保存失败')
  } finally {
    savingOpening.value = false
  }
}

async function removeEntry(entry: PersonaOpening): Promise<void> {
  try {
    await agentApi.removeOpening(entry.id)
    ElMessage.success('已删除')
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '删除失败')
  }
}

async function move(index: number, offset: number): Promise<void> {
  const target = index + offset
  if (target < 0 || target >= openings.value.length || !props.position) return
  const ids = openings.value.map((entry) => entry.id)
  const swapped = [...ids]
  ;[swapped[index], swapped[target]] = [swapped[target], swapped[index]]
  try {
    await agentApi.reorderOpenings({ position_id: props.position.id, ids: swapped })
    await load()
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '排序失败')
  }
}
</script>

<style scoped>
.drawer-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.drawer-head b {
  font-size: 15px;
}

.head-sub {
  font-size: 12px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.persona-note {
  margin-bottom: 12px;
}

.field-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 12.5px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.char-count {
  color: var(--bd-text-tertiary, #8a94a6);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.dirty-hint {
  font-size: 12px;
  color: #b26a00;
}

.opening-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

/* 主题层的 .el-button.is-plain 把背景刷成实心、文字压成同色，
   这里直接写死配色，不依赖 Element Plus 的 variant 级联。 */
.pill-btn {
  background: #ffffff !important;
  border: 1px solid #c4c7c5 !important;
  color: #0b57d0 !important;
  font-weight: 600;
}

.pill-btn:hover:not(.is-disabled) {
  background: #f0f4f9 !important;
  border-color: #0b57d0 !important;
  color: #0842a0 !important;
}

.flow-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.flow-end {
  color: var(--bd-text-secondary, #5f6b7a);
}

.opening-card.is-editing {
  border-color: var(--bd-primary, #0b57d0);
  box-shadow: 0 0 0 2px rgba(11, 87, 208, 0.12);
}

.opening-hint {
  font-size: 11.5px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-card {
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.opening-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.kind-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--bd-primary, #0b57d0);
}

.kind-tag.image,
.kind-tag.video {
  color: #b26a00;
}

.opening-tools {
  display: flex;
  align-items: center;
  gap: 2px;
}

.opening-body {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bd-text-primary);
}

.opening-caption {
  display: block;
  margin-top: 4px;
  color: var(--bd-text-secondary, #5f6b7a);
}

.opening-delay {
  margin-top: 6px;
  font-size: 11px;
  color: var(--bd-text-tertiary, #8a94a6);
}

.opening-edit {
  border: 1px solid var(--bd-primary, #0b57d0);
  border-radius: 10px;
  padding: 12px;
  margin-top: 12px;
}

.media-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.media-select {
  flex: 1;
}

.media-caption {
  margin-top: 8px;
}

.delay-row {
  margin-top: 10px;
}

.edit-tools {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.flow-actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 14px;
}

.flow-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.flow-status {
  width: 190px;
  margin-left: auto;
}

.flow-card {
  border: 1px solid var(--bd-border, #e8ecf3);
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.flow-body {
  margin-top: 8px;
}

.flow-options {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.hidden-input {
  display: none;
}
</style>
