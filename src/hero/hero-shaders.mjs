// three.js 鲸鱼粒子材质的 GLSL 着色器。
// 这里只保留字符串字面量，材质装配见 hero-scene.mjs。

export const heroVertexShader = `
        attribute float aOpacity;
        attribute float aIndex;
        attribute float aEdge;
        attribute vec3 aScattered;

        uniform float uTime;
        uniform float uWaveSpeed;
        uniform float uWaveAmount;
        uniform vec2 uMouse;
        uniform float uMouseRadius;
        uniform float uMouseStrength;
        uniform float uMouseDistort;
        uniform float uAssembly;
        uniform float uLoose;
        uniform float uScatter;
        uniform vec3 uLightPos;
        uniform float uLightRange;
        uniform float uShadeMin;
        uniform float uShadeMax;

        varying float vOpacity;
        varying vec3 vWorldPos;
        varying float vAssembly;
        varying float vLight;

        void main() {
          vOpacity = aOpacity;
          vAssembly = uAssembly;

          vec3 targetCenter = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          vec3 localOffset = (instanceMatrix * vec4(position, 1.0)).xyz - targetCenter;
          vec3 scatteredCenter = aScattered;
          float assembly = smoothstep(0.0, 1.0, uAssembly);
          vec3 center = mix(scatteredCenter, targetCenter, assembly);
          vec3 pos = center + localOffset;
          vWorldPos = center;

          float loose = uLoose * mix(0.25, 1.0, aEdge) * assembly;
          if (loose > 0.001) {
            vec3 jitter = vec3(
              fract(sin(aIndex * 12.9898) * 43758.5453) - 0.5,
              fract(sin(aIndex * 78.2330) * 12543.1230) - 0.5,
              fract(sin(aIndex * 39.4250) * 26711.7700) - 0.5
            );
            pos += jitter * 0.05 * loose;
            pos.x += sin(uTime * 0.50 + aIndex * 0.53) * 0.06 * loose;
            pos.y += cos(uTime * 0.42 + aIndex * 0.71) * 0.06 * loose;
            pos.z += sin(uTime * 0.36 + aIndex * 0.91) * 0.08 * loose;
            float tail = smoothstep(0.5, 4.5, targetCenter.x) * uLoose * assembly;
            pos.y += sin(uTime * 1.1 - targetCenter.x * 0.7) * 0.1 * tail;
            pos.z += cos(uTime * 0.9 - targetCenter.x * 0.55) * 0.06 * tail;
          }

          if (uScatter > 0.001) {
            float disperse = uScatter * mix(0.5, 1.0, aEdge);
            pos += (scatteredCenter - center) * disperse;
            pos.z += sin(uTime * 0.6 + aIndex * 0.3) * disperse * 0.6;
          }

          if (assembly > 0.95) {
            float effectStrength = (assembly - 0.95) * 20.0;
            float dist = length(center.xy);
            float waveFade = smoothstep(0.0, 3.0, dist);
            float wave = sin(dist * 3.0 - uTime * uWaveSpeed) * uWaveAmount * effectStrength * waveFade;
            pos.z += wave;
          }

          if (assembly > 0.8) {
            float mouseEffect = (assembly - 0.8) * 5.0;
            vec2 toMouse = center.xy - uMouse;
            float mouseDist = length(toMouse);
            if (mouseDist < uMouseRadius && mouseDist > 0.001) {
              float t = 1.0 - mouseDist / uMouseRadius;
              float force = t * t * t * mouseEffect * uMouseStrength;
              vec2 radialDir = toMouse / mouseDist;
              float noiseAngle = sin(aIndex * 0.37 + uTime * 0.5) * uMouseDistort;
              float ca = cos(noiseAngle);
              float sa = sin(noiseAngle);
              vec2 pushDir = vec2(
                radialDir.x * ca - radialDir.y * sa,
                radialDir.x * sa + radialDir.y * ca
              );
              pos.xy += pushDir * force * 2.0;
              pos.z += sin(aIndex * 1.7 + uTime) * force * 0.8;
            }
          }

          if (assembly < 0.9) {
            float scatter = smoothstep(0.9, 0.0, assembly);
            pos.x += sin(uTime * 0.5 + aIndex * 0.1) * 0.2 * scatter;
            pos.y += cos(uTime * 0.4 + aIndex * 0.07) * 0.2 * scatter;
            pos.z += sin(uTime * 0.3 + aIndex * 0.13) * 0.15 * scatter;
          }

          vec4 worldPos = modelMatrix * vec4(pos, 1.0);
          float lightDist = distance(worldPos.xyz, uLightPos);
          float lit = clamp(1.0 - lightDist / uLightRange, 0.0, 1.0);
          vLight = mix(uShadeMin, uShadeMax, lit * lit);

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `

export const heroFragmentShader = `
        varying float vOpacity;
        varying vec3 vWorldPos;
        varying float vAssembly;
        varying float vLight;

        uniform float uTime;
        uniform vec3 uColor;

        void main() {
          float dist = length(vWorldPos.xy);
          float glow = smoothstep(8.0, 0.0, dist) * 0.3 * vAssembly;
          float baseAlpha = mix(0.45, 0.75, vAssembly);
          float alpha = vOpacity * (baseAlpha + glow);
          float shimmer = sin(uTime * 1.5 + vWorldPos.x * 5.0 + vWorldPos.y * 3.0) * 0.1 + 0.9;
          alpha *= shimmer * min(vLight, 1.0);
          vec3 color = (uColor + glow * vec3(0.2, 0.3, 0.5)) * vLight;
          color = mix(color, color * vec3(1.07, 1.02, 0.94), clamp(vLight - 1.0, 0.0, 1.0));
          gl_FragColor = vec4(color, alpha);
        }
      `
