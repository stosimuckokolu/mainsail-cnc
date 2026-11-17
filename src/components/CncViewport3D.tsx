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

// Reusable math objects outside render loop (zero GC)
const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hitPoint = new THREE.Vector3();
const _desiredCamPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();

function cncToWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

function createSpoilboardTexture(bedX: number, bedY: number): THREE.CanvasTexture {
  const pxPerMm = 4;
  const w = Math.min(2048, Math.max(512, Math.round(bedX * pxPerMm)));
  const h = Math.min(2048, Math.max(512, Math.round(bedY * pxPerMm)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  // Dark anodized slate MDF/aluminum spoilboard base
  ctx.fillStyle = '#151922';
  ctx.fillRect(0, 0, w, h);

  const sx = w / bedX;
  const sy = h / bedY;

  // T-slot horizontal grooves every 50mm
  ctx.fillStyle = '#0f1219';
  for (let y = 25; y < bedY; y += 50) {
    const py = h - y * sy;
    ctx.fillRect(0, py - 2.5, w, 5);
    ctx.fillStyle = '#252c3b';
    ctx.fillRect(0, py - 3, w, 1);
    ctx.fillStyle = '#0f1219';
  }

  // Minor 10mm grid
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= bedX; x += 10) {
    const px = x * sx;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = 0; y <= bedY; y += 10) {
    const py = h - y * sy;
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // Major 50mm grid
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let x = 0; x <= bedX; x += 50) {
    const px = x * sx;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  for (let y = 0; y <= bedY; y += 50) {
    const py = h - y * sy;
    ctx.moveTo(0, py);
    ctx.lineTo(w, py);
  }
  ctx.stroke();

  // Metric axis rulers
  ctx.font = '600 18px "JetBrains Mono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.65)';
  ctx.textBaseline = 'bottom';
  for (let x = 50; x < bedX; x += 50) {
    ctx.fillText(`${x}`, x * sx + 4, h - 6);
  }
  ctx.textBaseline = 'top';
  for (let y = 50; y < bedY; y += 50) {
    ctx.fillText(`${y}`, 8, h - y * sy + 4);
  }

  // Origin label
  ctx.fillStyle = 'rgba(56, 189, 248, 0.85)';
  ctx.fillText('MCS (0,0)', 8, h - 26);

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

    // Refs synced with latest React state/props
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

    // Scene / dynamic buffer handles
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

    // Initialize WebGL Scene once
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
      renderer.toneMappingExposure = 1.1;
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
      scene.fog = new THREE.Fog('#0c0f14', 650, 1600);

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();

      const width = container.clientWidth || 800;
      const height = container.clientHeight || 600;
      const camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 3000);
      const bed = configRef.current.bedSize;
      camera.position.set(bed.x * 0.5, bed.z * 2.2 + 80, -bed.y * 0.1 + 290);

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = !isSoftwareGl;
      controls.dampingFactor = 0.07;
      controls.minDistance = 30;
      controls.maxDistance = 1200;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.target.set(bed.x * 0.45, 10, -bed.y * 0.45);
      controls.update();

      // 3-point studio lighting
      const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 0.75);
      scene.add(hemi);

      const keyLight = new THREE.DirectionalLight(0xfff7ed, 1.45);
      keyLight.position.set(bed.x * 0.7, 320, 220);
      keyLight.castShadow = !isSoftwareGl;
      if (keyLight.castShadow) {
        keyLight.shadow.mapSize.set(1024, 1024);
        keyLight.shadow.camera.left = -300;
        keyLight.shadow.camera.right = 300;
        keyLight.shadow.camera.top = 300;
        keyLight.shadow.camera.bottom = -300;
        keyLight.shadow.bias = -0.0005;
        keyLight.shadow.normalBias = 0.02;
      }
      scene.add(keyLight);

      const rimLight = new THREE.DirectionalLight(0x38bdf8, 0.65);
      rimLight.position.set(-180, 160, -280);
      scene.add(rimLight);

      // Floor plane underneath machine
      const floorGeo = new THREE.PlaneGeometry(3000, 3000);
      const floorMat = new THREE.MeshStandardMaterial({
        color: 0x0b0e13,
        roughness: 0.92,
        metalness: 0.05,
      });
      const floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.rotation.x = -Math.PI / 2;
      floorMesh.position.y = -24;
      scene.add(floorMesh);

      // Bed & Frame Group
      const bedGroup = new THREE.Group();
      scene.add(bedGroup);
      let bedTex: THREE.CanvasTexture | null = null;

      // Stock Workpiece Group
      const stockGroup = new THREE.Group();
      scene.add(stockGroup);

      // WCS Origin Triad
      const wcsTriad = new THREE.Group();
      const triadLen = 28;
      const xAxisGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(triadLen, 0, 0),
      ]);
      const yAxisGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -triadLen),
      ]);
      const zAxisGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, triadLen, 0),
      ]);
      wcsTriad.add(new THREE.Line(xAxisGeo, new THREE.LineBasicMaterial({ color: 0xef4444 })));
      wcsTriad.add(new THREE.Line(yAxisGeo, new THREE.LineBasicMaterial({ color: 0x22c55e })));
      wcsTriad.add(new THREE.Line(zAxisGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8 })));
      const originRing = new THREE.Mesh(
        new THREE.RingGeometry(2.2, 3.4, 24),
        new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide }),
      );
      originRing.rotation.x = -Math.PI / 2;
      originRing.position.y = 0.08;
      wcsTriad.add(originRing);
      scene.add(wcsTriad);

      // Gantry Rail & X-Carriage Group (tracks toolhead X & Y)
      const gantryGroup = new THREE.Group();
      const gantryBeamMat = new THREE.MeshStandardMaterial({
        color: 0x1e2430,
        metalness: 0.72,
        roughness: 0.35,
        transparent: true,
        opacity: 0.52,
      });
      const gantryBeam = new THREE.Mesh(
        new THREE.BoxGeometry(bed.x + 36, 16, 18),
        gantryBeamMat,
      );
      gantryBeam.position.set(bed.x / 2, bed.z + 24, 0);
      gantryGroup.add(gantryBeam);

      const xCarriage = new THREE.Mesh(
        new THREE.BoxGeometry(28, 24, 24),
        new THREE.MeshStandardMaterial({
          color: 0x2b3444,
          metalness: 0.8,
          roughness: 0.28,
        }),
      );
      xCarriage.position.set(0, bed.z + 24, 0);
      gantryGroup.add(xCarriage);
      scene.add(gantryGroup);

      // Composite 7-Part CNC Spindle & Endmill Assembly (THREE.Group)
      const spindleGroup = new THREE.Group();
      const darkAnodizedMat = new THREE.MeshStandardMaterial({
        color: 0x1e2530,
        metalness: 0.65,
        roughness: 0.45,
      });
      const brushedAluMat = new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        metalness: 0.88,
        roughness: 0.22,
      });
      const blackOxideMat = new THREE.MeshStandardMaterial({
        color: 0x111827,
        metalness: 0.82,
        roughness: 0.3,
      });
      const carbideMat = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        metalness: 0.94,
        roughness: 0.14,
      });
      const activeTipMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.5,
        roughness: 0.2,
        metalness: 0.6,
      });

      // Part 1: Z-axis mount plate
      const zPlate = new THREE.Mesh(new THREE.BoxGeometry(22, 54, 8), darkAnodizedMat);
      zPlate.position.set(0, 48, -14);
      zPlate.castShadow = !isSoftwareGl;
      spindleGroup.add(zPlate);

      // Part 2: Spindle clamp collar
      const clampCollar = new THREE.Mesh(
        new THREE.CylinderGeometry(14, 14, 14, 24),
        darkAnodizedMat,
      );
      clampCollar.position.set(0, 44, 0);
      spindleGroup.add(clampCollar);

      // Part 3: Brushed aluminum spindle body
      const spindleBody = new THREE.Mesh(
        new THREE.CylinderGeometry(12, 12, 46, 28),
        brushedAluMat,
      );
      spindleBody.position.set(0, 48, 0);
      spindleBody.castShadow = !isSoftwareGl;
      spindleGroup.add(spindleBody);

      // Part 4: Top cooling fan cap
      const topCap = new THREE.Mesh(
        new THREE.CylinderGeometry(12.8, 12.8, 7, 24),
        blackOxideMat,
      );
      topCap.position.set(0, 74, 0);
      spindleGroup.add(topCap);

      // Spinning Rotor Sub-group (Part 5: ER20 Collet Nut, Part 6: Shank, Part 7: Fluted Bit)
      const rotorGroup = new THREE.Group();
      const colletNut = new THREE.Mesh(
        new THREE.CylinderGeometry(7.2, 6.2, 10, 6),
        blackOxideMat,
      );
      colletNut.position.set(0, 21, 0);
      rotorGroup.add(colletNut);

      const endmillShank = new THREE.Mesh(
        new THREE.CylinderGeometry(2.2, 2.2, 12, 16),
        carbideMat,
      );
      endmillShank.position.set(0, 11, 0);
      rotorGroup.add(endmillShank);

      const endmillFlutes = new THREE.Mesh(
        new THREE.CylinderGeometry(1.6, 1.5, 6, 12),
        activeTipMat,
      );
      endmillFlutes.position.set(0, 3, 0);
      rotorGroup.add(endmillFlutes);

      spindleGroup.add(rotorGroup);
      scene.add(spindleGroup);

      // Projected Laser Crosshair Ring on Table / Stock
      const laserGroup = new THREE.Group();
      const laserRing = new THREE.Mesh(
        new THREE.RingGeometry(2.8, 3.6, 28),
        new THREE.MeshBasicMaterial({
          color: 0x22d3ee,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.75,
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
          opacity: 0.35,
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
        opacity: 0.32,
      });
      const plannedRapidMat = new THREE.LineBasicMaterial({
        color: 0xf59e0b,
        transparent: true,
        opacity: 0.16,
      });
      let plannedCutLines: THREE.LineSegments | null = null;
      let plannedRapidLines: THREE.LineSegments | null = null;

      // Live Generated Toolpath Buffers (Zero-GC pre-allocated)
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
          opacity: 0.62,
        }),
      );
      liveRapidMesh.frustumCulled = false;
      liveRapidMesh.renderOrder = 2;
      scene.add(liveRapidMesh);

      let cutSegCount = 0;
      let rapidSegCount = 0;

      const rebuildBedAndStock = (cfg: MachineConfig, wcsOffset: Vec3) => {
        // Clear old bed children
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

        const bx = cfg.bedSize.x;
        const by = cfg.bedSize.y;
        const bz = cfg.bedSize.z;

        bedTex = createSpoilboardTexture(bx, by);
        bedTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

        const bedPlate = new THREE.Mesh(
          new THREE.BoxGeometry(bx, 12, by),
          [
            new THREE.MeshStandardMaterial({ color: 0x1c222d, roughness: 0.5, metalness: 0.6 }),
            new THREE.MeshStandardMaterial({ color: 0x1c222d, roughness: 0.5, metalness: 0.6 }),
            new THREE.MeshStandardMaterial({
              map: bedTex,
              roughness: 0.72,
              metalness: 0.18,
            }),
            new THREE.MeshStandardMaterial({ color: 0x101319, roughness: 0.8 }),
            new THREE.MeshStandardMaterial({ color: 0x1c222d, roughness: 0.5, metalness: 0.6 }),
            new THREE.MeshStandardMaterial({ color: 0x1c222d, roughness: 0.5, metalness: 0.6 }),
          ],
        );
        bedPlate.position.set(bx / 2, -6.05, -by / 2);
        bedPlate.receiveShadow = !isSoftwareGl;
        bedGroup.add(bedPlate);

        // Machine envelope wireframe
        const envGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(bx, bz, by));
        const envWire = new THREE.LineSegments(
          envGeo,
          new THREE.LineBasicMaterial({
            color: 0x334155,
            transparent: true,
            opacity: 0.45,
          }),
        );
        envWire.position.set(bx / 2, bz / 2, -by / 2);
        bedGroup.add(envWire);

        // Update gantry beam width
        gantryBeam.geometry.dispose();
        gantryBeam.geometry = new THREE.BoxGeometry(bx + 36, 16, 18);
        gantryBeam.position.y = bz + 24;

        // Rebuild Stock Block
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
              color: 0x64748b,
              metalness: 0.65,
              roughness: 0.38,
              transparent: true,
              opacity: 0.24,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          stockMesh.position.set(wcsOffset.x + sx / 2, sz / 2, -(wcsOffset.y + sy / 2));
          stockGroup.add(stockMesh);

          const stockEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sz, sy)),
            new THREE.LineBasicMaterial({
              color: 0x94a3b8,
              transparent: true,
              opacity: 0.45,
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

          // Z-depth shading: plunge = bright coral-amber, deeper cuts = vivid emerald-cyan
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
            const depthT = Math.min(1, Math.abs(relZ) / 6);
            r = 0.05 + depthT * 0.08;
            g = 0.86 - depthT * 0.14;
            b = 0.66 + depthT * 0.32; // shifts emerald -> vivid cyan on deeper passes
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

      // Smooth damped camera transitions
      let camTransitionActive = false;
      const cancelCamTransition = () => {
        camTransitionActive = false;
      };
      controls.addEventListener('start', cancelCamTransition);

      const applyCameraPreset = (preset: CameraPreset) => {
        const cfg = configRef.current;
        const t = telemetryRef.current;
        const wcs = t.wcsOffsets[t.activeWcs];
        const cx = cfg.stockEnabled ? wcs.x + cfg.stockSize.x * 0.5 : cfg.bedSize.x * 0.5;
        const cy = cfg.stockEnabled ? wcs.y + cfg.stockSize.y * 0.5 : cfg.bedSize.y * 0.5;
        const cz = wcs.z * 0.5;

        _desiredTarget.set(cx, cz, -cy);
        if (preset === 'iso') {
          _desiredCamPos.set(cx + 120, cz + 170, -cy + 210);
        } else if (preset === 'top') {
          _desiredCamPos.set(cx, cz + 290, -cy + 0.5);
        } else if (preset === 'front') {
          _desiredCamPos.set(cx, cz + 55, -cy + 270);
        } else if (preset === 'side') {
          _desiredCamPos.set(cx + 270, cz + 65, -cy);
        } else {
          // fit bed
          const bx = cfg.bedSize.x * 0.5;
          const by = cfg.bedSize.y * 0.5;
          _desiredTarget.set(bx, 10, -by);
          _desiredCamPos.set(bx, 240, -by + 330);
        }
        camTransitionActive = true;
      };

      // Initial build
      const initWcs = telemetryRef.current.wcsOffsets[telemetryRef.current.activeWcs];
      rebuildBedAndStock(configRef.current, initWcs);
      sceneHandlesRef.current = {
        appendLiveSegment,
        clearLiveTrace,
        applyCameraPreset,
        rebuildPlannedPath,
        rebuildBedAndStock,
      };

      // Throttled pointer raycast for live table XY coordinates
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
          const wx = _hitPoint.x - wcs.x;
          const wy = -_hitPoint.z - wcs.y;
          if (
            _hitPoint.x >= -10 &&
            _hitPoint.x <= configRef.current.bedSize.x + 10 &&
            -_hitPoint.z >= -10 &&
            -_hitPoint.z <= configRef.current.bedSize.y + 10
          ) {
            setHoverCoord({ x: wx, y: wy });
          } else {
            setHoverCoord(null);
          }
        }
      };
      const onPointerLeave = () => setHoverCoord(null);
      renderer.domElement.addEventListener('pointermove', onPointerMove);
      renderer.domElement.addEventListener('pointerleave', onPointerLeave);

      // Resize observer
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

        // Update spindle & gantry positions
        cncToWorld(t.machinePos.x, t.machinePos.y, t.machinePos.z, spindleGroup.position);
        gantryBeam.position.z = -t.machinePos.y - 18;
        xCarriage.position.set(t.machinePos.x, configRef.current.bedSize.z + 24, -t.machinePos.y - 18);
        gantryGroup.visible = layers.showGantry;

        // Spin endmill when spindle RPM > 0
        if (t.spindleRpm > 0) {
          rotorGroup.rotation.y += dt * Math.min(45, (t.spindleRpm / 1000) * 3.2);
          activeTipMat.emissiveIntensity = t.workPos.z <= 0.2 ? 1.4 : 0.45;
        } else {
          activeTipMat.emissiveIntensity = 0.08;
        }

        // Laser crosshair on table/stock surface
        const surfaceY = wcs.z;
        laserGroup.position.set(t.machinePos.x, surfaceY + 0.08, -t.machinePos.y);
        const heightAboveSurface = Math.max(0.2, t.machinePos.z - surfaceY);
        dropLine.scale.y = heightAboveSurface;
        dropLine.visible = t.machinePos.z > surfaceY + 0.1;

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
            camera.position.distanceTo(_desiredCamPos) < 0.4 &&
            controls.target.distanceTo(_desiredTarget) < 0.4
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
        floorGeo.dispose();
        floorMat.dispose();
        if (bedTex) bedTex.dispose();
        renderer.dispose();
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement);
        }
      };
    }, []);

    // Rebuild planned toolpath when G-code or active WCS changes
    const activeWcsOffset = telemetry.wcsOffsets[telemetry.activeWcs];
    useEffect(() => {
      sceneHandlesRef.current?.rebuildPlannedPath(parsedGCode, activeWcsOffset);
    }, [parsedGCode, activeWcsOffset.x, activeWcsOffset.y, activeWcsOffset.z]);

    // Rebuild bed / stock when machine config or WCS changes
    useEffect(() => {
      sceneHandlesRef.current?.rebuildBedAndStock(config, activeWcsOffset);
    }, [
      config.bedSize.x,
      config.bedSize.y,
      config.bedSize.z,
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
        {/* Isolated WebGL mount container */}
        <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

        {webglLost && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0c0f14]/95 text-slate-300 text-sm">
            WebGL context paused — waiting for GPU restore
          </div>
        )}

        {/* Top-Left Live Table Telemetry HUD (no backdrop-blur over WebGL) */}
        <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-1.5 z-10">
          <div className="bg-[#11151d]/90 border border-slate-700/70 rounded-md px-3 py-2 flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 font-medium">{telemetry.activeWcs}</span>
              <span className="font-mono text-slate-100">
                X{telemetry.workPos.x.toFixed(2)} Y{telemetry.workPos.y.toFixed(2)} Z
                {telemetry.workPos.z.toFixed(2)}
              </span>
            </div>
            <span className="text-slate-600" aria-hidden="true">
              |
            </span>
            <div className="font-mono text-emerald-400">
              {liveTraceCount.toLocaleString()} pts traced
            </div>
          </div>

          {hoverCoord && (
            <div className="bg-[#11151d]/85 border border-slate-800 rounded px-2.5 py-1 text-[11px] font-mono text-slate-400 w-fit">
              Table Cursor: X {hoverCoord.x.toFixed(1)} · Y {hoverCoord.y.toFixed(1)} mm
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

        {/* Bottom-Center Collapsible Viewport Dock (per Three.js ergonomic UI rules) */}
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
              {/* Camera Presets */}
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

              {/* Follow Tool & Layer Toggles */}
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
                Stock
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
                Gantry
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
