<template>
  <section class="flow-page">
    <div class="page-header">
      <div>
        <h2 class="page-title">话术流程</h2>
        <p class="page-desc">查看和配置各岗位当前保存的招聘对话流程</p>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :disabled="!positionId" :loading="loading" @click="reloadFlow">刷新</el-button>
        <el-button
          v-if="flow && flow.version === 0 && flow.nodes.length === 0"
          :icon="Upload"
          :disabled="!openingsAvailable"
          :loading="migrating"
          @click="migrateOpening"
        >从开场生成草稿</el-button>
        <el-button type="primary" :icon="Check" :disabled="!isDirty || !flow" :loading="saving" @click="saveFlow">保存流程</el-button>
      </div>
    </div>

    <div class="flow-toolbar">
      <el-select
        :model-value="positionId || undefined"
        class="position-select"
        filterable
        placeholder="选择招聘岗位"
        :loading="positionsLoading"
        :disabled="positionsLoading || positions.length === 0"
        @change="changePosition"
      >
        <el-option
          v-for="position in positions"
          :key="position.id"
          :label="positionLabel(position)"
          :value="position.id"
        />
      </el-select>
      <el-tag v-if="flow" :type="flow.status === 'enabled' ? 'success' : 'info'" effect="light">
        {{ flow.status === 'enabled' ? '新会话已启用' : '已停用' }}
      </el-tag>
      <span v-if="flow" class="flow-version">版本 v{{ flow.version }} · {{ flow.nodes.length }} 节点 · {{ flow.edges.length }} 连接</span>
      <span v-if="isDirty" class="dirty-hint">未保存</span>
      <el-button :disabled="!positionId" @click="router.push({path:'/knowledge',query:{position_id:String(positionId)}})">本岗位问答</el-button>
      <el-button :disabled="!positionId" @click="router.push({path:'/media',query:{position_id:String(positionId)}})">本岗位图片视频</el-button>
      <span class="toolbar-spacer" />
      <el-switch
        v-if="flow && flow.nodes.length"
        :model-value="flow.status === 'enabled'"
        active-text="新会话启用"
        inactive-text="停用"
        @change="(enabled: boolean) => changeFlowStatus(enabled)"
      />
    </div>

    <PositionQa :position-id="positionId" />
    <el-alert v-if="pageError && !conflict" class="page-alert" type="error" :title="pageError" show-icon :closable="false" />
    <el-alert
      v-if="conflict"
      class="page-alert"
      type="warning"
      title="流程已在其他位置更新；本地编辑仍保留，重新载入前不会覆盖新版本。"
      show-icon
      :closable="false"
    >
      <template #default>
        <el-button link type="primary" @click="reloadAfterConflict">载入最新版本</el-button>
      </template>
    </el-alert>

    <div v-if="positionsLoading || loading" class="page-loading">
      <el-skeleton :rows="7" animated />
    </div>
    <el-empty v-else-if="!positions.length" description="暂无可配置的招聘岗位" />
    <template v-else-if="flow">
      <div v-if="!flow.nodes.length" class="empty-flow">
        <el-empty description="该岗位还没有流程图">
          <div class="empty-actions">
            <el-button type="primary" :icon="Plus" @click="createDraft">新建停用草稿</el-button>
            <el-button :icon="Upload" :disabled="!openingsAvailable" :loading="migrating" @click="migrateOpening">
              从开场生成停用草稿
            </el-button>
          </div>
        </el-empty>
      </div>

      <template v-else>
        <div class="graph-actions">
          <el-dropdown @command="addMessageNode">
            <el-button :icon="Plus">添加消息节点<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="text">文本</el-dropdown-item>
                <el-dropdown-item command="image">图片</el-dropdown-item>
                <el-dropdown-item command="video">视频</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button :icon="Share" :disabled="!selectedNode || !canAddBranch" @click="addBranch">添加分支</el-button>
          <el-button :icon="Clock" :disabled="!selectedNode || !selectedNode.await_reply" @click="addFollowup">添加超时复聊</el-button>
          <el-button :icon="CircleClose" :disabled="!canAddEnd" @click="addEnd">添加结束</el-button>
          <el-button :icon="Connection" :disabled="!canAddEdge" @click="addKeywordEdge">添加关键词连接</el-button>
          <el-button :icon="Delete" :disabled="!selectedNode || selectedNode.node_key === flow.entry_key" @click="removeSelectedNode">删除节点</el-button>
          <span class="graph-action-note">拖动节点调整布局；点击节点或连线编辑属性</span>
        </div>

        <div class="flow-workspace">
          <AgentFlowCanvas
            ref="canvas"
            :flow="flow"
            :selected-node-key="selectedNodeKey"
            :selected-edge-index="selectedEdgeIndex"
            @select-node="selectNode"
            @select-edge="selectEdge"
            @move-node="moveNode"
          />

          <aside class="inspector" aria-label="流程属性">
            <template v-if="selectedNode">
              <div class="inspector-heading">
                <div>
                  <div class="inspector-eyebrow">节点属性</div>
                  <h3>{{ nodeTypeLabel(selectedNode.node_type) }}</h3>
                </div>
                <el-tag v-if="selectedNode.node_key === flow.entry_key" type="warning" effect="plain">入口</el-tag>
              </div>

              <el-form label-position="top" size="small" class="inspector-form">
                <el-form-item label="节点名称">
                  <el-input v-model="selectedNode.title" maxlength="200" show-word-limit />
                </el-form-item>
                <el-form-item label="状态">
                  <el-switch
                    :model-value="selectedNode.status !== 'disabled'"
                    active-text="启用"
                    inactive-text="停用"
                    @change="(value: boolean) => setNodeEnabled(selectedNode!, value)"
                  />
                  <div v-if="selectedNode.status === 'disabled'" class="field-note">
                    新会话会跳过此节点内容，并沿主兜底连接继续；在途会话继续使用原流程快照。
                  </div>
                </el-form-item>
                <el-form-item v-if="selectedNode.node_key !== flow.entry_key" label="流程入口">
                  <el-button link type="primary" @click="setEntry(selectedNode!.node_key)">设为入口节点</el-button>
                </el-form-item>

                <template v-if="hasParts(selectedNode)">
                  <div class="inspector-subhead">
                    <span>发送内容</span>
                    <el-button link type="primary" :disabled="isFollowup(selectedNode) || selectedNode.parts!.length >= 6" @click="appendPart(selectedNode!)">
                      添加一条
                    </el-button>
                  </div>
                  <div v-for="(part, index) in selectedNode.parts" :key="`${selectedNode.node_key}-${index}`" class="part-editor">
                    <div class="part-heading">
                      <el-select
                        :model-value="part.kind"
                        :disabled="isFollowup(selectedNode)"
                        class="part-kind"
                        @change="(kind: string) => setPartKind(part, kind)"
                      >
                        <el-option label="文本" value="text" />
                        <el-option label="图片" value="image" />
                        <el-option label="视频" value="video" />
                      </el-select>
                      <el-button
                        v-if="!isFollowup(selectedNode)"
                        link
                        type="danger"
                        :disabled="selectedNode.parts!.length <= 1"
                        title="删除内容"
                        :icon="Delete"
                        @click="removePart(selectedNode!, index)"
                      />
                    </div>
                    <el-input
                      v-if="part.kind === 'text'"
                      v-model="part.body"
                      type="textarea"
                      :rows="3"
                      maxlength="2000"
                      show-word-limit
                      placeholder="输入此节点发送给客户的内容"
                    />
                    <el-select
                      v-else
                      v-model="part.media_name"
                      filterable
                      clearable
                      class="full-width"
                      :placeholder="part.kind === 'image' ? '选择岗位图片素材' : '选择岗位视频素材'"
                    >
                      <el-option
                        v-for="media in availableMedia(part.kind)"
                        :key="media.name"
                        :label="media.name"
                        :value="media.name"
                      />
                    </el-select>
                    <el-form-item label="发送后间隔（秒）" class="compact-item">
                      <el-input-number
                        :model-value="millisecondsToSeconds(part.delay_ms)"
                        :min="0"
                        :max="60"
                        controls-position="right"
                        @update:model-value="(value: number | undefined) => setPartDelay(part, value)"
                      />
                    </el-form-item>
                  </div>
                </template>

                <el-form-item v-if="canWait(selectedNode)" label="等待客户回复">
                  <el-switch
                    :model-value="Boolean(selectedNode.await_reply)"
                    active-text="等待"
                    inactive-text="继续"
                    @change="(value: boolean) => setAwaitReply(selectedNode!, value)"
                  />
                </el-form-item>
                <el-form-item v-if="canWait(selectedNode) && selectedNode.await_reply" label="等待时间（分钟）">
                  <el-input-number v-model="selectedNode.wait_minutes" :min="1" :max="10080" controls-position="right" />
                </el-form-item>
                <el-form-item v-if="isFollowup(selectedNode)" label="复聊次数">
                  <el-input-number :model-value="1" disabled controls-position="right" />
                </el-form-item>
                <el-form-item v-if="selectedNode.node_type !== 'end'" label="节点间隔（秒）">
                  <el-input-number
                    :model-value="millisecondsToSeconds(selectedNode.delay_ms)"
                    :min="0"
                    :max="60"
                    controls-position="right"
                    @update:model-value="(value: number | undefined) => setNodeDelay(selectedNode!, value)"
                  />
                </el-form-item>
              </el-form>
            </template>

            <template v-else-if="selectedEdge">
              <div class="inspector-heading">
                <div>
                  <div class="inspector-eyebrow">连接属性</div>
                  <h3>流程转移</h3>
                </div>
                <el-button
                  link
                  type="danger"
                  :disabled="isRequiredEdge(selectedEdge)"
                  title="删除可选连接"
                  :icon="Delete"
                  @click="removeSelectedEdge"
                />
              </div>
              <el-form label-position="top" size="small" class="inspector-form">
                <el-form-item label="从节点">
                  <el-input :model-value="nodeTitle(selectedEdge.from_key)" disabled />
                </el-form-item>
                <el-form-item label="触发条件">
                    <el-select
                      :model-value="selectedEdge.trigger"
                      :disabled="isRequiredEdge(selectedEdge)"
                      class="full-width"
                    >
                    <el-option v-if="isRequiredEdge(selectedEdge)" :label="triggerDescription(selectedEdge)" :value="selectedEdge.trigger" />
                    <el-option v-else label="匹配关键词" value="keyword" />
                    <el-option v-if="selectedEdge.trigger === 'giveup'" label="旧版放弃条件（当前客户端不执行）" value="giveup" disabled />
                  </el-select>
                </el-form-item>
                <el-form-item v-if="selectedEdge.trigger === 'keyword'" label="关键词">
                  <el-input v-model="selectedEdge.condition_value" maxlength="500" placeholder="客户消息包含此词时走此分支" />
                </el-form-item>
                <el-form-item label="目标节点">
                  <el-select v-model="selectedEdge.to_key" class="full-width" clearable placeholder="结束此分支">
                    <el-option
                      v-for="node in flow.nodes.filter((item) => item.node_key !== selectedEdge!.from_key && (selectedEdge!.trigger !== 'timeout' || item.node_type === 'followup'))"
                      :key="node.node_key"
                      :label="`${node.title || node.node_key}${node.status === 'disabled' ? '（停用，运行时跳过）' : ''}`"
                      :value="node.node_key"
                    />
                  </el-select>
                </el-form-item>
                <el-form-item label="优先级">
                  <el-input-number v-model="selectedEdge.priority" :min="-10000" :max="10000" controls-position="right" />
                </el-form-item>
                <el-alert
                  v-if="selectedEdge.trigger === 'giveup'"
                  type="warning"
                  :closable="false"
                  title="当前客户端运行器没有处理此条件的分支逻辑。"
                />
                <div v-if="isRequiredEdge(selectedEdge)" class="field-note">这是运行流程必需的兜底连接，不能删除。</div>
              </el-form>
            </template>

            <el-empty v-else :image-size="72" description="选择节点或连接编辑参数" />
          </aside>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import PositionQa from '../components/agent/PositionQa.vue'
import { computed, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Check, CircleClose, Clock, Connection, Delete, Plus, Refresh, Share, Upload } from '@element-plus/icons-vue'
import AgentFlowCanvas from '../components/agent/AgentFlowCanvas.vue'
import { agentApi, type AgentFlow, type AgentFlowEdge, type AgentFlowNode, type AgentFlowPart } from '../api/agent'
import { mediaApi, positionsApi } from '../api/core'
import type { ServicePosition } from '../api/types'
import { toArray } from '../utils/format'
import {
  addBranchNode,
  addFlowEdge,
  addFlowNode,
  addFollowupNode,
  changeFlowEntry,
  createBlankFlow,
  flowActivationIssues,
  flowRequiresEnableConfirmation,
  moveFlowNode,
  newlyDisabledNodeKeys,
  normalizeFlow,
  removeFlowEdge,
  removeFlowNode,
} from '../components/basic/flow-graph'

interface MediaOption {
  name: string
  kind: string
  position_id: number
  status: string
}

import { readPositionContext, savePositionContext } from '../utils/position-context'
import { useAuthStore } from '../stores/auth'
const auth = useAuthStore()
const userKey = () => auth.user?.id ?? auth.user?.username ?? ''
const route = useRoute()
const router = useRouter()
const positions = ref<ServicePosition[]>([])
const positionsLoading = ref(false)
const loading = ref(false)
const saving = ref(false)
const migrating = ref(false)
const pageError = ref('')
const conflict = ref(false)
const positionId = ref(0)
const flow = ref<AgentFlow | null>(null)
const mediaItems = ref<MediaOption[]>([])
const selectedNodeKey = ref('')
const selectedEdgeIndex = ref<number | null>(null)
const canvas = ref<InstanceType<typeof AgentFlowCanvas> | null>(null)
const baseline = ref('')
const openingsAvailable = ref(false)

const isDirty = computed(() => Boolean(flow.value && JSON.stringify(flow.value) !== baseline.value))
const selectedNode = computed(() => flow.value?.nodes.find((node) => node.node_key === selectedNodeKey.value) ?? null)
const selectedEdge = computed(() => {
  if (!flow.value || selectedEdgeIndex.value === null) return null
  return flow.value.edges[selectedEdgeIndex.value] ?? null
})
const canAddBranch = computed(() => {
  if (!flow.value || !selectedNode.value) return false
  return flow.value.edges.some((edge) => edge.from_key === selectedNode.value!.node_key && ['default', 'any_reply'].includes(edge.trigger))
})
const canAddEnd = computed(() => flow.value?.nodes.some((node) => ['text', 'image', 'video', 'branch'].includes(node.node_type)) ?? false)
const canAddEdge = computed(() => Boolean(selectedNode.value &&
  (selectedNode.value.node_type === 'branch' || (canWait(selectedNode.value) && selectedNode.value.await_reply))))

function positionLabel(position: ServicePosition): string {
  return [position.city_name, position.position_name].filter(Boolean).join(' · ')
}

function errorText(error: any, fallback: string): string {
  return String(error?.response?.data?.detail || error?.message || fallback)
}

function snapshot(value: AgentFlow | null): string {
  return value ? JSON.stringify(value) : ''
}

function chooseSelection(value: AgentFlow): void {
  selectedNodeKey.value = value.nodes.find((node) => node.node_key === value.entry_key)?.node_key || value.nodes[0]?.node_key || ''
  selectedEdgeIndex.value = null
}

async function loadPositions(): Promise<void> {
  positionsLoading.value = true
  pageError.value = ''
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 1000 })
    positions.value = toArray<ServicePosition>(data)
    const requested = Number(route.query.position_id) || readPositionContext(userKey())
    const requestedExists = positions.value.some((position) => position.id === requested)
    const nextId = requestedExists ? requested : positions.value[0]?.id ?? 0
    positionId.value = nextId
    if (nextId) savePositionContext(userKey(), nextId)
    if (nextId && String(route.query.position_id || '') !== String(nextId)) {
      await router.replace({ query: { ...route.query, position_id: String(nextId) } })
    }
    if (nextId) await loadFlow(nextId)
  } catch (error) {
    pageError.value = errorText(error, '岗位列表加载失败')
  } finally {
    positionsLoading.value = false
  }
}

async function loadFlow(id: number): Promise<void> {
  loading.value = true
  pageError.value = ''
  conflict.value = false
  try {
    const [flowResult, personaResult, mediaResult] = await Promise.all([
      agentApi.flowGet(id),
      agentApi.personaGet(id),
      mediaApi.list({ page: 1, page_size: 1000 }).catch(() => null),
    ])
    flow.value = normalizeFlow(flowResult.data)
    openingsAvailable.value = Array.isArray(personaResult.data.openings) && personaResult.data.openings.length > 0
    mediaItems.value = toArray<Record<string, unknown>>(mediaResult?.data).map((item) => ({
      name: String(item.name || ''),
      kind: String(item.kind || ''),
      position_id: Number(item.position_id || 0),
      status: String(item.status || ''),
    })).filter((item) => item.name)
    chooseSelection(flow.value)
    baseline.value = snapshot(flow.value)
  } catch (error) {
    pageError.value = errorText(error, '流程加载失败')
    flow.value = null
    openingsAvailable.value = false
    mediaItems.value = []
    baseline.value = ''
  } finally {
    loading.value = false
  }
}

async function changePosition(rawId: string | number): Promise<void> {
  const nextId = Number(rawId)
  if (!nextId || nextId === positionId.value) return
  if (isDirty.value) {
    try {
      await ElMessageBox.confirm('切换岗位会丢弃尚未保存的流程修改。', '切换岗位', {
        type: 'warning', confirmButtonText: '切换', cancelButtonText: '留在当前岗位',
      })
    } catch {
      return
    }
  }
  positionId.value = nextId
  savePositionContext(userKey(), nextId)
  await router.replace({ query: { ...route.query, position_id: String(nextId) } })
  await loadFlow(nextId)
}

watch(() => route.query.position_id, async (rawId) => {
  const nextId = Number(rawId)
  if (!nextId || nextId === positionId.value || !positions.value.some((position) => position.id === nextId)) return
  if (isDirty.value) {
    try {
      await ElMessageBox.confirm('切换岗位会丢弃尚未保存的流程修改。', '切换岗位', {
        type: 'warning', confirmButtonText: '切换', cancelButtonText: '留在当前岗位',
      })
    } catch {
      await router.replace({ query: { ...route.query, position_id: String(positionId.value) } })
      return
    }
  }
  positionId.value = nextId
  savePositionContext(userKey(), nextId)
  await loadFlow(nextId)
})

async function reloadFlow(): Promise<void> {
  if (!positionId.value) return
  if (isDirty.value) {
    try {
      await ElMessageBox.confirm('重新载入会丢弃当前未保存的修改。', '刷新流程', {
        type: 'warning', confirmButtonText: '重新载入', cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  await loadFlow(positionId.value)
}

async function reloadAfterConflict(): Promise<void> {
  if (isDirty.value) {
    try {
      await ElMessageBox.confirm('重新载入会丢弃当前未保存的修改。', '载入最新流程', {
        type: 'warning', confirmButtonText: '重新载入', cancelButtonText: '取消',
      })
    } catch {
      return
    }
  }
  if (positionId.value) await loadFlow(positionId.value)
}

function createDraft(): void {
  if (!positionId.value) return
  flow.value = createBlankFlow(positionId.value) as AgentFlow
  baseline.value = ''
  chooseSelection(flow.value)
  conflict.value = false
}

function changeFlowStatus(enabled: boolean): void {
  if (flow.value) flow.value.status = enabled ? 'enabled' : 'disabled'
}

async function migrateOpening(): Promise<void> {
  if (!positionId.value || !flow.value || flow.value.version !== 0) return
  migrating.value = true
  pageError.value = ''
  try {
    const { data } = await agentApi.flowMigrate(positionId.value)
    flow.value = normalizeFlow(data)
    baseline.value = snapshot(flow.value)
    chooseSelection(flow.value)
    ElMessage.success('已生成停用草稿')
  } catch (error) {
    pageError.value = errorText(error, '从开场生成草稿失败')
  } finally {
    migrating.value = false
  }
}

async function saveFlow(): Promise<void> {
  if (!flow.value || !isDirty.value || saving.value) return
  if (flow.value.status === 'enabled') {
    const issues = flowActivationIssues(flow.value)
    if (issues.length) {
      pageError.value = `启用前请修正：${issues.join('；')}`
      return
    }
  }
  const before = baseline.value ? JSON.parse(baseline.value) as AgentFlow : null
  const previousStatus = String(before?.status || 'disabled')
  const skippedNodes = before ? newlyDisabledNodeKeys(before, flow.value) : []
  if (skippedNodes.length) {
    const titles = skippedNodes.map((key) => flow.value?.nodes.find((node) => node.node_key === key)?.title || key)
    try {
      await ElMessageBox.confirm(
        `停用节点后，Windows 客户端会跳过这些节点及其超时/关键词条件，并沿主兜底连接继续：${titles.join('、')}。在途会话仍按原快照运行。`,
        '确认停用流程节点',
        { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '继续编辑' },
      )
    } catch {
      return
    }
  }
  if (flowRequiresEnableConfirmation(previousStatus, flow.value.status)) {
    try {
      await ElMessageBox.confirm('启用后，新客户会开始按此流程自动处理。现有会话继续使用已保存的流程快照。', '启用招聘流程', {
        type: 'warning', confirmButtonText: '启用流程', cancelButtonText: '继续编辑',
      })
    } catch {
      flow.value.status = previousStatus
      return
    }
  }
  saving.value = true
  pageError.value = ''
  conflict.value = false
  try {
    const { data } = await agentApi.flowSave(flow.value)
    flow.value = normalizeFlow(data)
    baseline.value = snapshot(flow.value)
    chooseSelection(flow.value)
    ElMessage.success(flow.value.status === 'enabled' ? '流程已启用' : '流程已保存并保持停用')
  } catch (error: any) {
    if (Number(error?.response?.status) === 409) {
      conflict.value = true
      pageError.value = '流程版本已变化；当前修改仍保留，请载入最新版本后再编辑。'
    } else {
      pageError.value = errorText(error, '流程保存失败')
    }
  } finally {
    saving.value = false
  }
}

function selectNode(nodeKey: string): void {
  selectedNodeKey.value = nodeKey
  selectedEdgeIndex.value = null
}

function selectEdge(index: number): void {
  selectedEdgeIndex.value = index
  selectedNodeKey.value = ''
}

function moveNode(nodeKey: string, x: number, y: number): void {
  if (flow.value) flow.value = moveFlowNode(flow.value, nodeKey, x, y)
}

function addMessageNode(kind: string): void {
  if (!flow.value) return
  if (!['text', 'image', 'video'].includes(kind)) return
  try {
    flow.value = addFlowNode(flow.value, kind as 'text' | 'image' | 'video')
    selectedNodeKey.value = flow.value.nodes.at(-1)?.node_key || ''
    selectedEdgeIndex.value = null
  } catch (error) {
    ElMessage.warning(errorText(error, '无法添加节点'))
  }
}

function addBranch(): void {
  if (!flow.value || !selectedNode.value) return
  try {
    flow.value = addBranchNode(flow.value, selectedNode.value.node_key)
    selectedNodeKey.value = flow.value.nodes.at(-1)?.node_key || ''
    selectedEdgeIndex.value = null
  } catch (error) {
    ElMessage.warning(errorText(error, '无法添加分支'))
  }
}

function addFollowup(): void {
  if (!flow.value || !selectedNode.value) return
  try {
    flow.value = addFollowupNode(flow.value, selectedNode.value.node_key)
    selectedNodeKey.value = flow.value.nodes.at(-1)?.node_key || ''
    selectedEdgeIndex.value = null
  } catch (error) {
    ElMessage.warning(errorText(error, '无法添加超时复聊'))
  }
}

function addEnd(): void {
  if (!flow.value) return
  try {
    flow.value = addFlowNode(flow.value, 'end')
    selectedNodeKey.value = flow.value.nodes.at(-1)?.node_key || ''
    selectedEdgeIndex.value = null
  } catch (error) {
    ElMessage.warning(errorText(error, '无法添加结束节点'))
  }
}

function addKeywordEdge(): void {
  if (!flow.value || !selectedNode.value) return
  try {
    flow.value = addFlowEdge(flow.value, selectedNode.value.node_key)
    selectedEdgeIndex.value = flow.value.edges.length - 1
    selectedNodeKey.value = ''
  } catch (error) {
    ElMessage.warning(errorText(error, '无法添加关键词连接'))
  }
}

function removeSelectedNode(): void {
  if (!flow.value || !selectedNode.value) return
  const result = removeFlowNode(flow.value, selectedNode.value.node_key)
  if (result.blocked) {
    ElMessage.warning(result.blocked === 'entry' ? '入口节点不能删除' : '流程至少要保留一个节点')
    return
  }
  flow.value = result.flow
  chooseSelection(flow.value)
}

function removeSelectedEdge(): void {
  if (!flow.value || selectedEdgeIndex.value === null) return
  const result = removeFlowEdge(flow.value, selectedEdgeIndex.value)
  if (result.blocked === 'required-fallback') {
    ElMessage.warning('运行流程必需的兜底连接不能删除')
    return
  }
  if (result.blocked) return
  flow.value = result.flow
  selectedEdgeIndex.value = null
}

function setEntry(nodeKey: string): void {
  if (!flow.value) return
  const result = changeFlowEntry(flow.value, nodeKey)
  if (result.blocked) {
    ElMessage.warning('停用节点不能设为流程入口')
    return
  }
  if (result.disabledNodeKeys.length) {
    const titles = result.disabledNodeKeys.map((key) => flow.value?.nodes.find((node) => node.node_key === key)?.title || key)
    ElMessageBox.confirm(
      `新入口会使以下节点无法从入口到达，确认将其停用：${titles.join('、')}？`,
      '调整流程入口',
      { type: 'warning', confirmButtonText: '调整并停用', cancelButtonText: '取消' },
    ).then(() => { flow.value = result.flow }).catch(() => undefined)
    return
  }
  flow.value = result.flow
}

function setNodeEnabled(node: AgentFlowNode, enabled: boolean): void {
  if (!flow.value) return
  if (!enabled && node.node_key === flow.value.entry_key) {
    ElMessage.warning('入口节点不能停用')
    return
  }
  if (!enabled && canWait(node) && flow.value.nodes.some((item) =>
    item.node_type === 'followup' && item.status !== 'disabled' &&
    flow.value!.edges.some((edge) => edge.from_key === node.node_key && edge.to_key === item.node_key && edge.trigger === 'timeout'),
  )) {
    for (const followup of flow.value.nodes) {
      if (followup.node_type === 'followup' && flow.value.edges.some((edge) =>
        edge.from_key === node.node_key && edge.to_key === followup.node_key && edge.trigger === 'timeout',
      )) followup.status = 'disabled'
    }
    ElMessage.info('关联的超时复聊节点也已停用')
  }
  node.status = enabled ? 'enabled' : 'disabled'
}

function setAwaitReply(node: AgentFlowNode, waiting: boolean): void {
  if (!flow.value) return
  if (!waiting && flow.value.edges.some((edge) => edge.from_key === node.node_key && edge.trigger === 'timeout')) {
    ElMessage.warning('请先删除此节点的超时复聊连接')
    return
  }
  if (!waiting && flow.value.edges.some((edge) => edge.from_key === node.node_key && edge.trigger === 'keyword')) {
    ElMessage.warning('请先删除关键词连接；连续执行节点不会检查客户回复')
    return
  }
  node.await_reply = waiting
  const primary = flow.value.edges.find((edge) => edge.from_key === node.node_key && ['default', 'any_reply'].includes(edge.trigger))
  if (primary) primary.trigger = waiting ? 'any_reply' : 'default'
  else flow.value.edges.push({
    from_key: node.node_key,
    to_key: '',
    trigger: waiting ? 'any_reply' : 'default',
    condition_value: '',
    priority: 0,
  })
}

function hasParts(node: AgentFlowNode): boolean {
  return !['branch', 'end'].includes(node.node_type)
}

function canWait(node: AgentFlowNode): boolean {
  return ['text', 'image', 'video'].includes(node.node_type)
}

function isFollowup(node: AgentFlowNode): boolean {
  return node.node_type === 'followup'
}

function appendPart(node: AgentFlowNode): void {
  if (!flow.value || !node.parts || node.parts.length >= 6 || isFollowup(node)) return
  node.parts.push({ kind: 'text', body: '', media_name: '', delay_ms: 2000 })
}

function removePart(node: AgentFlowNode, index: number): void {
  if (!flow.value || !node.parts || node.parts.length <= 1) return
  node.parts.splice(index, 1)
}

function setPartKind(part: AgentFlowPart, kind: string): void {
  if (!['text', 'image', 'video'].includes(kind)) return
  part.kind = kind
  part.media_name = ''
  if (kind === 'text') {
    part.body = part.body || ''
  } else {
    part.media_name = part.media_name || ''
    part.body = part.body || ''
  }
}

function setPartDelay(part: AgentFlowPart, seconds: number | undefined): void {
  part.delay_ms = Math.max(0, Math.min(60, Number(seconds) || 0)) * 1000
}

function setNodeDelay(node: AgentFlowNode, seconds: number | undefined): void {
  node.delay_ms = Math.max(0, Math.min(60, Number(seconds) || 0)) * 1000
}

function millisecondsToSeconds(value: unknown): number {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : 2
}

function availableMedia(kind: string): MediaOption[] {
  return mediaItems.value.filter((item) =>
    item.kind === kind && item.status === 'enabled' && (item.position_id === 0 || item.position_id === positionId.value),
  )
}

function nodeTitle(nodeKey: string): string {
  const node = flow.value?.nodes.find((item) => item.node_key === nodeKey)
  return node?.title || nodeKey || '结束'
}

function nodeTypeLabel(nodeType: string): string {
  return ({ text: '文本节点', image: '图片节点', video: '视频节点', followup: '超时复聊', branch: '条件分支', end: '结束节点' } as Record<string, string>)[nodeType] || nodeType
}

function isRequiredEdge(edge: AgentFlowEdge): boolean {
  if (['default', 'any_reply'].includes(edge.trigger)) return true
  if (edge.trigger !== 'timeout') return false
  const target = flow.value?.nodes.find((node) => node.node_key === edge.to_key)
  return target?.node_type === 'followup' && target.status !== 'disabled'
}

function triggerDescription(edge: AgentFlowEdge): string {
  if (edge.trigger === 'default') return '必需兜底：继续执行'
  if (edge.trigger === 'any_reply') return '必需兜底：客户回复'
  if (edge.trigger === 'timeout') return isRequiredEdge(edge) ? '启用复聊必需连接' : '可选超时连接'
  return edge.trigger
}

onBeforeRouteLeave(async () => {
  if (!isDirty.value) return true
  if (saving.value || migrating.value) return false
  try {
    await ElMessageBox.confirm('离开页面会丢弃尚未保存的流程修改。', '离开流程图', {
      type: 'warning', confirmButtonText: '离开', cancelButtonText: '留在页面',
    })
    return true
  } catch {
    return false
  }
})

onMounted(loadPositions)
</script>

<style scoped>
.flow-page { min-width: 0; }
.flow-toolbar,
.graph-actions,
.empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.flow-toolbar { min-height: 52px; margin-bottom: 12px; padding: 8px 12px; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.position-select { width: min(360px, 100%); }
.flow-version,.graph-action-note { color: var(--bd-text-tertiary, #7b8494); font-size: 12px; }
.toolbar-spacer { flex: 1; }
.dirty-hint { color: var(--el-color-warning); font-size: 12px; }
.page-alert { margin-bottom: 12px; }
.page-loading,.empty-flow { min-height: 360px; padding: 28px; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.empty-actions { justify-content: center; }
.graph-actions { margin-bottom: 12px; }
.graph-action-note { margin-left: auto; }
.flow-workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 330px); align-items: start; gap: 12px; min-width: 0; }
.inspector { min-width: 0; max-height: min(68vh, 760px); padding: 14px; overflow: auto; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.inspector-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
.inspector-heading h3 { margin: 3px 0 0; font-size: 15px; font-weight: 600; }
.inspector-eyebrow { color: var(--bd-text-tertiary, #7b8494); font-size: 11px; }
.inspector-form { min-width: 0; }
.inspector-subhead,.part-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.inspector-subhead { margin: 4px 0 8px; color: var(--bd-text-secondary, #5f6b7a); font-size: 12px; font-weight: 600; }
.part-editor { display: grid; gap: 8px; margin-bottom: 10px; padding: 10px; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 5px; }
.part-kind { width: 120px; }
.compact-item { margin: 0; }
.full-width { width: 100%; }
.field-note { color: var(--bd-text-tertiary, #7b8494); font-size: 12px; line-height: 1.5; }
@media (max-width: 1000px) {
  .flow-workspace { grid-template-columns: minmax(0, 1fr); }
  .inspector { max-height: none; }
}
@media (max-width: 640px) {
  .flow-toolbar { align-items: stretch; }
  .position-select { width: 100%; }
  .toolbar-spacer { display: none; }
  .graph-action-note { width: 100%; margin-left: 0; }
  .page-header { align-items: flex-start; }
}
</style>
