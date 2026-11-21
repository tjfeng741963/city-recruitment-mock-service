(function(){
 'use strict';
 const labels={positions:'招聘工种',salary_detail:'薪资详情',salary_ask:'薪资简述',work_content:'工作内容',meal_dorm:'吃住情况',social_insurance:'社保情况',shift_info:'班次问题',work_hours:'工作时间',factory_env:'工厂环境',dorm_env:'宿舍环境',work_env:'工作环境',uniform:'工衣问题',medical_fee:'体检费问题',luggage_question:'行李问题',interview_notice:'面试通知模板',checkin_guide:'面试指引',registration_form:'报名表单',remarks:'补充说明'};
 const node=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
 const rec=v=>v&&typeof v==='object'&&!Array.isArray(v)?v:{};
 const canonicalSections={salary_detail:'salary',salary_ask:'salary',work_hours:'hours',shift_info:'hours',social_insurance:'insurance',interview_notice:'notice',checkin_guide:'guide'};
 const extras=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
 const token=()=>localStorage.getItem('cr_token')||localStorage.getItem('token')||'';
 async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{authorization:'Bearer '+token(),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw new Error(typeof d.detail==='string'?d.detail:`HTTP ${r.status}`);return d;}
 function style(){if(document.getElementById('city-dify-sources-style'))return;const s=node('style');s.id='city-dify-sources-style';s.textContent='.cds-box{margin:12px 0;padding:14px;border:1px solid #c9d8f0;border-radius:10px;background:#f5f8ff;color:#234}.cds-box button,.cds-dialog button{padding:7px 12px;margin:4px;border:1px solid #bac9de;border-radius:6px;background:white;color:#174fcb;cursor:pointer}.cds-box select,.cds-dialog select{padding:8px;max-width:100%;border:1px solid #bbc9d8;border-radius:6px}.cds-dialog{width:min(850px,90vw);max-height:90vh;border:0;border-radius:12px;padding:22px;box-shadow:0 12px 60px #2345}.cds-dialog::backdrop{background:#17243a66}.cds-dialog label{display:block;font-weight:600;margin-top:14px}.cds-dialog textarea,.cds-box textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #bbc9d8;border-radius:6px;font:inherit;min-height:70px}.cds-dialog pre,.cds-box pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;background:#fff;padding:10px;font-size:12px}.cds-muted{font-size:12px;color:#58677c}.cds-result{white-space:pre-wrap;padding:10px;background:white;border-radius:6px;margin-top:8px}';document.head.append(s);}
 function field(parent,label,value){const l=node('label',label),a=node('textarea');a.value=String(value||'');l.append(a);parent.append(l);return a;}
 async function cityEditor(initialCityName){
  const dialog=node('dialog');dialog.className='cds-dialog';dialog.setAttribute('aria-label','城市完整招聘资料');
  const head=node('h2','城市完整招聘资料 · 模式二 Dify 来源'),note=node('p','这里直接编辑原系统城市资料。保存后模式二每轮实时读取；没有填写的项才回退岗位资料。不会覆盖模式一岗位人设。');note.className='cds-muted';
  const select=node('select');select.setAttribute('aria-label','选择要编辑的城市');const blank=node('option','请选择城市');blank.value='';select.append(blank);
  const state=node('p'),form=node('div'),close=node('button','关闭'),save=node('button','保存完整城市资料');close.onclick=()=>dialog.close();save.disabled=true;
  dialog.append(head,note,select,state,form,save,close);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  let base=null,inputs={},requestId=0;
  try{const cities=await api('/api/v1/cities?page=1&page_size=1000');for(const city of cities.items||[]){const opt=node('option',city.city_name);opt.value=city.id;select.append(opt);}}catch(e){state.textContent=e.message;}
  let categories=[],categoriesLoaded=false;try{const data=await api('/api/v1/verticals');categories=(data.items||data).filter(x=>x.status==='enabled');categoriesLoaded=true;}catch(e){state.textContent='知识品类读取失败：'+e.message;}
  select.onchange=async()=>{const current=++requestId;save.disabled=true;form.replaceChildren();state.textContent='读取中…';try{
   const loaded=await api('/api/v1/cities/'+select.value);if(current!==requestId||!dialog.open)return;base=loaded;inputs={};const salary=rec(base.salary),hours=rec(base.work_hours),interview=rec(base.interview),sections=rec(base.prompt_sections);
   const categoryLabel=node('label','模式二知识品类'),category=node('select');category.setAttribute('aria-label','模式二知识品类');const emptyCategory=node('option','不选品类：只用通用和本岗位知识');emptyCategory.value='';category.append(emptyCategory);for(const item of categories){const option=node('option',item.name);option.value=item.id;category.append(option);}if(base.knowledge_vertical_id&&!categories.some(x=>Number(x.id)===Number(base.knowledge_vertical_id))){const old=node('option','原知识品类（当前不可用，保存其他资料时保留）');old.value=base.knowledge_vertical_id;category.append(old);}category.value=base.knowledge_vertical_id?String(base.knowledge_vertical_id):'';category.disabled=!categoriesLoaded;categoryLabel.append(category);form.append(categoryLabel);inputs.category=category;
   form.append(node('p','选择后复用该品类已启用的历史问答模板，模板中的工资、工时等从本轮资料填入；不会使用其他品类。'));
   const weekdayNames=['周一','周二','周三','周四','周五','周六','周日'];
   const weekdays=node('fieldset');weekdays.append(node('legend','可面试星期'));inputs.days=[];
   const storedDays=Array.isArray(interview.days)?interview.days.map(day=>String(day).replace(/^星期/,'周').replace(/[天七]$/,'日')):[];
   for(const day of weekdayNames){const label=node('label',day),checkbox=node('input');checkbox.type='checkbox';checkbox.value=day;checkbox.checked=storedDays.includes(day);label.style.display='inline-block';label.style.marginRight='12px';label.prepend(checkbox);weekdays.append(label);inputs.days.push(checkbox);}
   form.append(weekdays);
   for(const [key,label,value]of [['salary','薪资原文（例如：综合月薪5000–8000元）',salary.raw||sections.salary_detail||sections.salary_ask],['hours','工作时间',hours.raw||sections.work_hours||sections.shift_info],['insurance','社保说明',base.social_insurances||sections.social_insurance],['time','面试时间',interview.time||interview.raw_time],['address','面试地点',interview.location||interview.raw_address],['coordinates','面试坐标',interview.coordinates],['contact','联系人',interview.contact],['notice','面试通知模板',interview.interview_notice||sections.interview_notice],['guide','面试指引',interview.interview_guide||sections.checkin_guide]])inputs[key]=field(form,label,value);
   const details=node('details'),summary=node('summary','完整话术原文 / 旧版本自定义内容');details.open=true;details.append(summary);form.append(details);
   const names={...labels,...rec(base.prompt_section_labels)};inputs.sections={};
   details.append(node('p','薪资、工作时间、社保、面试通知与指引统一在上方编辑，保存时同步历史话术字段。'));
   for(const key of [...new Set([...Object.keys(labels),...Object.keys(sections)])])if(!canonicalSections[key])inputs.sections[key]=field(details,names[key]||key,sections[key]);
   const advanced=node('details');advanced.append(node('summary','历史附加字段（不含上方已编辑字段）'));inputs.advanced=field(advanced,'附加结构化资料 JSON',JSON.stringify({salary:extras(salary,['raw']),hours:extras(hours,['raw']),interview:extras(interview,['days','time','raw_time','location','raw_address','coordinates','contact','interview_notice','interview_guide']),requirements:rec(base.requirements)},null,2));form.append(advanced);
   state.textContent='已读取「'+base.city_name+'」。只保存此窗口修改的城市，不修改岗位或发送消息。';save.disabled=false;
  }catch(e){state.textContent=e.message;}};
  if(typeof initialCityName==='string'){const option=[...select.options].find(o=>o.textContent===initialCityName);if(option){select.value=option.value;select.onchange();}}
  save.onclick=async()=>{save.disabled=true;select.disabled=true;try{const advanced=JSON.parse(inputs.advanced.value);const sections={...rec(base.prompt_sections)};for(const[key,a]of Object.entries(inputs.sections))sections[key]=a.value;for(const[key,input]of Object.entries(canonicalSections))if(key in sections)sections[key]=inputs[input].value;
   const body={knowledge_vertical_id:inputs.category.value?Number(inputs.category.value):null,salary:{...rec(advanced.salary),raw:inputs.salary.value},work_hours:{...rec(advanced.hours),raw:inputs.hours.value},social_insurances:inputs.insurance.value,interview:{...rec(advanced.interview),time:inputs.time.value,raw_time:inputs.time.value,location:inputs.address.value,raw_address:inputs.address.value,coordinates:inputs.coordinates.value,contact:inputs.contact.value,interview_notice:inputs.notice.value,interview_guide:inputs.guide.value},requirements:rec(advanced.requirements),prompt_sections:sections,prompt_section_labels:{...labels,...rec(base.prompt_section_labels)}};
   if(!categoriesLoaded||Number(body.knowledge_vertical_id)===Number(base.knowledge_vertical_id)&&!categories.some(x=>Number(x.id)===Number(body.knowledge_vertical_id)))delete body.knowledge_vertical_id;
   body.interview.days=inputs.days.filter(day=>day.checked).map(day=>day.value);
   await api('/api/v1/dify/cities/'+base.id+'/materials','PUT',body);state.textContent='已保存「'+base.city_name+'」，模式二下一轮使用最新城市资料。原城市列表可刷新查看。';
   // Close the stale Vue drawer so its pre-save snapshot cannot overwrite this edit.
   const stale=[...document.querySelectorAll('.el-drawer')].find(x=>x!==dialog&&x.getAttribute('aria-hidden')!=='true');
   const cancel=stale&&[...stale.querySelectorAll('button')].find(b=>b.textContent.trim()==='取消');
   if(cancel)cancel.click();
  }catch(e){state.textContent='保存失败：'+e.message;}finally{save.disabled=false;select.disabled=false;}};
 }
 function render(){style();if(location.pathname==='/cities'){
  for(const drawer of document.querySelectorAll('.el-drawer')){const heading=drawer.querySelector('.el-drawer__header')?.textContent.trim()||'';if(heading==='编辑城市'&&!drawer.querySelector('[data-city-material-open]')){const button=node('button','编辑完整城市原文资料');button.type='button';button.dataset.cityMaterialOpen='1';button.className='el-button';button.onclick=()=>{const item=[...drawer.querySelectorAll('.el-form-item')].find(x=>x.querySelector('.el-form-item__label')?.textContent.trim()==='城市名称');cityEditor(item?.querySelector('input')?.value||'');};drawer.querySelector('.el-drawer__body')?.append(button);}}
  for(const item of document.querySelectorAll('.el-drawer .el-form-item,.el-drawer .el-collapse-item'))if(item.style.display==='none')item.style.display='';
  const header=document.querySelector('.page-header');if(header&&!document.querySelector('[data-city-dify-editor]')){const b=node('button','完整城市资料 · Dify 来源');b.dataset.cityDifyEditor='1';b.className='el-button';b.onclick=()=>cityEditor();(header.querySelector('.header-actions')||header).append(b);}
 }
 }
 let queued=false;const schedule=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;render();});};new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('popstate',schedule);document.readyState==='loading'?document.addEventListener('DOMContentLoaded',schedule,{once:true}):schedule();
})();
