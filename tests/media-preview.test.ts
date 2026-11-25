import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('media library preview', () => {
  it('renders covers in the list and fetches full video only when previewed', () => {
    const view = readFileSync('frontend-vue/src/views/MediaView.vue', 'utf8');

    expect(view).toMatch(/<VideoPreview v-if="previewItem\.kind === 'video'" :src="previewUrl" :name="previewItem\.name"/);
    expect(view).toMatch(/<img v-else :src="previewUrl"/);
    // 列表缩略图对图片和视频都走 preview=thumbnail（别把 5MB 原图拉进浏览器）
    expect(view).toContain("params: { version: row.sha256, preview: 'thumbnail' }");
    // 预览弹窗仍拿原图：fetchMedia 不带 preview
    expect(view).toMatch(/async function fetchMedia[\s\S]{0,200}responseType: 'blob'/);
    expect(view).not.toMatch(/async function fetchMedia[\s\S]{0,200}preview:/);
    // 图片按真实比例装进缩略框，78×132 这类废图一眼可见
    expect(view).toContain('.media-thumb.image img');
    expect(view).toContain('object-fit: contain');
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
