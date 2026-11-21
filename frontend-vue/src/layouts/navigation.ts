export interface NavigationItem { path: string; label: string; adminOnly?: boolean }
export interface NavigationGroup { key: string; label: string; items: NavigationItem[] }

export function navigationForRole(role: string): NavigationGroup[] {
  return [
    { key: 'home', label: '首页', items: [{ path: '/dashboard', label: '首页' }] },
    { key: 'operations', label: '日常招聘', items: [
      { path: '/conversations', label: '对话管理' }, { path: '/candidates', label: '候选人管理' },
      { path: '/archive', label: '面试登记' }, { path: '/agent-devices', label: '微信账号' },
    ] },
    { key: 'basic', label: '招聘资料', items: [
      { path: '/cities', label: '城市' }, { path: '/service-positions', label: '招聘岗位' },
      ...(role === 'recruiter' ? [{ path: '/recruiter-featured', label: '岗位推荐' }] : []),
    ] },
    { key: 'knowledge', label: 'AI 接待', items: [
      { path: '/recruitment-flow', label: '话术流程' },
      { path: '/knowledge', label: '问答知识库' },
      { path: '/media', label: '图片与视频' },
    ] },
    ...(role === 'admin' ? [{ key: 'system', label: '账号与设置', items: [
      { path: '/recruiters', label: '招聘人员' }, { path: '/users', label: '账号权限' },
      { path: '/settings', label: '系统设置' },
    ] }] : []),
  ];
}

export function activeNavigationPath(path: string): string {
  return path === '/device-report' ? '/dashboard' : path;
}

export function positionLink(path: string, id: number) {
  return { path, query: id > 0 ? { position_id: String(id) } : {} };
}
