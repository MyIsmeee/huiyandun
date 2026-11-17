import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/*
 * 登录页左上角的 3D 枪型监控摄像头。
 *
 * 独立的小场景，以像素为单位：原点在屏幕中心、y 向上，z 朝向观众；透视相机放在
 * z = (H/2)/tan(fov/2)，z=0 平面上 1 单位正好 1 像素，于是安装点、对准点都能直接用屏幕坐标。
 * 页面本身就是「墙」：底座贴在 z=0 平面上，弯臂向观众伸出，机身经球铰挂在臂端，
 * 云台每帧带阻尼地转向地球上的覆盖区（像舵机，不是瞬间对准）。
 * 在地球之后另画一遍（只清深度），开销只有几百个三角形。
 */

const FOV = 28;
/** 镜头略微朝向观众：对准点抬离墙面的距离（像素），从斜前方能看到镜头玻璃 */
const TARGET_LIFT = 90;

export interface CameraFrame {
  width: number;
  height: number;
  /** 底座中心（屏幕像素） */
  mountX: number;
  mountY: number;
  /** 对准的屏幕点（覆盖区中心） */
  targetX: number;
  targetY: number;
  scale: number;
  /** 0 = 完全移出画面（左上方），1 = 就位 */
  presence: number;
  time: number;
  motion: number;
  dt: number;
}

export interface SecurityCamera {
  /** 摆好姿态并返回镜头中心的屏幕坐标 */
  update: (frame: CameraFrame) => { x: number; y: number };
  render: (renderer: THREE.WebGLRenderer) => void;
  setTheme: (night: boolean) => void;
  dispose: () => void;
}

/** 墙面上的柔和投影：径向渐隐的椭圆 */
function shadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // 横向拉伸 2 倍：在缩放后的坐标里画正圆，落到画布上是 128×64 的椭圆
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.setTransform(2, 0, 0, 1, 0, 0);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}

export function createSecurityCamera(renderer: THREE.WebGLRenderer): SecurityCamera {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);

  // 写实材质靠环境反射：用 three.js 自带的室内环境生成预过滤贴图
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  scene.environment = envMap;
  scene.environmentIntensity = 0.9;

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(-0.6, 1, 0.9);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.5);
  fill.position.set(1, -0.4, 0.6);
  scene.add(fill);

  const shell = new THREE.MeshStandardMaterial({ color: "#f3f5f8", roughness: 0.36, metalness: 0.04 });
  const trim = new THREE.MeshStandardMaterial({ color: "#d9dee6", roughness: 0.5, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: "#1c2029", roughness: 0.35, metalness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: "#9aa3b2", roughness: 0.25, metalness: 0.9 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: "#0a0e16",
    roughness: 0.04,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    transparent: true,
    opacity: 0.82,
  });
  const accent = new THREE.MeshStandardMaterial({ color: "#2563eb", roughness: 0.4, metalness: 0.2 });
  const iris = new THREE.MeshStandardMaterial({ color: "#1e3a8a", emissive: "#2563eb", emissiveIntensity: 0.6 });
  const led = new THREE.MeshStandardMaterial({ color: "#1e40af", emissive: "#3b82f6", emissiveIntensity: 2 });
  const irLed = new THREE.MeshStandardMaterial({ color: "#2a2f3a", roughness: 0.2, metalness: 0.3 });
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture(),
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    color: "#0f172a",
  });

  const rig = new THREE.Group();
  scene.add(rig);

  // ── 墙面投影 ──
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(220, 90), shadowMaterial);
  shadow.position.set(64, -58, -1);
  shadow.renderOrder = -1;
  rig.add(shadow);

  // ── 底座与弯臂（固定） ──
  const plate = new THREE.Mesh(new RoundedBoxGeometry(64, 64, 8, 3, 4), shell);
  rig.add(plate);
  for (const [sx, sy] of [
    [-22, -22],
    [22, -22],
    [-22, 22],
    [22, 22],
  ] as const) {
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 2, 16).rotateX(Math.PI / 2), metal);
    screw.position.set(sx, sy, 4.6);
    rig.add(screw);
  }
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(13, 15, 8, 32).rotateX(Math.PI / 2), trim);
  collar.position.set(0, 0, 8);
  rig.add(collar);
  // 弯臂从底座向外、向右下伸出，球铰托住机身后部：从正面看底座不被机身挡住
  const ballCenter = new THREE.Vector3(26, -22, 40);
  const armCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 8),
    new THREE.Vector3(4, -2, 24),
    new THREE.Vector3(16, -12, 36),
    ballCenter.clone().add(new THREE.Vector3(-4, 4, -2)),
  ]);
  rig.add(new THREE.Mesh(new THREE.TubeGeometry(armCurve, 32, 8, 20), shell));
  const ball = new THREE.Mesh(new THREE.SphereGeometry(11, 32, 24), trim);
  ball.position.copy(ballCenter);
  rig.add(ball);

  // ── 云台：以球铰为支点转向目标 ──
  const head = new THREE.Group();
  head.position.copy(ballCenter);
  rig.add(head);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 7.5, 18, 20), trim);
  neck.position.set(0, 9, 0);
  head.add(neck);

  // 机身中心在球铰上方、偏前：转动时绕机身后部的支点摆动
  const body = new THREE.Group();
  body.position.set(0, 30, 30);
  head.add(body);
  body.add(new THREE.Mesh(new RoundedBoxGeometry(46, 44, 120, 5, 13), shell));
  // 尾盖与出线
  const rear = new THREE.Mesh(new RoundedBoxGeometry(47, 45, 12, 4, 6), trim);
  rear.position.z = -57;
  body.add(rear);
  const gland = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 10, 16).rotateX(Math.PI / 2), dark);
  gland.position.set(0, -8, -66);
  body.add(gland);
  // 侧面品牌色饰条
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(46.6, 3, 66), accent);
  stripe.position.set(0, -7, -6);
  body.add(stripe);
  // 遮阳罩：机身上方的一段圆弧壳，向前伸出
  const hood = new THREE.Mesh(
    new THREE.CylinderGeometry(33, 33, 134, 48, 1, true, Math.PI - 1.05, 2.1).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: "#f3f5f8", roughness: 0.36, metalness: 0.04, side: THREE.DoubleSide }),
  );
  hood.position.set(0, 2, 12);
  body.add(hood);
  // 前罩、镜头
  const bezel = new THREE.Mesh(new THREE.CylinderGeometry(19.5, 20.5, 8, 48).rotateX(Math.PI / 2), dark);
  bezel.position.z = 63;
  body.add(bezel);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(12.5, 1.4, 12, 48), metal);
  ring.position.z = 67.2;
  body.add(ring);
  const irisDisc = new THREE.Mesh(new THREE.CircleGeometry(6.5, 32), iris);
  irisDisc.position.z = 67.1;
  body.add(irisDisc);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(12, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), glass);
  lens.position.z = 66.5;
  lens.scale.z = 0.5;
  body.add(lens);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const ir = new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 8), irLed);
    ir.position.set(Math.cos(a) * 16.5, Math.sin(a) * 16.5, 67);
    body.add(ir);
  }
  const statusLed = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), led);
  statusLed.position.set(14, 22.5, -40);
  body.add(statusLed);

  const lensLocal = new THREE.Vector3(0, 0, 68);
  const lensWorld = new THREE.Vector3();
  const target = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const desired = new THREE.Vector3();
  let aimed = false;
  const toScene = (x: number, y: number, width: number, height: number, out: THREE.Vector3) =>
    out.set(x - width / 2, height / 2 - y, 0);

  const update = (f: CameraFrame) => {
    camera.aspect = f.width / f.height;
    camera.position.set(0, 0, f.height / 2 / Math.tan((FOV * Math.PI) / 360));
    camera.updateProjectionMatrix();

    // 就位/退场：从左上方滑入、滑出
    const away = 1 - f.presence;
    toScene(f.mountX - away * 260 * f.scale, f.mountY - away * 200 * f.scale, f.width, f.height, rig.position);
    rig.scale.setScalar(f.scale);
    rig.updateMatrixWorld(true);

    // 对准点：覆盖区中心，抬离墙面一段，让镜头略朝观众
    toScene(f.targetX, f.targetY, f.width, f.height, target);
    target.z = TARGET_LIFT * f.scale;
    head.getWorldPosition(desired);
    desired.subVectors(target, desired).normalize();
    // 舵机式阻尼：方向向量逐帧逼近
    if (!aimed || !f.motion) aim.copy(desired);
    else aim.lerp(desired, 1 - Math.exp(-f.dt * 5)).normalize();
    aimed = true;
    head.lookAt(head.getWorldPosition(target).add(aim));

    led.emissiveIntensity = 0.6 + 1.6 * (0.5 + 0.5 * Math.sin(f.time * 3.2 * f.motion));
    shadow.rotation.z = Math.atan2(aim.y, aim.x) * 0.5;

    lensWorld.copy(lensLocal);
    body.localToWorld(lensWorld);
    lensWorld.project(camera);
    return { x: ((lensWorld.x + 1) / 2) * f.width, y: ((1 - lensWorld.y) / 2) * f.height };
  };

  return {
    update,
    render: (r) => {
      r.clearDepth();
      r.render(scene, camera);
    },
    setTheme: (night) => {
      shadowMaterial.opacity = night ? 0.4 : 0.16;
      scene.environmentIntensity = night ? 0.65 : 0.9;
    },
    dispose: () => {
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose();
      });
      for (const m of [shell, trim, dark, metal, glass, accent, iris, led, irLed, shadowMaterial, hood.material as THREE.Material]) m.dispose();
      shadowMaterial.map?.dispose();
      envMap.dispose();
      pmrem.dispose();
    },
  };
}
