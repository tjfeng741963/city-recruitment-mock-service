import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('media library preview', () => {
  it('renders videos in a player and loads them only when previewed', () => {
    const view = readFileSync('frontend-vue/src/views/MediaView.vue', 'utf8');

    expect(view).toMatch(/<video v-if="previewItem\.kind === 'video'" :src="previewUrl" controls\b/);
    expect(view).toMatch(/<img v-else :src="previewUrl"/);
    expect(view).toContain("items.value.filter(row => row.kind === 'image')");
    expect(view).toContain('await fetchMedia(row, request.signal)');
  });
});
