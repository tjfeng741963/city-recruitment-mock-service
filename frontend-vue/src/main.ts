import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import CandidateView from './views/CandidateView.vue'
import { createVNode, withCtx } from 'vue'
// @ts-expect-error Existing same-origin JS helper preserves the deployed OA columns.
import { addRegistrationColumn } from '../../public/theme/candidate-registration-table.js'
const candidate = CandidateView as any
const originalSetup = candidate.setup
candidate.setup = function (this: any, ...args: any[]) {
  const render = originalSetup.apply(this, args)
  return function (this: any, ...renderArgs: any[]) {
    const tree = render.apply(this, renderArgs)
    addRegistrationColumn(tree, createVNode, withCtx)
    return tree
  }
}

import App from './App.vue'
import router from './router'
import './styles/index.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

for (const [name, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(name, component)
}

app.mount('#app')
