<template>
  <div class="app-layout">
    <aside class="sidebar" :class="{ collapsed }">
      <div class="sidebar-logo">
        <YuanyiMark label="源绎" class="sidebar-brand" />
        <div v-if="!collapsed" class="sidebar-brand-copy">
          <span class="sidebar-brand-account" :title="auth.user?.username">{{ auth.user?.username }}</span>
          <span class="sidebar-brand-name">源绎 AI 系统</span>
        </div>
      </div>

      <el-menu
        :default-active="navPath"
        :collapse="collapsed"
        :collapse-transition="false"
        :default-openeds="defaultOpeneds"
        class="sidebar-menu"
        router
        unique-opened
        @select="handleMenuSelect"
      >
        <template v-for="group in navigation" :key="group.key">
          <el-menu-item v-if="group.key === 'home'" index="/dashboard" aria-label="首页" tabindex="0" @keydown.enter.space.prevent="activateMenuItem">
            <el-icon><DataBoard /></el-icon><template #title>首页</template>
          </el-menu-item>
          <el-sub-menu v-else :index="group.key">
            <template #title><el-icon><component :is="groupIcon(group.key)" /></el-icon><span>{{ group.label }}</span></template>
            <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path" :route="menuTarget(item.path)"
              :aria-label="item.label" tabindex="0" @keydown.enter.space.prevent="activateMenuItem">
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
        <span v-if="pendingMenu" class="sidebar-navigation-status" role="status">正在打开{{ pendingMenu }}…</span>
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
import { ElMessage } from 'element-plus'
import YuanyiMark from '../components/YuanyiMark.vue'
import { useAuthStore } from '../stores/auth'
import { navigationForRole, activeNavigationPath } from './navigation'
import { readPositionContext } from '../utils/position-context'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const navigation = computed(() => navigationForRole(auth.user?.role || 'customer'))
const pendingMenu = ref('')
const positionPages = ['/recruitment-flow', '/knowledge', '/media']
let navigationAttempt = 0
function groupIcon(key: string): string {
  return ({operations:'ChatDotRound',basic:'Briefcase',knowledge:'ChatLineRound',system:'Tools'} as Record<string,string>)[key] || 'Grid'
}
function itemIcon(path: string): string {
  return ({'/conversations':'ChatLineRound','/candidates':'User','/archive':'Tickets','/agent-devices':'Monitor','/cities':'Location','/service-positions':'Briefcase','/recruitment-flow':'Share','/knowledge':'Reading','/media':'Picture','/users':'Lock','/settings':'Setting','/recruiters':'Avatar'} as Record<string,string>)[path] || 'Star'
}
function menuTarget(path: string): string {
  if (path === route.path) return route.fullPath
  if (!positionPages.includes(path)) return path
  const currentPosition = positionPages.includes(route.path)
    ? Number(route.query.position_id)
    : 0
  const id = Number.isSafeInteger(currentPosition) && currentPosition > 0
    ? currentPosition
    : readPositionContext(auth.user?.id ?? auth.user?.username ?? '')
  return id ? `${path}?position_id=${id}` : path
}

function activateMenuItem(event: KeyboardEvent): void {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.click()
}

async function handleMenuSelect(path: string, _indexPath: string[], _item: unknown, result?: Promise<unknown>): Promise<void> {
  if (!result) return
  const attempt = ++navigationAttempt
  pendingMenu.value = navigation.value.flatMap(group => group.items).find(item => item.path === path)?.label ?? '页面'
  try {
    await result
  } catch {
    if (attempt === navigationAttempt) ElMessage.error('页面加载失败，请刷新后重试。')
  } finally {
    if (attempt === navigationAttempt) pendingMenu.value = ''
  }
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
.sidebar-logo .sidebar-brand {
  box-sizing: border-box;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid #dce3ef;
  background: linear-gradient(140deg, #fdfdff, #edf2fd 60%, #eef7f1);
}

.sidebar-brand-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.sidebar-brand-account {
  overflow: hidden;
  color: var(--rk-ink-1, #26314f);
  font-size: 15px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
}

.sidebar-brand-name {
  color: var(--rk-ink-2, #536176);
  font-size: 12px;
  line-height: 16px;
}

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

.sidebar-navigation-status {
  margin-right: auto;
  color: var(--rk-ink-2);
  font-size: 13px;
}
</style>
