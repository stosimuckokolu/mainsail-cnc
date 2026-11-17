import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  AxisBounds,
  CameraPreset,
  KlipperTelemetry,
  LiveTraceSegment,
  MachineConfig,
  ParsedGCode,
  Vec3,
} from '../types/cnc';
import {
  Box,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Eraser,
  Eye,
  Focus,
  Layers,
} from 'lucide-react';

export interface CncViewportHandle {
  appendLiveSegment: (seg: LiveTraceSegment) => void;
  clearLiveTrace: () => void;
  setCameraPreset: (preset: CameraPreset) => void;
}

interface CncViewport3DProps {
  telemetry: KlipperTelemetry;
  config: MachineConfig;
  parsedGCode: ParsedGCode | null;
  liveTraceCount: number;
  onClearTrace: () => void;
}

const MAX_CUT_SEGS = 120000;
const MAX_RAPID_SEGS = 40000;

const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPoint = new THREE.Vector3();
const _desiredCamPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();

function cncToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  // CNC: +X right, +Y back, +Z up -> Three.js: +X right, +Y up, -Z back
  // Quadrant 4 (+X, -Y) maps directly to (+world.x, +world.z) in front of the operator.
  return out.set(x, z, -y);
}

function createSawBladeGeometry(radius: number, thickness: number, teeth = 28): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const innerR = radius * 0.91;
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = ((i + 0.35) / teeth) * Math.PI * 2;
    const a2 = ((i + 0.6) / teeth) * Math.PI * 2;
    const x0 = Math.cos(a0) * innerR;
    const y0 = Math.sin(a0) * innerR;
    const x1 = Math.cos(a1) * radius;
    const y1 = Math.sin(a1) * radius;
    const x2 = Math.cos(a2) * innerR;
    const y2 = Math.sin(a2) * innerR;
    if (i === 0) shape.moveTo(x0, y0);
    else shape.lineTo(x0, y0);
    shape.lineTo(x1, y1);
    shape.lineTo(x2, y2);
  }
  shape.closePath();

  const bore = new THREE.Path();
  bore.absarc(0, 0, 12, 0, Math.PI * 2, true);
  shape.holes.push(bore);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    steps: 1,
  });
  geo.center();
  return geo;
}

function createQuadrant4BedTexture(bounds: AxisBounds): THREE.CanvasTexture {
  const spanX = bounds.max.x - bounds.min.x; // 3500
  const spanY = bounds.max.y - bounds.min.y; // 1500
  const w = 2048;
  const h = Math.max(512, Math.round((spanY / spanX) * w));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // World plane sits at X:[min.x..max.x], world.z:[-max.y..-min.y]
  // UV top (py=0) corresponds to world.z = -max.y (cncY = +500, back)
  // UV bottom (py=h) corresponds to world.z = -min.y (cncY = -1000, front)
  const toPxX = (cncX: number) => ((cncX - bounds.min.x) / spanX) * w;
  const toPxY = (cncY: number) => ((bounds.max.y - cncY) / spanY) * h;

  // Base industrial slate floor inside machine enclosure
  ctx.fillStyle = '#11151d';
  ctx.fillRect(0, 0, w, h);

  // Highlight Quadrant 4 Active Panel Zone (X >= 0, Y <= 0)
  const q4Left = toPxX(Math.max(0, bounds.min.x));
  const q4Right = toPxX(bounds.max.x);
  const q4Top = toPxY(Math.min(0, bounds.max.y));
  const q4Bottom = toPxY(bounds.min.y);
  ctx.fillStyle = '#161c26';
  ctx.fillRect(q4Left, q4Top, q4Right - q4Left, q4Bottom - q4Top);

  // Minor 100mm grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(bounds.min.x / 100) * 100; x <= bounds.max.x; x += 100) {
    const px = toPxX(x);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = Math.ceil(bounds.min.y / 100) * 100; y <= bounds.max.y; y += 100) {
    const py = toPxY(y);
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // Major 500mm grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let x = Math.ceil(bounds.min.x / 500) * 500; x <= bounds.max.x; x += 500) {
    const px = toPxX(x);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = Math.ceil(bounds.min.y / 500) * 500; y <= bounds.max.y; y += 500) {
    const py = toPxY(y);
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // X=0 & Y=0 Datum Fence Lines
  const zeroX = toPxX(0);
  const zeroY = toPxY(0);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(zeroX, 0);
  ctx.lineTo(zeroX, h);
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();

  // Coordinate ruler labels
  ctx.font = '600 17px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.78)';
  ctx.textBaseline = 'bottom';
  for (let x = Math.ceil(bounds.min.x / 500) * 500; x <= bounds.max.x; x += 500) {
    const px = toPxX(x);
    ctx.fillText(`X${x}`, Math.min(w - 75, px + 5), h - 8);
  }

  ctx.textBaseline = 'top';
  for (let y = Math.ceil(bounds.min.y / 500) * 500; y <= bounds.max.y; y += 500) {
    const py = toPxY(y);
    ctx.fillText(`Y${y}`, 8, Math.min(h - 24, py + 5));
  }

  ctx.fillStyle = 'rgba(56, 189, 248, 0.9)';
  ctx.fillText('SCM TECH 99L · QUADRANT 4 (X+ / Y-)', zeroX + 12, zeroY + 10);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export const CncViewport3D = forwardRef<CncViewportHandle, CncViewport3DProps>(
  function CncViewport3D({ telemetry, config, parsedGCode, liveTraceCount, onClearTrace }, ref) {
    const mountRef = useRef<HTMLDivElement | null>(null);

    const [showPlanned, setShowPlanned] = useState(true);
    const [showLiveTrace, setShowLiveTrace] = useState(true);
    const [showRapids, setShowRapids] = useState(true);
    const [showStock, setShowStock] = useState(true);
    const [showGantry, setShowGantry] = useState(true);
    const [followTool, setFollowTool] = useState(false);
    const [dockCollapsed, setDockCollapsed] = useState(false);
    const [hoverCoord, setHoverCoord] = useState<{ x: number; y: number } | null>(null);
    const [webglLost, setWebglLost] = useState(false);

    const telemetryRef = useRef(telemetry);
    telemetryRef.current = telemetry;
    const configRef = useRef(config);
    configRef.current = config;
    const layersRef = useRef({
      showPlanned,
      showLiveTrace,
      showRapids,
      showStock,
      showGantry,
      followTool,
    });
    layersRef.current = {
      showPlanned,
      showLiveTrace,
      showRapids,
      showStock,
      showGantry,
      followTool,
    };

    const sceneHandlesRef = useRef<{
      appendLiveSegment: (seg: LiveTraceSegment) => void;
      clearLiveTrace: () => void;
      applyCameraPreset: (preset: CameraPreset) => void;
      rebuildPlannedPath: (parsed: ParsedGCode | null, wcsOffset: Vec3) => void;
      rebuildBedAndStock: (cfg: MachineConfig, wcsOffset: Vec3) => void;
    } | null>(null);

    useImperativeHandle(ref, () => ({
      appendLiveSegment: (seg) => {
        sceneHandlesRef.current?.appendLiveSegment(seg);
      },
      clearLiveTrace: () => {
        sceneHandlesRef.current?.clearLiveTrace();
      },
      setCameraPreset: (preset) => {
        sceneHandlesRef.current?.applyCameraPreset(preset);
      },
    }));

    useEffect(() => {
      const container = mountRef.current;
      if (!container) return;

      const isSoftwareGl = (() => {
        const probe = document.createElement('canvas').getContext('webgl2');
        if (!probe) return true;
        const ext = probe.getExtension('WEBGL_debug_renderer_info');
        const param = ext ? ext.UNMASKED_RENDERER_WEBGL : probe.RENDERER;
        const gpu = String(probe.getParameter(param));
        probe.getExtension('WEBGL_lose_context')?.loseContext();
        return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
      })();

      const renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: 'high-performance',
      });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = !isSoftwareGl;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setSize(container.clientWidth || 800, container.clientHeight || 600);
      container.appendChild(renderer.domElement);

      const handleContextLost = (e: Event) => {
        e.preventDefault();
        setWebglLost(true);
      };
      const handleContextRestored = () => {
        setWebglLost(false);
      };
      renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#0c0f14');
      scene.fog = new THREE.Fog('#0c0f14', 3200, 8200);

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();

      const width = container.clientWidth || 800;
      const height = container.clientHeight || 600;
      const camera = new THREE.PerspectiveCamera(40, width / height, 2, 14000);
      // Initial isometric framing centered on Quadrant 4 panel area
      camera.position.set(1180, 920, 1480);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !isSoftwareGl;
      controls.dampingFactor = 0.07;
      controls.minDistance = 80;
      controls.maxDistance = 6500;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.target.set(480, 25, 300);
      controls.update();

      // 3-point studio lighting
      const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.85);
      scene.add(hemi);

      const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.4);
      keyLight.position.set(1400, 1800, 1200);
      keyLight.castShadow = !isSoftwareGl;
      if (keyLight.castShadow) {
        keyLight.shadow.mapSize.set(1024, 1024);
        keyLight.shadow.camera.left = -2200;
        keyLight.shadow.camera.right = 2200;
        keyLight.shadow.camera.top = 1500;
        keyLight.shadow.camera.bottom = -1500;
        keyLight.shadow.camera.far = 5000;
        keyLight.shadow.bias = -0.0006;
        keyLight.shadow.normalBias = 0.02;
      }
      scene.add(keyLight);

      const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
      rimLight.position.set(-1200, 900, -1400);
      scene.add(rimLight);

      // Shop floor plane
      const floorGeo = new THREE.PlaneGeometry(14000, 14000);
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0x090c11,
        roughness: 0.94,
        metalness: 0.05,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.rotation.x = -Math.PI / 2;
      floorMesh.position.y = -110;
      scene.add(floorMesh);

      const bedGroup = new THREE.Group();
      scene.add(bedGroup);
      let bedTex: THREE.CanvasTexture | null = null;

      const stockGroup = new THREE.Group();
      scene.add(stockGroup);

      // WCS Origin Triad
      const wcsTriad = new THREE.Group();
      const triadLen = 90;
      wcsTriad.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(triadLen, 0, 0),
          ]),
          new THREE.LineBasicMaterial({ color: 0xef4444 }),
        ),
      );
      wcsTriad.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -triadLen),
          ]),
          new THREE.LineBasicMaterial({ color: 0x22c55e }),
        ),
      );
      wcsTriad.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, triadLen, 0),
          ]),
          new THREE.LineBasicMaterial({ color: 0x38bdf8 }),
        ),
      );
      const originRing = new THREE.Mesh(
        new THREE.RingGeometry(8, 12, 24),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide }),
      );
      originRing.rotation.x = -Math.PI / 2;
      originRing.position.y = 0.25;
      wcsTriad.add(originRing);
      scene.add(wcsTriad);

      // SCM Tech 99L Cantilever / Rear-Beam Gantry Assembly (tracks X along rear Y=+500)
      const gantryGroup = new THREE.Group();
      const scmCreamMat = new THREE.MeshStandardMaterial({
        color: 0xd6d9de,
        metalness: 0.25,
        roughness: 0.52,
      });
      const scmSlateMat = new THREE.MeshStandardMaterial({
        color: 0x1e2532,
        metalness: 0.55,
        roughness: 0.42,
      });
      const darkAnodizedMat = new THREE.MeshStandardMaterial({
        color: 0x1a202c,
        metalness: 0.72,
        roughness: 0.38,
      });
      const brushedAluMat = new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        metalness: 0.88,
        roughness: 0.22,
      });
      const blackOxideMat = new THREE.MeshStandardMaterial({
        color: 0x111827,
        metalness: 0.84,
        roughness: 0.28,
      });
      const carbideMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.94,
        roughness: 0.14,
      });
      const activeTipMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.45,
        roughness: 0.2,
        metalness: 0.65,
      });
      const activeDrillMat = new THREE.MeshStandardMaterial({
        color: 0x22d3ee,
        emissive: 0x06b6d4,
        emissiveIntensity: 0.7,
        metalness: 0.85,
        roughness: 0.2,
      });
      const steelDrillMat = new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        metalness: 0.88,
        roughness: 0.24,
      });

      // Cantilever X-Tower + Y-Arm tracking toolhead X
      const xTower = new THREE.Group();
      const towerBase = new THREE.Mesh(new THREE.BoxGeometry(220, 260, 180), scmSlateMat);
      towerBase.position.set(0, 130, -560);
      xTower.add(towerBase);

      const cantileverArm = new THREE.Mesh(new THREE.BoxGeometry(190, 85, 1650), scmCreamMat);
      cantileverArm.position.set(0, 285, 220);
      cantileverArm.castShadow = !isSoftwareGl;
      xTower.add(cantileverArm);

      const yRail = new THREE.Mesh(new THREE.BoxGeometry(36, 18, 1600), brushedAluMat);
      yRail.position.set(85, 250, 220);
      xTower.add(yRail);

      gantryGroup.add(xTower);
      scene.add(gantryGroup);

      // =========================================================================
      // SCM Tech 99L Composite Machining Head (THREE.Group)
      // - Main Routing Electrospindle (T0) at local (0, 0, 0)
      // - Boring Block with 14 Top (Vertical) Drills (9 along X + 5 along Y, 32mm grid)
      // - 6 Side (Horizontal) Edge Drills (4 along X [2+2], 2 along Y [1+1])
      // - 1 Circular Grooving Saw (125mm diameter blade + guard hood)
      // =========================================================================
      const headGroup = new THREE.Group();

      // Main Z-Carriage & SCM Head Shroud
      const zCarriagePlate = new THREE.Mesh(new THREE.BoxGeometry(360, 190, 48), scmSlateMat);
      zCarriagePlate.position.set(125, 160, -145);
      headGroup.add(zCarriagePlate);

      const headCover = new THREE.Mesh(new THREE.BoxGeometry(350, 130, 160), scmCreamMat);
      headCover.position.set(125, 185, -45);
      headCover.castShadow = !isSoftwareGl;
      headGroup.add(headCover);

      // 1) Main Routing Electrospindle (ISO30 / HSK63F) at local (0,0,0)
      const spindleBody = new THREE.Mesh(
        new THREE.CylinderGeometry(36, 36, 130, 24),
        brushedAluMat,
      );
      spindleBody.position.set(0, 125, 0);
      spindleBody.castShadow = !isSoftwareGl;
      headGroup.add(spindleBody);

      const spindleClamp = new THREE.Mesh(
        new THREE.CylinderGeometry(42, 42, 34, 24),
        darkAnodizedMat,
      );
      spindleClamp.position.set(0, 125, 0);
      headGroup.add(spindleClamp);

      const mainRotor = new THREE.Group();
      const isoTaper = new THREE.Mesh(
        new THREE.CylinderGeometry(20, 15, 22, 18),
        blackOxideMat,
      );
      isoTaper.position.set(0, 49, 0);
      mainRotor.add(isoTaper);

      const colletNut = new THREE.Mesh(
        new THREE.CylinderGeometry(14, 12, 16, 6),
        blackOxideMat,
      );
      colletNut.position.set(0, 31, 0);
      mainRotor.add(colletNut);

      const routerShank = new THREE.Mesh(
        new THREE.CylinderGeometry(5, 5, 18, 12),
        carbideMat,
      );
      routerShank.position.set(0, 15, 0);
      mainRotor.add(routerShank);

      const routerFlutes = new THREE.Mesh(
        new THREE.CylinderGeometry(4, 3.6, 12, 12),
        activeTipMat,
      );
      routerFlutes.position.set(0, 6, 0);
      mainRotor.add(routerFlutes);
      headGroup.add(mainRotor);

      // 2) SCM Boring Manifold Housing (offset beside main spindle: +X = +95..+365, -Z = -40..-210)
      const boringBlock = new THREE.Mesh(
        new THREE.BoxGeometry(285, 68, 175),
        darkAnodizedMat,
      );
      boringBlock.position.set(205, 108, -75);
      boringBlock.castShadow = !isSoftwareGl;
      headGroup.add(boringBlock);

      // 14 Top (Vertical) Drills on 32mm Pitch Grid (9 along X + 5 along Y)
      const vDrillRefs: Array<{ group: THREE.Group; bitMesh: THREE.Mesh; baseY: number }> = [];
      const vDrillCoords: Array<[number, number]> = [];
      // 9 spindles along X (32mm pitch) at local z = -15
      for (let i = 0; i < 9; i++) {
        vDrillCoords.push([85 + i * 32, -15]);
      }
      // 5 spindles along Y (32mm pitch into -Z) at local x = 85
      for (let j = 1; j <= 5; j++) {
        vDrillCoords.push([85, -15 - j * 32]);
      }

      vDrillCoords.forEach(([lx, lz]) => {
        const dGroup = new THREE.Group();
        const baseY = 48; // retracted above main bit tip
        dGroup.position.set(lx, baseY, lz);

        const sleeve = new THREE.Mesh(
          new THREE.CylinderGeometry(7.5, 7.5, 34, 12),
          brushedAluMat,
        );
        sleeve.position.set(0, 26, 0);
        dGroup.add(sleeve);

        const chuck = new THREE.Mesh(
          new THREE.CylinderGeometry(5.5, 4.5, 12, 10),
          blackOxideMat,
        );
        chuck.position.set(0, 6, 0);
        dGroup.add(chuck);

        const bit = new THREE.Mesh(
          new THREE.CylinderGeometry(2.6, 2.2, 26, 10),
          steelDrillMat.clone(),
        );
        bit.position.set(0, -12, 0);
        dGroup.add(bit);

        headGroup.add(dGroup);
        vDrillRefs.push({ group: dGroup, bitMesh: bit, baseY });
      });

      // 3) 6 Side (Horizontal) Edge-Boring Drills (4 in X [2 +X, 2 -X], 2 in Y [1 +Y, 1 -Y])
      const hDrillSpecs: Array<{
        pos: [number, number, number];
        dir: [number, number, number];
        rot: [number, number, number];
      }> = [
        // H1, H2: +X facing
        { pos: [348, 86, -40], dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2] },
        { pos: [348, 86, -72], dir: [1, 0, 0], rot: [0, 0, -Math.PI / 2] },
        // H3, H4: -X facing (mounted on left side of boring block, clear of spindle)
        { pos: [62, 86, -105], dir: [-1, 0, 0], rot: [0, 0, Math.PI / 2] },
        { pos: [62, 86, -137], dir: [-1, 0, 0], rot: [0, 0, Math.PI / 2] },
        // H5: +Y facing (toward rear -Z in Three.js)
        { pos: [175, 86, -162], dir: [0, 0, -1], rot: [-Math.PI / 2, 0, 0] },
        // H6: -Y facing (toward front operator +Z in Three.js)
        { pos: [207, 86, 12], dir: [0, 0, 1], rot: [Math.PI / 2, 0, 0] },
      ];

      const hDrillRefs: Array<{
        group: THREE.Group;
        bitMesh: THREE.Mesh;
        basePos: THREE.Vector3;
        dir: THREE.Vector3;
      }> = [];

      hDrillSpecs.forEach((spec) => {
        const hg = new THREE.Group();
        const basePos = new THREE.Vector3(...spec.pos);
        hg.position.copy(basePos);
        hg.rotation.set(...spec.rot);

        const collar = new THREE.Mesh(
          new THREE.CylinderGeometry(6.5, 6.5, 16, 12),
          blackOxideMat,
        );
        collar.position.set(0, 6, 0);
        hg.add(collar);

        const bit = new THREE.Mesh(
          new THREE.CylinderGeometry(2.4, 2.0, 28, 10),
          steelDrillMat.clone(),
        );
        bit.position.set(0, 24, 0);
        hg.add(bit);

        headGroup.add(hg);
        hDrillRefs.push({
          group: hg,
          bitMesh: bit,
          basePos,
          dir: new THREE.Vector3(...spec.dir),
        });
      });

      // 4) 1 Circular Grooving Saw Unit (125mm blade oriented along X-axis)
      const sawGroup = new THREE.Group();
      const sawBaseY = 72;
      sawGroup.position.set(275, sawBaseY, -125);

      const sawGuard = new THREE.Mesh(
        new THREE.CylinderGeometry(68, 68, 16, 20, 1, false, 0, Math.PI),
        scmSlateMat,
      );
      sawGuard.rotation.x = Math.PI / 2;
      sawGuard.rotation.z = 0;
      sawGroup.add(sawGuard);

      const sawBladeGeo = createSawBladeGeometry(62.5, 3.2, 28);
      const sawBladeMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.92,
        roughness: 0.18,
      });
      const sawBladeMesh = new THREE.Mesh(sawBladeGeo, sawBladeMat);
      sawBladeMesh.castShadow = !isSoftwareGl;
      sawGroup.add(sawBladeMesh);

      const sawFlange = new THREE.Mesh(
        new THREE.CylinderGeometry(18, 18, 8, 16),
        blackOxideMat,
      );
      sawFlange.rotation.x = Math.PI / 2;
      sawGroup.add(sawFlange);

      headGroup.add(sawGroup);
      scene.add(headGroup);

      // Projected Laser Crosshair Ring on Table / Stock
      const laserGroup = new THREE.Group();
      const laserRing = new THREE.Mesh(
        new THREE.RingGeometry(8, 11, 28),
        new THREE.MeshBasicMaterial({
          color: 0x22d3ee,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.8,
        }),
      );
      laserRing.rotation.x = -Math.PI / 2;
      laserGroup.add(laserRing);
      const dropLineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 1, 0),
      ]);
      const dropLine = new THREE.Line(
        dropLineGeo,
        new THREE.LineBasicMaterial({
          color: 0x22d3ee,
          transparent: true,
          opacity: 0.4,
        }),
      );
      laserGroup.add(dropLine);
      scene.add(laserGroup);

      // Planned G-Code Path Group
      const plannedGroup = new THREE.Group();
      scene.add(plannedGroup);
      const plannedCutMat = new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.34,
      });
      const plannedRapidMat = new THREE.LineBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.18,
      });
      let plannedCutLines: THREE.LineSegments | null = null;
      let plannedRapidLines: THREE.LineSegments | null = null;

      // Live Generated Toolpath Buffers (Zero-GC)
      const liveCutPositions = new Float32Array(MAX_CUT_SEGS * 2 * 3);
      const liveCutColors = new Float32Array(MAX_CUT_SEGS * 2 * 3);
      const liveCutGeo = new THREE.BufferGeometry();
      const liveCutPosAttr = new THREE.BufferAttribute(liveCutPositions, 3);
      liveCutPosAttr.setUsage(THREE.DynamicDrawUsage);
      const liveCutColAttr = new THREE.BufferAttribute(liveCutColors, 3);
      liveCutColAttr.setUsage(THREE.DynamicDrawUsage);
      liveCutGeo.setAttribute('position', liveCutPosAttr);
      liveCutGeo.setAttribute('color', liveCutColAttr);
      liveCutGeo.setDrawRange(0, 0);
      const liveCutMesh = new THREE.LineSegments(
        liveCutGeo,
        new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.96,
        }),
      );
      liveCutMesh.frustumCulled = false;
      liveCutMesh.renderOrder = 3;
      scene.add(liveCutMesh);

      const liveRapidPositions = new Float32Array(MAX_RAPID_SEGS * 2 * 3);
      const liveRapidGeo = new THREE.BufferGeometry();
      const liveRapidPosAttr = new THREE.BufferAttribute(liveRapidPositions, 3);
      liveRapidPosAttr.setUsage(THREE.DynamicDrawUsage);
      liveRapidGeo.setAttribute('position', liveRapidPosAttr);
      liveRapidGeo.setDrawRange(0, 0);
      const liveRapidMesh = new THREE.LineSegments(
        liveRapidGeo,
        new THREE.LineBasicMaterial({
          color: 0xf59e0b,
          transparent: true,
          opacity: 0.65,
        }),
      );
      liveRapidMesh.frustumCulled = false;
      liveRapidMesh.renderOrder = 2;
      scene.add(liveRapidMesh);

      let cutSegCount = 0;
      let rapidSegCount = 0;

      const rebuildBedAndStock = (cfg: MachineConfig, wcsOffset: Vec3) => {
        while (bedGroup.children.length > 0) {
          const ch = bedGroup.children.pop()!;
          ch.traverse((o) => {
            if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
            const m = (o as THREE.Mesh).material;
            if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
            else if (m) m.dispose();
          });
        }
        if (bedTex) {
          bedTex.dispose();
          bedTex = null;
        }

        const { min, max } = cfg.axisBounds;
        const spanX = Math.max(100, max.x - min.x);
        const spanY = Math.max(100, max.y - min.y);
        const spanZ = Math.max(40, max.z - min.z);
        const centerX = (min.x + max.x) * 0.5;
        const centerWorldZ = -((min.y + max.y) * 0.5);

        bedTex = createQuadrant4BedTexture(cfg.axisBounds);
        bedTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

        // Main Machine Bed Base below vacuum consoles (sits at world.y = -70..-98)
        const baseDeck = new THREE.Mesh(
          new THREE.BoxGeometry(spanX, 24, spanY),
          [
            new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.55, metalness: 0.55 }),
            new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.55, metalness: 0.55 }),
            new THREE.MeshStandardMaterial({ map: bedTex, roughness: 0.78, metalness: 0.16 }),
            new THREE.MeshStandardMaterial({ color: 0x0e1117, roughness: 0.85 }),
            new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.55, metalness: 0.55 }),
            new THREE.MeshStandardMaterial({ color: 0x1a202c, roughness: 0.55, metalness: 0.55 }),
          ],
        );
        baseDeck.position.set(centerX, -82, centerWorldZ);
        baseDeck.receiveShadow = !isSoftwareGl;
        bedGroup.add(baseDeck);

        // Pod-and-Rail Vacuum Consoles in Quadrant 4 (top of pods at Z=0 datum!)
        const consoleXPositions = [110, 480, 920, 1450, 2050, 2680].filter(
          (x) => x >= min.x + 80 && x <= max.x - 80,
        );
        const railLenY = Math.min(1040, Math.abs(min.y) + 40);
        const railGeo = new THREE.BoxGeometry(64, 34, railLenY);
        const railMat = new THREE.MeshStandardMaterial({
          color: 0x334155,
          metalness: 0.72,
          roughness: 0.34,
        });
        const podGeo = new THREE.BoxGeometry(135, 36, 135);
        const podMat = new THREE.MeshStandardMaterial({
          color: 0x1e2430,
          metalness: 0.3,
          roughness: 0.7,
        });
        const stopPinGeo = new THREE.CylinderGeometry(8, 8, 22, 14);
        const stopPinMat = new THREE.MeshStandardMaterial({
          color: 0xf59e0b,
          metalness: 0.75,
          roughness: 0.28,
        });

        const railsInst = new THREE.InstancedMesh(railGeo, railMat, consoleXPositions.length);
        const podYPositions = [-140, -480, -820].filter((y) => y >= min.y + 80);
        const podsInst = new THREE.InstancedMesh(
          podGeo,
          podMat,
          consoleXPositions.length * podYPositions.length,
        );
        const pinsInst = new THREE.InstancedMesh(stopPinGeo, stopPinMat, consoleXPositions.length + 1);

        const dummy = new THREE.Object3D();
        let podIdx = 0;
        consoleXPositions.forEach((cx, idx) => {
          // Console rail sits from y=-53 to y=-19 under pods
          dummy.position.set(cx, -53, railLenY * 0.5 - 20);
          dummy.updateMatrix();
          railsInst.setMatrixAt(idx, dummy.matrix);

          // Rear Reference Stop Pin at Y=0
          dummy.position.set(cx, 6, 0);
          dummy.updateMatrix();
          pinsInst.setMatrixAt(idx, dummy.matrix);

          podYPositions.forEach((py) => {
            // Pod top sits cleanly at world.y = -0.2 (Z=0 panel bottom datum)
            dummy.position.set(cx, -18.5, -py);
            dummy.updateMatrix();
            podsInst.setMatrixAt(podIdx++, dummy.matrix);
          });
        });
        // Left side stop pin at X=0, Y=-250
        dummy.position.set(0, 6, 250);
        dummy.updateMatrix();
        pinsInst.setMatrixAt(consoleXPositions.length, dummy.matrix);

        railsInst.instanceMatrix.needsUpdate = true;
        podsInst.instanceMatrix.needsUpdate = true;
        pinsInst.instanceMatrix.needsUpdate = true;
        railsInst.computeBoundingSphere();
        podsInst.computeBoundingSphere();
        pinsInst.computeBoundingSphere();
        bedGroup.add(railsInst);
        bedGroup.add(podsInst);
        bedGroup.add(pinsInst);

        // Work envelope wireframe spanning X[min..max], Y[min..max], Z[min..max]
        const envGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(spanX, spanZ, spanY));
        const envWire = new THREE.LineSegments(
          envGeo,
          new THREE.LineBasicMaterial({
            color: 0x334155,
            transparent: true,
            opacity: 0.42,
          }),
        );
        envWire.position.set(centerX, (min.z + max.z) * 0.5, centerWorldZ);
        bedGroup.add(envWire);

        // Stock Workpiece in Quadrant 4 (+X width, -Y depth, +Z thickness)
        while (stockGroup.children.length > 0) {
          const ch = stockGroup.children.pop()!;
          ch.traverse((o) => {
            if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
            const m = (o as THREE.Mesh).material;
            if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
            else if (m) m.dispose();
          });
        }
        if (cfg.stockEnabled) {
          const sx = cfg.stockSize.x;
          const sy = cfg.stockSize.y;
          const sz = cfg.stockSize.z;
          const stockMesh = new THREE.Mesh(
            new THREE.BoxGeometry(sx, sz, sy),
            new THREE.MeshStandardMaterial({
              color: 0xb48c64, // Baltic birch / MDF wood panel tone
              metalness: 0.12,
              roughness: 0.68,
              transparent: true,
              opacity: 0.34,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          // Quadrant 4: starts at (wcs.x, wcs.y) and goes +X, -Y (world +Z)
          stockMesh.position.set(wcsOffset.x + sx / 2, sz / 2, -wcsOffset.y + sy / 2);
          stockGroup.add(stockMesh);

          const stockEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sz, sy)),
            new THREE.LineBasicMaterial({
              color: 0xd6b08a,
              transparent: true,
              opacity: 0.55,
            }),
          );
          stockEdges.position.copy(stockMesh.position);
          stockGroup.add(stockEdges);
        }

        wcsTriad.position.set(wcsOffset.x, wcsOffset.z, -wcsOffset.y);
      };

      const rebuildPlannedPath = (parsed: ParsedGCode | null, wcsOffset: Vec3) => {
        if (plannedCutLines) {
          plannedGroup.remove(plannedCutLines);
          plannedCutLines.geometry.dispose();
          plannedCutLines = null;
        }
        if (plannedRapidLines) {
          plannedGroup.remove(plannedRapidLines);
          plannedRapidLines.geometry.dispose();
          plannedRapidLines = null;
        }
        if (!parsed || parsed.segments.length === 0) return;

        const cutVerts: number[] = [];
        const rapidVerts: number[] = [];
        for (const seg of parsed.segments) {
          const sx = seg.start.x + wcsOffset.x;
          const sy = seg.start.z + wcsOffset.z;
          const sz = -(seg.start.y + wcsOffset.y);
          const ex = seg.end.x + wcsOffset.x;
          const ey = seg.end.z + wcsOffset.z;
          const ez = -(seg.end.y + wcsOffset.y);
          if (seg.type === 'rapid') {
            rapidVerts.push(sx, sy, sz, ex, ey, ez);
          } else {
            cutVerts.push(sx, sy, sz, ex, ey, ez);
          }
        }

        if (cutVerts.length > 0) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(cutVerts, 3));
          plannedCutLines = new THREE.LineSegments(g, plannedCutMat);
          plannedCutLines.renderOrder = 1;
          plannedGroup.add(plannedCutLines);
        }
        if (rapidVerts.length > 0) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(rapidVerts, 3));
          plannedRapidLines = new THREE.LineSegments(g, plannedRapidMat);
          plannedRapidLines.renderOrder = 1;
          plannedGroup.add(plannedRapidLines);
        }
      };

      const appendLiveSegment = (seg: LiveTraceSegment) => {
        const sx = seg.start.x;
        const sy = seg.start.z;
        const sz = -seg.start.y;
        const ex = seg.end.x;
        const ey = seg.end.z;
        const ez = -seg.end.y;

        if (seg.type === 'rapid') {
          if (rapidSegCount >= MAX_RAPID_SEGS) return;
          const base = rapidSegCount * 6;
          liveRapidPositions[base] = sx;
          liveRapidPositions[base + 1] = sy;
          liveRapidPositions[base + 2] = sz;
          liveRapidPositions[base + 3] = ex;
          liveRapidPositions[base + 4] = ey;
          liveRapidPositions[base + 5] = ez;
          liveRapidPosAttr.clearUpdateRanges();
          liveRapidPosAttr.addUpdateRange(base, 6);
          liveRapidPosAttr.needsUpdate = true;
          rapidSegCount++;
          liveRapidGeo.setDrawRange(0, rapidSegCount * 2);
        } else {
          if (cutSegCount >= MAX_CUT_SEGS) return;
          const base = cutSegCount * 6;
          liveCutPositions[base] = sx;
          liveCutPositions[base + 1] = sy;
          liveCutPositions[base + 2] = sz;
          liveCutPositions[base + 3] = ex;
          liveCutPositions[base + 4] = ey;
          liveCutPositions[base + 5] = ez;

          const wcsZ = telemetryRef.current.wcsOffsets[telemetryRef.current.activeWcs].z;
          const relZ = seg.end.z - wcsZ;
          let r = 0.08;
          let g = 0.88;
          let b = 0.62;
          if (seg.type === 'plunge') {
            r = 0.96;
            g = 0.44;
            b = 0.36;
          } else if (relZ < -0.1) {
            const depthT = Math.min(1, Math.abs(relZ) / 16);
            r = 0.05 + depthT * 0.08;
            g = 0.86 - depthT * 0.14;
            b = 0.66 + depthT * 0.32;
          }

          liveCutColors[base] = r;
          liveCutColors[base + 1] = g;
          liveCutColors[base + 2] = b;
          liveCutColors[base + 3] = r;
          liveCutColors[base + 4] = g;
          liveCutColors[base + 5] = b;

          liveCutPosAttr.clearUpdateRanges();
          liveCutPosAttr.addUpdateRange(base, 6);
          liveCutPosAttr.needsUpdate = true;
          liveCutColAttr.clearUpdateRanges();
          liveCutColAttr.addUpdateRange(base, 6);
          liveCutColAttr.needsUpdate = true;
          cutSegCount++;
          liveCutGeo.setDrawRange(0, cutSegCount * 2);
        }
      };

      const clearLiveTrace = () => {
        cutSegCount = 0;
        rapidSegCount = 0;
        liveCutGeo.setDrawRange(0, 0);
        liveRapidGeo.setDrawRange(0, 0);
      };

      let camTransitionActive = false;
      const cancelCamTransition = () => {
        camTransitionActive = false;
      };
      controls.addEventListener('start', cancelCamTransition);

      const applyCameraPreset = (preset: CameraPreset) => {
        const cfg = configRef.current;
        const t = telemetryRef.current;
        const wcs = t.wcsOffsets[t.activeWcs];
        const { min, max } = cfg.axisBounds;

        // Quadrant 4 stock center: X from wcs.x to wcs.x + stockSize.x; Y from wcs.y down to wcs.y - stockSize.y
        const stockCenterX = cfg.stockEnabled
          ? wcs.x + cfg.stockSize.x * 0.5
          : (min.x + max.x) * 0.5;
        const stockCenterY = cfg.stockEnabled
          ? wcs.y - cfg.stockSize.y * 0.5
          : (min.y + max.y) * 0.5;
        const stockCenterZ = wcs.z * 0.5;

        if (preset === 'fit') {
          const bx = (min.x + max.x) * 0.5;
          const by = (min.y + max.y) * 0.5;
          _desiredTarget.set(bx, 35, -by);
          _desiredCamPos.set(bx + 200, 1850, -by + 2500);
        } else {
          _desiredTarget.set(stockCenterX, stockCenterZ, -stockCenterY);
          if (preset === 'iso') {
            _desiredCamPos.set(stockCenterX + 700, stockCenterZ + 880, -stockCenterY + 1150);
          } else if (preset === 'top') {
            _desiredCamPos.set(stockCenterX, stockCenterZ + 1450, -stockCenterY + 2);
          } else if (preset === 'front') {
            _desiredCamPos.set(stockCenterX, stockCenterZ + 220, -stockCenterY + 1350);
          } else if (preset === 'side') {
            _desiredCamPos.set(stockCenterX + 1450, stockCenterZ + 240, -stockCenterY);
          }
        }
        camTransitionActive = true;
      };

      const initWcs = telemetryRef.current.wcsOffsets[telemetryRef.current.activeWcs];
      rebuildBedAndStock(configRef.current, initWcs);
      sceneHandlesRef.current = {
        appendLiveSegment,
        clearLiveTrace,
        applyCameraPreset,
        rebuildPlannedPath,
        rebuildBedAndStock,
      };

      let lastRaycast = 0;
      const onPointerMove = (e: PointerEvent) => {
        const now = performance.now();
        if (now - lastRaycast < 45) return;
        lastRaycast = now;
        const rect = renderer.domElement.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const wcs = telemetryRef.current.wcsOffsets[telemetryRef.current.activeWcs];
        _plane.constant = -wcs.z;
        if (_raycaster.ray.intersectPlane(_plane, _hitPoint)) {
          const mx = _hitPoint.x;
          const my = -_hitPoint.z;
          const { min, max } = configRef.current.axisBounds;
          if (mx >= min.x - 50 && mx <= max.x + 50 && my >= min.y - 50 && my <= max.y + 50) {
            setHoverCoord({ x: mx - wcs.x, y: my - wcs.y });
          } else {
            setHoverCoord(null);
          }
        }
      };
      const onPointerLeave = () => setHoverCoord(null);
      renderer.domElement.addEventListener('pointermove', onPointerMove);
      renderer.domElement.addEventListener('pointerleave', onPointerLeave);

      const resizeObserver = new ResizeObserver(() => {
        if (!container) return;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w <= 0 || h <= 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      });
      resizeObserver.observe(container);

      if (!isSoftwareGl) {
        renderer.compile(scene, camera);
      }

      let frameId = 0;
      let lastTime = performance.now();

      function afterDraw(cb: () => void) {
        const gl = renderer.getContext() as WebGL2RenderingContext;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        const poll = () => {
          const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
          if (state === gl.UNSIGNALED) {
            frameId = window.setTimeout(poll, 5);
          } else {
            if (sync) gl.deleteSync(sync);
            frameId = window.setTimeout(cb, 80);
          }
        };
        frameId = window.setTimeout(poll, 5);
      }

      const tick = () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - lastTime) / 1000);
        lastTime = now;

        const t = telemetryRef.current;
        const layers = layersRef.current;
        const wcs = t.wcsOffsets[t.activeWcs];
        const tool = t.activeTool;

        // Position SCM Tech 99L Head & Cantilever X-Tower
        cncToWorld(t.machinePos.x, t.machinePos.y, t.machinePos.z, headGroup.position);
        xTower.position.x = t.machinePos.x + 125;
        gantryGroup.visible = layers.showGantry;

        // Animate active tool (Main Spindle, 14 Top Drills, 6 Side Drills, or Circular Saw)
        const spinActive = t.spindleRpm > 0 || t.isJobRunning;
        const spinRate = dt * Math.min(48, Math.max(8, (t.spindleRpm / 1000) * 3.5));

        if (tool.mode === 'spindle' && t.spindleRpm > 0) {
          mainRotor.rotation.y += spinRate;
          activeTipMat.emissiveIntensity = t.workPos.z <= 0.5 ? 1.4 : 0.5;
        } else {
          activeTipMat.emissiveIntensity = 0.08;
        }

        // Pneumatic drop & spin on the 14 Top Drills
        vDrillRefs.forEach((dr, idx) => {
          const isSelected = tool.mode === 'v_drill' && tool.index === idx + 1;
          const targetY = isSelected ? dr.baseY - 34 : dr.baseY;
          dr.group.position.y = THREE.MathUtils.damp(dr.group.position.y, targetY, 14, dt);
          const mat = dr.bitMesh.material as THREE.MeshStandardMaterial;
          if (isSelected) {
            mat.color.setHex(0x22d3ee);
            mat.emissive.setHex(0x06b6d4);
            mat.emissiveIntensity = 0.7;
            if (spinActive) dr.group.rotation.y += spinRate;
          } else {
            mat.color.setHex(0x94a3b8);
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
          }
        });

        // Pneumatic extension & spin on the 6 Side Drills
        hDrillRefs.forEach((hd, idx) => {
          const isSelected = tool.mode === 'h_drill' && tool.index === idx + 1;
          const ext = isSelected ? 22 : 0;
          const tx = hd.basePos.x + hd.dir.x * ext;
          const ty = hd.basePos.y + hd.dir.y * ext;
          const tz = hd.basePos.z + hd.dir.z * ext;
          hd.group.position.x = THREE.MathUtils.damp(hd.group.position.x, tx, 14, dt);
          hd.group.position.y = THREE.MathUtils.damp(hd.group.position.y, ty, 14, dt);
          hd.group.position.z = THREE.MathUtils.damp(hd.group.position.z, tz, 14, dt);
          const mat = hd.bitMesh.material as THREE.MeshStandardMaterial;
          if (isSelected) {
            mat.color.setHex(0x22d3ee);
            mat.emissive.setHex(0x06b6d4);
            mat.emissiveIntensity = 0.7;
            if (spinActive) hd.bitMesh.rotation.y += spinRate;
          } else {
            mat.color.setHex(0x94a3b8);
            mat.emissive.setHex(0x000000);
            mat.emissiveIntensity = 0;
          }
        });

        // Circular Grooving Saw drop & spin
        const sawActive = tool.mode === 'saw';
        const sawTargetY = sawActive ? sawBaseY - 46 : sawBaseY;
        sawGroup.position.y = THREE.MathUtils.damp(sawGroup.position.y, sawTargetY, 12, dt);
        if (sawActive) {
          sawBladeMat.color.setHex(0x38bdf8);
          sawBladeMat.emissive.setHex(0x0284c7);
          sawBladeMat.emissiveIntensity = 0.45;
          if (spinActive) sawBladeMesh.rotation.z -= spinRate * 0.8;
        } else {
          sawBladeMat.color.setHex(0xe2e8f0);
          sawBladeMat.emissive.setHex(0x000000);
          sawBladeMat.emissiveIntensity = 0;
        }

        // Laser crosshair on table/stock surface
        const surfaceY = wcs.z;
        laserGroup.position.set(t.machinePos.x, surfaceY + 0.25, -t.machinePos.y);
        const heightAboveSurface = Math.max(0.2, t.machinePos.z - surfaceY);
        dropLine.scale.y = heightAboveSurface;
        dropLine.visible = t.machinePos.z > surfaceY + 0.2;

        // Layer visibility
        plannedGroup.visible = layers.showPlanned;
        if (plannedRapidLines) plannedRapidLines.visible = layers.showRapids;
        liveCutMesh.visible = layers.showLiveTrace;
        liveRapidMesh.visible = layers.showLiveTrace && layers.showRapids;
        stockGroup.visible = layers.showStock;
        wcsTriad.position.set(wcs.x, wcs.z, -wcs.y);

        // Camera follow or preset damping
        if (layers.followTool && !camTransitionActive) {
          const targetX = t.machinePos.x;
          const targetY = t.machinePos.z;
          const targetZ = -t.machinePos.y;
          const dx = THREE.MathUtils.damp(controls.target.x, targetX, 6, dt) - controls.target.x;
          const dy = THREE.MathUtils.damp(controls.target.y, targetY, 6, dt) - controls.target.y;
          const dz = THREE.MathUtils.damp(controls.target.z, targetZ, 6, dt) - controls.target.z;
          controls.target.x += dx;
          controls.target.y += dy;
          controls.target.z += dz;
          camera.position.x += dx;
          camera.position.y += dy;
          camera.position.z += dz;
        } else if (camTransitionActive) {
          camera.position.x = THREE.MathUtils.damp(camera.position.x, _desiredCamPos.x, 7, dt);
          camera.position.y = THREE.MathUtils.damp(camera.position.y, _desiredCamPos.y, 7, dt);
          camera.position.z = THREE.MathUtils.damp(camera.position.z, _desiredCamPos.z, 7, dt);
          controls.target.x = THREE.MathUtils.damp(controls.target.x, _desiredTarget.x, 7, dt);
          controls.target.y = THREE.MathUtils.damp(controls.target.y, _desiredTarget.y, 7, dt);
          controls.target.z = THREE.MathUtils.damp(controls.target.z, _desiredTarget.z, 7, dt);
          if (
            camera.position.distanceTo(_desiredCamPos) < 1.5 &&
            controls.target.distanceTo(_desiredTarget) < 1.5
          ) {
            camTransitionActive = false;
          }
        }

        controls.update();
        renderer.render(scene, camera);

        if (isSoftwareGl) {
          afterDraw(tick);
        } else {
          frameId = requestAnimationFrame(tick);
        }
      };

      frameId = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(frameId);
        clearTimeout(frameId);
        resizeObserver.disconnect();
        controls.removeEventListener('start', cancelCamTransition);
        controls.dispose();
        renderer.domElement.removeEventListener('pointermove', onPointerMove);
        renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
        renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
        renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
        liveCutGeo.dispose();
        liveRapidGeo.dispose();
        sawBladeGeo.dispose();
        floorGeo.dispose();
        floorMat.dispose();
        if (bedTex) bedTex.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement);
        }
      };
    }, []);

    const activeWcsOffset = telemetry.wcsOffsets[telemetry.activeWcs];
    useEffect(() => {
      sceneHandlesRef.current?.rebuildPlannedPath(parsedGCode, activeWcsOffset);
    }, [parsedGCode, activeWcsOffset.x, activeWcsOffset.y, activeWcsOffset.z]);

    useEffect(() => {
      sceneHandlesRef.current?.rebuildBedAndStock(config, activeWcsOffset);
    }, [
      config.axisBounds.min.x,
      config.axisBounds.min.y,
      config.axisBounds.min.z,
      config.axisBounds.max.x,
      config.axisBounds.max.y,
      config.axisBounds.max.z,
      config.stockEnabled,
      config.stockSize.x,
      config.stockSize.y,
      config.stockSize.z,
      activeWcsOffset.x,
      activeWcsOffset.y,
      activeWcsOffset.z,
    ]);

    return (
      <div className="relative w-full h-full min-h-[460px] bg-[#0c0f14] rounded-lg border border-slate-800/90 overflow-hidden select-none">
        <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

        {webglLost && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0c0f14]/95 text-slate-300 text-sm">
            WebGL context paused — waiting for GPU restore
          </div>
        )}

        {/* Top-Left Live Table & Head Telemetry HUD */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-1.5 z-10">
          <div className="bg-[#11151d]/90 border border-slate-700/70 rounded-md px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">{telemetry.activeWcs}</span>
              <span className="font-mono text-slate-100">
                X{telemetry.workPos.x.toFixed(1)} Y{telemetry.workPos.y.toFixed(1)} Z
                {telemetry.workPos.z.toFixed(1)}
              </span>
            </div>
            <span className="text-slate-600" aria-hidden="true">
              |
            </span>
            <span className="font-mono text-sky-300">{telemetry.activeTool.label}</span>
            <span className="text-slate-600" aria-hidden="true">
              |
            </span>
            <div className="font-mono text-emerald-400">
              {liveTraceCount.toLocaleString()} pts traced
            </div>
          </div>

          {hoverCoord && (
            <div className="bg-[#11151d]/85 border border-slate-800 rounded px-2.5 py-1 text-[11px] font-mono text-slate-400 w-fit">
              Table Cursor (Q4): X {hoverCoord.x.toFixed(1)} · Y {hoverCoord.y.toFixed(1)} mm
            </div>
          )}
        </div>

        {/* Top-Right Compact Legend */}
        <div className="pointer-events-none absolute top-3 right-3 z-10 bg-[#11151d]/88 border border-slate-800 rounded-md px-3 py-1.5 flex items-center gap-3 text-[11px] text-slate-300">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 bg-emerald-400 inline-block" />
            Live Cut
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 bg-amber-400 inline-block" />
            Rapid
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 bg-sky-400/50 inline-block" />
            Planned
          </span>
        </div>

        {/* Bottom-Center Collapsible Viewport Dock */}
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center max-w-[96%]">
          <button
            type="button"
            onClick={() => setDockCollapsed((v) => !v)}
            className="px-3 py-1 text-[11px] font-medium text-slate-300 bg-[#141923]/95 hover:bg-[#1c2331] border border-b-0 border-slate-700/80 rounded-t-md flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
          >
            {dockCollapsed ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                Viewport Controls
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                Hide Controls
              </>
            )}
          </button>

          {!dockCollapsed && (
            <div className="bg-[#141923]/95 border border-slate-700/80 rounded-lg px-2.5 py-2 flex flex-wrap items-center justify-center gap-1.5 shadow-lg">
              <div className="flex items-center gap-1 pr-2 border-r border-slate-700/70">
                {(['iso', 'top', 'front', 'side', 'fit'] as CameraPreset[]).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => sceneHandlesRef.current?.applyCameraPreset(preset)}
                    className="px-2 py-1 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors uppercase whitespace-nowrap shrink-0"
                  >
                    {preset}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setFollowTool((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  followTool
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                    : 'text-slate-300 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Focus className="w-3.5 h-3.5" />
                Follow
              </button>

              <button
                type="button"
                onClick={() => setShowLiveTrace((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  showLiveTrace
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-slate-400 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Crosshair className="w-3.5 h-3.5" />
                Live Trace
              </button>

              <button
                type="button"
                onClick={() => setShowPlanned((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  showPlanned
                    ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                    : 'text-slate-400 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Planned
              </button>

              <button
                type="button"
                onClick={() => setShowRapids((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  showRapids
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'text-slate-400 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                Rapids
              </button>

              <button
                type="button"
                onClick={() => setShowStock((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                  showStock
                    ? 'bg-slate-700/70 text-slate-200 border border-slate-600'
                    : 'text-slate-400 hover:bg-slate-800 border border-transparent'
                }`}
              >
                <Box className="w-3.5 h-3.5" />
                Panel
              </button>

              <button
                type="button"
                onClick={() => setShowGantry((v) => !v)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  showGantry
                    ? 'bg-slate-700/70 text-slate-200 border border-slate-600'
                    : 'text-slate-400 hover:bg-slate-800 border border-transparent'
                }`}
              >
                Cantilever
              </button>

              <div className="pl-1.5 border-l border-slate-700/70">
                <button
                  type="button"
                  onClick={onClearTrace}
                  className="px-2.5 py-1 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
                  title="Clear live generated toolpath"
                >
                  <Eraser className="w-3.5 h-3.5" />
                  Clear Trace
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },
);
