import { memo, type RefObject, useEffect, useRef } from "react";
import * as THREE from "three";
import { cn } from "@/lib/utils";
import {
  clamp01,
  DIVE,
  diveAltitude,
  easeInCubic,
  easeInOutCubic,
  easeOutCubic,
  easeOutQuart,
  formatLocation,
  forwardAngle,
  fovForRadius,
  hermite,
  lerp,
  localZoneLongitude,
  nearestAngle,
  radiusForFov,
  REST_DISTANCE,
  restLayout,
  smoothstep,
  span,
  subsolarPoint,
  type ZoneTable,
  zoneLocation,
} from "./motion";
import {
  cloudShellFragment,
  cloudShellVertex,
  earthFragment,
  earthVertex,
  haloFragment,
  haloVertex,
} from "./shaders";
import { createSecurityCamera } from "./securityCamera";

/*
 * 登录页的写实地球与监控覆盖层。
 *
 * 地球本体移植自 Voyage 后台（aegis-console 的 hero-globe）：不走 @react-three/fiber，在一个 effect 里
 * 手动建 WebGLRenderer、用原生 requestAnimationFrame 驱动；贴图为 NASA Visible Earth（公有领域，
 * deploy/third-party.yaml 登记），后台线程解码；昼夜按真实 UTC 时刻计算。
 *
 * 在此之上：
 * - 左上方的摄像头（SVG）始终对准球面上的覆盖区，视锥贴着覆盖圆的切点；
 * - 球体上下两段贴合轮廓的覆盖弧与往返扫描标记，半径每帧按投影后的球轮廓求，始终贴边；
 * - 登录成功后的俯冲：地球移到中央放大、覆盖区所在的地块转到正面，镜头按对数高度扎下去，
 *   穿过云层后网格接替贴图，登录层边推进边淡出，露出下方已挂载的控制台。
 * 各段共用一个时钟，单帧最多推进 1/15 s：挂载控制台等长任务只会让画面停一下，不会跳帧。
 */

const TEXTURE_BASE = "/textures/earth";
const SPIN = 0.06; // 自转角速度（弧度/秒），约 105 s 一圈
const REST_TILT = 0.3;
/** 静止时覆盖区在世界坐标中的方向：球面左上，正对左上方的摄像头 */
const SCAN_REST = new THREE.Vector3(-0.42, 0.36, 0.83).normalize();
const SCAN_ANGLE_REST = 0.2;
const SCAN_ANGLE_LOCK = 0.11;
/** 俯冲时太阳转到镜头左上方 */
const SUN_DIVE = new THREE.Vector3(-0.35, 0.45, 1).normalize();
const RING_SAMPLES = 40;
const X_AXIS = new THREE.Vector3(1, 0, 0);

const THEMES = {
  light: {
    halo: "#60a5fa",
    haloIntensity: 0.55,
    haloBlending: THREE.NormalBlending,
    meridian: "#0284c7",
    scanIdle: "#8ab8ff",
    scanDive: "#2563eb",
    diveTint: "#e8eef8",
    cloudTint: "#dbe4f1",
  },
  night: {
    halo: "#8bb8ff",
    haloIntensity: 0.9,
    haloBlending: THREE.AdditiveBlending,
    meridian: "#7dd3fc",
    scanIdle: "#8ab8ff",
    scanDive: "#60a5fa",
    diveTint: "#0b1220",
    cloudTint: "#1c2740",
  },
} as const;

type ThemeName = keyof typeof THEMES;

/** 经纬度 → 单位球坐标。经度 0 朝 +z（相机方向），北极朝 +y */
function toVector(latRad: number, lngRad: number, radius = 1, target = new THREE.Vector3()) {
  const cos = Math.cos(latRad);
  return target.set(cos * Math.sin(lngRad) * radius, Math.sin(latRad) * radius, cos * Math.cos(lngRad) * radius);
}

/** 后台线程解码贴图；不支持 createImageBitmap 的浏览器退回 TextureLoader */
function createTextureLoader() {
  if (typeof createImageBitmap === "function") {
    const loader = new THREE.ImageBitmapLoader();
    loader.setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" });
    return async (url: string) => {
      const bitmap = await loader.loadAsync(url);
      const texture = new THREE.Texture(bitmap);
      texture.flipY = false;
      texture.needsUpdate = true;
      return texture;
    };
  }
  const loader = new THREE.TextureLoader();
  return (url: string) => loader.loadAsync(url);
}

/**
 * color：彩色贴图（sRGB）；否则为单通道数据（云量、水体遮罩、高度），着色器只读 .r：按 R8 上传，
 * 显存是 RGBA 的四分之一（4K 含 mipmap 约 11 MB 而非 43 MB）
 */
async function loadTexture(load: (url: string) => Promise<THREE.Texture>, url: string, color: boolean, anisotropy: number) {
  const texture = await load(url);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (!color) texture.format = THREE.RedFormat;
  texture.anisotropy = anisotropy;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

// ── 覆盖弧（单位：球轮廓半径；SVG 角度自 +x 顺时针） ──
const polar = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)}`;
};
const arc = (r: number, a0: number, a1: number) =>
  `M${polar(r, a0)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${polar(r, a1)}`;
const band = (r0: number, r1: number, a0: number, a1: number) =>
  `${arc(r1, a0, a1)} L${polar(r0, a1)} A${r0} ${r0} 0 0 0 ${polar(r0, a0)} Z`;
function ticks(a0: number, a1: number) {
  let d = "";
  for (let a = a0; a <= a1 + 1e-6; a += 5) {
    const major = Math.round(a - a0) % 25 === 0;
    d += `M${polar(1.098, a)} L${polar(major ? 1.14 : 1.118, a)} `;
  }
  return d;
}
/** 一侧覆盖弧：mid 为弧中心角（上 270、下 90） */
function coverage(mid: number) {
  return {
    band: band(1.09, 1.17, mid - 55, mid + 55),
    main: arc(1.09, mid - 66, mid + 66),
    outer: arc(1.2, mid - 42, mid + 42),
    ticks: ticks(mid - 60, mid + 60),
    caps: `M${polar(1.06, mid - 66)} L${polar(1.16, mid - 66)} M${polar(1.06, mid + 66)} L${polar(1.16, mid + 66)}`,
  };
}
const ARCS = [coverage(270), coverage(90)];
const SWEEP_PATH = arc(1.09, -7, 7);
const RETICLE_PATH =
  "M-1 -0.55 V-1 H-0.55 M0.55 -1 H1 V-0.55 M1 0.55 V1 H0.55 M-0.55 1 H-1 V0.55 M0 -1 V-0.86 M0 1 V0.86 M-1 0 H-0.86 M1 0 H0.86";

export interface GlobeStageProps {
  night: boolean;
  reducedMotion: boolean;
  /** 置为 true 开始俯冲过渡 */
  diving: boolean;
  /** 镜头贴近地面：此时挂载控制台（在登录层下方） */
  onReveal: () => void;
  /** 过渡结束：移除登录层 */
  onDone: () => void;
  /** 末段与地球一起推进、淡出的元素（登录页根节点） */
  fadeRef: RefObject<HTMLElement | null>;
  className?: string;
}

interface Controller {
  /** 贴图已就绪、可以播放俯冲 */
  canDive: () => boolean;
  dive: () => void;
}

export const GlobeStage = memo(function GlobeStage({
  night,
  reducedMotion,
  diving,
  onReveal,
  onDone,
  fadeRef,
  className,
}: GlobeStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const themeRef = useRef<ThemeName>(night ? "night" : "light");
  const applyThemeRef = useRef<((theme: ThemeName) => void) | null>(null);
  const controllerRef = useRef<Controller | null>(null);
  const callbacks = useRef({ onReveal, onDone });

  useEffect(() => {
    callbacks.current = { onReveal, onDone };
  }, [onReveal, onDone]);

  useEffect(() => {
    themeRef.current = night ? "night" : "light";
    applyThemeRef.current?.(themeRef.current);
  }, [night]);

  // 俯冲：没有 WebGL、贴图未到或降低动效时，退化为登录层短暂淡出（降低动效时瞬时切换，V-A4）；
  // 页面在后台时帧循环不跑，直接进入控制台
  useEffect(() => {
    if (!diving) return;
    const controller = controllerRef.current;
    if (!reducedMotion && !document.hidden && controller?.canDive()) {
      controller.dive();
      return;
    }
    callbacks.current.onReveal();
    const el = fadeRef.current;
    if (reducedMotion || document.hidden || !el || typeof el.animate !== "function") {
      callbacks.current.onDone();
      return;
    }
    const fade = el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 320,
      easing: "cubic-bezier(0.7, 0, 0.84, 0)",
      fill: "forwards",
    });
    fade.onfinish = () => callbacks.current.onDone();
    return () => fade.cancel();
    // 只在 diving 变为 true 时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diving]);

  useEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;
    // three.js 需要 WebGL 2；jsdom 与过旧的浏览器没有，此时只显示表单
    if (typeof WebGL2RenderingContext === "undefined") return;

    let renderer: THREE.WebGLRenderer;
    try {
      // 高分屏本身足够细，多重采样只在 1 倍屏上开
      renderer = new THREE.WebGLRenderer({
        antialias: (window.devicePixelRatio || 1) < 1.5,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      return;
    }
    const motion = reducedMotion ? 0 : 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });
    container.appendChild(renderer.domElement);
    // 左上角的 3D 摄像头：另一个小场景，画在地球之后
    const securityCamera = createSecurityCamera(renderer);

    const q = <T extends Element>(name: string): T => {
      const el = svg.parentElement?.querySelector<T>(`[data-part="${name}"]`);
      if (!el) throw new Error(`覆盖层缺少 ${name}`);
      return el;
    };
    const parts = {
      arcs: q<SVGGElement>("arcs"),
      sweepTop: q<SVGGElement>("sweep-0"),
      sweepBottom: q<SVGGElement>("sweep-1"),
      cone: q<SVGPathElement>("cone"),
      coneEdge: q<SVGPathElement>("cone-edge"),
      reticle: q<SVGGElement>("reticle"),
      caption: q<HTMLDivElement>("caption"),
      coords: q<HTMLSpanElement>("coords"),

    };

    let frame = 0;
    let queued = 0;
    let pageVisible = !document.hidden;
    let disposed = false;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.002, 100);

    // 外层倾斜让北半球朝向观众，内层自转
    const tilt = new THREE.Group();
    tilt.rotation.x = REST_TILT;
    const globe = new THREE.Group();
    tilt.add(globe);
    scene.add(tilt);

    const placeholder = new THREE.Texture();
    const earthUniforms = {
      uDay: { value: placeholder as THREE.Texture },
      uNight: { value: placeholder as THREE.Texture },
      uClouds: { value: placeholder as THREE.Texture },
      uWater: { value: placeholder as THREE.Texture },
      uHeight: { value: placeholder as THREE.Texture },
      uSun: { value: new THREE.Vector3(0, 0, 1) },
      uCloudShift: { value: 0 },
      uCloudAmount: { value: 1 },
      uBump: { value: 0.9 },
      uReveal: { value: 0 },
      uAtmosphere: { value: new THREE.Color("#9cc3ff") },
      uScanDir: { value: SCAN_REST.clone() },
      uScanAngle: { value: SCAN_ANGLE_REST },
      uScanTime: { value: 0 },
      uScanAlpha: { value: 0 },
      uScanColor: { value: new THREE.Color() },
      uDive: { value: 0 },
      uDiveTint: { value: new THREE.Color() },
    };
    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: earthUniforms,
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
      transparent: true,
    });
    // SphereGeometry 的经度 0 在 +x，转 -90° 对齐到 +z；分段加密，贴地时轮廓不出棱角
    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 144), earthMaterial);
    earth.rotation.y = -Math.PI / 2;
    globe.add(earth);

    const haloUniforms = {
      uColor: { value: new THREE.Color() },
      uSun: { value: new THREE.Vector3(0, 0, 1) },
      uIntensity: { value: 0.9 },
      uReveal: { value: 0 },
    };
    const haloMaterial = new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.1, 64, 48), haloMaterial);
    // 地球先画并写深度，挡住辉光球正对镜头的那片背面
    earth.renderOrder = 0;
    halo.renderOrder = 1;
    tilt.add(halo);

    // 俯冲时穿过的云层壳
    const cloudUniforms = {
      uClouds: { value: placeholder as THREE.Texture },
      uCloudShift: { value: 0 },
      uOpacity: { value: 0 },
      uSun: { value: new THREE.Vector3(0, 0, 1) },
      uTint: { value: new THREE.Color() },
    };
    const cloudShell = new THREE.Mesh(
      new THREE.SphereGeometry(1.03, 160, 120),
      new THREE.ShaderMaterial({
        uniforms: cloudUniforms,
        vertexShader: cloudShellVertex,
        fragmentShader: cloudShellFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    cloudShell.rotation.y = -Math.PI / 2;
    cloudShell.renderOrder = 2;
    cloudShell.visible = false;
    globe.add(cloudShell);

    // 本地时区中央经线
    const zoneLng = localZoneLongitude(new Date());
    const meridianPoints: THREE.Vector3[] = [];
    for (let i = 0; i <= 128; i++) meridianPoints.push(toVector(-Math.PI / 2 + (i / 128) * Math.PI, zoneLng, 1.004));
    const meridianMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(meridianPoints), meridianMaterial));

    const scanIdle = new THREE.Color();
    const scanDive = new THREE.Color();
    // 登录页背景固定为深色太空：辉光、经线等始终用深色方案；只有俯冲末段的网格底色与云层随控制台主题，
    // 末段淡出时与下方控制台的底色衔接
    const applyTheme = (name: ThemeName) => {
      const t = THEMES.night;
      const end = THEMES[name];
      haloUniforms.uColor.value.set(t.halo);
      haloUniforms.uIntensity.value = t.haloIntensity;
      haloMaterial.blending = t.haloBlending;
      haloMaterial.needsUpdate = true;
      meridianMaterial.color.set(t.meridian);
      scanIdle.set(t.scanIdle);
      scanDive.set(end.scanDive);
      earthUniforms.uDiveTint.value.set(end.diveTint);
      cloudUniforms.uTint.value.set(end.cloudTint);
      securityCamera.setTheme(true);
      requestRender();
    };
    applyThemeRef.current = applyTheme;
    applyTheme(themeRef.current);

    let clock = 0; // 模拟时钟（秒）：单帧最多推进 1/20 s
    let spin = 0;
    let lastTime = 0;

    // ── 贴图 ──
    let ready = false;
    let revealAt = 0;
    const owned: THREE.Texture[] = [];
    const load = createTextureLoader();
    const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    Promise.all(
      (
        [
          ["day-4k.webp", true],
          ["night-4k.webp", true],
          ["clouds-4k.webp", false],
          ["water-4k.png", false],
          ["height-4k.jpg", false],
        ] as const
      ).map(([file, color]) => loadTexture(load, `${TEXTURE_BASE}/${file}`, color, anisotropy)),
    )
      .then((textures) => {
        if (disposed) {
          textures.forEach((texture) => texture.dispose());
          return;
        }
        const [day, nightLights, clouds, water, height] = textures as [
          THREE.Texture,
          THREE.Texture,
          THREE.Texture,
          THREE.Texture,
          THREE.Texture,
        ];
        earthUniforms.uDay.value = day;
        earthUniforms.uNight.value = nightLights;
        earthUniforms.uClouds.value = clouds;
        earthUniforms.uWater.value = water;
        earthUniforms.uHeight.value = height;
        cloudUniforms.uClouds.value = clouds;
        owned.push(...textures);
        // 先上传到显卡，揭幕时不卡第一帧
        textures.forEach((texture) => renderer.initTexture(texture));
        ready = true;
        revealAt = clock;
        requestRender();
      })
      .catch(() => {
        /* 贴图加载失败时不显示地球，表单照常可用 */
      });

    // ── 指针：靠近地球时轻微偏转 ──
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    let size = { width: 1, height: 1 };
    const onPointerMove = (event: PointerEvent) => {
      if (dive) return;
      pointer.tx = Math.max(-1, Math.min(1, (event.clientX / size.width - 0.5) * 2));
      pointer.ty = Math.max(-1, Math.min(1, (event.clientY / size.height - 0.5) * 2));
    };
    const onPointerLeave = () => {
      pointer.tx = 0;
      pointer.ty = 0;
    };
    if (motion) {
      window.addEventListener("pointermove", onPointerMove);
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }

    const resize = () => {
      size = { width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight) };
      renderer.setSize(size.width, size.height, false);
      camera.aspect = size.width / size.height;
      requestRender();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // ── 本地位置：按浏览器时区取代表城市，俯冲飞向这里（坐标表单独分包，不拖慢登录页首屏） ──
    let home: { lat: number; lng: number } | null = null;
    const timeZone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return undefined;
      }
    })();
    import("./zones.json")
      .then(({ default: table }) => {
        if (disposed) return;
        home = zoneLocation(timeZone, table as ZoneTable);
        parts.coords.textContent = home ? formatLocation(home) : "";
      })
      .catch(() => {
        /* 坐标表加载失败时照旧扎向覆盖区当时所在的地块 */
      });

    // ── 俯冲状态 ──
    interface Dive {
      t: number;
      speed: number;
      yaw0: number;
      yawT: number;
      yawV: number;
      tilt0: number;
      tiltT: number;
      target: THREE.Vector3; // 覆盖区中心在地球本地坐标中的位置
      /** 起跳时覆盖区的世界方向：飞向本地时覆盖区由此平滑移到目标地块；null 为就地锁定 */
      scan0: THREE.Vector3 | null;
      cx0: number;
      cy0: number;
      fov0: number;
      h0: number;
      sun0: THREE.Vector3;
      revealed: boolean;
      finished: boolean;
    }
    let dive: Dive | null = null;
    const speedUp = () => {
      if (dive) dive.speed = 3; // 点击或按键快进，不必等完整个镜头
    };

    const finishDive = () => {
      if (!dive || dive.finished) return;
      dive.finished = true;
      if (!dive.revealed) callbacks.current.onReveal();
      callbacks.current.onDone();
    };

    let current = { cx: 0, cy: 0, fov: 30, distance: REST_DISTANCE };

    controllerRef.current = {
      canDive: () => ready && !disposed,
      dive: () => {
        if (dive || !ready) return;
        globe.updateWorldMatrix(true, false);
        // 时区查得到时飞向本地，否则锁定覆盖区当时所在的地块
        const target = home
          ? toVector(home.lat, home.lng)
          : globe.worldToLocal(earthUniforms.uScanDir.value.clone()).normalize();
        const lat = Math.asin(THREE.MathUtils.clamp(target.y, -1, 1));
        const lng = Math.atan2(target.x, target.z);
        const yaw0 = globe.rotation.y;
        dive = {
          t: 0,
          speed: 1,
          yaw0,
          // 就地锁定的地块总在正面偏左，沿自转方向转过去即可；飞向本地按最近的方向转
          yawT: home ? nearestAngle(yaw0, -lng) : forwardAngle(yaw0, -lng),
          // 接上原有转速：Hermite 的速度以归一化时间计
          yawV: SPIN * motion * (DIVE.align[1] - DIVE.align[0]),
          tilt0: tilt.rotation.x,
          tiltT: lat,
          target,
          scan0: home ? earthUniforms.uScanDir.value.clone() : null,
          cx0: current.cx,
          cy0: current.cy,
          fov0: current.fov,
          h0: current.distance - 1,
          sun0: earthUniforms.uSun.value.clone(),
          revealed: false,
          finished: false,
        };
        window.addEventListener("pointerdown", speedUp);
        window.addEventListener("keydown", speedUp);
        requestRender();
      },
    };

    const sunLocal = new THREE.Vector3();
    const globeQuaternion = new THREE.Quaternion();
    const scratch = new THREE.Vector3();
    const blend = new THREE.Vector3();
    const t1 = new THREE.Vector3();
    const t2 = new THREE.Vector3();
    type Point = { x: number; y: number };
    const ring: Point[] = Array.from({ length: RING_SAMPLES }, () => ({ x: 0, y: 0 }));
    const ringAt = (i: number): Point => ring[i] ?? { x: 0, y: 0 };
    const baseYaw = -zoneLng;

    const project = (v: THREE.Vector3) => {
      scratch.copy(v).project(camera);
      return { x: ((scratch.x + 1) / 2) * size.width, y: ((1 - scratch.y) / 2) * size.height };
    };

    const renderOnce = (dt: number) => {
      const { width, height } = size;
      clock += dt;
      const time = clock;
      const rest = restLayout(width, height);
      const intro = !ready ? 0 : motion ? clamp01((time - revealAt) / 2.2) : 1;
      const eased = easeOutQuart(intro);

      pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 3);
      pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 3);
      spin += SPIN * motion * dt;

      let cx = rest.cx;
      let cy = rest.cy;
      let distance = REST_DISTANCE + (1 - eased) * 1.6;
      let fov = fovForRadius(REST_DISTANCE, rest.radius, height);
      let roll = 0;
      let overlay = eased * (rest.split ? 1 : 0);
      let reticle = 0;
      let decor = eased;
      let scanAngle = SCAN_ANGLE_REST;
      let diveAmount = 0;
      let cloudAmount = 1;
      let shell = 0;
      let haloFade = 1;
      let fade = 0;

      if (dive) {
        dive.t += Math.min(dt, 1 / 15) * dive.speed;
        const t = dive.t;
        const eC = easeInOutCubic(span(t, DIVE.center[0], DIVE.center[1]));
        const sA = span(t, DIVE.align[0], DIVE.align[1]);
        globe.rotation.y = hermite(dive.yaw0, dive.yawV, dive.yawT, sA);
        tilt.rotation.x = lerp(dive.tilt0, dive.tiltT, easeInOutCubic(sA));
        cx = lerp(dive.cx0, width / 2, eC);
        cy = lerp(dive.cy0, height / 2, eC);
        // 高度：对数插值；起点接上静止时的距离（入场动画未完时也连贯）
        const h = diveAltitude(t, dive.h0);
        distance = 1 + h;
        const fovCenter = lerp(dive.fov0, fovForRadius(REST_DISTANCE, Math.min(width, height) * 0.36, height), eC);
        fov = lerp(fovCenter, 56, easeInCubic(span(t, DIVE.widen[0], DIVE.widen[1])));
        roll = 0.12 * Math.sin(Math.PI * span(t, 0.9, 2.95));
        overlay *= 1 - easeOutCubic(span(t, DIVE.overlayOut[0], DIVE.overlayOut[1]));
        reticle = easeOutCubic(span(t, DIVE.reticleIn[0], DIVE.reticleIn[1])) * (1 - span(t, DIVE.reticleOut[0], DIVE.reticleOut[1]));
        decor *= 1 - span(t, 0.6, 1.3);
        scanAngle = lerp(SCAN_ANGLE_REST, SCAN_ANGLE_LOCK, eC);
        // 贴图在约 0.25 高度以下开始发糊，从这里起网格逐渐接替
        diveAmount = smoothstep(0.3, 0.03, h);
        cloudAmount = 1 - smoothstep(0.3, 0.06, h);
        shell = smoothstep(0.55, 0.1, h) * (1 - smoothstep(0.045, 0.028, h)) * 0.95;
        haloFade = smoothstep(0.1, 0.45, h);
        fade = span(t, DIVE.fade[0], DIVE.fade[1]);
        if (!dive.revealed && t >= DIVE.reveal) {
          dive.revealed = true;
          callbacks.current.onReveal();
        }
      } else {
        globe.rotation.y = baseYaw + spin + motion * pointer.x * 0.2 + (1 - eased) * 1.1;
        tilt.rotation.x = REST_TILT + motion * pointer.y * 0.07;
      }
      current = { cx, cy, fov, distance };

      // 镜头：投影中心平移到 (cx, cy)，球仍是正圆
      camera.fov = fov;
      camera.setViewOffset(width, height, width / 2 - cx, height / 2 - cy, width, height);
      camera.updateProjectionMatrix();
      camera.position.set(0, 0, distance);
      camera.lookAt(0, 0, 0);
      if (roll) camera.rotateZ(roll);
      camera.updateMatrixWorld();

      // 覆盖区方向：静止时在世界坐标里缓慢漂移，摄像头随之转动；俯冲时钉在目标地块上
      const scanDir = earthUniforms.uScanDir.value;
      globe.updateWorldMatrix(true, false);
      if (dive) {
        scanDir.copy(dive.target).applyQuaternion(globe.getWorldQuaternion(globeQuaternion)).normalize();
        // 飞向本地：覆盖区自起跳处滑向目标地块，地球居中放大结束时到位。起跳时目标可能在背面（与起点近乎相反），
        // 此时权重为 0，取起点；等目标随地球转到正面一侧权重才升上来，插值不会经过球心
        const w = easeInOutCubic(span(dive.t, DIVE.center[0], DIVE.center[1]));
        if (dive.scan0 && w < 1) {
          blend.copy(dive.scan0).lerp(scanDir, w);
          if (blend.lengthSq() > 1e-6) scanDir.copy(blend).normalize();
        }
      } else {
        scanDir
          .copy(SCAN_REST)
          .applyAxisAngle(THREE.Object3D.DEFAULT_UP, motion * Math.sin(time * 0.31) * 0.16)
          .applyAxisAngle(X_AXIS, motion * Math.sin(time * 0.23 + 1) * 0.07)
          .normalize();
      }

      // 太阳：真实时刻；俯冲时转到镜头一侧
      const sun = subsolarPoint(new Date());
      toVector(sun.lat, sun.lng, 1, sunLocal);
      sunLocal.applyQuaternion(globe.getWorldQuaternion(globeQuaternion));
      if (dive) {
        const s = easeInOutCubic(span(dive.t, DIVE.sun[0], DIVE.sun[1]));
        sunLocal.copy(dive.sun0).lerp(SUN_DIVE, s).normalize();
      }
      earthUniforms.uSun.value.copy(sunLocal);
      haloUniforms.uSun.value.copy(sunLocal);
      cloudUniforms.uSun.value.copy(sunLocal);

      earthUniforms.uReveal.value = eased;
      earthUniforms.uCloudShift.value = motion * time * 0.0009;
      earthUniforms.uCloudAmount.value = cloudAmount;
      earthUniforms.uScanAngle.value = scanAngle;
      earthUniforms.uScanTime.value = motion * time * 1.4;
      earthUniforms.uScanAlpha.value = eased;
      earthUniforms.uDive.value = diveAmount;
      earthUniforms.uScanColor.value.lerpColors(scanIdle, scanDive, diveAmount);
      haloUniforms.uReveal.value = eased * haloFade;
      cloudUniforms.uCloudShift.value = earthUniforms.uCloudShift.value;
      cloudUniforms.uOpacity.value = shell;
      cloudShell.visible = shell > 0.001;
      meridianMaterial.opacity = (0.14 + 0.12 * (0.5 + 0.5 * Math.sin(time * 2)) * motion) * decor;

      renderer.render(scene, camera);

      // ── SVG 覆盖层：按投影后的球与覆盖区摆放 ──
      const radius = radiusForFov(distance, fov, height);
      const focus = project(scanDir);

      parts.arcs.style.opacity = String(overlay);
      if (overlay > 0.001) {
        parts.arcs.setAttribute("transform", `translate(${cx} ${cy}) scale(${radius})`);
        const swing = motion * Math.sin(time * 0.7) * 52;
        parts.sweepTop.setAttribute("transform", `rotate(${270 + swing})`);
        parts.sweepBottom.setAttribute("transform", `rotate(${90 - swing})`);
      }

      parts.cone.style.opacity = String(overlay);
      parts.coneEdge.style.opacity = String(overlay);
      if (overlay > 0.001) {
        // 摄像头装在页面左上角、品牌标识下方，远距离俯视地球
        const k = Math.max(0.75, Math.min(1.15, (height / 900) * 1.05));
        const lens = securityCamera.update({
          width,
          height,
          mountX: 48 + 44 * k,
          mountY: 124 + 60 * k,
          targetX: focus.x,
          targetY: focus.y,
          scale: k,
          presence: easeInOutCubic(overlay),
          time,
          motion,
          dt,
        });
        renderer.autoClear = false;
        securityCamera.render(renderer);
        renderer.autoClear = true;
        const aim = Math.atan2(focus.y - lens.y, focus.x - lens.x);

        // 视锥：镜头 → 覆盖圆在镜头视角下的两条切线，远端沿覆盖圆走
        const axisRef = Math.abs(scanDir.y) > 0.95 ? X_AXIS : THREE.Object3D.DEFAULT_UP;
        t1.crossVectors(axisRef, scanDir).normalize();
        t2.crossVectors(scanDir, t1);
        const cosA = Math.cos(scanAngle);
        const sinA = Math.sin(scanAngle);
        let iMin = 0;
        let iMax = 0;
        let aMin = Infinity;
        let aMax = -Infinity;
        for (let i = 0; i < RING_SAMPLES; i++) {
          const th = (i / RING_SAMPLES) * Math.PI * 2;
          const p = project(
            scratch
              .copy(scanDir)
              .multiplyScalar(cosA)
              .addScaledVector(t1, Math.cos(th) * sinA)
              .addScaledVector(t2, Math.sin(th) * sinA),
          );
          ring[i] = p;
          let rel = Math.atan2(p.y - lens.y, p.x - lens.x) - aim;
          rel = Math.atan2(Math.sin(rel), Math.cos(rel));
          if (rel < aMin) [aMin, iMin] = [rel, i];
          if (rel > aMax) [aMax, iMax] = [rel, i];
        }
        // 从 iMin 到 iMax 有两条路径，取离镜头更远的那条（覆盖圆的远侧）
        const walk = (step: number) => {
          const out: Point[] = [];
          for (let i = iMin; ; i = (i + step + RING_SAMPLES) % RING_SAMPLES) {
            out.push(ringAt(i));
            if (i === iMax) break;
          }
          return out;
        };
        const forward = walk(1);
        const backward = walk(-1);
        const dist = (path: Point[]) => {
          const m = path[Math.floor(path.length / 2)] ?? lens;
          return Math.hypot(m.x - lens.x, m.y - lens.y);
        };
        const far = dist(forward) >= dist(backward) ? forward : backward;
        const fmt = (p: Point) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
        parts.cone.setAttribute("d", `M${fmt(lens)} L${far.map(fmt).join(" L")} Z`);
        parts.coneEdge.setAttribute("d", `M${fmt(lens)} L${fmt(ringAt(iMin))} M${fmt(lens)} L${fmt(ringAt(iMax))}`);
        parts.coneEdge.style.strokeDashoffset = String(-time * 24 * motion);
      }

      parts.reticle.style.opacity = String(reticle);
      parts.caption.style.opacity = String(reticle);
      if (reticle > 0.001) {
        const footprint = radius * Math.sin(scanAngle);
        const half = Math.max(36, Math.min(footprint * 1.35, Math.min(width, height) * 0.3)) * (1 + 0.45 * (1 - reticle));
        parts.reticle.setAttribute("transform", `translate(${focus.x} ${focus.y}) scale(${half})`);
        parts.caption.style.transform = `translate(${focus.x}px, ${focus.y + half + 12}px) translateX(-50%)`;
      }

      // 末段：登录层整体推进并淡出，露出控制台
      const root = fadeRef.current;
      if (root && dive) {
        root.style.opacity = String(1 - easeInOutCubic(fade));
        root.style.transform = fade > 0 ? `scale(${1 + 0.08 * easeInCubic(fade)})` : "";
      }
      if (dive && dive.t >= DIVE.total) finishDive();

      return (ready && intro < 1) || Boolean(dive && !dive.finished);
    };

    // ── 帧循环：标签页隐藏时暂停 ──
    const active = () => pageVisible && !disposed;
    let animating = true;
    const loop = (now: number) => {
      frame = 0;
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 1 / 20) : 0;
      lastTime = now;
      animating = renderOnce(dt);
      // 贴图到位前不空转；静态模式只在入场与俯冲期间连续出帧
      if (active() && ready && (motion || animating)) frame = requestAnimationFrame(loop);
    };
    function requestRender() {
      if (frame || queued || disposed) return;
      queued = requestAnimationFrame((now) => {
        queued = 0;
        if (!frame) loop(now);
      });
    }
    const stopLoop = () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(queued);
      frame = 0;
      queued = 0;
      lastTime = 0;
    };
    const onVisibility = () => {
      pageVisible = !document.hidden;
      if (pageVisible) requestRender();
      else {
        stopLoop();
        // 俯冲期间切走标签页：直接进入控制台，不让过渡停在半路
        finishDive();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    // 静态模式下每分钟重画一次，晨昏线仍随真实时间推进
    const staticTimer = motion ? 0 : window.setInterval(requestRender, 60_000);

    resize();

    return () => {
      disposed = true;
      applyThemeRef.current = null;
      controllerRef.current = null;
      stopLoop();
      window.clearInterval(staticTimer);
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerdown", speedUp);
      window.removeEventListener("keydown", speedUp);
      owned.forEach((texture) => texture.dispose());
      securityCamera.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // fadeRef 是稳定的 ref 对象
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  return (
    <div aria-hidden data-testid="globe-stage" className={cn("pointer-events-none", className)}>
      <div ref={containerRef} className="absolute inset-0" />
      <svg ref={svgRef} className="absolute inset-0 size-full overflow-visible text-primary">
        <g data-part="arcs" style={{ opacity: 0 }}>
          {ARCS.map((side, i) => (
            <g key={i}>
              <path d={side.band} className="fill-current" fillOpacity={0.06} />
              <path d={side.main} className="stroke-current" fill="none" strokeWidth={1.5} strokeOpacity={0.75} vectorEffect="non-scaling-stroke" />
              <path d={side.ticks} className="stroke-current" fill="none" strokeWidth={1} strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
              <path d={side.caps} className="stroke-current" fill="none" strokeWidth={1.5} strokeOpacity={0.8} vectorEffect="non-scaling-stroke" />
              <path
                d={side.outer}
                className="stroke-current"
                fill="none"
                strokeWidth={1}
                strokeOpacity={0.4}
                strokeDasharray="2 5"
                vectorEffect="non-scaling-stroke"
              />
              <g data-part={`sweep-${i}`}>
                <path d={SWEEP_PATH} className="stroke-current" fill="none" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                <circle cx={1.2} cy={0} r={0.012} className="fill-current" />
              </g>
            </g>
          ))}
        </g>

        <path data-part="cone" className="fill-current" fillOpacity={0.12} />
        <path
          data-part="cone-edge"
          className="stroke-current"
          fill="none"
          strokeWidth={1}
          strokeOpacity={0.7}
          strokeDasharray="6 6"
        />

        <g data-part="reticle" style={{ opacity: 0 }}>
          <path d={RETICLE_PATH} className="stroke-current" fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
      <div
        data-part="caption"
        className="absolute top-0 left-0 flex flex-col items-center gap-1 font-mono text-meta tracking-[0.3em] whitespace-nowrap text-primary"
        style={{ opacity: 0 }}
      >
        <span>锁定区域 · 接入控制台</span>
        {/* 按时区定位到的代表城市坐标；查不到时为空 */}
        <span data-part="coords" className="opacity-70" />
      </div>
    </div>
  );
});
