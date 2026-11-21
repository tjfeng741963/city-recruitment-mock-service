import { describe, expect, it, vi } from 'vitest';
const post=vi.hoisted(()=>vi.fn(async (_url:string,payload:Record<string,unknown>)=>({data:{id:42,...payload}})));
vi.mock('../frontend-vue/src/api/http',()=>({default:{post}}));
import { createKnowledgeItem } from '../frontend-vue/src/api/knowledge.js';

describe('岗位知识新增',()=>{
  it('writes position scope before any knowledge list has loaded',async()=>{
    await createKnowledgeItem({question:'集合后怎么办',answer:'联系老师',keywords:[],vertical_id:null,
      scope_level:'position',scope_position_id:28,scope_location_id:null,scope_employer_id:null,status:'enabled',sort_order:0});
    expect(post).toHaveBeenCalledWith('/api/v1/kb-faqs',expect.objectContaining({scope_level:'position',scope_position_id:28}));
  });
});
