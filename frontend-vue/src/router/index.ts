import { createRouter, createWebHistory } from 'vue-router'
import { hasToken } from '../api/auth'

/** 业务页面按路由懒加载。 */
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
          meta: { title: '首页', group: '监控' },
        },
        {
          path: 'device-report',
          name: 'device-report',
          component: () => import('../views/StatusDashboardView.vue'),
          meta: { title: '设备报表', group: '日常招聘' },
        },
        {
          path: 'account-summary',
          name: 'account-summary',
          component: () => import('../views/AccountSummaryView.vue'),
          meta: { title: '运营汇总', group: '日常招聘' },
        },
        // 基础配置
        {
          path: 'cities',
          name: 'cities',
          component: () => import('../views/CityView.vue'),
          meta: { title: '城市', group: '招聘资料' },
        },
        {
          path: 'factories',
          name: 'factories',
          component: () => import('../views/FactoryView.vue'),
          meta: { title: '厂区管理', group: '招聘资料' },
        },
        {
          path: 'service-positions',
          name: 'service-positions',
          component: () => import('../views/ServicePositionView.vue'),
          meta: { title: '招聘岗位', group: '招聘资料' },
        },
        {
          path: 'city-links',
          name: 'city-links',
          component: () => import('../views/CityLinkView.vue'),
          meta: { title: '周边城市设置', group: '招聘资料' },
        },
        {
          path: 'media',
          name: 'media',
          component: () => import('../views/MediaView.vue'),
          meta: { title: '图片与视频', group: 'AI 接待' },
        },
        {
          path: 'holidays',
          name: 'holidays',
          component: () => import('../views/HolidayView.vue'),
          meta: { title: '节假日管理', group: '招聘资料' },
        },
        {
          path: 'factory-overview',
          name: 'factory-overview',
          component: () => import('../views/FactoryOverviewView.vue'),
          meta: { title: '工厂配置总览', group: '招聘资料' },
        },
        // 坐席运营
        {
          path: 'agent-devices',
          name: 'agent-devices',
          component: () => import('../views/AgentDeviceView.vue'),
          meta: { title: '微信账号', group: '日常招聘' },
        },
        {
          path: 'conversations',
          name: 'conversations',
          component: () => import('../views/ConversationView.vue'),
          meta: { title: '对话管理', group: '日常招聘' },
        },
        {
          path: 'recontact',
          name: 'recontact',
          component: () => import('../views/RecontactView.vue'),
          meta: { title: '复聊板块', group: '日常招聘' },
        },
        {
          path: 'archive',
          name: 'archive',
          component: () => import('../views/ArchiveView.vue'),
          meta: { title: '面试登记', group: '日常招聘' },
        },
        {
          path: 'candidates',
          name: 'candidates',
          component: () => import('../views/CandidateView.vue'),
          meta: { title: '候选人员', group: '日常招聘' },
        },
        {
          path: 'old-friends',
          name: 'old-friends',
          component: () => import('../views/OldFriendView.vue'),
          meta: { title: '老友管理', group: '日常招聘' },
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
          meta: { title: '问答知识库', group: 'AI 接待' },
        },
        {
          path: 'recruitment-flow',
          name: 'recruitment-flow',
          component: () => import('../views/AgentFlowView.vue'),
          meta: { title: '话术流程', group: 'AI 接待' },
        },
        {
          path: 'unknown-questions',
          name: 'unknown-questions',
          component: () => import('../views/UnknownQuestionView.vue'),
          meta: { title: '未知问题', group: 'AI 接待' },
        },
        // 系统管理
        {
          path: 'recruiters',
          name: 'recruiters',
          component: () => import('../views/RecruiterView.vue'),
          meta: { title: '招聘人员', group: '账号与设置' },
        },
        {
          path: 'recruiter-featured',
          name: 'recruiter-featured',
          component: () => import('../views/RecruiterFeaturedView.vue'),
          meta: { title: '主推设置', group: '账号与设置' },
        },
        {
          path: 'users',
          name: 'users',
          component: () => import('../views/UserView.vue'),
          meta: { title: '账号权限', group: '账号与设置' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../views/SettingsView.vue'),
          meta: { title: '设置', group: '账号与设置' },
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
  return true
})

router.afterEach((to, _from, failure) => {
  if (failure) return
  const title = (to.meta.title as string) || ''
  document.title = to.name === 'login' ? '登录 · 源绎招聘' : title ? `${title} · 城市配置管理` : '城市配置管理'
})

export default router
