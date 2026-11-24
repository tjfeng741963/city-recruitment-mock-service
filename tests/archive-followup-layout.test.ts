import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const view = (name: string) =>
  readFileSync(new URL(`../frontend-vue/src/views/${name}.vue`, import.meta.url), 'utf8');

describe('recruitment page labels and follow-up layout', () => {
  it('uses a neutral label on the existing positions import and export button', () => {
    expect(view('ServicePositionView')).toContain('@click="importVisible = true">导入 / 导出</el-button>');
  });

  it('keeps one follow-up panel below registration details, using the existing summary fields', () => {
    const archive = view('ArchiveView');
    expect(archive).toMatch(/<div v-else class="arch-card arch-empty">选择左侧一条登记查看详情<\/div>\s*<section v-if="selected" class="followup-panel"/);
    expect(archive.match(/@click="generateFollowup"/g)).toHaveLength(1);
    expect(archive).toContain('AI 跟进分析');
    for (const field of ['intent', 'discussed', 'experience', 'next_question']) {
      expect(archive).toContain(`summary?.${field}`);
    }
    expect(archive).toContain('currentFollowup.summary.quote');
    expect(archive).toContain('暂无可分析的对话');
  });

  it('measures coverage from associated conversations in the registration list', () => {
    const archive = view('ArchiveView');
    expect(archive).toContain('items.value.filter(item => item.has_conversation).length');
    expect(archive).toContain('对话覆盖');
  });
});
