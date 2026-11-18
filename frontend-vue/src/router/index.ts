import { createRouter, createWebHistory } from 'vue-router'
import { hasToken } from '../api/auth'

/** 路由表：与旧前端的 23 个菜单项一一对应，组件按域懒加载 */
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true, title: '登录' },
    },
    {
      path: '/m',
      name: 'mobile-chat',
      component: () => import('../views/MobileChatView.vue'),
      meta: { title: '移动端' },
    },
    {
      path: '/',
      component: () => import('../layouts/MainLayout.vue'),
      redirect: '/dashboard',
      children: [
        // 监控
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('../views/StatusDashboardView.vue'),
          meta: { title: '监控看板', group: '监控' },
        },
        {
          path: 'device-report',
          name: 'device-report',
          component: () => import('../views/StatusDashboardView.vue'),
          meta: { title: '设备报表', group: '坐席运营' },
        },
        {
          path: 'account-summary',
          name: 'account-summary',
          component: () => import('../views/AccountSummaryView.vue'),
          meta: { title: '运营汇总', group: '坐席运营' },
        },
        // 基础配置
        {
          path: 'cities',
          name: 'cities',
          component: () => import('../views/CityView.vue'),
          meta: { title: '城市管理', group: '基础配置' },
        },
        {
          path: 'factories',
          name: 'factories',
          component: () => import('../views/FactoryView.vue'),
          meta: { title: '厂区管理', group: '基础配置' },
        },
        {
          path: 'service-positions',
          name: 'service-positions',
          component: () => import('../views/ServicePositionView.vue'),
          meta: { title: '岗位管理', group: '基础配置' },
        },
        {
          path: 'city-links',
          name: 'city-links',
          component: () => import('../views/CityLinkView.vue'),
          meta: { title: '周边城市设置', group: '基础配置' },
        },
        {
          path: 'media',
          name: 'media',
          component: () => import('../views/MediaView.vue'),
          meta: { title: '岗位素材库', group: '基础配置' },
        },
        {
          path: 'holidays',
          name: 'holidays',
          component: () => import('../views/HolidayView.vue'),
          meta: { title: '节假日管理', group: '基础配置' },
        },
        {
          path: 'factory-overview',
          name: 'factory-overview',
          component: () => import('../views/FactoryOverviewView.vue'),
          meta: { title: '工厂配置总览', group: '基础配置' },
        },
        // 坐席运营
        {
          path: 'agent-devices',
          name: 'agent-devices',
          component: () => import('../views/AgentDeviceView.vue'),
          meta: { title: '坐席设备', group: '坐席运营' },
        },
        {
          path: 'conversations',
          name: 'conversations',
          component: () => import('../views/ConversationView.vue'),
          meta: { title: '对话管理', group: '坐席运营' },
        },
        {
          path: 'archive',
          name: 'archive',
          component: () => import('../views/ArchiveView.vue'),
          meta: { title: '面试登记', group: '坐席运营' },
        },
        {
          path: 'candidates',
          name: 'candidates',
          component: () => import('../views/CandidateView.vue'),
          meta: { title: '候选人员', group: '坐席运营' },
        },
        {
          path: 'old-friends',
          name: 'old-friends',
          component: () => import('../views/OldFriendView.vue'),
          meta: { title: '老友管理', group: '坐席运营' },
        },
        // 复聊激活
        {
          path: 'activation',
          name: 'activation',
          component: () => import('../views/ActivationDashboardView.vue'),
          meta: { title: '激活看板', group: '复聊激活' },
        },
        {
          path: 'activation/customers',
          name: 'activation-customers',
          component: () => import('../views/ActivationCustomerView.vue'),
          meta: { title: '激活名单', group: '复聊激活' },
        },
        {
          path: 'activation/strategies',
          name: 'activation-strategies',
          component: () => import('../views/ActivationStrategyView.vue'),
          meta: { title: '策略配置', group: '复聊激活' },
        },
        {
          path: 'activation/devices',
          name: 'activation-devices',
          component: () => import('../views/ActivationDeviceView.vue'),
          meta: { title: '设备配置', group: '复聊激活' },
        },
        {
          path: 'activation/scripts',
          name: 'activation-scripts',
          component: () => import('../views/ActivationScriptView.vue'),
          meta: { title: '语料库', group: '复聊激活' },
        },
        // 知识管理
        {
          path: 'knowledge',
          name: 'knowledge',
          component: () => import('../views/KnowledgeView.vue'),
          meta: { title: '知识库配置', group: '知识管理' },
        },
        {
          path: 'unknown-questions',
          name: 'unknown-questions',
          component: () => import('../views/UnknownQuestionView.vue'),
          meta: { title: '未知问题', group: '知识管理' },
        },
        // 系统管理
        {
          path: 'recruiters',
          name: 'recruiters',
          component: () => import('../views/RecruiterView.vue'),
          meta: { title: '招聘员管理', group: '系统管理' },
        },
        {
          path: 'recruiter-featured',
          name: 'recruiter-featured',
          component: () => import('../views/RecruiterFeaturedView.vue'),
          meta: { title: '主推设置', group: '系统管理' },
        },
        {
          path: 'users',
          name: 'users',
          component: () => import('../views/UserView.vue'),
          meta: { title: '用户管理', group: '系统管理' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/SettingsView.vue'),
          meta: { title: '设置', group: '系统管理' },
        },
        {
          path: ':pathMatch(.*)*',
          name: 'not-found',
          component: () => import('../views/NotFoundView.vue'),
          meta: { title: '页面不存在' },
        },
      ],
    },
  ],
})

router.beforeEach((to) => {
  if (!to.meta.public && !hasToken()) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.path === '/login' && hasToken()) return '/dashboard'
  const title = (to.meta.title as string) || ''
  document.title = title ? `${title} · 城市配置管理` : '城市配置管理'
  return true
})

export default router
