import * as THREE from 'three';
import { pointOn, type HarpString } from './strings';

const MAX = 2048;
const GRAVITY = 260; // px/s², gentle so sparks arc instead of drop
const DRAG = 1.6; // 1/s

export const POINT_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPixelRatio;
  }
`;

export const POINT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    if (d > 1.0) discard;
    float a = exp(-d * d * 4.0);
    gl_FragColor = vec4(vColor * a, 1.0);
  }
`;

export function makePointMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: POINT_VERTEX,
    fragmentShader: POINT_FRAGMENT,
    uniforms: { uPixelRatio: { value: 1 } },
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
}

/**
 * Pooled spark particles (struct-of-arrays, ring-buffer allocation, no per-frame garbage).
 * A particle is either riding a string ("rail": moves along u and follows the
 * string's vibration) or free (ballistic with gravity + drag). Rail sparks that
 * run off a string's end turn free and spray outward.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  readonly material = makePointMaterial();

  private x = new Float32Array(MAX);
  private y = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private r = new Float32Array(MAX);
  private g = new Float32Array(MAX);
  private b = new Float32Array(MAX);
  private u = new Float32Array(MAX);
  private du = new Float32Array(MAX); // rail speed in px/s (signed)
  private rail: (HarpString | null)[] = new Array(MAX).fill(null);
  private next = 0;

  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private sizes = new Float32Array(MAX);
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private tmpColor = new THREE.Color();
  private tmpPt = { x: 0, y: 0 };

  constructor() {
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('aColor', this.colAttr);
    geom.setAttribute('aSize', this.sizeAttr);
    this.points = new THREE.Points(geom, this.material);
    this.points.frustumCulled = false;
  }

  private alloc(hue: number, sat: number, light: number, life: number, size: number): number {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.tmpColor.setHSL((hue / 360) % 1, sat, light);
    this.r[i] = this.tmpColor.r;
    this.g[i] = this.tmpColor.g;
    this.b[i] = this.tmpColor.b;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size;
    this.rail[i] = null;
    return i;
  }

  /** Radial burst of free sparks. */
  burst(x: number, y: number, count: number, speed: number, hue: number): void {
    for (let k = 0; k < count; k++) {
      const i = this.alloc(hue + (Math.random() - 0.5) * 40, 0.8, 0.6 + Math.random() * 0.3, 0.35 + Math.random() * 0.5, 3 + Math.random() * 4);
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.x[i] = x;
      this.y[i] = y;
      this.vx[i] = Math.cos(a) * v;
      this.vy[i] = Math.sin(a) * v;
    }
  }

  /** Flick: sparks that race along the string in both directions, then spray off the ends. */
  sparksAlong(s: HarpString, u: number, intensity: number): void {
    const count = Math.round(24 + 40 * intensity);
    for (let k = 0; k < count; k++) {
      const i = this.alloc(s.hue + (Math.random() - 0.5) * 30, 0.7, 0.65 + Math.random() * 0.25, 2.5, 4 + Math.random() * 6);
      this.rail[i] = s;
      this.u[i] = u;
      const dir = k % 2 === 0 ? 1 : -1;
      this.du[i] = dir * (500 + Math.random() * 1100) * (0.6 + 0.6 * intensity);
    }
    pointOn(s, u, performance.now() / 1000, this.tmpPt);
    this.burst(this.tmpPt.x, this.tmpPt.y, Math.round(10 + 16 * intensity), 420, s.hue);
  }

  /** String dissolves into drifting embers (clear / undo / eviction / snap). */
  dissolve(s: HarpString, energetic = false): void {
    const n = Math.min(160, Math.max(8, Math.round(s.length / 10)));
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const L = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / L;
    const ny = dx / L;
    for (let k = 0; k < n; k++) {
      const t = Math.random();
      const i = this.alloc(s.hue, 0.75, 0.55 + Math.random() * 0.3, 0.5 + Math.random() * 0.8, 2.5 + Math.random() * 3.5);
      this.x[i] = s.ax + dx * t;
      this.y[i] = s.ay + dy * t;
      const side = Math.random() < 0.5 ? -1 : 1;
      const v = (energetic ? 260 : 60) * (0.3 + Math.random());
      // Snapped halves recoil toward their anchors.
      const along = energetic ? (t < 0.5 ? -1 : 1) * 200 * Math.random() : 0;
      this.vx[i] = nx * side * v + (dx / L) * along;
      this.vy[i] = ny * side * v + (dy / L) * along - 30;
    }
  }

  update(dt: number, now: number): void {
    const drag = Math.exp(-DRAG * dt);
    const P = this.positions;
    const C = this.colors;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.sizes[i] !== 0) this.sizes[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const s = this.rail[i];
      if (s) {
        if (s.dead || s.grabbed) {
          this.rail[i] = null;
          this.vx[i] = (Math.random() - 0.5) * 200;
          this.vy[i] = (Math.random() - 0.5) * 200;
        } else {
          this.u[i] += (this.du[i] * dt) / s.length;
          if (this.u[i] < 0 || this.u[i] > 1) {
            // Ran off the end: spray outward along the string's direction.
            const end = this.u[i] < 0 ? 0 : 1;
            pointOn(s, end, now, this.tmpPt);
            const dx = s.bx - s.ax;
            const dy = s.by - s.ay;
            const L = Math.max(1, Math.hypot(dx, dy));
            const sp = Math.abs(this.du[i]) * (0.35 + Math.random() * 0.4);
            const spread = (Math.random() - 0.5) * 1.2;
            const dir = end ? 1 : -1;
            const ux = (dx / L) * dir;
            const uy = (dy / L) * dir;
            this.vx[i] = (ux * Math.cos(spread) - uy * Math.sin(spread)) * sp;
            this.vy[i] = (ux * Math.sin(spread) + uy * Math.cos(spread)) * sp;
            this.x[i] = this.tmpPt.x;
            this.y[i] = this.tmpPt.y;
            this.rail[i] = null;
            this.life[i] = this.maxLife[i] = 0.3 + Math.random() * 0.5;
          } else {
            pointOn(s, this.u[i], now, this.tmpPt);
            this.x[i] = this.tmpPt.x;
            this.y[i] = this.tmpPt.y;
          }
        }
      }
      if (!this.rail[i]) {
        this.vx[i] *= drag;
        this.vy[i] = this.vy[i] * drag + GRAVITY * dt;
        this.x[i] += this.vx[i] * dt;
        this.y[i] += this.vy[i] * dt;
      }
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      const intensity = (this.rail[i] ? 1.8 : 1.4) * Math.pow(k, 1.3);
      P[i * 3] = this.x[i];
      P[i * 3 + 1] = -this.y[i]; // world y = −screen y
      C[i * 3] = this.r[i] * intensity;
      C[i * 3 + 1] = this.g[i] * intensity;
      C[i * 3 + 2] = this.b[i] * intensity;
      this.sizes[i] = this.size[i] * (0.4 + 0.6 * k);
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }
}
