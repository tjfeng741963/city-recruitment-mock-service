import http, { TOKEN_KEY, USER_KEY } from '../api/http'
import type { User } from '../api/types'

export async function login(username: string, password: string): Promise<string> {
  const { data } = await http.post<{ access_token: string }>('/api/v1/auth/login', {
    username,
    password,
  })
  localStorage.setItem(TOKEN_KEY, data.access_token)
  return data.access_token
}

export async function fetchMe(): Promise<User> {
  const { data } = await http.get<User>('/api/v1/auth/me')
  localStorage.setItem(USER_KEY, JSON.stringify(data))
  return data
}

export function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function hasToken(): boolean {
  return Boolean(localStorage.getItem(TOKEN_KEY))
}
