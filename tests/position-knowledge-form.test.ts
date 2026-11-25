import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
const post=vi.hoisted(()=>vi.fn(async (_url:string,payload:Record<string,unknown>)=>({data:{id:42,...payload}})));
vi.mock('../frontend-vue/src/api/http',()=>({default:{post}}));
import { createKnowledgeItem } from '../frontend-vue/src/api/knowledge.js';

describe('岗位知识新增',()=>{
  it('copies a row into the create dialog without writing or changing the original', async () => {
    const view = readFileSync(new URL('../frontend-vue/src/views/KnowledgeView.vue', import.meta.url), 'utf8');
    expect(view).toContain('@click="openCopy(row)">复制</el-button>');
    const start = view.indexOf('function openCopy(');
    const end = view.indexOf('\nasync function save(', start);
    const script = ts.transpileModule(view.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const row = { id: 7, question: '原问题', answer: '原答案', keywords: ['原关键词'], status: 'enabled', scope_level: 'position', scope_position_id: 28 };
    const editing = { value: row };
    const copySource = { value: null };
    const dialogVisible = { value: false };
    const openCopy = runInNewContext(script + '\nopenCopy', { editing, copySource, dialogVisible });
    openCopy(row);
    expect(editing.value).toBeNull();
    expect(copySource.value).toBe(row);
    expect(dialogVisible.value).toBe(true);
    expect(row.status).toBe('enabled');
  });

  it('prefills copied content, preserves scope, and starts disabled', () => {
    const dialog = readFileSync(new URL('../frontend-vue/src/components/kb/KnowledgeFormDialog.vue', import.meta.url), 'utf8');
    const source = { question: '原问题', answer: '原答案', keywords: ['原关键词'], status: 'enabled', sort_order: 3, vertical_id: 9, scope_level: 'position', scope_position_id: 28 as number | null };
    const props = { item: null, copySource: source, positionId: 30, positionsLoading: false, positions: [{ id: 28 }, { id: 30 }] };
    const form = {};
    const reset = dialog.match(/function reset\(\): void \{[^]*?\n}/)?.[0] ?? '';
    const script = ts.transpileModule(reset, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(script + '\nreset()', { props, form, keywordInput: { value: '' } });
    expect(form).toMatchObject({ applicability: 28, question: '原问题', answer: '原答案', keywords: ['原关键词'], enabled: false, vertical_id: 9, sort_order: 3 });
    expect((form as { keywords: string[] }).keywords).not.toBe(source.keywords);
    source.scope_position_id = null;
    runInNewContext(script + '\nreset()', { props, form, keywordInput: { value: '' } });
    expect(form).toMatchObject({ applicability: undefined });
    expect(dialog).toContain('v-if="legacyScope || copySource"');
  });
  it('sets the scope in the dialog before submitting and opens without a page-level selection', () => {
    const read = (path: string) => readFileSync(new URL(`../frontend-vue/src/${path}`, import.meta.url), 'utf8');
    const dialog = read('components/kb/KnowledgeFormDialog.vue');
    expect(dialog).toContain('v-model="form.applicability"');
    expect(dialog).toContain('scope_position_id: scopeLevel === \'position\' ? selectedPositionId : null');
    const view = read('views/KnowledgeView.vue');
    const createButton = view.match(/<el-button[^>]*@click="openCreate"[^>]*>/)?.[0];
    expect(createButton).toBeDefined();
    expect(createButton).not.toContain(':disabled');
  });
  it('writes position scope before any knowledge list has loaded',async()=>{
    await createKnowledgeItem({question:'集合后怎么办',answer:'联系老师',keywords:[],vertical_id:null,
      scope_level:'position',scope_position_id:28,scope_location_id:null,scope_employer_id:null,status:'enabled',sort_order:0});
    expect(post).toHaveBeenCalledWith('/api/v1/kb-faqs',expect.objectContaining({scope_level:'position',scope_position_id:28}));
  });

  it('saves an edited copy by creating a separate disabled FAQ', async () => {
    const view = readFileSync(new URL('../frontend-vue/src/views/KnowledgeView.vue', import.meta.url), 'utf8');
    const save = view.match(/async function save\(draft: KnowledgeDraft\): Promise<void> \{[^]*?\n}/)?.[0] ?? '';
    const script = ts.transpileModule(save, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const updateKnowledgeItem = vi.fn();
    const context = {
      editing: { value: null },
      submitting: { value: false },
      dialogVisible: { value: true },
      positionId: { value: 28 },
      positions: { value: [{ id: 28, position_name: '岗位' }] },
      ElMessage: { success: vi.fn(), error: vi.fn() },
      load: vi.fn(),
      createKnowledgeItem,
      updateKnowledgeItem,
    };
    const submit = runInNewContext(script + '\nsave', context);
    await submit({
      question: '编辑后的问题', answer: '沿用的答案', keywords: ['关键词'], vertical_id: 9,
      scope_level: 'position', scope_position_id: 28, scope_location_id: null, scope_employer_id: null,
      status: 'disabled', sort_order: 3,
    });
    expect(post).toHaveBeenLastCalledWith('/api/v1/kb-faqs', expect.objectContaining({
      question: '编辑后的问题', status: 'disabled', scope_position_id: 28, vertical_id: 9,
    }));
    expect(updateKnowledgeItem).not.toHaveBeenCalled();
    expect(context.dialogVisible.value).toBe(false);
  });
});
