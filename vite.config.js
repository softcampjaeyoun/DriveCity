import { defineConfig } from 'vite';

/**
 * three.js r0.186 WebGPU 백엔드 우회 패치.
 * 바인딩용 텍스처 뷰를 늘 aspect 'all' 로 만들어, 깊이+스텐실 텍스처(지하차도 구멍용 스텐실을 쓰는 장면 패스의 깊이)를
 * AO 가 샘플링하면 "Multiple aspects (Depth|Stencil) selected" 검증 오류가 난다. 깊이+스텐실이면 'depth-only' 로 만든다.
 * three 를 올렸을 때 이 줄이 없으면(고쳐졌거나 바뀜) 경고만 내고 그대로 둔다
 */
const THREE_ASPECT_FROM = 'const aspectGPU = GPUTextureAspect.All;';
const THREE_ASPECT_TO = "const aspectGPU = ( binding.texture.isDepthTexture && binding.texture.format === DepthStencilFormat ) ? 'depth-only' : GPUTextureAspect.All;";

function threeDepthStencilAspect() {
  return {
    name: 'three-depth-stencil-aspect',
    enforce: 'pre',
    transform(code, id) {
      if (!/three[\\/]build[\\/]three\.webgpu(\.min)?\.js/.test(id)) return null;
      if (!code.includes(THREE_ASPECT_FROM)) {
        this.warn('three.webgpu.js 에서 aspect 패치 대상 줄을 못 찾았어요 (three 버전이 바뀜?)');
        return null;
      }
      return { code: code.replace(THREE_ASPECT_FROM, THREE_ASPECT_TO), map: null };
    },
  };
}

export default defineConfig({
  plugins: [threeDepthStencilAspect()],
  // 사전 번들(esbuild)에 들어가면 위 transform 이 적용되지 않는다
  optimizeDeps: { exclude: ['three'] },
});
