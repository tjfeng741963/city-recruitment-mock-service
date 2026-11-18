import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { clearSession, fetchMe, login as loginApi, readStoredUser } from '../api/auth'
import { TOKEN_KEY } from '../api/http'
import type { User } from '../api/types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>(localStorage.getItem(TOKEN_KEY) || '')
  const user = ref<User | null>(readStoredUser())
  const loading = ref(false)
  const isAuthed = computed(() => Boolean(token.value))

  async function login(username: string, password: string): Promise<void> {
    loading.value = true
    try {
      token.value = await loginApi(username, password)
      user.value = await fetchMe()
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    if (!token.value) return
    user.value = await fetchMe()
  }

  function logout(): void {
    clearSession()
    token.value = ''
    user.value = null
  }

  return { token, user, loading, isAuthed, login, refresh, logout }
})
