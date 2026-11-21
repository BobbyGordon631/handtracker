import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { makePointMaterial } from './particles';
import { settings } from './settings';
import { POINTS, SEGMENTS } from './strings';

// Coordinates: everything is laid out in CSS pixels with y pointing down (screen
// space). The orthographic camera spans x ∈ [0, W], y ∈ [−H, 0], so world y = −screen y.

const RIBBON_POOL = 40; // 16 live + fading + draft headroom
const SPRITE_MAX = 16 + RIBBON_POOL * 2;

const RIBBON_VERTEX = /* glsl */ `
  attribute float aSide;
  attribute float aU;
  varying float vSide;
  varying float vU;
  void main() {
    vSide = aSide;
    vU = aU;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Thin white-hot core + coloured halo across the ribbon's width.
const RIBBON_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uAlpha;
  varying float vSide;
  varying float vU;
  void main() {
    float d = abs(vSide);
    float core = exp(-d * d * 30.0);
    float halo = exp(-d * d * 4.0);
    float ends = smoothstep(0.0, 0.03, vU) * smoothstep(1.0, 0.97, vU);
    vec3 col = uColor * halo * 0.85 + mix(uColor, vec3(1.0), 0.7) * core * 1.25;
    gl_FragColor = vec4(col * uIntensity * uAlpha * (0.35 + 0.65 * ends), 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  uniform float uProgress;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = fract(atan(p.x, p.y) / 6.2831853 + 1.0); // 0 at 12 o'clock, clockwise
    float ring = exp(-pow((r - 0.82) / 0.035, 2.0));
    float lit = step(a, uProgress);
    vec3 col = uColor * ring * (0.15 + 1.0 * lit);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const SIMPLE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Final composite: darkened, tinted, mirrored webcam + bloomed light layer.
const COMPOSITE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
  uniform sampler2D tVideo;
  uniform sampler2D tLight;
  uniform vec2 uCover;       // displayed video size ÷ viewport (object-fit: cover)
  uniform float uCamGain;    // linear gain = brightness^2.2
  uniform vec3 uTint;
  uniform float uHasVideo;
  varying vec2 vUv;
  void main() {
    vec3 cam = vec3(0.0);
    if (uHasVideo > 0.5) {
      vec2 s = vec2(vUv.x, 1.0 - vUv.y);            // screen, top-down 0..1
      vec2 v = (s - 0.5) / uCover + 0.5;            // → video, top-down 0..1 (cropped)
      v.x = 1.0 - v.x;                              // mirror
      cam = texture2D(tVideo, vec2(v.x, 1.0 - v.y)).rgb;
      float l = dot(cam, vec3(0.2126, 0.7152, 0.0722));
      cam = mix(vec3(l), cam, 0.55) * uTint * uCamGain;
    }
    vec3 light = texture2D(tLight, vUv).rgb;
    gl_FragColor = vec4(cam + light, 1.0);
    #include <colorspace_fragment>
  }
`;

class Ribbon {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private positions = new Float32Array(POINTS * 2 * 3);
  private posAttr: THREE.BufferAttribute;

  constructor() {
    const geom = new THREE.BufferGeometry();
    const side = new Float32Array(POINTS * 2);
    const uAttr = new Float32Array(POINTS * 2);
    for (let i = 0; i < POINTS; i++) {
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      uAttr[i * 2] = uAttr[i * 2 + 1] = i / SEGMENTS;
    }
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geom.setAttribute('aU', new THREE.BufferAttribute(uAttr, 1));
    geom.setIndex(index);
    this.material = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
      uniforms: {
        uColor: { value: new THREE.Color() },
        uIntensity: { value: 1 },
        uAlpha: { value: 1 },
      },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geom, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Extrude a polyline (screen px, x/y pairs) into a ribbon of the given half-width. */
  update(pts: Float32Array, halfWidth: number, hue: number, intensity: number, alpha: number): void {
    const P = this.positions;
    for (let i = 0; i < POINTS; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(SEGMENTS, i + 1);
      let tx = pts[i1 * 2] - pts[i0 * 2];
      let ty = pts[i1 * 2 + 1] - pts[i0 * 2 + 1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const nx = -ty * halfWidth;
      const ny = tx * halfWidth;
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      const o = i * 6;
      P[o] = x - nx;
      P[o + 1] = -(y - ny);
      P[o + 2] = 0;
      P[o + 3] = x + nx;
      P[o + 4] = -(y + ny);
      P[o + 5] = 0;
    }
    this.posAttr.needsUpdate = true;
    const u = this.material.uniforms;
    (u.uColor.value as THREE.Color).setHSL((hue / 360) % 1, 0.9, 0.55);
    u.uIntensity.value = intensity;
    u.uAlpha.value = alpha;
    this.mesh.visible = true;
  }
}

class PalmRing {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: SIMPLE_VERTEX,
      fragmentShader: RING_FRAGMENT,
      uniforms: { uProgress: { value: 0 }, uColor: { value: new THREE.Color(0.55, 0.85, 1.0) } },
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
  set(x: number, y: number, radius: number, progress: number): void {
    this.mesh.position.set(x, -y, 0);
    this.mesh.scale.set(radius, radius, 1);
    this.material.uniforms.uProgress.value = progress;
    this.mesh.visible = progress > 0;
  }
}

/** Pool of absolutely-positioned note-name labels. */
class LabelLayer {
  private els: HTMLDivElement[] = [];
  private used = 0;
  private text: string[] = [];
  constructor(private root: HTMLElement) {}
  begin(): void {
    this.used = 0;
  }
  add(text: string, x: number, y: number, alpha: number, hue: number): void {
    if (alpha <= 0.01) return;
    let el = this.els[this.used];
    if (!el) {
      el = document.createElement('div');
      el.className = 'note-label';
      this.root.appendChild(el);
      this.els.push(el);
      this.text.push('');
    }
    if (this.text[this.used] !== text) {
      el.textContent = text;
      this.text[this.used] = text;
    }
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    el.style.opacity = alpha.toFixed(3);
    el.style.color = `hsl(${hue.toFixed(0)}, 90%, 75%)`;
    el.style.display = '';
    this.used++;
  }
  end(): void {
    for (let i = this.used; i < this.els.length; i++) {
      if (this.els[i].style.display !== 'none') this.els[i].style.display = 'none';
    }
  }
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly labels: LabelLayer;
  width = 1;
  height = 1;
  pixelRatio = 1;

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private compositeScene = new THREE.Scene();
  private compositeCam = new THREE.Camera();
  private composite: THREE.ShaderMaterial;
  private videoTex: THREE.VideoTexture | null = null;

  private ribbons: Ribbon[] = [];
  private ribbonsUsed = 0;
  private rings: [PalmRing, PalmRing] = [new PalmRing(), new PalmRing()];

  private spritePos = new Float32Array(SPRITE_MAX * 3);
  private spriteCol = new Float32Array(SPRITE_MAX * 3);
  private spriteSize = new Float32Array(SPRITE_MAX);
  private spriteGeom = new THREE.BufferGeometry();
  private spriteMat = makePointMaterial();
  private spritesUsed = 0;
  private tmpColor = new THREE.Color();
  private pointMaterials: THREE.ShaderMaterial[] = [];

  constructor(container: HTMLElement, labelRoot: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
    this.camera.position.z = 1;

    for (let i = 0; i < RIBBON_POOL; i++) {
      const r = new Ribbon();
      this.ribbons.push(r);
      this.scene.add(r.mesh);
    }
    for (const ring of this.rings) this.scene.add(ring.mesh);

    this.spriteGeom.setAttribute('position', new THREE.BufferAttribute(this.spritePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.spriteGeom.setAttribute('aColor', new THREE.BufferAttribute(this.spriteCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.spriteGeom.setAttribute('aSize', new THREE.BufferAttribute(this.spriteSize, 1).setUsage(THREE.DynamicDrawUsage));
    const sprites = new THREE.Points(this.spriteGeom, this.spriteMat);
    sprites.frustumCulled = false;
    sprites.renderOrder = 2;
    this.scene.add(sprites);
    this.pointMaterials.push(this.spriteMat);

    // Light layer → bloom. Only light lives in this scene, so threshold 0 is fine.
    this.composer = new EffectComposer(this.renderer);
    this.composer.renderToScreen = false;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), settings.bloomStrength, settings.bloomRadius, 0);
    this.composer.addPass(this.bloom);

    this.composite = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: {
        tVideo: { value: null },
        tLight: { value: null },
        uCover: { value: new THREE.Vector2(1, 1) },
        uCamGain: { value: 0.05 },
        uTint: { value: new THREE.Vector3(0.75, 0.92, 1.3) },
        uHasVideo: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    quad.frustumCulled = false;
    this.compositeScene.add(quad);

    this.labels = new LabelLayer(labelRoot);
    this.applySettings();
  }

  /** Register an extra Points material so its pixel-ratio uniform tracks resizes. */
  addPoints(points: THREE.Points, material: THREE.ShaderMaterial): void {
    this.scene.add(points);
    this.pointMaterials.push(material);
    material.uniforms.uPixelRatio.value = this.pixelRatio;
  }

  setVideo(video: HTMLVideoElement): void {
    this.videoTex = new THREE.VideoTexture(video);
    this.videoTex.colorSpace = THREE.SRGBColorSpace;
    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.composite.uniforms.tVideo.value = this.videoTex;
    this.composite.uniforms.uHasVideo.value = 1;
  }

  setCover(sx: number, sy: number): void {
    (this.composite.uniforms.uCover.value as THREE.Vector2).set(sx, sy);
  }

  applySettings(): void {
    this.bloom.strength = settings.bloomStrength;
    this.bloom.radius = settings.bloomRadius;
    // Brightness is perceptual (like CSS brightness on sRGB); convert to a linear gain.
    this.composite.uniforms.uCamGain.value = Math.pow(settings.cameraBrightness, 2.2);
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(w, h);
    this.camera.right = w;
    this.camera.bottom = -h;
    this.camera.updateProjectionMatrix();
    for (const m of this.pointMaterials) m.uniforms.uPixelRatio.value = this.pixelRatio;
  }

  beginFrame(): void {
    this.ribbonsUsed = 0;
    this.spritesUsed = 0;
    this.labels.begin();
  }

  drawString(pts: Float32Array, halfWidth: number, hue: number, intensity: number, alpha: number): void {
    if (this.ribbonsUsed >= RIBBON_POOL) return;
    this.ribbons[this.ribbonsUsed++].update(pts, halfWidth, hue, intensity, alpha);
  }

  /** A glowing dot (fingertips, string anchors). */
  sprite(x: number, y: number, size: number, hue: number, sat: number, light: number, intensity: number): void {
    if (this.spritesUsed >= SPRITE_MAX) return;
    const i = this.spritesUsed++;
    this.tmpColor.setHSL((hue / 360) % 1, sat, light);
    this.spritePos[i * 3] = x;
    this.spritePos[i * 3 + 1] = -y;
    this.spritePos[i * 3 + 2] = 0;
    this.spriteCol[i * 3] = this.tmpColor.r * intensity;
    this.spriteCol[i * 3 + 1] = this.tmpColor.g * intensity;
    this.spriteCol[i * 3 + 2] = this.tmpColor.b * intensity;
    this.spriteSize[i] = size;
  }

  palmRing(i: number, x: number, y: number, radius: number, progress: number): void {
    this.rings[i].set(x, y, radius, progress);
  }

  endFrame(): void {
    for (let i = this.ribbonsUsed; i < RIBBON_POOL; i++) this.ribbons[i].mesh.visible = false;
    for (let i = this.spritesUsed; i < SPRITE_MAX; i++) this.spriteSize[i] = 0;
    this.spriteGeom.attributes.position.needsUpdate = true;
    this.spriteGeom.attributes.aColor.needsUpdate = true;
    this.spriteGeom.attributes.aSize.needsUpdate = true;
    this.labels.end();

    this.composer.render();
    this.composite.uniforms.tLight.value = this.composer.readBuffer.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.compositeCam);
  }
}
