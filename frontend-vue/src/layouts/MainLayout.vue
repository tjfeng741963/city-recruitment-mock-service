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
        <template v-for="group in navigation" :key="group.key">
          <el-menu-item v-if="group.key === 'home'" index="/dashboard">
            <el-icon><DataBoard /></el-icon><template #title>首页</template>
          </el-menu-item>
          <el-sub-menu v-else :index="group.key">
            <template #title><el-icon><component :is="groupIcon(group.key)" /></el-icon><span>{{ group.label }}</span></template>
            <el-menu-item v-for="item in group.items" :key="item.path" :index="menuTarget(item.path)">
              <el-icon><component :is="itemIcon(item.path)" /></el-icon><template #title>{{ item.label }}</template>
            </el-menu-item>
          </el-sub-menu>
        </template>
      </el-menu>

      <button class="sidebar-footer" type="button" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" :aria-expanded="!collapsed" @click="toggleCollapsed">
        <el-icon><Expand v-if="collapsed" /><Fold v-else /></el-icon>
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
import { navigationForRole, activeNavigationPath } from './navigation'
import { readPositionContext } from '../utils/position-context'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const navigation = computed(() => navigationForRole(auth.user?.role || 'customer'))
function groupIcon(key: string): string {
  return ({operations:'ChatDotRound',basic:'Briefcase',knowledge:'ChatLineRound',system:'Tools'} as Record<string,string>)[key] || 'Grid'
}
function itemIcon(path: string): string {
  return ({'/conversations':'ChatLineRound','/candidates':'User','/archive':'Tickets','/agent-devices':'Monitor','/cities':'Location','/service-positions':'Briefcase','/recruitment-flow':'Share','/knowledge':'Reading','/media':'Picture','/users':'Lock','/settings':'Setting','/recruiters':'Avatar'} as Record<string,string>)[path] || 'Star'
}
function menuTarget(path: string): string {
  const id = readPositionContext(auth.user?.id ?? auth.user?.username ?? '')
  return path === '/recruitment-flow' && id ? `${path}?position_id=${id}` : path
}
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

const navPath = computed(() => activeNavigationPath(route.path))
const activeMenu = computed(() => menuTarget(navPath.value))

/** 打开当前所在分组 */
const defaultOpeneds = computed(() => {
  return navigation.value.filter(group => group.items.some(item => item.path === navPath.value)).map(group => group.key)
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
