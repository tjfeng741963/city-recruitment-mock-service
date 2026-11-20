<template>
  <el-drawer
    :model-value="modelValue"
    size="640px"
    :close-on-click-modal="false"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @open="load"
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
          <span class="opening-hint">按顺序发送；每条至少间隔 2 秒</span>
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

      <el-tab-pane label="流程" name="flow">
        <el-alert
          class="persona-note"
          type="info"
          show-icon
          :closable="false"
          title="节点流程默认停用"
          description="先把招聘介绍拆成阶段并保存为停用草稿；只有集中验收通过后，才考虑启用正式岗位。"
        />
        <div v-if="flowLoading" class="opening-empty">流程加载中…</div>
        <template v-else-if="!flow">
          <div class="opening-empty">
            还没有节点流程。可以从当前 7 条开场生成停用草稿，再逐节点检查等待闸门。
            <div class="flow-actions">
              <el-button type="primary" @click="migrateFlow">从当前开场生成停用草稿</el-button>
              <el-button @click="createBlankFlow">创建空白停用草稿</el-button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="flow-toolbar">
            <el-tag :type="flow.status === 'enabled' ? 'success' : 'info'">
              {{ flow.status === 'enabled' ? '新会话已启用' : '已停用' }}
            </el-tag>
            <span class="opening-hint">版本 v{{ flow.version }} · {{ flow.nodes.length }} 个节点</span>
            <el-select v-model="flow.status" size="small" class="flow-status" @change="flowDirty = true">
              <el-option label="停用（不启动新会话）" value="disabled" />
              <el-option label="启用（仅新会话）" value="enabled" />
            </el-select>
          </div>
          <div class="flow-add-row">
            <el-button size="small" class="pill-btn" @click="addFlowNode('text')">+ 发送节点</el-button>
            <el-button size="small" class="pill-btn" @click="addFlowNode('end')">+ 结束节点</el-button>
            <span class="opening-hint">新节点接在当前流程末尾，保存后才生效</span>
          </div>
          <div v-for="(node, index) in flow.nodes" :key="node.node_key" class="flow-card">
            <div class="opening-head">
              <span class="kind-tag">{{ index + 1 }} · {{ node.title || node.node_key }}</span>
              <div class="opening-tools">
                <el-tag size="small" effect="plain">{{ NODE_TYPE_LABEL[node.node_type] || node.node_type }}</el-tag>
                <el-button
                  link
                  size="small"
                  type="danger"
                  :disabled="flow.nodes.length <= 1 || node.node_key === flow.entry_key"
                  :title="node.node_key === flow.entry_key ? '入口节点不能删除' : '删除节点'"
                  @click="removeFlowNode(index)"
                >
                  删除
                </el-button>
              </div>
            </div>
            <div v-if="node.node_type === 'end'" class="opening-body flow-end">
              结束节点：流程到此停止，不发送消息
            </div>
            <el-input
              v-else-if="node.parts?.[0]?.kind === 'text'"
              v-model="node.parts![0].body"
              type="textarea"
              :rows="3"
              class="flow-body"
              @input="flowDirty = true"
            />
            <div v-else class="opening-body">媒体节点：{{ node.parts?.[0]?.media_name || '未设置素材' }}</div>
            <div v-if="node.node_type !== 'end'" class="flow-options">
              <el-checkbox v-model="node.await_reply" @change="onAwaitReplyChange(node)">发完后等待客户回复</el-checkbox>
              <el-input-number
                v-if="node.await_reply"
                v-model="node.wait_minutes"
                :min="1"
                :max="10080"
                size="small"
                controls-position="right"
                @change="flowDirty = true"
              />
              <span v-if="node.await_reply" class="opening-hint">分钟后可进入复聊/结束</span>
            </div>
          </div>
          <div class="foot">
            <span v-if="flowDirty" class="dirty-hint">未保存</span>
            <el-button type="primary" :loading="savingFlow" :disabled="!flowDirty" @click="saveFlow">保存流程</el-button>
          </div>
        </template>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { agentApi, type AgentFlow, type AgentFlowNode } from '../../api/agent'
import { addFlowNode as appendFlowNode, normalizeFlow, removeFlowNode as dropFlowNode } from './flow-graph'
import { mediaApi } from '../../api/core'
import type { ServicePosition } from '../../api/types'

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
const NODE_TYPE_LABEL: Record<string, string> = {
  text: '发送文本',
  image: '发送图片',
  video: '发送视频',
  followup: '一次性复聊',
  branch: '分支',
  end: '结束',
}
const MIN_DELAY_MS = 2000
const MAX_BYTES = 20 * 1024 * 1024

const props = defineProps<{ modelValue: boolean; position: ServicePosition | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void; (e: 'changed'): void }>()

const tab = ref<'persona' | 'opening' | 'flow'>('persona')
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
const savingFlow = ref(false)
const flowDirty = ref(false)

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

async function load(): Promise<void> {
  if (!props.position) return
  loading.value = true
  draft.value = null
  flowLoading.value = true
  flowDirty.value = false
  tab.value = 'persona'
  try {
    const [personaResult, flowResult] = await Promise.all([
      agentApi.personaGet(props.position.id),
      agentApi.flowGet(props.position.id),
    ])
    const { data } = personaResult
    persona.value = String(data.persona?.content || '')
    savedPersona.value = persona.value
    openings.value = (Array.isArray(data.openings) ? data.openings : []) as unknown as PersonaOpening[]
    flow.value = flowResult.data?.version ? normalizeFlow(flowResult.data) : null
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || 'Agent 配置加载失败')
  } finally {
    loading.value = false
    flowLoading.value = false
  }
}

function normalizeFlowDraft(raw: AgentFlow): AgentFlow {
  return normalizeFlow(raw)
}

function createBlankFlow(): void {
  flow.value = {
    position_id: Number(props.position?.id || 0), version: 0, status: 'disabled', entry_key: 'intro', canvas: {},
    nodes: [{ node_key: 'intro', node_type: 'text', title: '招聘介绍', parts: [{ kind: 'text', body: '请填写招聘介绍', delay_ms: 2000 }], await_reply: true, wait_minutes: 15, max_times: 1, status: 'enabled' }],
    edges: [{ from_key: 'intro', to_key: '', trigger: 'any_reply', priority: 0 }],
  }
  flowDirty.value = true
}

function onAwaitReplyChange(node: AgentFlowNode): void {
  if (!flow.value) return
  // The API requires a default edge for continuous nodes and an any_reply
  // fallback for waiting nodes. Keep the migrated edge valid as the operator
  // switches the gate in the editor.
  const fallback = flow.value.edges.find((edge) =>
    edge.from_key === node.node_key && (edge.trigger === 'default' || edge.trigger === 'any_reply'))
  if (fallback) fallback.trigger = node.await_reply ? 'any_reply' : 'default'
  else {
    flow.value.edges.push({
      from_key: node.node_key,
      to_key: '',
      trigger: node.await_reply ? 'any_reply' : 'default',
      condition_value: '',
      priority: 0,
    })
  }
  flowDirty.value = true
}

/** 在流程末尾追加节点；图的合法性由 flow-graph.ts 保证。 */
function addFlowNode(kind: 'text' | 'end'): void {
  if (!flow.value) return
  flow.value = appendFlowNode(flow.value, kind)
  flowDirty.value = true
}

/** 删除节点：前驱边改指向被删节点的后继，入口节点与最后一个节点不可删。 */
function removeFlowNode(index: number): void {
  const current = flow.value
  const node = current?.nodes[index]
  if (!current || !node) return
  const result = dropFlowNode(current, node.node_key)
  if (result.blocked === 'last') {
    ElMessage.warning('流程至少要保留一个节点')
    return
  }
  if (result.blocked === 'entry') {
    ElMessage.warning('入口节点不能删除')
    return
  }
  if (result.blocked) return
  flow.value = result.flow
  flowDirty.value = true
}

function revealEditor(): void {
  void nextTick(() => {
    editorRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
}

async function migrateFlow(): Promise<void> {
  if (!props.position) return
  flowLoading.value = true
  try {
    const { data } = await agentApi.flowMigrate(props.position.id)
    flow.value = data
    flowDirty.value = false
    ElMessage.success('已生成停用流程草稿')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '流程草稿生成失败')
  } finally {
    flowLoading.value = false
  }
}

async function saveFlow(): Promise<void> {
  if (!flow.value) return
  savingFlow.value = true
  try {
    const { data } = await agentApi.flowSave(flow.value)
    flow.value = data
    flowDirty.value = false
    ElMessage.success(data.status === 'enabled' ? '流程已启用' : '流程已保存并保持停用')
    emit('changed')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.detail || '流程保存失败')
  } finally {
    savingFlow.value = false
  }
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
