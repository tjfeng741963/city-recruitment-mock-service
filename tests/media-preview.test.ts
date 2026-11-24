import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('media library preview', () => {
  it('renders covers in the list and fetches full video only when previewed', () => {
    const view = readFileSync('frontend-vue/src/views/MediaView.vue', 'utf8');

    expect(view).toMatch(/<VideoPreview v-if="previewItem\.kind === 'video'" :src="previewUrl" :name="previewItem\.name"/);
    expect(view).toMatch(/<img v-else :src="previewUrl"/);
    expect(view).toContain("preview: row.kind === 'video' ? 'thumbnail' : undefined");
    expect(view).toMatch(/<img\s+v-if="thumbUrl\(row\)"/);
    expect(view).toContain('watch(paged,');
    expect(view).toContain('await fetchMedia(row, request.signal)');
  });

  it('shares the compatibility fallback for failed playback and audio-only metadata', () => {
    const player = readFileSync('frontend-vue/src/components/agent/VideoPreview.vue', 'utf8');
    const flow = readFileSync('frontend-vue/src/components/agent/FlowMediaPreview.vue', 'utf8');
    expect(flow).toContain('<VideoPreview v-else');
    expect(player).toContain('@error="prepareCompatible"');
    expect(player).toContain('if (!video.videoWidth || !video.videoHeight) void prepareCompatible()');
    expect(player).toContain("params: { preview: 'compatible' }");
  });
});
