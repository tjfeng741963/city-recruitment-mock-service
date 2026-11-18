<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="sidebar-logo">
        <div class="logo-icon">C</div>
        <span v-if="!collapsed" class="logo-text">城市配置管理</span>
      </div>

      <el-menu
        :default-active="activeMenu"
        :collapse="collapsed"
        :collapse-transition="false"
        :default-openeds="defaultOpeneds"
        class="sidebar-menu"
        router
        unique-opened
      >
        <el-menu-item index="/dashboard">
          <el-icon><DataBoard /></el-icon>
          <template #title>监控看板</template>
        </el-menu-item>

        <el-sub-menu index="basic">
          <template #title>
            <el-icon><Setting /></el-icon>
            <span>基础配置</span>
          </template>
          <el-menu-item index="/cities">
            <el-icon><Location /></el-icon>
            <template #title>城市管理</template>
          </el-menu-item>
<!-- /factories 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
          <el-menu-item index="/service-positions">
            <el-icon><Briefcase /></el-icon>
            <template #title>岗位管理</template>
          </el-menu-item>
          <el-menu-item index="/city-links">
            <el-icon><Connection /></el-icon>
            <template #title>周边城市设置</template>
          </el-menu-item>
          <el-menu-item index="/media">
            <el-icon><Picture /></el-icon>
            <template #title>素材库</template>
          </el-menu-item>
          <el-menu-item index="/factory-overview">
            <el-icon><Grid /></el-icon>
            <template #title>工厂配置总览</template>
          </el-menu-item>
          <el-menu-item index="/factory-overview">
            <el-icon><Grid /></el-icon>
            <template #title>工厂配置总览</template>
          </el-menu-item>
<!-- 节假日管理入口按旧版 nav-adjust 补丁隐藏（与「工厂配置总览」重复）；路由 /holidays 保留 -->
        </el-sub-menu>

        <el-sub-menu index="operations">
          <template #title>
            <el-icon><ChatDotRound /></el-icon>
            <span>坐席运营</span>
          </template>
          <el-menu-item index="/agent-devices">
            <el-icon><Monitor /></el-icon>
            <template #title>坐席设备</template>
          </el-menu-item>
<!-- /old-friends 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
          <el-menu-item index="/conversations">
            <el-icon><ChatLineRound /></el-icon>
            <template #title>对话管理</template>
          </el-menu-item>
          <el-menu-item index="/archive">
            <el-icon><Tickets /></el-icon>
            <template #title>面试登记</template>
          </el-menu-item>
<!-- /candidates 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
<!-- /device-report 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
<!-- /account-summary 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
        </el-sub-menu>

<!-- 复聊激活分组按旧版 nav-adjust 补丁隐藏（后端旧链路已下线） -->

        <el-sub-menu index="knowledge">
          <template #title>
            <el-icon><Notebook /></el-icon>
            <span>知识管理</span>
          </template>
          <el-menu-item index="/knowledge">
            <el-icon><Reading /></el-icon>
            <template #title>知识库配置</template>
          </el-menu-item>
<!-- /unknown-questions 入口按旧版注入补丁隐藏（nav-adjust/city-factories），路由保留 -->
        </el-sub-menu>

        <el-sub-menu index="system">
          <template #title>
            <el-icon><Tools /></el-icon>
            <span>系统管理</span>
          </template>
          <el-menu-item index="/recruiters">
            <el-icon><Avatar /></el-icon>
            <template #title>招聘员管理</template>
          </el-menu-item>
          <el-menu-item index="/recruiter-featured">
            <el-icon><Star /></el-icon>
            <template #title>主推设置</template>
          </el-menu-item>
          <el-menu-item index="/users">
            <el-icon><User /></el-icon>
            <template #title>用户管理</template>
          </el-menu-item>
          <el-menu-item index="/settings">
            <el-icon><Setting /></el-icon>
            <template #title>设置</template>
          </el-menu-item>
        </el-sub-menu>

      </el-menu>

      <button class="sidebar-footer" type="button" @click="toggleCollapsed">
        <el-icon><Fold /></el-icon>
        <span v-if="!collapsed">收起侧栏</span>
      </button>
    </aside>

    <div class="main-area">
      <header class="top-header">
        <div class="header-right">
          <el-avatar :size="32" class="user-avatar">{{ initial }}</el-avatar>
          <span class="user-name">{{ auth.user?.username || 'local-admin' }}</span>
          <el-button link class="logout-btn" @click="handleLogout">退出</el-button>
        </div>
      </header>
      <main class="main-scroll">
        <router-view v-slot="{ Component }">
          <component :is="Component" :key="route.fullPath" />
        </router-view>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
// 对齐 theme/sidebar.js：收起状态记忆在 localStorage，窄屏（≤1200px）自动收起
const NAV_COLLAPSED_KEY = 'rk-nav-collapsed'

const collapsed = ref(readCollapsedPreference())

function readCollapsedPreference(): boolean {
  const stored = localStorage.getItem(NAV_COLLAPSED_KEY)
  if (stored === '1') return true
  if (stored === '0') return false
  return window.matchMedia('(max-width: 1200px)').matches
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
  localStorage.setItem(NAV_COLLAPSED_KEY, collapsed.value ? '1' : '0')
}

const narrowQuery = window.matchMedia('(max-width: 1200px)')
const onNarrowChange = (event: MediaQueryListEvent): void => {
  if (!localStorage.getItem(NAV_COLLAPSED_KEY)) collapsed.value = event.matches
}

const initial = computed(() => (auth.user?.username || 'L').slice(0, 1).toUpperCase())

/** /device-report 复用监控看板菜单项的高亮 */
const activeMenu = computed(() => (route.path === '/device-report' ? '/device-report' : route.path))

/** 打开当前所在分组 */
const defaultOpeneds = computed(() => {
  const group = route.meta.group as string | undefined
  const map: Record<string, string> = {
    基础配置: 'basic',
    坐席运营: 'operations',
    复聊激活: 'activation',
    知识管理: 'knowledge',
    系统管理: 'system',
  }
  return group && map[group] ? [map[group]] : []
})

onMounted(() => {
  narrowQuery.addEventListener('change', onNarrowChange)
})

onUnmounted(() => {
  narrowQuery.removeEventListener('change', onNarrowChange)
})

onMounted(async () => {
  if (auth.isAuthed && !auth.user) {
    try {
      await auth.refresh()
    } catch {
      auth.logout()
      router.replace('/login')
    }
  }
})

function handleLogout(): void {
  auth.logout()
  router.replace('/login')
}
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
}

.sidebar.collapsed {
  width: 64px;
}

.sidebar.collapsed .sidebar-logo {
  justify-content: center;
  padding-left: 0;
  padding-right: 0;
}

.sidebar-footer {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  border: 0;
  background: transparent;
  color: var(--bd-text-tertiary);
  cursor: pointer;
  font-size: 13px;
}

.sidebar-footer:hover {
  color: var(--bd-primary);
}
</style>
