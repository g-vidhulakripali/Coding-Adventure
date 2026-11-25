import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Scene, SceneFrame, SceneToken, SceneValue } from '../../../core/visualisation/scene';

/**
 * 3D visual laboratory.
 *
 * Layout (world units):
 *  - Each call-stack frame is a bench. The current frame's bench is at z = 0;
 *    callers recede behind it (z = -BENCH_GAP, -2·BENCH_GAP, …) and are dimmed.
 *  - Variables are glass containers along the back of a bench; collections
 *    show one cube per element with its index.
 *  - The operation "machine" sits at the front right; its shape and colour
 *    follow the visual vocabulary (function, decision, collection, …).
 *  - Values travel as glowing tokens: sources → machine → destination.
 *
 * Text is rendered as HTML (CSS2DRenderer) so code and values stay crisp,
 * selectable and theme-aware. The scene renders on demand only.
 */

const BENCH_GAP = 7.5;
const VAR_ROW_Z = -1.1;
const VAR_GAP = 0.7;
/** Distance between element cubes in a collection. */
const ELEM_GAP = 1.2;
/** Elements drawn per collection; the rest are summarised as "+N more". */
const MAX_ELEMENTS = 6;

const MIN_BENCH_WIDTH = 11;
/** Camera elevation above the bench, in radians. */
const CAMERA_ELEVATION = THREE.MathUtils.degToRad(56);

interface Palette {
  variable: THREE.Color;
  value: THREE.Color;
  collection: THREE.Color;
  function: THREE.Color;
  decision: THREE.Color;
  loop: THREE.Color;
  return: THREE.Color;
  surface: THREE.Color;
  surface2: THREE.Color;
  border: THREE.Color;
  accent: THREE.Color;
  danger: THREE.Color;
  codeBg: THREE.Color;
  bench: THREE.Color;
  benchEdge: THREE.Color;
  glassOpacity: number;
}

interface Tween {
  start: number;
  duration: number;
  update: (t: number) => void;
  done?: () => void;
}

interface Anchor {
  /** Top-centre of a variable container (where tokens enter). */
  position: THREE.Vector3;
  /** Element positions for collections. */
  elements: THREE.Vector3[];
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function label(className: string, html?: string, text?: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  if (html !== undefined) el.innerHTML = html;
  else if (text !== undefined) el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 0.5);
  return obj;
}

/** Compact type label for 3D tags: `pandas.Series (float64)` → `Series[float64]`. */
function shortType(type: string): string {
  return type.replace(/^(?:pandas|numpy)\./, '').replace(/ \((\w+)\)$/, '[$1]');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class LabRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private dynamic = new THREE.Group();
  private palette: Palette;
  private tweens: Tween[] = [];
  private frameRequested = false;
  private controlsActive = false;
  private benchZ = 0;
  private disposed = false;
  private lastScene: Scene | null = null;
  /** Delay before a destination container shows its new value (when the token lands). */
  private revealDelay = 0;
  /** Layout of the current scene (benches are sized to their content). */
  private benchWidth = MIN_BENCH_WIDTH;
  private machinePos = new THREE.Vector3(0, 0.9, 1.5);
  /** Console output is a screen-space terminal overlay (not part of the 3D layout). */
  private hud: HTMLDivElement | null = null;
  /** True once the user orbits/zooms; auto-framing then stops until "reset view". */
  private userMoved = false;
  private readonly themeObserver: MutationObserver;
  private readonly media: MediaQueryList | null;

  constructor(private readonly container: HTMLElement) {
    // Throws when WebGL is unavailable; the caller falls back to 2D.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'lab3d__canvas';
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'lab3d__labels';
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 34;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.addEventListener('start', () => {
      this.controlsActive = true;
      this.userMoved = true;
      this.requestFrame();
    });
    this.controls.addEventListener('end', () => {
      this.controlsActive = false;
      this.requestFrame();
    });
    this.controls.addEventListener('change', () => this.requestFrame());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(6, 12, 8);
    this.scene.add(sun);
    this.scene.add(this.dynamic);

    this.palette = this.readPalette();
    this.resetView(false);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    // Rebuild colours when the theme changes.
    this.themeObserver = new MutationObserver(() => this.onThemeChange());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    this.media?.addEventListener('change', this.onThemeChange);

    // Development-only hook for inspecting the scene from devtools (stripped from production builds).
    if (import.meta.env.DEV) (window as unknown as { __labRenderer?: LabRenderer }).__labRenderer = this;
  }

  /** Completes running animations and renders synchronously (debugging/tests). */
  renderNow() {
    for (const tween of this.tweens) {
      tween.update(1);
      tween.done?.();
    }
    this.tweens = [];
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.resolveOverlaps();
  }

  /**
   * Screen-space tidy-up after each render: name tags that would sit on top of
   * other text are nudged upwards, and the code label under the machine is
   * nudged downwards, until nothing overlaps.
   */
  private resolveOverlaps() {
    const root = this.labels.domElement;
    const visible = (el: HTMLElement) => el.style.display !== 'none';
    const fixed = [...root.querySelectorAll<HTMLElement>('.lab3d-value, .lab3d-index')].filter(visible);
    const elems = [...root.querySelectorAll<HTMLElement>('.lab3d-elem')].filter(visible);
    const tags = [...root.querySelectorAll<HTMLElement>('.lab3d-tag')].filter(visible);
    const machine = root.querySelector<HTMLElement>('.lab3d-machine');
    for (const el of [...elems, ...tags, ...(machine ? [machine] : [])]) el.style.marginTop = '0px';
    const placed: DOMRect[] = fixed.map((el) => el.getBoundingClientRect());
    if (this.hud) placed.push(this.hud.getBoundingClientRect());
    const hits = (r: DOMRect, dy: number) =>
      placed.some((p) => p.left < r.right - 2 && p.right > r.left + 2 && p.top < r.bottom + dy - 2 && p.bottom > r.top + dy + 2);
    // List numbers first (they stagger upwards in pairs), then name tags above them.
    for (const group of [elems, tags]) {
      const rects = group.map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => a.r.left - b.r.left);
      for (const { el, r } of rects) {
        let dy = 0;
        while (hits(r, dy) && dy > -90) dy -= 4;
        el.style.marginTop = `${dy}px`;
        placed.push(new DOMRect(r.left, r.top + dy, r.width, r.height));
      }
    }
    if (machine) {
      const r = machine.getBoundingClientRect();
      let dy = 0;
      while (hits(r, dy) && dy < 90) dy += 4;
      machine.style.marginTop = `${dy}px`;
    }
  }

  private onThemeChange = () => {
    this.palette = this.readPalette();
    if (this.lastScene) this.show(this.lastScene, 0);
  };

  private readPalette(): Palette {
    const cs = getComputedStyle(this.container);
    const c = (name: string, fallback: string) => new THREE.Color((cs.getPropertyValue(name).trim() || fallback) as THREE.ColorRepresentation);
    return {
      variable: c('--lab-variable', '#4fb3ff'),
      value: c('--lab-value', '#ffd166'),
      collection: c('--lab-collection', '#2ee6d6'),
      function: c('--lab-function', '#b388ff'),
      decision: c('--lab-decision', '#ff9f43'),
      loop: c('--lab-loop', '#3ddc97'),
      return: c('--lab-return', '#ff6b81'),
      surface: c('--color-surface', '#10141b'),
      surface2: c('--color-surface-2', '#151a23'),
      border: c('--color-border-strong', '#334055'),
      accent: c('--color-accent', '#3ddc97'),
      danger: c('--color-danger', '#ff6b81'),
      codeBg: c('--code-bg', '#0c1016'),
      bench: c('--lab-bench', '#151a23'),
      benchEdge: c('--lab-bench-edge', '#334055'),
      glassOpacity: Number.parseFloat(cs.getPropertyValue('--lab-glass-opacity')) || 0.16,
    };
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (!this.userMoved) this.resetView(false);
    this.requestFrame();
  }

  /**
   * Camera pose that fits the current bench in the panel, whatever its size.
   * Moves the camera back along a fixed viewing direction until the bench
   * corners, the variable tags above them and the operation label hanging
   * below the machine all project inside the stage.
   */
  private framing(): { target: THREE.Vector3; position: THREE.Vector3 } {
    const z = this.benchZ;
    const half = this.benchWidth / 2;
    const target = new THREE.Vector3(0, 0.5, z + 0.3);
    const direction = new THREE.Vector3(0, Math.sin(CAMERA_ELEVATION), Math.cos(CAMERA_ELEVATION));
    const heightPx = Math.max(1, this.container.clientHeight);
    const widthPx = Math.max(1, this.container.clientWidth);
    // Screen margins (in normalised device coordinates) for HTML labels that extend beyond their anchors.
    const bottomMargin = (58 / heightPx) * 2; // operation label hangs below its anchor
    const topMargin = (34 / heightPx) * 2; // name tags sit above the containers
    const sideMargin = (12 / widthPx) * 2;
    const points = [
      new THREE.Vector3(-half, 0, z + 2.8),
      new THREE.Vector3(half, 0, z + 2.8),
      new THREE.Vector3(-half, 2.0, z - 2.8),
      new THREE.Vector3(half, 2.0, z - 2.8),
    ];
    const labelAnchor = new THREE.Vector3(this.machinePos.x, 0.02, this.machinePos.z + 0.95);
    const probe = this.camera.clone();
    const ndc = new THREE.Vector3();
    let distance = 8;
    for (; distance < 40; distance += 0.5) {
      probe.position.copy(target).addScaledVector(direction, distance);
      probe.lookAt(target);
      probe.updateMatrixWorld();
      const fits =
        points.every((pt) => {
          ndc.copy(pt).project(probe);
          return Math.abs(ndc.x) <= 1 - sideMargin && ndc.y <= 1 - topMargin && ndc.y >= -1;
        }) && ndc.copy(labelAnchor).project(probe).y >= -1 + bottomMargin;
      if (fits) break;
    }
    return { target, position: target.clone().addScaledVector(direction, distance) };
  }

  /** Puts the camera in its default view, fitted to the current bench. */
  resetView(animate = true) {
    this.userMoved = false;
    const { target, position } = this.framing();
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.copy(position);
      this.controls.update();
      this.requestFrame();
      return;
    }
    const fromT = this.controls.target.clone();
    const fromP = this.camera.position.clone();
    this.addTween(700, (t) => {
      const k = ease(t);
      this.controls.target.lerpVectors(fromT, target, k);
      this.camera.position.lerpVectors(fromP, position, k);
    });
  }

  private addTween(duration: number, update: (t: number) => void, done?: () => void) {
    if (duration <= 0) {
      update(1);
      done?.();
      this.requestFrame();
      return;
    }
    this.tweens.push({ start: performance.now(), duration, update, ...(done ? { done } : {}) });
    this.requestFrame();
  }

  private requestFrame() {
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.frameRequested = false;
    if (this.disposed) return;
    const remaining: Tween[] = [];
    for (const tween of this.tweens) {
      const t = Math.min(1, (now - tween.start) / tween.duration);
      tween.update(t);
      if (t < 1) remaining.push(tween);
      else tween.done?.();
    }
    this.tweens = remaining;
    const dampingMoving = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    this.resolveOverlaps();
    if (this.tweens.length > 0 || this.controlsActive || dampingMoving) this.requestFrame();
  };

  // ---- Scene construction ----------------------------------------------------------

  /** Shows a step. `duration` 0 jumps to the final state (reduced motion / stepping back). */
  show(scene: Scene, duration: number) {
    this.lastScene = scene;
    this.tweens = this.tweens.filter((t) => !(t as Tween & { stepTween?: boolean }).stepTween);
    this.clearDynamic();
    this.revealDelay = duration > 0 ? (scene.operation.kind === 'assign' || scene.operation.kind === 'define' || scene.operation.kind === 'import' || scene.operation.kind === 'enter' ? duration * 0.45 : duration) : 0;

    const frames = scene.frames;
    const currentIndex = frames.length - 1;
    const hasConsole = scene.console.length > 0 || scene.operation.destination.kind === 'console';
    const varsWidth = (f: SceneFrame) => f.vars.reduce((sum, v) => sum + this.variableWidth(v) + VAR_GAP, -VAR_GAP);
    const widest = Math.max(0, ...frames.map(varsWidth));
    const previousWidth = this.benchWidth;
    this.benchWidth = Math.max(MIN_BENCH_WIDTH, widest + 2);
    const shift = 0;
    this.machinePos = new THREE.Vector3(0, 0.9, 1.5);
    const newBenchZ = 0; // the current frame is always at z = 0; callers are placed behind it
    const anchors = new Map<string, Anchor>();
    const benchZOf = new Map<number, number>();

    frames.forEach((frame, i) => {
      const z = newBenchZ - (currentIndex - i) * BENCH_GAP;
      benchZOf.set(frame.id, z);
      this.buildBench(frame, z, i === currentIndex, anchors, scene, -Math.max(0, varsWidth(frame)) / 2 + shift);
    });

    const op = scene.operation;
    const machineAt = this.machinePos.clone();
    const showMachine = op.kind !== 'assign' && op.kind !== 'define' && op.kind !== 'import';
    const machine = showMachine ? this.buildMachine(op.role, op.status, machineAt) : null;
    // No code text on the stage: the code panel highlights the exact source, the caption shows the numbers.

    this.updateConsole(hasConsole ? scene.console : null, op.destination.kind === 'console' && duration > 0);

    // ---- Tokens & animation ----------------------------------------------------
    const inputSocket = machineAt.clone().add(new THREE.Vector3(-1.5, 0.1, 0.4));
    const outputSocket = machineAt.clone().add(new THREE.Vector3(1.55, 0.1, 0.4));
    const sourcePosition = (token: SceneToken, i: number): THREE.Vector3 => {
      const src = token.source;
      if (src.kind === 'variable') {
        const a = anchors.get(`${src.frameId}:${src.name}`);
        if (a) return a.position.clone();
      }
      if (src.kind === 'caller') {
        const z = benchZOf.get(src.frameId) ?? -BENCH_GAP;
        return new THREE.Vector3(this.machinePos.x + 1.5, this.machinePos.y + 0.2, z + this.machinePos.z);
      }
      if (src.kind === 'previous') return outputSocket.clone().add(new THREE.Vector3(0.6, 0.6 + i * 0.25, 0));
      return machineAt.clone().add(new THREE.Vector3(-2.4, 2.4, 0.6 + i * 0.3));
    };

    const durationIn = duration * 0.45;
    const durationOut = duration * 0.4;
    const isStore = !showMachine;

    // Inputs fly into the machine (or straight into their destination for stores/params).
    op.inputs.forEach((token, i) => {
      const from = sourcePosition(token, i);
      let to = inputSocket.clone().add(new THREE.Vector3(0, i * 0.42 - (op.inputs.length - 1) * 0.21, 0));
      if (op.destination.kind === 'params') {
        const name = token.label;
        const anchor = anchors.get(`${op.destination.frameId}:${name}`);
        if (anchor) to = anchor.position.clone();
      } else if (isStore && op.destination.kind === 'variable') {
        const anchor = anchors.get(`${op.destination.frameId}:${op.destination.names[0]}`);
        if (anchor) to = anchor.position.clone();
      }
      const tok = this.buildToken(token, this.roleColor(token.role === 'index' ? 'collection' : 'value'));
      this.flyToken(tok, from, to, durationIn, i * 70, true);
    });

    if (machine && duration > 0) {
      const base = machine.scale.clone();
      this.stepTween(duration * 0.2, (t) => {
        const pulse = Math.sin(Math.PI * t) * 0.14;
        machine.scale.set(base.x * (1 + pulse), base.y * (1 + pulse), base.z * (1 + pulse));
        machine.rotation.y += 0.04;
      }, durationIn);
    }

    // Output leaves the machine towards its destination.
    if (op.output && !isStore && op.destination.kind !== 'params') {
      const d = op.destination;
      let to = this.machinePos.clone().add(new THREE.Vector3(2.0, -0.4, 1.0));
      if (d.kind === 'variable') {
        const a = anchors.get(`${d.frameId}:${d.names[0]}`);
        if (a) to = a.position.clone();
      } else if (d.kind === 'return') {
        const z = benchZOf.get(d.toFrameId) ?? -BENCH_GAP;
        to = new THREE.Vector3(this.machinePos.x, this.machinePos.y + 0.4, z + this.machinePos.z);
      } else if (d.kind === 'console') {
        // Towards the bench's front-right corner, where the console overlay sits on screen.
        to = new THREE.Vector3(this.benchWidth / 2 - 0.4, 0.3, 2.6);
      }
      const color = op.status === 'ok' ? this.roleColor(op.role === 'decision' ? 'decision' : op.role === 'return' ? 'return' : 'value') : this.palette.danger;
      const tok = this.buildToken(op.output, color, true);
      this.flyToken(tok, outputSocket, to, durationOut, duration * 0.6, d.kind === 'return' || d.kind === 'console');
    }

    // Re-frame when the bench changes size, unless the user has taken over the camera.
    this.benchZ = newBenchZ;
    if (!this.userMoved && Math.abs(previousWidth - this.benchWidth) > 0.01) {
      const { target, position } = this.framing();
      const fromT = this.controls.target.clone();
      const fromP = this.camera.position.clone();
      this.addTween(Math.min(600, duration), (t) => {
        const k = ease(t);
        this.controls.target.lerpVectors(fromT, target, k);
        this.camera.position.lerpVectors(fromP, position, k);
      });
    }
    this.requestFrame();
  }

  private stepTween(duration: number, update: (t: number) => void, delay = 0, done?: () => void) {
    const tween: Tween & { stepTween: boolean } = { start: performance.now() + delay, duration: Math.max(1, duration), update: (t) => update(Math.max(0, t)), stepTween: true, ...(done ? { done } : {}) };
    if (duration <= 0) {
      update(1);
      done?.();
      return;
    }
    this.tweens.push(tween);
    this.requestFrame();
  }

  private clearDynamic() {
    const old = this.dynamic;
    this.scene.remove(old);
    old.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    // CSS2DObjects remove their DOM elements when detached; make sure of it.
    old.traverse((obj) => {
      if (obj instanceof CSS2DObject) obj.element.remove();
    });
    this.dynamic = new THREE.Group();
    this.scene.add(this.dynamic);
  }

  private roleColor(role: string): THREE.Color {
    const p = this.palette as unknown as Record<string, THREE.Color>;
    return p[role] ?? this.palette.value;
  }

  private variableWidth(v: SceneValue & { name?: string }): number {
    const count = v.elements ? Math.min(v.elements.length, MAX_ELEMENTS) : 0;
    const content = v.elements ? count * ELEM_GAP + 0.5 : 1.9;
    // Name tags are ~0.25 world units per character at the fitted zoom.
    const nameWidth = (v.name?.length ?? 0) * 0.25 + 0.5;
    return Math.max(1.9, content, nameWidth);
  }

  private buildBench(frame: SceneFrame, z: number, isCurrent: boolean, anchors: Map<string, Anchor>, scene: Scene, startX: number) {
    const opacity = isCurrent ? 1 : 0.3;
    const bench = new THREE.Mesh(
      new RoundedBoxGeometry(this.benchWidth, 0.3, 5.6, 3, 0.12),
      new THREE.MeshStandardMaterial({ color: this.palette.bench, roughness: 0.85, metalness: 0.05, transparent: !isCurrent, opacity }),
    );
    bench.position.set(0, -0.16, z);
    this.dynamic.add(bench);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(this.benchWidth, 0.3, 5.6)),
      new THREE.LineBasicMaterial({ color: isCurrent ? this.palette.accent : this.palette.benchEdge, transparent: true, opacity: isCurrent ? 0.6 : 0.25 }),
    );
    edges.position.copy(bench.position);
    this.dynamic.add(edges);

    const op = scene.operation;
    // Spotlight: the boxes this step reads from or writes to stay bright; the others fade back.
    const involved = new Set<string>();
    if (isCurrent) {
      for (const input of op.inputs) if (input.source.kind === 'variable' && input.source.frameId === frame.id) involved.add(input.source.name);
      if (op.destination.kind === 'variable' || op.destination.kind === 'params') op.destination.names.forEach((n) => involved.add(n));
    }
    let x = startX;
    // Neighbouring name tags that would collide are staggered (every other one raised).
    let prev = null as { right: number; lifted: boolean } | null;
    for (const v of frame.vars) {
      const isTarget =
        isCurrent && ((op.destination.kind === 'variable' && op.destination.names.includes(v.name)) || (op.destination.kind === 'params' && op.destination.names.includes(v.name)));
      const selected =
        isCurrent && op.selectedIndex !== null && op.inputs[0]?.source.kind === 'variable' && op.inputs[0].source.name === v.name ? op.selectedIndex : null;
      const w = this.variableWidth(v);
      const halfTag = (v.name.length * 0.3 + 0.5) / 2;
      const left = x + w / 2 - halfTag;
      const lifted: boolean = prev !== null && !prev.lifted && prev.right > left;
      const quiet = isCurrent && involved.size > 0 && !involved.has(v.name);
      const width = this.buildVariable(v, x, z, isCurrent, isTarget, selected, anchors, frame.id, lifted, quiet, involved.has(v.name) && !isTarget);
      prev = { right: x + w / 2 + halfTag, lifted };
      x += width + VAR_GAP;
    }
    if (frame.vars.length === 0 && isCurrent) {
      const empty = label('lab3d-empty', undefined, 'No variables yet');
      empty.position.set(0, 0.5, z + VAR_ROW_Z);
      this.dynamic.add(empty);
    }
  }

  /** Builds a variable container; returns its width. */
  private buildVariable(
    v: SceneValue & { name: string; changed: boolean },
    x: number,
    z: number,
    isCurrent: boolean,
    isTarget: boolean,
    selected: number | null,
    anchors: Map<string, Anchor>,
    frameId: number,
    liftTag = false,
    quiet = false,
    isInput = false,
  ): number {
    const elements = v.elements ? v.elements.slice(0, MAX_ELEMENTS) : null;
    const width = this.variableWidth(v);
    const height = 1.15;
    const depth = 1.25;
    const cx = x + width / 2;
    const color = elements ? this.palette.collection : this.palette.variable;

    const glass = new THREE.Mesh(
      new RoundedBoxGeometry(width, height, depth, 3, 0.1),
      new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: !isCurrent ? 0.05 : quiet ? this.palette.glassOpacity * 0.4 : this.palette.glassOpacity * (isTarget || isInput ? 1.6 : 1),
        roughness: 0.15,
        metalness: 0.1,
        depthWrite: false,
      }),
    );
    glass.position.set(cx, height / 2, z + VAR_ROW_Z);
    this.dynamic.add(glass);
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
      new THREE.LineBasicMaterial({ color: isInput ? this.palette.value : color, transparent: true, opacity: !isCurrent ? 0.2 : quiet ? 0.3 : 1 }),
    );
    outline.position.copy(glass.position);
    this.dynamic.add(outline);

    const anchor: Anchor = { position: new THREE.Vector3(cx, height + 0.35, z + VAR_ROW_Z), elements: [] };
    if (elements) {
      elements.forEach((text, i) => {
        const ex = x + 0.25 + ELEM_GAP / 2 + i * ELEM_GAP;
        const isSel = selected === i;
        const cube = new THREE.Mesh(
          new RoundedBoxGeometry(0.56, 0.56, 0.56, 2, 0.07),
          new THREE.MeshStandardMaterial({
            color: isSel ? this.palette.value : this.palette.collection,
            emissive: isSel ? this.palette.value : new THREE.Color(0x000000),
            emissiveIntensity: isSel ? 0.35 : 0,
            roughness: 0.4,
            transparent: !isCurrent || quiet,
            opacity: !isCurrent ? 0.3 : quiet ? 0.4 : 1,
          }),
        );
        cube.position.set(ex, isSel ? 0.62 : 0.35, z + VAR_ROW_Z);
        this.dynamic.add(cube);
        anchor.elements.push(cube.position.clone());
        if (isCurrent) {
          const valueLabel = label(`lab3d-elem${isSel ? ' is-selected' : ''}${quiet ? ' is-quiet' : ''}`, undefined, text);
          if (isTarget) this.revealOnArrival(valueLabel.element);
          valueLabel.position.set(ex, cube.position.y + 0.42, z + VAR_ROW_Z);
          this.dynamic.add(valueLabel);
          const idx = label('lab3d-index', undefined, `[${i}]`);
          idx.position.set(ex, 0.02, z + VAR_ROW_Z + 0.75);
          this.dynamic.add(idx);
        }
      });
      if (v.elements && v.elements.length > elements.length && isCurrent) {
        const more = label('lab3d-index', undefined, `+${v.elements.length - elements.length} more`);
        more.position.set(x + width - 0.2, 0.02, z + VAR_ROW_Z + 0.75);
        this.dynamic.add(more);
      }
    } else if (isCurrent) {
      const value = label(`lab3d-value${v.changed ? ' is-changed' : ''}${quiet ? ' is-quiet' : ''}`, undefined, v.display);
      value.position.set(cx, height / 2, z + VAR_ROW_Z + depth / 2);
      this.dynamic.add(value);
      if (isTarget) this.revealOnArrival(value.element);
    }

    // Waiting (caller) benches carry no text at all; the caption says where we are.
    if (isCurrent) {
      // The type line is shown on the variable being written; all types are listed in the Explain panel.
      const cls = `lab3d-tag${isTarget ? ' is-target' : ''}${isInput ? ' is-input' : ''}${quiet ? ' is-quiet' : ''}`;
      const tag = label(cls, `<b>${escapeHtml(v.name)}</b>${isTarget ? `<span>${escapeHtml(shortType(v.type))}</span>` : ''}`);
      tag.position.set(cx, height + (elements ? 0.7 : 0.45) + (liftTag ? 0.75 : 0), z + VAR_ROW_Z);
      this.dynamic.add(tag);
    }
    anchors.set(`${frameId}:${v.name}`, anchor);
    return width;
  }

  private revealOnArrival(el: HTMLElement) {
    if (this.revealDelay <= 0) return;
    el.classList.add('is-pending');
    this.stepTween(1, () => {}, this.revealDelay, () => el.classList.remove('is-pending'));
  }

  private buildMachine(role: string, status: string, at: THREE.Vector3): THREE.Object3D {
    const color = status === 'ok' ? this.roleColor(role) : status === 'error' ? this.palette.danger : this.palette.border;
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2, emissive: color, emissiveIntensity: 0.12 });
    let mesh: THREE.Object3D;
    if (role === 'decision') {
      mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.95, 0), material);
      mesh.scale.set(1.25, 0.9, 1.25);
    } else if (role === 'loop') {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.28, 16, 40), material);
      mesh.rotation.x = Math.PI / 2;
    } else {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new RoundedBoxGeometry(2.4, 1.3, 1.4, 4, 0.22), material));
      // Input / output slots on the machine's sides.
      const slotMat = new THREE.MeshStandardMaterial({ color: this.palette.codeBg, roughness: 0.6 });
      for (const sx of [-1.21, 1.21]) {
        const slot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.7), slotMat);
        slot.position.set(sx, 0.1, 0.2);
        group.add(slot);
      }
      if (role === 'function') {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.07, 10, 28), new THREE.MeshStandardMaterial({ color: this.palette.codeBg }));
        ring.position.set(0, 0.05, 0.71);
        group.add(ring);
      }
      mesh = group;
    }
    mesh.position.copy(at);
    this.dynamic.add(mesh);
    return mesh;
  }

  /** Shows (or hides) the terminal overlay in the stage's bottom-right corner. */
  private updateConsole(lines: readonly string[] | null, highlightLast: boolean) {
    if (!lines) {
      this.hud?.remove();
      this.hud = null;
      return;
    }
    if (!this.hud) {
      this.hud = document.createElement('div');
      this.hud.className = 'lab3d-console';
      this.hud.setAttribute('aria-label', 'Console output');
      this.container.appendChild(this.hud);
    }
    const shown = lines.slice(-4);
    const delay = highlightLast ? this.revealDelay : 0;
    this.hud.innerHTML = `<span class="lab3d-console__title">console</span>${shown
      .map((l, i) => `<div class="${highlightLast && i === shown.length - 1 ? 'is-new is-pending' : ''}">${escapeHtml(l) || '&nbsp;'}</div>`)
      .join('')}`;
    const fresh = this.hud.querySelector('.is-pending');
    if (fresh) this.stepTween(1, () => {}, delay, () => fresh.classList.remove('is-pending'));
  }

  private buildToken(token: SceneValue & { label?: string }, color: THREE.Color, isOutput = false): THREE.Group {
    const group = new THREE.Group();
    const geometry = token.elements ? new RoundedBoxGeometry(0.75, 0.32, 0.5, 2, 0.08) : new THREE.SphereGeometry(0.24, 24, 16);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.3 }));
    group.add(mesh);
    const chip = label(`lab3d-token${isOutput ? ' is-output' : ''}`, undefined, token.display);
    chip.position.set(0, 0.48, 0);
    group.add(chip);
    this.dynamic.add(group);
    return group;
  }

  /** Moves a token along an arc. `vanish` hides it on arrival (it was absorbed by its destination). */
  private flyToken(token: THREE.Group, from: THREE.Vector3, to: THREE.Vector3, duration: number, delay: number, vanish: boolean) {
    const mid = from.clone().lerp(to, 0.5);
    mid.y += 1.4 + from.distanceTo(to) * 0.08;
    const curve = new THREE.QuadraticBezierCurve3(from.clone(), mid, to.clone());
    if (duration <= 0) {
      token.position.copy(to);
      if (vanish) token.visible = false;
      return;
    }
    token.position.copy(from);
    if (delay > 0) token.visible = false;
    this.stepTween(
      duration,
      (t) => {
        if (t > 0) token.visible = true;
        token.position.copy(curve.getPoint(ease(t)));
      },
      delay,
      () => {
        if (vanish) token.visible = false;
      },
    );
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.themeObserver.disconnect();
    this.media?.removeEventListener('change', this.onThemeChange);
    this.clearDynamic();
    this.hud?.remove();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
