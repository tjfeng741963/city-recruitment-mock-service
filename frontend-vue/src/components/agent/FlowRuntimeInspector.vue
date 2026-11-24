<template>
  <div class="runtime-inspector">
    <div class="inspector-label">{{ node?.node_type === 'system_media' ? 'AI 可选媒体分支 · 只读' : legacy ? '当前旧开场路径 · 只读' : '已保存的运行路径 · 只读' }}</div>
    <template v-if="node">
      <h3>{{ node.title || node.node_key }}</h3>
      <h4>这个节点实际做什么</h4>
      <p v-for="line in explanations" :key="line">{{ line }}</p>
      <template v-if="node.parts?.length">
        <h4>{{ node.node_type === 'system_media' ? 'AI 可选素材 · 按需发送' : '此步骤配置的发送内容' }}</h4>
        <div v-for="(part, index) in node.parts" :key="index" class="message-preview">
          <span class="message-kind">第 {{ index + 1 }} 条 · {{ part.kind === 'text' ? '文本' : part.kind === 'video' ? '视频' : '图片' }}</span>
          <p v-if="part.kind === 'text'" class="verbatim">{{ part.body || '未填写文本' }}</p>
          <template v-else><strong>{{ part.media_name || '未选素材' }}</strong>
            <FlowMediaPreview v-if="part.media_name" :name="part.media_name" :kind="part.kind" />
          </template>
        </div>
      </template>
      <template v-if="outgoing.length">
        <h4>之后往哪里走</h4>
        <el-button v-for="edge in outgoing" :key="`${edge.to_key}-${edge.trigger}`" class="transition" link type="primary" @click="$emit('select-node', edge.to_key)">
          {{ edge.runtime_label || edgeLabel(edge) }} → {{ graph.nodes.find(n => n.node_key === edge.to_key)?.title || '结束' }}
        </el-button>
      </template>
    </template>
    <template v-else-if="edge">
      <h3>连接决定何时继续</h3>
      <p>{{ edge.runtime_label || edgeLabel(edge) }}</p>
      <p v-if="edge.trigger === 'keyword' && edge.condition_value">客户文本包含「{{ edge.condition_value }}」时匹配，优先级 {{ edge.priority || 0 }}。</p>
      <p>起点：{{ title(edge.from_key) }}</p><p>去向：{{ title(edge.to_key) }}</p>
    </template>
    <el-empty v-else :image-size="60" description="点击图上的阶段，看触发条件和完整消息" />
    <el-divider />
    <p class="evidence-note">这里展示配置推导的执行路径，不是送达回执；客户端状态镜像也不能单独证明客户已收到消息。</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentFlow, AgentFlowEdge, AgentFlowNode } from '../../api/agent'
import { describeRuntimeNode } from './flow-runtime'
import FlowMediaPreview from './FlowMediaPreview.vue'
const props = defineProps<{ graph: AgentFlow; node: AgentFlowNode | null; edge: AgentFlowEdge | null; legacy: boolean }>()
defineEmits<{
  (event: 'select-node', key: string): void
}>()
const explanations = computed(() => props.node ? describeRuntimeNode(props.node, props.graph, props.legacy) : [])
const outgoing = computed(() => props.graph.edges.filter(edge => edge.from_key === props.node?.node_key))
function title(key: string): string { return props.graph.nodes.find(node => node.node_key === key)?.title || key || '结束' }
function edgeLabel(edge: AgentFlowEdge): string {
  return ({ default: '连续执行', any_reply: '等待客户回复', timeout: '等待超时后一次复聊', keyword: `匹配关键词「${edge.condition_value || ''}」`, giveup: '旧放弃条件，当前运行器不处理' } as Record<string, string>)[edge.trigger] || edge.trigger
}
</script>

<style scoped>
.runtime-inspector { color: var(--el-text-color-regular); font-size: 13px; line-height: 1.7; }
.inspector-label,.message-kind { color: var(--el-text-color-secondary); font-size: 12px; }
h3 { margin: 6px 0 8px; color: var(--el-text-color-primary); font-size: 16px; }
h4 { margin: 20px 0 8px; font-size: 13px; }
p { margin: 8px 0; overflow-wrap: anywhere; }
.message-preview { margin: 8px 0; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px; background: var(--el-fill-color-light); }
.message-kind { display: block; margin-bottom: 6px; }
.verbatim { white-space: pre-wrap; }
.transition { display: flex; height: auto; margin: 6px 0 !important; text-align: left; white-space: normal; }
.evidence-note { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
