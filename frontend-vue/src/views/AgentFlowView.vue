<template>
  <section class="flow-page" :class="{ 'is-fullscreen': fullscreen }" :style="{ '--inspector-width': `${inspectorWidth}px` }">
    <div class="page-header">
      <el-button v-if="fullscreen" ref="exitFullscreenButton" :icon="ArrowLeft" type="primary" plain @click="exitFullscreen">
        返回普通视图
      </el-button>
      <div class="page-heading">
        <h2 class="page-title">话术流程 <el-tag effect="plain" type="primary">系统 Agent</el-tag></h2>
      </div>
      <div class="header-actions">
        <el-button v-if="viewMode === 'edit'" type="primary" :icon="Check"
          :disabled="!isDirty || !flow || loading || migrating" :loading="saving" @click="saveFlow">保存流程</el-button>
      </div>
    </div>

    <div class="flow-toolbar">
      <el-select
        :model-value="positionId || undefined"
        class="position-select"
        filterable
        placeholder="选择招聘岗位"
        :loading="positionsLoading"
        :disabled="positionsLoading || loading || saving || migrating || positions.length === 0"
        @change="changePosition"
      >
        <el-option
          v-for="position in positions"
          :key="position.id"
          :label="positionLabel(position)"
          :value="position.id"
        />
      </el-select>
      <el-tag v-if="savedFlow" :type="savedFlow.status === 'enabled' ? 'success' : 'info'" effect="light">
        {{ savedFlow.status === 'enabled' ? '已保存：节点流程启用' : '已保存：节点流程停用' }}
      </el-tag>
      <span v-if="flow" class="flow-version">版本 v{{ flow.version }} · {{ flow.nodes.length }} 节点 · {{ flow.edges.length }} 连接</span>
      <span v-if="isDirty" class="dirty-hint">未保存</span>
      <span class="toolbar-spacer" />
      <el-button v-if="auth.user?.role === 'admin'" @click="testVisible = true">接待测试</el-button>
      <el-button :icon="Refresh" :disabled="!positionId || saving || migrating" :loading="loading" @click="reloadFlow">刷新</el-button>
      <el-dropdown trigger="click" :disabled="positionsLoading || loading || saving || migrating" @command="openConfiguration">
        <el-button type="primary" :disabled="positionsLoading || loading || saving || migrating">
          岗位配置<el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="flow" :disabled="!savedFlow">编辑流程</el-dropdown-item>
            <el-dropdown-item command="opening" :disabled="!savedFlow">编辑开场</el-dropdown-item>
            <el-dropdown-item command="persona" :disabled="!savedFlow">编辑人设</el-dropdown-item>
            <el-dropdown-item command="knowledge" divided>{{ positionId ? '岗位问答' : '问答知识库' }}</el-dropdown-item>
            <el-dropdown-item command="media">图片与视频</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <div v-if="savedFlow && !loading" class="runtime-status-bar">
      <span><strong>绑定设备</strong>：{{ boundDevices.length ? boundDevices.map(device => device.device_code).join('、') : devicesAvailable ? '未绑定设备，当前无人执行该岗位' : '设备列表读取失败，绑定状态未知' }}</span>
      <span class="field-note">系统 Agent 保存路径：{{ savedFlow.status === 'enabled' ? '节点流程' : '旧开场' }}；保存版本 {{ savedFlow.status === 'enabled' ? `v${savedFlow.version}` : openingVersion ? openingVersion.slice(0, 10) : '未知' }}</span>
      <el-button link type="primary" @click="runtimeDetails = !runtimeDetails">{{ runtimeDetails ? '收起运行说明' : '查看运行说明与状态' }}</el-button>
    </div>

    <div v-if="boundDevices.length && savedFlow && !loading" class="config-sync-status">
      <div v-for="device in boundDevices" :key="device.device_code" class="config-sync-row">
        <strong>{{ device.device_code }}</strong>
        <el-tag size="small" :title="syncView(device.device_code).detail" :type="syncView(device.device_code).state === 'synced' ? 'success' : syncView(device.device_code).state === 'blocked' ? 'danger' : 'info'">{{ syncView(device.device_code).label }}</el-tag>
        <span>安装版本 {{ clientSync[device.device_code]?.client_commit?.slice(0, 8) || '未上报' }} · 拉取时间 {{ formatTime(syncView(device.device_code).time) }}</span>
      </div>
    </div>

    <div v-if="viewMode === 'runtime' && savedFlow && !loading" class="runtime-media-summary">
      <span>固定{{ savedFlow.status === 'enabled' ? '节点' : '开场' }}：{{ fixedMediaCounts.images }} 张图片、{{ fixedMediaCounts.videos }} 个视频</span>
      <span>按需素材：{{ aiMediaBranches.filter(item => item.kind === 'image').length }} 张图片、{{ aiMediaBranches.filter(item => item.kind === 'video').length }} 个视频</span>
      <span v-if="!aiContextAvailable" class="field-note">AI 素材上下文读取失败，按需分支未知</span>
    </div>

    <div v-if="runtimeDetails && savedFlow" class="runtime-details">
      <p>这里显示按服务器配置推导的路径。没有运行客户端、企微未登录或没有客户触发时，不会自动发送。网页点击节点只查看配置。</p>
      <p v-if="isDirty">编辑器有未保存修改；实际执行路径仍使用上次保存的 v{{ savedFlow.version }}。</p>
      <p v-if="contentMatches">节点内容与旧开场逐条一致；等待方式仍以节点连接为准，内容一致不代表发送节奏一致。</p>
      <p v-else>节点流程与旧开场内容不同。启用时走节点流程，停用时新客户走旧开场；已有会话保留自己的流程快照。</p>
      <p>节点流程会在本轮文本确认发到目标会话后发送素材。按需素材随答复选择。</p>
      <div v-for="device in boundDevices" :key="device.device_code" class="device-evidence">
        <strong>{{ device.device_code }}</strong> · 最后心跳 {{ formatTime(device.last_online) }}
        <template v-if="mirrorErrors.includes(device.device_code)"> · 状态汇总读取失败</template>
        <template v-else-if="!mirrors.some(row => row.device_code === device.device_code)"> · 没有流程状态上报；无法证明该设备已执行节点</template>
        <div v-for="row in mirrors.filter(item => item.device_code === device.device_code)" :key="`${row.position_id}-${row.flow_version}-${row.node_key}-${row.phase}`">
          v{{ row.flow_version }} · {{ row.node_key }} · {{ phaseLabel(row.phase) }} · {{ row.count }} 个会话 · {{ formatTime(row.updated_at) }}
        </div>
      </div>
      <p class="field-note">配置拉取和状态上报不是送达回执。</p>
    </div>

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
      <div class="canvas-bar">
        <div class="canvas-summary">
          <strong>{{ viewMode === 'runtime' ? '实际执行路径' : '流程编辑' }}</strong>
        </div>
        <div class="canvas-actions">
          <el-switch
            v-if="viewMode === 'edit' && flow.nodes.length"
            :model-value="flow.status === 'enabled'"
            active-text="新会话启用"
            inactive-text="停用"
            @change="(enabled: boolean) => changeFlowStatus(enabled)"
          />
          <el-button v-if="viewMode === 'edit'" :disabled="saving || migrating" @click="showRuntime">查看执行路径</el-button>
          <el-button v-if="!fullscreen" ref="enterFullscreenButton" :icon="FullScreen" @click="enterFullscreen">
            全屏画布
          </el-button>
        </div>
      </div>

      <div id="flow-canvas-panel" class="canvas-panel">
        <div v-if="viewMode === 'edit' && !flow.nodes.length" class="empty-flow">
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
          <div v-if="viewMode === 'edit'" class="graph-actions">
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
          </div>

          <div class="flow-workspace">
            <div class="canvas-column">
            <AgentFlowCanvas
              ref="canvas"
              :flow="displayFlow"
              :readonly="viewMode === 'runtime'"
              :selected-node-key="displayNodeKey"
              :selected-edge-index="displayEdgeIndex"
              @select-node="selectDisplayNode"
              @select-edge="selectDisplayEdge"
              @move-node="moveNode"
            />

            </div>

            <div class="inspector-resizer" role="separator" aria-label="调整右侧编辑栏宽度" aria-orientation="vertical"
              tabindex="0" :aria-valuenow="inspectorWidth" :aria-valuemin="300" :aria-valuemax="520"
              @pointerdown="beginInspectorResize" @pointermove="moveInspectorResize" @pointerup="endInspectorResize" @pointercancel="endInspectorResize"
              @keydown.left.prevent="inspectorWidth = Math.min(520, inspectorWidth + 20)"
              @keydown.right.prevent="inspectorWidth = Math.max(300, inspectorWidth - 20)" />

            <aside class="inspector" aria-label="流程属性">
              <FlowRuntimeInspector v-if="viewMode === 'runtime'" :graph="displayFlow" :node="runtimeNode" :edge="runtimeEdge"
                :legacy="savedFlow?.status !== 'enabled'"
                @select-node="selectDisplayNode" />
              <template v-else-if="selectedNode">
                <div class="inspector-heading">
                  <div>
                    <div class="inspector-eyebrow">节点属性</div>
                    <h3>{{ nodeTypeLabel(selectedNode.node_type) }}</h3>
                  </div>
                  <el-tag v-if="selectedNode.node_key === flow.entry_key" type="warning" effect="plain">入口</el-tag>
                </div>

                <el-collapse class="node-execution-notes">
                  <el-collapse-item title="这个节点实际如何发送" name="execution">
                    <p v-for="line in selectedNodeExplanation" :key="line" class="field-note">{{ line }}</p>
                  </el-collapse-item>
                </el-collapse>

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
                          <el-option label="企微位置卡" value="favorite_location" />
                        </el-select>
                        <el-button v-if="!isFollowup(selectedNode) && selectedNode.parts!.length > 1" link
                          :disabled="index === 0" @click="movePart(selectedNode!, index, -1)">上移</el-button>
                        <el-button v-if="!isFollowup(selectedNode) && selectedNode.parts!.length > 1" link
                          :disabled="index === selectedNode.parts!.length - 1" @click="movePart(selectedNode!, index, 1)">下移</el-button>
                        <el-button
                          v-if="!isFollowup(selectedNode)"
                          link
                          type="danger"
                          :disabled="selectedNode.parts!.length <= 1"
                          :icon="Delete"
                          @click="removePart(selectedNode!, index)"
                        >删除内容</el-button>
                      </div>
                      <el-select v-if="part.kind === 'text' && savedOpeningTexts.length"
                        aria-label="选用已保存开场文字" class="full-width opening-picker" filterable
                        placeholder="选用已保存开场文字" :model-value="undefined"
                        @change="(id: number) => useOpeningText(part, id)">
                        <el-option v-for="opening in savedOpeningTexts" :key="opening.id" :value="opening.id!"
                          :label="'开场 ' + opening.seq + ' · ' + opening.content?.slice(0, 52)" />
                      </el-select>
                      <el-input
                        v-if="part.kind === 'text'"
                        v-model="part.body"
                        type="textarea"
                        :rows="3"
                        maxlength="2000"
                        show-word-limit
                        placeholder="输入此节点发送给客户的内容"
                      />
                      <template v-else-if="part.kind === 'favorite_location'">
                        <el-form-item label="发送哪个面试点" class="compact-item">
                          <el-select v-model="part.interview_point" class="full-width" filterable
                            placeholder="选择面试点"
                            :loading="locationPointsLoading" loading-text="正在读取面试点…"
                            :no-data-text="locationPointsError || '该岗位暂无面试点'"
                            @visible-change="refreshLocationPoints">
                            <el-option v-for="(point, pointIndex) in locationPoints" :key="`${point.name}-${pointIndex}`" :value="point.name"
                              :label="`${point.name} · ${point.title}`"
                              :disabled="point.disabled || locationPointsLoading || Boolean(locationPointsError)" />
                          </el-select>
                          <div v-if="locationPointsError" class="field-note" role="status">{{ locationPointsError }}</div>
                          <div v-else-if="!locationPointsLoading && !locationPoints.length" class="field-note">请在该岗位「面试与门店」添加面试点、地址和经纬度，保存后再展开。</div>
                          <div v-else-if="!locationPointsLoading && part.interview_point && !locationPoints.some(point => point.name === part.interview_point && !point.disabled)" class="field-note">该面试点已变更或资料不全，请核对后重新选择。</div>
                        </el-form-item>
                        <el-form-item label="轮到本条后等待（秒）" class="compact-item">
                          <el-input-number :model-value="(part.delay_before_ms ?? 0) / 1000" :min="0" :max="60" :step="0.5" :precision="1"
                            controls-position="right" @update:model-value="(value: number | undefined) => part.delay_before_ms = Math.round((value ?? 0) * 1000)" />
                          <div class="field-note">按顺序发送；前面须先有文字确认目标会话。需要更新 Windows 客户端。</div>
                        </el-form-item>
                      </template>
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
                      <FlowMediaPreview v-if="['image', 'video'].includes(part.kind) && part.media_name" :name="part.media_name" :kind="part.kind" />
                      <el-form-item label="发送后间隔（秒）" class="compact-item" title="最后一条的间隔在进入下一节点前执行">
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
                    :icon="Delete"
                    @click="removeSelectedEdge"
                  >删除连接</el-button>
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
      </div>
    </template>
    <ReceptionTestDrawer v-if="auth.user?.role === 'admin'" v-model="testVisible"
      :position-id="positionId" :positions="positions" :positions-loading="positionsLoading"
      :initial-engine="route.query.test_engine === 'dify' ? 'dify' : 'agent'"
      :initial-device="typeof route.query.device_code === 'string' ? route.query.device_code : ''" />
    <PositionAgentDrawer v-model="agentDrawerVisible" :position="currentPosition" :initial-tab="agentDrawerTab" @changed="refreshOpeningContext" />
  </section>
</template>

<script setup lang="ts">
import ReceptionTestDrawer from '../components/agent/ReceptionTestDrawer.vue'
import PositionAgentDrawer from '../components/basic/PositionAgentDrawer.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { workflowPositionSelection } from '../components/agent/device-workflow-entry'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, ArrowLeft, Check, CircleClose, Clock, Connection, Delete, FullScreen, Plus, Refresh, Share, Upload } from '@element-plus/icons-vue'
import AgentFlowCanvas from '../components/agent/AgentFlowCanvas.vue'
import FlowRuntimeInspector from '../components/agent/FlowRuntimeInspector.vue'
import FlowMediaPreview from '../components/agent/FlowMediaPreview.vue'
import { activeOpenings, buildAiMediaBranches, buildRuntimeFlow, compareOpeningContents, describeRuntimeNode, type LegacyOpening } from '../components/agent/flow-runtime'
import { availableFlowMedia, normalizeFlowMediaOptions, type FlowMediaOption } from '../components/agent/flow-media-options'
import { locationPointOptions } from '../components/agent/favorite-location-preview'
import { agentApi, devicesApi, type AgentDeviceItem, type AgentFlow, type AgentFlowEdge, type AgentFlowNode, type AgentFlowPart, type FlowStateSummary } from '../api/agent'
import { mediaApi, positionsApi } from '../api/core'
import type { ServicePosition } from '../api/types'
import { toArray } from '../utils/format'
import { configurationSyncView, type ConfigSyncEvidence } from '../components/agent/config-sync-view'
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

import { readPositionContext, savePositionContext } from '../utils/position-context'
import { useAuthStore } from '../stores/auth'
import { positionLink } from '../layouts/navigation'
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
const mediaItems = ref<FlowMediaOption[]>([])
const selectedNodeKey = ref('')
const selectedEdgeIndex = ref<number | null>(null)
const canvas = ref<InstanceType<typeof AgentFlowCanvas> | null>(null)
const baseline = ref('')
const openingsAvailable = ref(false)
const fullscreen = ref(false)
const enterFullscreenButton = ref<{ $el: HTMLElement } | null>(null)
const exitFullscreenButton = ref<{ $el: HTMLElement } | null>(null)
const inspectorWidth = ref(360)
const viewMode = ref<'runtime' | 'edit'>(route.query.edit === '1' ? 'edit' : 'runtime')
const runtimeDetails = ref(false)
const testVisible = ref(route.query.test_engine === 'dify' || route.query.test_engine === 'agent')
const savedFlow = ref<AgentFlow | null>(null)
const legacyOpenings = ref<LegacyOpening[]>([])
const savedOpeningTexts = computed(() => legacyOpenings.value.filter(opening =>
  opening.kind === 'text' && opening.id != null && opening.content?.trim() && opening.content.length <= 2000,
))
function useOpeningText(part: AgentFlowPart, id: number): void {
  const opening = savedOpeningTexts.value.find(item => item.id === id)
  const content = opening?.content
  if (!content || part.kind !== 'text') return
  if (part.body?.trim() && part.body !== content && part.body !== '请填写此节点要发送的内容') {
    void ElMessageBox.confirm('用选中的开场文字替换此节点的正文？', '选用开场文字', {type: 'warning'})
      .then(() => { part.body = content }).catch(() => {})
    return
  }
  part.body = content
}
const openingVersion = ref<string | null>(null)
const clientSync = ref<Record<string, ConfigSyncEvidence | null>>({})
const evidenceNow = ref(Date.now())
const agentDrawerVisible = ref(false)
const agentDrawerTab = ref<'persona' | 'opening'>('opening')
const currentPosition = computed(() => positions.value.find(item => item.id === positionId.value) || null)
const locationPoints = computed(() => locationPointOptions(currentPosition.value?.interview_points))
const locationPointsLoading = ref(false)
const locationPointsError = ref('')
let evidenceTimer: ReturnType<typeof setInterval> | undefined
const aiFacts = ref<Record<string, string>>({})
const aiContextAvailable = ref(false)
const devices = ref<AgentDeviceItem[]>([])
const devicesAvailable = ref(false)
const mirrors = ref<Array<FlowStateSummary & { device_code: string }>>([])
const mirrorErrors = ref<string[]>([])
const runtimeNodeKey = ref('__runtime_start')
const runtimeEdgeIndex = ref<number | null>(null)
let loadSequence = 0
let inspectorDrag: { pointerId: number; x: number; width: number } | null = null

const boundDevices = computed(() => devices.value.filter(device => Number(device.position_id) === positionId.value))
const aiMediaBranches = computed(() => buildAiMediaBranches(mediaItems.value, aiFacts.value, positionId.value))
const runtimeFlow = computed(() => buildRuntimeFlow(savedFlow.value || { position_id: positionId.value, version: 0, status: 'disabled', entry_key: '', nodes: [], edges: [] }, legacyOpenings.value, aiMediaBranches.value))
const fixedMediaCounts = computed(() => {
  const parts = savedFlow.value?.status === 'enabled'
    ? savedFlow.value.nodes.filter(node => node.status !== 'disabled').flatMap(node => node.parts || [])
    : legacyOpenings.value.map(item => ({kind:item.kind}))
  return {images:parts.filter(part => part.kind === 'image').length,videos:parts.filter(part => part.kind === 'video').length}
})
const displayFlow = computed(() => viewMode.value === 'runtime' ? runtimeFlow.value : flow.value!)
const displayNodeKey = computed(() => viewMode.value === 'runtime' ? runtimeNodeKey.value : selectedNodeKey.value)
const displayEdgeIndex = computed(() => viewMode.value === 'runtime' ? runtimeEdgeIndex.value : selectedEdgeIndex.value)
const runtimeNode = computed(() => runtimeFlow.value.nodes.find(node => node.node_key === runtimeNodeKey.value) || null)
const runtimeEdge = computed(() => runtimeEdgeIndex.value === null ? null : runtimeFlow.value.edges[runtimeEdgeIndex.value] || null)
const contentMatches = computed(() => Boolean(savedFlow.value?.nodes.length && compareOpeningContents(savedFlow.value, legacyOpenings.value)))
const selectedNodeExplanation = computed(() => selectedNode.value && flow.value ? describeRuntimeNode(selectedNode.value, flow.value, false) : [])

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
  const routeAtStart = route.fullPath
  positionsLoading.value = true
  pageError.value = ''
  try {
    const { data } = await positionsApi.list({ page: 1, page_size: 1000 })
    if (route.fullPath !== routeAtStart) return
    positions.value = toArray<ServicePosition>(data)
    let requestedPosition = route.query.position_id
    const requestedDevice = route.query.device_code
    if (!requestedPosition && route.query.test_engine === 'dify' && typeof requestedDevice === 'string' && requestedDevice) {
      const accounts = await devicesApi.list()
      if (route.fullPath !== routeAtStart) return
      const account = accounts.data.items.find(device => device.device_code === requestedDevice)
      if (!account?.position_id) return
      requestedPosition = String(account.position_id)
    }
    const selection = workflowPositionSelection(requestedPosition, readPositionContext(userKey()), positions.value.map(position => position.id))
    if (selection.error) { positionId.value = 0; pageError.value = selection.error; return }
    const nextId = selection.id
    positionId.value = nextId
    if (nextId) savePositionContext(userKey(), nextId)
    if (nextId) await loadFlow(nextId)
  } catch (error) {
    pageError.value = errorText(error, '岗位列表加载失败')
  } finally {
    positionsLoading.value = false
  }
}

async function loadFlow(id: number): Promise<void> {
  const sequence = ++loadSequence
  locationPointsLoading.value = false
  locationPointsError.value = ''
  loading.value = true
  pageError.value = ''
  conflict.value = false
  try {
    const [flowResult, personaResult, mediaResult, devicesResult, contextResult, positionResult] = await Promise.all([
      agentApi.flowGet(id),
      agentApi.personaGet(id),
      mediaApi.list({ page: 1, page_size: 1000 }).catch(() => null),
      devicesApi.list({ page: 1, page_size: 1000 }).catch(() => null),
      agentApi.context({ position_id: id }).catch(() => null),
      positionsApi.get(id).catch(() => null),
    ])
    if (sequence !== loadSequence) return
    if (positionResult) positions.value = positions.value.map(position => position.id === id ? positionResult.data : position)
    flow.value = normalizeFlow(flowResult.data)
    savedFlow.value = JSON.parse(JSON.stringify(flow.value))
    legacyOpenings.value = activeOpenings((personaResult.data.openings || []) as unknown as LegacyOpening[])
    openingVersion.value = personaResult.data.opening_version || null
    aiFacts.value = (contextResult?.data.facts || {}) as Record<string, string>
    aiContextAvailable.value = contextResult !== null
    devicesAvailable.value = devicesResult !== null
    devices.value = toArray<AgentDeviceItem>(devicesResult?.data)
    mirrors.value = []
    clientSync.value = {}
    mirrorErrors.value = []
    runtimeNodeKey.value = '__runtime_start'
    runtimeEdgeIndex.value = null
    openingsAvailable.value = Array.isArray(personaResult.data.openings) && personaResult.data.openings.length > 0
    mediaItems.value = normalizeFlowMediaOptions(toArray<Record<string, unknown>>(mediaResult?.data))
    chooseSelection(flow.value)
    baseline.value = snapshot(flow.value)
    void loadRuntimeMirrors(id, sequence)
    void loadClientSync(id, sequence)
  } catch (error) {
    if (sequence !== loadSequence) return
    pageError.value = errorText(error, '流程加载失败')
    flow.value = null
    savedFlow.value = null
    openingVersion.value = null
    aiFacts.value = {}
    aiContextAvailable.value = false
    openingsAvailable.value = false
    mediaItems.value = []
    baseline.value = ''
  } finally {
    if (sequence === loadSequence) {
      loading.value = false
      await nextTick()
      canvas.value?.fitToCanvas()
    }
  }
}

async function refreshLocationPoints(visible: boolean): Promise<void> {
  const id = positionId.value
  if (!visible || !id || locationPointsLoading.value) return
  const sequence = loadSequence
  const isCurrent = () => sequence === loadSequence && positionId.value === id

  locationPointsLoading.value = true
  locationPointsError.value = ''
  try {
    const { data } = await positionsApi.get(id)
    if (isCurrent()) {
      positions.value = positions.value.map(position => position.id === id ? data : position)
    }
  } catch {
    if (isCurrent()) locationPointsError.value = '面试点读取失败，请收起下拉框后重新展开。'
  } finally {
    if (sequence === loadSequence) locationPointsLoading.value = false
  }
}

async function loadClientSync(id: number, sequence: number): Promise<void> {
  const scoped = devices.value.filter(device => Number(device.position_id) === id)
  const results = await Promise.all(scoped.map(async device => {
    try { const { data } = await agentApi.configSync(device.device_code); return [device.device_code, data] as const }
    catch { return [device.device_code, null] as const }
  }))
  if(sequence === loadSequence) clientSync.value = Object.fromEntries(results)
}

function syncView(code: string) {
  return configurationSyncView(clientSync.value[code], {
    mode: savedFlow.value?.status === 'enabled' ? 'flow' : 'opening',
    positionId: positionId.value,
    version: savedFlow.value?.status === 'enabled' ? savedFlow.value.version : openingVersion.value,
    flowVersion: savedFlow.value?.version,
    flowStatus: savedFlow.value?.status === 'enabled' ? 'enabled' : 'disabled',
  }, evidenceNow.value)
}

function openConfiguration(command: 'flow' | 'opening' | 'persona' | 'media' | 'knowledge'): void {
  if (command === 'flow') {
    viewMode.value = 'edit'
    changeViewMode()
  } else if (command === 'opening' || command === 'persona') {
    agentDrawerTab.value = command
    agentDrawerVisible.value = true
  } else {
    void router.push(positionLink(command === 'media' ? '/media' : '/knowledge', positionId.value))
  }
}

function enterFullscreen(): void {
  fullscreen.value = true
  void nextTick(() => exitFullscreenButton.value?.$el.focus())
}

function exitFullscreen(): void {
  fullscreen.value = false
  void nextTick(() => enterFullscreenButton.value?.$el.focus())
}

function showRuntime(): void {
  viewMode.value = 'runtime'
  changeViewMode()
}

async function refreshOpeningContext(): Promise<void> {
  const id=positionId.value,sequence=loadSequence
  try {
    const [persona, context]=await Promise.all([agentApi.personaGet(id),agentApi.context({position_id:id})])
    if(sequence!==loadSequence || id!==positionId.value)return
    legacyOpenings.value = activeOpenings((persona.data.openings||[]) as unknown as LegacyOpening[])
    openingVersion.value = persona.data.opening_version || null
    openingsAvailable.value = legacyOpenings.value.length > 0
    aiFacts.value = (context.data.facts||{}) as Record<string,string>
    void loadClientSync(id,sequence)
  } catch {
    if(sequence===loadSequence)pageError.value='开场已提交，但运行图刷新失败，请点击刷新重新核对。'
  }
}

async function loadRuntimeMirrors(id: number, sequence: number): Promise<void> {
  const scoped = devices.value.filter(device => Number(device.position_id) === id)
  const results = await Promise.all(scoped.map(async device => {
    try {
      const { data } = await agentApi.flowStateSummary(device.device_code)
      return { code: device.device_code, rows: data.items, failed: false }
    } catch { return { code: device.device_code, rows: [] as FlowStateSummary[], failed: true } }
  }))
  if (sequence !== loadSequence) return
  mirrors.value = results.flatMap(result => result.rows.map(row => ({ ...row, device_code: result.code })))
  mirrorErrors.value = results.filter(result => result.failed).map(result => result.code)
}

function phaseLabel(phase: string): string {
  return ({ running: '执行中', awaiting: '等待回复', followup_due: '待复聊', followup_sent: '已复聊', replied: '已回复并交接', expired: '固定流程结束', held: '暂停待核对', idle: '尚未开始' } as Record<string, string>)[phase] || phase
}

function formatTime(value: unknown): string {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '未上报'
}

function selectDisplayNode(key: string): void {
  if (viewMode.value === 'runtime') { runtimeNodeKey.value = key; runtimeEdgeIndex.value = null }
  else selectNode(key)
}

function selectDisplayEdge(index: number): void {
  if (viewMode.value === 'runtime') { runtimeEdgeIndex.value = index; runtimeNodeKey.value = '' }
  else selectEdge(index)
}

function changeViewMode(): void { nextTick(() => canvas.value?.fitToCanvas()) }

function beginInspectorResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  inspectorDrag = { pointerId: event.pointerId, x: event.clientX, width: inspectorWidth.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function moveInspectorResize(event: PointerEvent): void {
  if (inspectorDrag?.pointerId !== event.pointerId) return
  inspectorWidth.value = Math.max(300, Math.min(520, inspectorDrag.width + inspectorDrag.x - event.clientX))
}
function endInspectorResize(event: PointerEvent): void {
  if (inspectorDrag?.pointerId === event.pointerId) inspectorDrag = null
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}
function onWorkspaceKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && fullscreen.value && !agentDrawerVisible.value && !testVisible.value) exitFullscreen()
}

watch(canvas, value => { if (value) nextTick(() => value.fitToCanvas()) }, { flush: 'post' })

async function changePosition(rawId: string | number): Promise<void> {
  if (saving.value || migrating.value || loading.value) return
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
  fullscreen.value = false
  viewMode.value = 'runtime'
  runtimeDetails.value = false
  positionId.value = nextId
  savePositionContext(userKey(), nextId)
  await router.replace({ query: { ...route.query, position_id: String(nextId) } })
  await loadFlow(nextId)
}

watch(() => route.query.position_id, async (rawId) => {
  const nextId = Number(rawId)
  if (!nextId || nextId === positionId.value || !positions.value.some((position) => position.id === nextId)) return
  if (saving.value || migrating.value) {
    await router.replace({ query: { ...route.query, position_id: String(positionId.value) } })
    return
  }
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
  fullscreen.value = false
  viewMode.value = 'runtime'
  runtimeDetails.value = false
  positionId.value = nextId
  savePositionContext(userKey(), nextId)
  await loadFlow(nextId)
})

async function reloadFlow(): Promise<void> {
  if (saving.value || migrating.value) return
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
  if (saving.value || migrating.value) return
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
  viewMode.value = 'edit'
}

function changeFlowStatus(enabled: boolean): void {
  if (flow.value) flow.value.status = enabled ? 'enabled' : 'disabled'
}

async function migrateOpening(): Promise<void> {
  if (!positionId.value || !flow.value || flow.value.version !== 0 || saving.value || migrating.value || loading.value) return
  const requestPosition = positionId.value
  const requestSequence = loadSequence
  migrating.value = true
  pageError.value = ''
  try {
    const { data } = await agentApi.flowMigrate(requestPosition)
    if (requestPosition !== positionId.value || requestSequence !== loadSequence) return
    flow.value = normalizeFlow(data)
    savedFlow.value = JSON.parse(JSON.stringify(flow.value))
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
  if (!flow.value || !isDirty.value || saving.value || loading.value || migrating.value) return
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
  const requestPosition = positionId.value
  const requestSequence = loadSequence
  pageError.value = ''
  conflict.value = false
  try {
    const { data } = await agentApi.flowSave(flow.value)
    if (requestPosition !== positionId.value || requestSequence !== loadSequence) return
    flow.value = normalizeFlow(data)
    savedFlow.value = JSON.parse(JSON.stringify(flow.value))
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

function movePart(node: AgentFlowNode, index: number, offset: number): void {
  const parts = node.parts
  const target = index + offset
  if (!parts || target < 0 || target >= parts.length) return
  const [part] = parts.splice(index, 1)
  parts.splice(target, 0, part)
}

function setPartKind(part: AgentFlowPart, kind: string): void {
  if (!['text', 'image', 'video', 'favorite_location'].includes(kind)) return
  part.kind = kind
  part.media_name = ''
  if (kind !== 'favorite_location') {
    delete part.interview_point
    delete part.delay_before_ms
  } else part.delay_before_ms = 0
}

function setPartDelay(part: AgentFlowPart, seconds: number | undefined): void {
  part.delay_ms = Math.max(0, Math.min(60, Number(seconds) || 0)) * 1000
}

function millisecondsToSeconds(value: unknown): number {
  const milliseconds = Number(value)
  return Number.isFinite(milliseconds) ? Math.round(milliseconds / 1000) : 2
}

function availableMedia(kind: string): FlowMediaOption[] {
  return availableFlowMedia(mediaItems.value, kind, positionId.value)
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
  if (saving.value || migrating.value) return false
  if (!isDirty.value) return true
  try {
    await ElMessageBox.confirm('离开页面会丢弃尚未保存的流程修改。', '离开流程图', {
      type: 'warning', confirmButtonText: '离开', cancelButtonText: '留在页面',
    })
    return true
  } catch {
    return false
  }
})

onMounted(() => {
  window.addEventListener('keydown', onWorkspaceKey)
  void loadPositions()
  evidenceTimer = setInterval(() => { evidenceNow.value=Date.now(); if(!loading.value && positionId.value)void loadClientSync(positionId.value,loadSequence) },30000)
})
onBeforeUnmount(() => { loadSequence += 1; if(evidenceTimer)clearInterval(evidenceTimer); window.removeEventListener('keydown', onWorkspaceKey) })
</script>

<style scoped>
.opening-picker { margin-bottom: 8px; }
.flow-page { min-width: 0; }
.flow-page.is-fullscreen { position: fixed; z-index: 1800; inset: 0; display: flex; flex-direction: column; padding: 16px 20px 12px; overflow: hidden; background: var(--el-bg-color-page, #f5f7fb); }
.is-fullscreen .page-header { flex-shrink: 0; margin-bottom: 10px; gap: 12px; }
.page-heading { flex: 1; min-width: 0; }
.is-fullscreen .page-header .page-title { font-size: 20px; }
.is-fullscreen .flow-toolbar { flex-shrink: 0; margin-bottom: 8px; }
.runtime-status-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; flex-shrink: 0; padding: 6px 4px 10px; font-size: 12px; color: var(--el-text-color-regular); }
.runtime-status-bar .el-button { margin-left: auto; }
.config-sync-status { flex-shrink: 0; padding: 0 4px 8px; font-size: 12px; color: var(--el-text-color-regular); }
.config-sync-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:3px 0; }
.runtime-media-summary { display: flex; flex-wrap: wrap; flex-shrink: 0; gap: 5px 18px; margin-bottom: 8px; color: var(--el-text-color-regular); font-size: 12px; }
.flow-page :deep(.el-button.is-link) { background: transparent !important; border-color: transparent !important; }
.flow-page :deep(.el-button.is-link:hover) { background: var(--el-fill-color-light) !important; }
.runtime-details { flex-shrink: 0; max-height: 220px; overflow-y: auto; padding: 10px 14px; margin-bottom: 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-bg-color); font-size: 12px; line-height: 1.65; }
.runtime-details p { margin: 5px 0; }
.device-evidence { padding: 5px 0; }
.node-execution-notes { margin: 8px 0 16px; }
.node-execution-notes p { margin: 8px 0; }
.canvas-column { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: min(68vh, 760px); }
.is-fullscreen .canvas-column { height: 100%; }
.canvas-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px 16px; flex-wrap: wrap; flex-shrink: 0; padding: 10px 12px; margin-bottom: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-bg-color); }
.canvas-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.canvas-actions .el-button { margin-left: 0; }
.inspector-resizer { width: 8px; cursor: col-resize; touch-action: none; display: flex; justify-content: center; }
.inspector-resizer::after { content: ''; width: 2px; height: 48px; margin-top: 40px; border-radius: 2px; background: var(--el-border-color); }
.inspector-resizer:hover::after,.inspector-resizer:focus-visible::after { background: var(--el-color-primary); }
.flow-toolbar,
.graph-actions,
.empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.flow-toolbar { min-height: 52px; margin-bottom: 12px; padding: 8px 12px; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.position-select { width: min(360px, 100%); }
.flow-version { color: var(--bd-text-tertiary, #7b8494); font-size: 12px; }
.toolbar-spacer { flex: 1; }
.dirty-hint { color: var(--el-color-warning); font-size: 12px; }
.page-alert { margin-bottom: 12px; }
.page-loading,.empty-flow { min-height: 360px; padding: 28px; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.empty-actions { justify-content: center; }
.graph-actions { margin-bottom: 12px; }
.flow-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 8px var(--inspector-width, 360px); align-items: stretch; gap: 4px; min-width: 0; min-height: 0; }
.canvas-panel { min-width: 0; }
.is-fullscreen .canvas-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.is-fullscreen .flow-workspace { flex: 1; overflow: hidden; }
.inspector { min-width: 0; max-height: min(68vh, 760px); padding: 14px; overflow: auto; border: 1px solid var(--bd-border, #e8ecf3); border-radius: 6px; background: var(--el-bg-color, #fff); }
.is-fullscreen .inspector { max-height: none; height: 100%; box-sizing: border-box; }
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
@media (max-width: 850px) {
  .flow-workspace { grid-template-columns: minmax(0, 1fr); }
  .flow-page.is-fullscreen { padding: 10px; overflow-y: auto; }
  .is-fullscreen .canvas-panel { flex: none; }
  .is-fullscreen .flow-workspace { flex: none; overflow: visible; }
  .canvas-column,.is-fullscreen .canvas-column { height: 60vh; min-height: 350px; }
  .inspector-resizer { display: none; }
  .inspector { max-height: none; }
  .is-fullscreen .inspector { height: auto; max-height: 65vh; }
  .header-actions { flex-wrap: wrap; gap: 6px; }
  .header-actions .el-button { margin-left: 0; }
}
@media (max-width: 640px) {
  .flow-toolbar { align-items: stretch; }
  .position-select { width: 100%; }
  .toolbar-spacer { display: none; }
  .page-header { align-items: flex-start; }
}
</style>
