/*
 * 地球着色器。昼夜、云层、海面高光、地形凹凸与大气辉光移植自 Voyage 后台（aegis-console 的 hero-globe），
 * 在此基础上加了摄像头的监控覆盖区：贴在球面上的扫描圆、雷达扫掠与多级网格。
 * 网格按屏幕导数（fwidth）逐级淡入淡出，镜头贴近地面时更细的一级接替上来，始终清晰，
 * 也盖住 4K 贴图在近处的模糊。
 */

export const earthVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPosition = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const earthFragment = /* glsl */ `
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uWater;
uniform sampler2D uHeight;
uniform vec3 uSun;
uniform float uCloudShift;
uniform float uCloudAmount;
uniform float uBump;
uniform float uReveal;
uniform vec3 uAtmosphere;
// 监控覆盖区（世界坐标）
uniform vec3 uScanDir;
uniform float uScanAngle;
uniform float uScanTime;
uniform float uScanAlpha;
uniform vec3 uScanColor;
uniform float uDive;
uniform vec3 uDiveTint;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPosition;

// 与 three.js bumpmap 相同的屏幕空间法线扰动
vec3 perturbNormal(vec3 position, vec3 normal, float scale) {
  vec2 dSTdx = dFdx(vUv);
  vec2 dSTdy = dFdy(vUv);
  float h = texture2D(uHeight, vUv).r;
  float dBx = scale * (texture2D(uHeight, vUv + dSTdx).r - h);
  float dBy = scale * (texture2D(uHeight, vUv + dSTdy).r - h);
  vec3 sigmaX = dFdx(position);
  vec3 sigmaY = dFdy(position);
  vec3 r1 = cross(sigmaY, normal);
  vec3 r2 = cross(normal, sigmaX);
  float det = dot(sigmaX, r1);
  vec3 grad = sign(det) * (dBx * r1 + dBy * r2);
  return normalize(abs(det) * normal - grad);
}

// 一级网格：线宽按屏幕像素算；格子小于约 4 像素时整级淡出，交给更粗的一级
float gridLevel(vec2 q, float spacing) {
  vec2 c = q / spacing;
  vec2 w = fwidth(c);
  vec2 d = abs(fract(c - 0.5) - 0.5) / max(w, vec2(1e-5));
  float line = 1.0 - min(min(d.x, d.y), 1.0);
  return line * (1.0 - smoothstep(0.12, 0.3, max(w.x, w.y)));
}

void main() {
  vec3 n = normalize(vWorldNormal);
  vec3 view = normalize(cameraPosition - vWorldPosition);
  float water = texture2D(uWater, vUv).r;
  // 贴图被放大（一个纹素占好几个像素）时高度图是分段线性的，凹凸会显出方块，按放大程度淡出
  float texelsPerPixel = max(fwidth(vUv.x) * 4096.0, fwidth(vUv.y) * 2048.0);
  float bumpLod = smoothstep(0.12, 0.5, texelsPerPixel);
  vec3 bumped = perturbNormal(vWorldPosition, n, uBump * (1.0 - water) * bumpLod);

  float sunGeo = dot(n, uSun);
  float daylight = smoothstep(-0.16, 0.2, sunGeo);
  float diffuse = clamp(dot(bumped, uSun) * 1.05, 0.0, 1.0);

  vec3 day = texture2D(uDay, vUv).rgb;
  vec2 cloudUv = vec2(vUv.x + uCloudShift, vUv.y);
  float cloud = smoothstep(0.16, 0.86, texture2D(uClouds, cloudUv).r) * uCloudAmount;
  // 云影：沿太阳方向略微错开采样
  float cloudShadow = smoothstep(0.16, 0.86, texture2D(uClouds, cloudUv + vec2(0.0018, -0.0012)).r) * uCloudAmount;

  vec3 surface = day * diffuse * (1.0 - 0.38 * cloudShadow);

  // 海面高光
  vec3 halfway = normalize(uSun + view);
  float spec = pow(max(dot(n, halfway), 0.0), 160.0) * water * (1.0 - cloud) * daylight;
  surface += vec3(1.0, 0.95, 0.86) * spec * 0.28;

  // 云层：受光面偏白，晨昏线附近染一点暖色
  float twilight = exp(-pow(sunGeo / 0.16, 2.0));
  vec3 cloudLit = mix(vec3(0.96), vec3(1.0, 0.72, 0.5), twilight * 0.55) * clamp(sunGeo * 1.2 + 0.02, 0.0, 1.0);
  surface = mix(surface, cloudLit, cloud * 0.92);

  // 夜半球的城市灯光，云层会挡掉一部分；只取明显亮于底色的城市像素，否则整个夜半球会发浑
  vec3 nightTex = texture2D(uNight, vUv).rgb;
  float glow = smoothstep(0.16, 0.6, dot(nightTex, vec3(0.299, 0.587, 0.114)));
  vec3 lights = vec3(1.0, 0.78, 0.48) * glow * 1.4;
  float night = 1.0 - smoothstep(-0.22, 0.04, sunGeo);
  surface += lights * night * (1.0 - cloud * 0.8);

  // 晨昏线散射与边缘大气
  surface += vec3(1.0, 0.5, 0.25) * twilight * daylight * 0.035;
  float rim = pow(1.0 - max(dot(n, view), 0.0), 4.0);
  surface += uAtmosphere * rim * smoothstep(-0.25, 0.5, sunGeo) * 0.35;

  // ── 监控覆盖区 ──
  float ang = acos(clamp(dot(n, uScanDir), -1.0, 1.0));
  float aw = max(fwidth(ang), 1e-5);
  float inside = 1.0 - smoothstep(uScanAngle - aw, uScanAngle + aw, ang);
  float ring = 1.0 - smoothstep(0.6, 1.6, abs(ang - uScanAngle) / aw);
  float ringInner = (1.0 - smoothstep(0.4, 1.2, abs(ang - uScanAngle * 0.58) / aw)) * 0.45;
  // 外圈刻度：每 10° 一格
  vec3 axisRef = abs(uScanDir.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 t1 = normalize(cross(axisRef, uScanDir));
  vec3 t2 = cross(uScanDir, t1);
  vec2 q = vec2(dot(n, t1), dot(n, t2));
  float azimuth = atan(q.y, q.x);
  // 刻度线宽按屏幕像素算：贴近地面时不会变成粗块
  float tickArc = abs(fract(azimuth / 0.17453 + 0.5) - 0.5) * 0.17453 * sin(ang);
  float tickBand = (1.0 - smoothstep(uScanAngle * 1.07, uScanAngle * 1.07 + aw, ang))
    * smoothstep(uScanAngle * 0.93 - aw, uScanAngle * 0.93, ang);
  float ticks = (1.0 - smoothstep(0.5, 1.5, tickArc / aw)) * tickBand;
  // 雷达扫掠：前沿最亮，向后拖出余辉
  float sweepPhase = fract((azimuth - uScanTime) / 6.2831853);
  float sweep = (pow(sweepPhase, 8.0) * 0.4 + pow(sweepPhase, 90.0) * 0.6) * inside * (1.0 - uDive);
  // 十字准线
  float crossLine = (1.0 - smoothstep(0.5, 1.4, min(abs(q.x) / fwidth(q.x), abs(q.y) / fwidth(q.y))))
    * inside * step(uScanAngle * 0.2, ang) * 0.5;
  // 多级网格：俯冲时一级级细下去
  // 静止时只留最粗一级，俯冲时细的几级接上来
  float grid = max(gridLevel(q, 0.03), max(gridLevel(q, 0.0075) * 0.8, gridLevel(q, 0.0019) * 0.65) * uDive);
  float gridMask = inside * mix(0.22, 0.85, uDive);

  // 俯冲时覆盖区内压暗地表，网格成为主体
  surface = mix(surface, uDiveTint, inside * uDive * 0.55 * uScanAlpha);
  float mark = inside * 0.05 + ring * 0.85 + ringInner + ticks * 0.6 + sweep + crossLine + grid * gridMask;
  surface = mix(surface, uScanColor, clamp(mark, 0.0, 1.0) * uScanAlpha);

  gl_FragColor = vec4(surface, uReveal);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const haloVertex = /* glsl */ `
varying vec3 vNormal;
varying vec3 vWorldNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const haloFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uSun;
uniform float uIntensity;
uniform float uReveal;
varying vec3 vNormal;
varying vec3 vWorldNormal;
void main() {
  float rim = pow(clamp(0.62 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 4.5);
  float lit = 0.1 + 0.9 * smoothstep(-0.3, 0.6, dot(vWorldNormal, uSun));
  gl_FragColor = vec4(uColor, clamp(rim * lit * uIntensity * uReveal, 0.0, 1.0));
}
`;

/** 俯冲时镜头穿过的云层壳：只在贴近地面的那一段出现 */
export const cloudShellVertex = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
  vUv = uv;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const cloudShellFragment = /* glsl */ `
uniform sampler2D uClouds;
uniform float uCloudShift;
uniform float uOpacity;
uniform vec3 uSun;
uniform vec3 uTint;
varying vec2 vUv;
varying vec3 vWorldNormal;
void main() {
  float c = smoothstep(0.1, 0.75, texture2D(uClouds, vec2(vUv.x + uCloudShift, vUv.y)).r);
  float lit = 0.55 + 0.45 * clamp(dot(normalize(vWorldNormal), uSun), 0.0, 1.0);
  gl_FragColor = vec4(mix(uTint, vec3(1.0), lit), c * uOpacity);
  #include <colorspace_fragment>
}
`;
