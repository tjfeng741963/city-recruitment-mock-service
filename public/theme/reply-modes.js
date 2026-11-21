(function () {
  "use strict";
  function render() {
    const sidebar=document.querySelector('.sidebar');
    const menu=sidebar?.querySelector('.sidebar-menu');
    if(menu&&!sidebar.querySelector('[data-reply-mode-navigation]')){
      const section=document.createElement('nav');
      section.dataset.replyModeNavigation='1';section.setAttribute('aria-label','两套回复模式');
      section.style.cssText='margin:10px 12px;padding:12px;border:1px solid #d4def0;border-radius:10px;font-size:12px;line-height:1.7;background:rgba(255,255,255,.65)';
      const title=document.createElement('strong');title.textContent='回复模式';section.append(title);
      for(const [label,url] of [['模式一 · 系统 Agent','/recruitment-flow'],['模式二 · Dify 工作流','/dify-connection']]){
        const link=document.createElement('a');link.textContent=label;link.href=url;link.style.cssText='display:block;margin-top:7px;color:#174fcb;text-decoration:none';section.append(link);
      }
      const note=document.createElement('small');note.textContent='两套独立配置，按微信账号选择';section.append(note);menu.after(section);
    }
    if(location.pathname==='/agent-devices'){
      const header=document.querySelector('.page-header');
      if(header&&!document.querySelector('[data-reply-mode-note]')){
        const note=document.createElement('p');note.dataset.replyModeNote='1';note.style.cssText='padding:10px 14px;background:#eef4ff;border-radius:8px;color:#25466d';
        note.append('模式一：系统 Agent（话术流程与人设）；模式二：Dify 工作流。');
        const link=document.createElement('a');link.href='/dify-connection';link.textContent='进入模式二配置与测试';link.style.marginLeft='10px';note.append(link);header.after(note);
      }
    }
  }
  let queued=false;
  const schedule=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;render();});};
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true});
  window.addEventListener('popstate',schedule);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule,{once:true});else schedule();
})();
