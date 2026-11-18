import axios from 'axios'

export const TOKEN_KEY = 'cr_token'
export const USER_KEY = 'cr_user'

/**
 * 前后端分离：接口基址由环境变量注入。
 * - 开发：留空，走 Vite proxy（/api → 127.0.0.1:8080），避免 CORS。
 * - 生产：设置 VITE_API_BASE_URL=https://api.example.com，前端可独立部署在任意静态站点。
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')

const http = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      if (location.pathname !== '/login') location.href = '/login'
    }
    return Promise.reject(error)
  },
)

/** 把后端返回的相对路径（/api/v1/media/xxx）拼成可直接访问的地址 */
export function backendUrl(path: string): string {
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return path
  return `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
}

export default http
