const el=id=>document.getElementById(id);
const testSession=()=> 'dify-test:'+Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join('');
let session=testSession();
const requestedDevice=new URLSearchParams(location.search).get('device_code')||'';
const token=localStorage.getItem('cr_token')||localStorage.getItem('access_token')||'';
async function api(path,method='GET',data){
 const response=await fetch(path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
 const body=await response.json();if(!response.ok)throw new Error(body.detail||`HTTP ${response.status}`);return body;
}
function notice(message,error=false){el('notice').textContent=message;el('notice').className=error?'error':'muted';}
async function status(){if(!el('device').value)return;const state=await api('/api/v1/agent/devices/'+encodeURIComponent(el('device').value)+'/reply-provider');el('provider').value=state.provider;el('state').textContent=state.configured?'Dify 服务端配置已就绪。':'Dify 服务端地址或应用密钥尚未配置。';}
function bubble(role,text){const item=document.createElement('div');item.className='bubble '+(role==='求职者'?'user':'');item.textContent=role+'：'+text;el('chat').append(item);item.scrollIntoView({block:'nearest'});}
el('device').onchange=()=>{session=testSession();el('chat').replaceChildren();status().catch(e=>notice(e.message,true));};
el('save').onclick=async()=>{try{if(!el('device').value)return;await api('/api/v1/agent/devices/'+encodeURIComponent(el('device').value)+'/reply-provider','PUT',{provider:el('provider').value,fresh_client_state_confirmed:el('fresh').checked});notice('来源已保存。请重新启动已停止的客户端，清除原开场缓存后生效。');await status();}catch(e){notice(e.message,true);}};
el('inspect').onclick=async()=>{try{const r=await api('/api/v1/agent/chat','POST',{device_code:el('device').value,session_key:session,text:'测试岗位输入',dry:true});el('facts').hidden=false;el('facts').textContent=JSON.stringify(r.inputs||r.facts||r,null,2);}catch(e){notice(e.message,true);}};
el('reset').onclick=()=>{session=testSession();el('chat').replaceChildren();notice('已新建独立测试会话。');};
el('form').onsubmit=async event=>{event.preventDefault();if(el('provider').value!=='dify'){notice('请先选择专用测试设备，保存 Dify 来源。',true);return;}el('send').disabled=true;const text=el('text').value;bubble('求职者',text);el('text').value='';try{const result=await api('/api/v1/agent/chat','POST',{device_code:el('device').value,session_key:session,text});if(!result.ok)throw new Error(result.code+'：'+result.error);for(const m of result.reply.messages)bubble('Dify',m.content);notice('已生成测试回复；未向企微发送。');}catch(e){bubble('暂停',e.message);}finally{el('send').disabled=false;}};
try{if(!token)throw new Error('请先在招聘系统登录管理员，再打开本页。');const data=await api('/api/v1/agent/devices');el('device').replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent='请选择专用测试设备';el('device').append(blank);for(const d of data.items||[]){const option=document.createElement('option');option.value=d.device_code;option.textContent=(d.name||d.device_code)+' · '+d.device_code;el('device').append(option);}if(requestedDevice){if((data.items||[]).some(d=>d.device_code===requestedDevice)){el('device').value=requestedDevice;await status();notice('已选择该账号。此处查看回复来源和测试；工作流内容请在 Dify 后台维护。');}else{notice('指定账号不存在或无权访问，请核对后重新选择。',true);}}else{notice('选择设备后可查看配置。');}}catch(e){notice(e.message,true);}
