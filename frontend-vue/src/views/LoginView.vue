<template>
  <main class="yuanyi-login">
    <div class="yuanyi-login__frame">
      <div class="yuanyi-login__stage" @pointerenter="startReflection" @pointermove="moveReflection" @pointerleave="hideReflection">
        <div class="yuanyi-login__light" aria-hidden="true" />
        <div ref="reflection" class="yuanyi-login__reflection" aria-hidden="true" />
        <div class="yuanyi-login__contours" aria-hidden="true" />
        <YuanyiMark animated label="源绎" class="yuanyi-login__artwork" />
      </div>

      <section class="yuanyi-login__access" aria-labelledby="yuanyi-login-title">
        <div class="yuanyi-login__content">
          <h1 id="yuanyi-login-title">登录</h1>

          <form class="yuanyi-login__form" novalidate @submit.prevent="handleSubmit">
            <div class="yuanyi-login__field">
              <label for="yuanyi-username">用户名</label>
              <input
                id="yuanyi-username"
                ref="usernameInput"
                v-model="form.username"
                name="username"
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
                required
                :aria-invalid="invalidField === 'username' || undefined"
                :aria-describedby="invalidField === 'username' ? 'yuanyi-login-error' : undefined"
                @input="clearError"
              />
            </div>
            <div class="yuanyi-login__field">
              <label for="yuanyi-password">密码</label>
              <div class="yuanyi-login__password">
                <input
                  id="yuanyi-password"
                  ref="passwordInput"
                  v-model="form.password"
                  name="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  required
                  :aria-invalid="invalidField === 'password' || undefined"
                  :aria-describedby="invalidField === 'password' ? 'yuanyi-login-error' : undefined"
                  @input="clearError"
                />
                <button
                  type="button"
                  class="yuanyi-login__visibility"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  aria-controls="yuanyi-password"
                  @click="showPassword = !showPassword"
                >
                  <component :is="showPassword ? Hide : View" aria-hidden="true" />
                </button>
              </div>
            </div>

            <p v-if="errorMessage" id="yuanyi-login-error" class="yuanyi-login__error" role="alert">
              {{ errorMessage }}
            </p>
            <button class="yuanyi-login__submit" type="submit" :disabled="submitting">
              <span v-if="submitting" class="yuanyi-login__spinner" aria-hidden="true" />
              {{ submitting ? '正在登录…' : '登录' }}
              <ArrowRight v-if="!submitting" class="yuanyi-login__arrow" aria-hidden="true" />
            </button>
            <span class="yuanyi-login__status" role="status">{{ submitting ? '正在登录' : '' }}</span>
          </form>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ArrowRight, Hide, View } from '@element-plus/icons-vue'
import { isAxiosError } from 'axios'
import { nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import YuanyiMark from '../components/YuanyiMark.vue'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const form = reactive({ username: '', password: '' })
const usernameInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)
const showPassword = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const invalidField = ref<'username' | 'password' | ''>('')
const reflection = ref<HTMLDivElement | null>(null)
const pointerMotion = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)')
let stageBox: DOMRect | undefined
let reflectionFrame = 0

function startReflection(event: PointerEvent): void {
  if (event.pointerType !== 'mouse' || !pointerMotion.matches) return
  stageBox = (event.currentTarget as HTMLElement).getBoundingClientRect()
  moveReflection(event)
}

function moveReflection(event: PointerEvent): void {
  if (!stageBox || !pointerMotion.matches || event.pointerType !== 'mouse') return
  const x = event.clientX - stageBox.left
  const y = event.clientY - stageBox.top
  cancelAnimationFrame(reflectionFrame)
  reflectionFrame = requestAnimationFrame(() => {
    const light = reflection.value
    if (!light) return
    light.style.transform = `translate3d(${x}px, ${y}px, 0)`
    light.dataset.visible = ''
  })
}

function hideReflection(): void {
  cancelAnimationFrame(reflectionFrame)
  stageBox = undefined
  reflection.value?.removeAttribute('data-visible')
}

onBeforeUnmount(hideReflection)

function clearError(): void {
  invalidField.value = ''
  errorMessage.value = ''
}

async function handleSubmit(): Promise<void> {
  if (submitting.value) return
  clearError()
  const username = form.username.trim()
  if (!username || !form.password) {
    invalidField.value = username ? 'password' : 'username'
    errorMessage.value = username ? '请输入密码。' : '请输入用户名。'
    await nextTick()
    const field = username ? passwordInput.value : usernameInput.value
    field?.focus()
    return
  }
  submitting.value = true
  try {
    await auth.login(username, form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/cities'
    await router.replace(redirect)
  } catch (error: unknown) {
    const response = isAxiosError(error) ? error.response : undefined
    errorMessage.value = response?.status === 401 && response.config.url === '/api/v1/auth/login'
      ? '用户名或密码不正确。'
      : response?.status === 429
        ? '登录尝试过于频繁，请稍后再试。'
        : '暂时无法登录，请稍后再试。'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
/* finesse · register=product · design-language=apple · apple-mode=app */
.yuanyi-login {
  --login-ink: #202536;
  --login-muted: #5e6575;
  --login-focus: #376bc5;
  display: grid;
  min-height: 100vh;
  min-height: 100svh;
  background: #f9fafc;
  color: var(--login-ink);
  font-family: "Google Sans Flex", "PingFang SC", "Microsoft YaHei", sans-serif;
}

.yuanyi-login__frame {
  display: grid;
  grid-template-columns: minmax(0, 1.64fr) minmax(350px, 1fr);
}

.yuanyi-login__stage {
  position: relative;
  isolation: isolate;
  display: grid;
  place-items: center;
  overflow: hidden;
  min-width: 0;
  background: #e0e8f8;
}

.yuanyi-login__light {
  position: absolute;
  z-index: -2;
  inset: -1px;
  background:
    radial-gradient(ellipse at 49% 46%, #f9fcff 0%, #f4f8ffb8 23%, transparent 59%),
    radial-gradient(ellipse at 7% 91%, #a7dacc 0%, #bde5dccc 25%, transparent 57%),
    radial-gradient(ellipse at 76% 109%, #f5d79f 1%, #f9e2b0a8 24%, transparent 58%),
    radial-gradient(ellipse at 100% 78%, #e8afc7 0%, #eec9ddc9 24%, transparent 62%),
    radial-gradient(ellipse at 96% 4%, #96a2e3 0%, #b8bff3d9 28%, transparent 66%),
    radial-gradient(ellipse at 0% 0%, #a5c7ed 0%, #c0ddf4 30%, #dde7f8 70%);
}

.yuanyi-login__reflection {
  position: absolute;
  z-index: -1;
  top: -190px;
  left: -190px;
  width: 380px;
  height: 380px;
  background: radial-gradient(closest-side, #fcffff82, #f8faff00);
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}

.yuanyi-login__reflection[data-visible] {
  opacity: 1;
}

.yuanyi-login__contours {
  position: absolute;
  z-index: -1;
  top: 4%;
  left: -34%;
  width: 173%;
  height: 85%;
  transform: rotate(-24deg);
  mask-image: linear-gradient(111deg, #000 9%, #000 30%, transparent 58%, #000 78%);
  pointer-events: none;
}

.yuanyi-login__contours::before,
.yuanyi-login__contours::after {
  position: absolute;
  border: 1px solid #ffffffa8;
  border-radius: 46% 54% 43% 57% / 57% 45% 55% 43%;
  content: '';
}

.yuanyi-login__contours::before {
  inset: 0;
  box-shadow: 0 0 0 22px #ffffff22, 0 0 0 23px #ffffff54;
}

.yuanyi-login__contours::after {
  inset: 12% 2.4% -8% 3.8%;
  border-color: #ffffff83;
  box-shadow: 0 0 0 28px #ffffff1d, 0 0 0 29px #ffffff49;
}

.yuanyi-login__artwork {
  width: min(68%, 790px, max(290px, 88svh));
  margin-top: -2%;
}

.yuanyi-login__access {
  display: grid;
  align-items: center;
  justify-items: center;
  min-width: 0;
  padding: clamp(38px, 5vw, 112px) clamp(28px, 5vw, 112px);
  border-inline-start: 1px solid #c7d0e165;
  background:
    radial-gradient(ellipse at 100% 0%, #edf1fa 0%, transparent 63%),
    linear-gradient(153deg, #fcfcfe 25%, #f7f9fd 100%);
}

.yuanyi-login__content {
  width: min(100%, 390px);
}

.yuanyi-login__content h1 {
  margin: 0;
  font-size: clamp(39px, 4vw, 58px);
  font-weight: 680;
  line-height: 1.12;
}

.yuanyi-login__form {
  margin-top: 30px;
  display: grid;
  gap: 19px;
}

.yuanyi-login__field {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.yuanyi-login__field label {
  font-size: 13px;
  font-weight: 650;
}

.yuanyi-login__field input {
  display: block;
  width: 100%;
  height: 54px;
  box-sizing: border-box;
  padding: 0 16px;
  border: 1px solid #8290a6;
  border-radius: 12px;
  background: #f5f7fa;
  color: var(--login-ink);
  font: inherit;
  font-size: 16px;
  transition: border-color 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
}

.yuanyi-login__field input:hover {
  border-color: #66748b;
}

.yuanyi-login__field input:focus {
  outline: none;
  border-color: var(--login-focus);
  background: #fdfdff;
  box-shadow: 0 0 0 3px #376bc526;
}

.yuanyi-login__field input[aria-invalid='true'] {
  border-color: #b83746;
}

.yuanyi-login__password {
  position: relative;
}

.yuanyi-login__password input {
  padding-right: 58px;
}

.yuanyi-login__visibility {
  position: absolute;
  top: 5px;
  right: 5px;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--login-muted);
  cursor: pointer;
  transition: background-color 160ms ease, color 160ms ease;
}

.yuanyi-login__visibility:hover {
  background: #e6ebf4;
  color: var(--login-ink);
}

.yuanyi-login__visibility svg {
  width: 19px;
  height: 19px;
}

.yuanyi-login__error {
  margin: -4px 0 0;
  color: #ac263b;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.yuanyi-login__submit {
  position: relative;
  isolation: isolate;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 54px;
  margin-top: 7px;
  padding: 0 48px;
  border: 1px solid #1d3a7290;
  border-radius: 12px;
  background: linear-gradient(107deg, #285285 0%, #31599e 42%, #50549b 100%);
  box-shadow: 0 7px 16px -8px #24457c96, 0 1px 0 #ffffff33 inset;
  color: #fff;
  font: inherit;
  font-size: 15px;
  font-weight: 650;
  cursor: pointer;
  transition: box-shadow 180ms ease, transform 180ms ease;
}

.yuanyi-login__submit::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(112deg, #3267a3, #3f63aa 55%, #635ab0);
  opacity: 0;
  transition: opacity 180ms ease;
  content: '';
}

.yuanyi-login__submit:not(:disabled):hover::before {
  opacity: 1;
}

.yuanyi-login__submit:not(:disabled):hover {
  box-shadow: 0 9px 21px -9px #24457ca6, 0 1px 0 #ffffff4a inset;
}

.yuanyi-login__submit:not(:disabled):active {
  transform: scale(.99);
}

.yuanyi-login__submit:disabled {
  cursor: wait;
}

.yuanyi-login__arrow {
  position: absolute;
  right: 18px;
  width: 17px;
  height: 17px;
  transition: transform 180ms ease;
}

.yuanyi-login__submit:hover .yuanyi-login__arrow {
  transform: translateX(3px);
}

.yuanyi-login__visibility:focus-visible,
.yuanyi-login__submit:focus-visible {
  outline: 2px solid var(--login-focus);
  outline-offset: 3px;
}

.yuanyi-login__spinner {
  width: 15px;
  height: 15px;
  border: 2px solid #ffffff75;
  border-top-color: #fff;
  border-radius: 50%;
  animation: yuanyi-login-spin 850ms linear infinite;
}

.yuanyi-login__status {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes yuanyi-login-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 760px) {
  .yuanyi-login__frame {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 1fr;
  }

  .yuanyi-login__stage {
    min-height: clamp(165px, 29svh, 295px);
    padding-top: env(safe-area-inset-top);
  }

  .yuanyi-login__artwork {
    width: min(60%, 288px, max(180px, 35svh));
    margin-top: 0;
  }

  .yuanyi-login__access {
    align-items: start;
    padding: 34px max(25px, env(safe-area-inset-right)) max(36px, env(safe-area-inset-bottom))
      max(25px, env(safe-area-inset-left));
    border-inline-start: 0;
    border-block-start: 1px solid #c7d0e165;
  }

  .yuanyi-login__form {
    margin-top: 24px;
  }
}

@media (max-width: 760px) and (max-height: 670px) {
  .yuanyi-login__access { padding-top: 23px; padding-bottom: 27px; }
  .yuanyi-login__form { margin-top: 18px; gap: 15px; }
}

@media (prefers-reduced-motion: reduce) {
  .yuanyi-login__reflection {
    display: none;
  }

  .yuanyi-login__field input,
  .yuanyi-login__visibility,
  .yuanyi-login__submit,
  .yuanyi-login__submit::before,
  .yuanyi-login__arrow {
    transition: none;
  }

  .yuanyi-login__submit:active,
  .yuanyi-login__submit:hover .yuanyi-login__arrow {
    transform: none;
  }

  .yuanyi-login__spinner {
    animation: none;
  }
}
</style>
