<template>
  <section class="position-qa">
    <el-input v-model="question" placeholder="例如：工资多少？包住吗？面试在哪里？" :disabled="busy" />
    <el-button :disabled="!positionId || !question.trim()" :loading="busy" type="primary" @click="preview(false)">查看回答依据</el-button>
    <el-button :disabled="!positionId || !question.trim()" :loading="busy" @click="preview(true)">生成模拟回答</el-button>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="answer" class="qa-answer" role="status">{{ answer }}</div>
    <p v-if="usedFaq">采用问答 #{{ usedFaq.id }} · {{ usedFaq.question }}</p>
    <p v-else-if="evidence?.faq_media_candidate && !answer">匹配到待试答的问答 #{{ evidence.faq_media_candidate.id }} · {{ evidence.faq_media_candidate.question }}</p>
    <el-alert v-if="locationNotice" class="qa-answer" title="位置卡预览" :description="locationNotice" type="info" :closable="false" show-icon />
    <template v-if="evidence"><p>已读取 {{ knowledge.length }} 条适用问答；这表示回答可参考这些内容，不代表每条均被本次命中。</p>
      <dl><template v-for="(value,key) in facts" :key="key"><dt>{{ factLabels[String(key)] || '岗位补充资料' }}</dt><dd>{{ value }}</dd></template></dl>
      <div v-for="item in knowledge" :key="item.id" class="qa-faq"><b>{{ item.question }}</b><p>{{ item.answer }}</p></div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { agentApi } from '../../api/agent'
import { describeFavoriteLocation } from './favorite-location-preview'
const props = defineProps<{positionId:number}>()
const factLabels:Record<string,string>={city:'城市',factory_name:'招聘项目',job_title:'岗位',wage_text:'工资',hours_text:'工作时间',age_text:'年龄要求',welfare_text:'吃住与福利',place:'工作地点',interview_address:'面试地址',interview_time:'面试时间',basic_requirements:'招聘要求',height_text:'身高要求',job_content:'工作内容',cert_text:'证件要求'}
const question=ref(''),busy=ref(false),error=ref(''),answer=ref(''),evidence=ref<Record<string,any>|null>(null)
const usedFaq = ref<{ id: number; question: string }>()
const facts=computed(()=>evidence.value?.facts || {})
const knowledge=computed<Array<{id:number;question:string;answer:string}>>(()=>evidence.value?.knowledge || [])
const locationNotice=computed(()=>describeFavoriteLocation(evidence.value?.favorite_location_preview))
watch(()=>props.positionId,()=>{evidence.value=null;answer.value='';error.value='';usedFaq.value=undefined})
async function preview(generate:boolean) {
  busy.value=true;error.value='';answer.value='';evidence.value=null;usedFaq.value=undefined
  try {
    const {data}=await agentApi.chat({position_id:props.positionId,text:question.value,dry:true})
    evidence.value=data
    if(generate) {
      const result=await agentApi.chat({position_id:props.positionId,text:question.value,preview:true})
      const value=result.data as any
      if(!value.ok) throw new Error(value.error || '模拟回答失败')
      usedFaq.value = value.reply?.faq
      answer.value=(value.reply?.messages || value.messages || []).map((item:any)=>item.content || item.name || '').join('\n') || '模型未生成可显示的回答'
    }
  } catch(e:any) {error.value=String(e?.response?.data?.detail || e?.message || '试答失败')}
  finally {busy.value=false}
}
</script>
<style scoped>
.position-qa{margin:0 0 16px}.position-qa p{font-size:12px;color:var(--bd-text-secondary)}.position-qa .el-input{margin-bottom:10px}.qa-answer,.qa-faq{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;margin-top:10px;background:var(--el-fill-color-light);border-radius:8px}dl{display:grid;grid-template-columns:minmax(70px, 1fr) 2fr;font-size:12px;gap:6px}dd{margin:0;white-space:pre-wrap}
</style>
