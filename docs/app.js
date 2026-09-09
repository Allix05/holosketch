import * as THREE from "three";
import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { isPinching, isPinkyUp, penPoint, palmCenter, handLength, wristTwistAngle, Debouncer } from "./hand.js";
import { preparePathForExtrusion } from "./path.js";

const COLORS = ["#4df3ff", "#ff8a3d", "#4dffa0", "#ff4dc4", "#ffffff"];
const MIN_STROKE_POINTS = 8;
const DEPTH_BASE = 3.0;
const SCALE_MIN = 0.4;
const SCALE_MAX = 2.4;
const MATERIALIZE_MS = 500;

const video = document.getElementById("video");
const stage = document.querySelector(".stage");
const drawCanvas = document.getElementById("drawCanvas");
const drawCtx = drawCanvas.getContext("2d");
const glCanvas = document.getElementById("glCanvas");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");
const startOverlay = document.getElementById("startOverlay");
const startBtn = document.getElementById("startBtn");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingText = document.getElementById("loadingText");
const errorBanner = document.getElementById("errorBanner");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const colorSwatchesEl = document.getElementById("colorSwatches");
const clearBtn = document.getElementById("clearBtn");

let currentColor = COLORS[0];
COLORS.forEach((color, i) => {
  const btn = document.createElement("button");
  btn.className = "swatch" + (i === 0 ? " active" : "");
  btn.style.setProperty("--sw-color", color);
  btn.addEventListener("click", () => {
    currentColor = color;
    [...colorSwatchesEl.children].forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    if (holoGroup) applyColorToHolo(holoGroup, currentColor);
  });
  colorSwatchesEl.appendChild(btn);
});

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.remove("hidden");
}

function setStatus(text, dotClass) {
  statusText.textContent = text;
  statusDot.className = "status-dot" + (dotClass ? " " + dotClass : "");
}

// ---- Three.js scene -------------------------------------------------

let renderer, scene, camera3d, holoGroup = null;
let referenceHandLength = null;

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  camera3d = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(2, 3, 4);
  scene.add(dir);
}

function resizeAll() {
  const rect = video.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  for (const c of [drawCanvas, overlay]) {
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  }
  if (renderer && (glCanvas.width !== Math.round(w * renderer.getPixelRatio()) || glCanvas.height !== Math.round(h * renderer.getPixelRatio()))) {
    renderer.setSize(w, h, false);
    camera3d.aspect = w / (h || 1);
    camera3d.updateProjectionMatrix();
  }
}

// Maps normalized (0..1) screen coordinates to a world position at the
// given depth (distance in front of the camera), so a hologram "stuck" to
// a screen position via this function visually tracks the hand.
function screenToWorld(nx, ny, depth) {
  const vFov = (camera3d.fov * Math.PI) / 180;
  const visibleHeight = 2 * Math.tan(vFov / 2) * depth;
  const visibleWidth = visibleHeight * camera3d.aspect;
  return {
    x: (nx - 0.5) * visibleWidth,
    y: -(ny - 0.5) * visibleHeight,
    z: -depth,
  };
}

function applyColorToHolo(group, hex) {
  const color = new THREE.Color(hex);
  group.traverse((obj) => {
    if (obj.material) obj.material.color = color;
  });
}

function buildHologram(points2D, hex) {
  const shape = new THREE.Shape();
  shape.moveTo(points2D[0].x, points2D[0].y);
  for (let i = 1; i < points2D.length; i++) shape.lineTo(points2D[i].x, points2D[i].y);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.35,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 2,
  });
  geometry.center();

  const color = new THREE.Color(hex);
  const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
  const fillMesh = new THREE.Mesh(geometry, fillMat);
  fillMesh.userData.baseOpacity = 0.22;

  const edgesGeo = new THREE.EdgesGeometry(geometry, 12);
  const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
  const wireframe = new THREE.LineSegments(edgesGeo, edgeMat);
  wireframe.userData.baseOpacity = 0.95;

  const group = new THREE.Group();
  group.add(fillMesh);
  group.add(wireframe);

  const world = screenToWorld(0.5, 0.5, DEPTH_BASE);
  group.position.set(world.x, world.y, world.z);

  if (holoGroup) scene.remove(holoGroup);
  holoGroup = group;
  scene.add(holoGroup);
}

// ---- 2D drawing / camera loop ----------------------------------------

let handLandmarker = null;
let running = false;
let mode = "draw"; // "draw" | "holo"
let strokePoints = [];
let lastDrawPx = null;
const pinchDebouncer = new Debouncer(3, false);
const pinkyDebouncer = new Debouncer(4, false);
let pinkyWasUp = false;
let materializeStart = null;
let materializeOriginPx = null;
let materializeColor = currentColor;

function clearDrawCanvas() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

function drawCursor(px, py, pinching) {
  overlayCtx.beginPath();
  overlayCtx.arc(px, py, pinching ? 9 : 6, 0, Math.PI * 2);
  overlayCtx.fillStyle = pinching ? currentColor : "rgba(217, 247, 255, 0.5)";
  overlayCtx.fill();
  overlayCtx.lineWidth = 1.5;
  overlayCtx.strokeStyle = "rgba(255,255,255,0.6)";
  overlayCtx.stroke();
}

function extrude(landmarks) {
  const shape2D = preparePathForExtrusion(strokePoints, { simplifyTolerance: 0.008, targetSize: 1.3 });
  if (!shape2D) return;
  referenceHandLength = handLength(landmarks);
  buildHologram(shape2D, currentColor);
  mode = "holo";
  clearDrawCanvas();
  setStatus("Resting in your open hand", "holding");

  const p = penPoint(landmarks);
  materializeStart = performance.now();
  materializeOriginPx = { x: p.x * overlay.width, y: p.y * overlay.height };
  materializeColor = currentColor;
}

// A quick materialization pulse -- an expanding, fading ring plus a bright
// core flash at the hand -- drawn while the hologram itself fades/scales
// in from nothing (see the "holo" branch in loop()), so it feels like it
// snaps into existence rather than just appearing. Returns the 0..1
// progress (or null if no pulse is active) so the caller can drive the
// matching fade-in on the hologram itself from the same timeline.
function drawMaterializeFlash(nowMs) {
  if (materializeStart === null) return null;
  const t = Math.min(1, (nowMs - materializeStart) / MATERIALIZE_MS);
  const ringEase = 1 - Math.pow(1 - t, 2);
  const maxRadius = Math.max(overlay.width, overlay.height) * 0.22;

  overlayCtx.save();
  overlayCtx.globalCompositeOperation = "lighter";

  overlayCtx.beginPath();
  overlayCtx.arc(materializeOriginPx.x, materializeOriginPx.y, 6 + ringEase * maxRadius, 0, Math.PI * 2);
  overlayCtx.strokeStyle = materializeColor;
  overlayCtx.lineWidth = 2 + (1 - t) * 5;
  overlayCtx.globalAlpha = (1 - t) * 0.9;
  overlayCtx.shadowColor = materializeColor;
  overlayCtx.shadowBlur = 20;
  overlayCtx.stroke();

  overlayCtx.beginPath();
  overlayCtx.arc(materializeOriginPx.x, materializeOriginPx.y, 16 * (1 - t), 0, Math.PI * 2);
  overlayCtx.fillStyle = "#ffffff";
  overlayCtx.globalAlpha = (1 - t) * 0.85;
  overlayCtx.fill();

  overlayCtx.restore();

  if (t >= 1) materializeStart = null;
  return t;
}

async function init() {
  try {
    startOverlay.classList.add("hidden");
    loadingOverlay.classList.remove("hidden");

    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();

    initThree();
    resizeAll();

    loadingText.textContent = "Loading hand-tracking model...";
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
    });

    loadingOverlay.classList.add("hidden");
    setStatus("Show your hand to begin sketching", "ready");
    running = true;
    requestAnimationFrame(loop);
  } catch (err) {
    loadingOverlay.classList.add("hidden");
    showError("Couldn't start: " + err.message);
  }
}

function loop() {
  if (!running) return;
  resizeAll();
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const nowMs = performance.now();
  const materializeT = drawMaterializeFlash(nowMs);
  const result = handLandmarker.detectForVideo(video, nowMs);
  const landmarks = (result.landmarks || [])[0];

  if (landmarks) {
    const pinching = pinchDebouncer.update(isPinching(landmarks));
    const p = penPoint(landmarks);
    const px = p.x * drawCanvas.width;
    const py = p.y * drawCanvas.height;

    if (mode === "draw") {
      if (pinching) {
        strokePoints.push({ x: p.x, y: p.y });
        drawCtx.strokeStyle = currentColor;
        drawCtx.fillStyle = currentColor;
        drawCtx.lineWidth = Math.max(3, drawCanvas.width * 0.006);
        drawCtx.lineCap = "round";
        drawCtx.lineJoin = "round";
        drawCtx.shadowColor = currentColor;
        drawCtx.shadowBlur = 10;
        if (lastDrawPx) {
          drawCtx.beginPath();
          drawCtx.moveTo(lastDrawPx.x, lastDrawPx.y);
          drawCtx.lineTo(px, py);
          drawCtx.stroke();
        } else {
          drawCtx.beginPath();
          drawCtx.arc(px, py, drawCtx.lineWidth / 2, 0, Math.PI * 2);
          drawCtx.fill();
        }
        drawCtx.shadowBlur = 0;
        lastDrawPx = { x: px, y: py };
        setStatus("Sketching...", "drawing");
      } else {
        lastDrawPx = null;
        setStatus(
          strokePoints.length >= MIN_STROKE_POINTS ? "Raise your pinky to make it 3D" : "Pinch thumb + index to sketch",
          "ready"
        );
      }

      const pinkyUp = pinkyDebouncer.update(isPinkyUp(landmarks));
      if (pinkyUp && !pinkyWasUp && strokePoints.length >= MIN_STROKE_POINTS) {
        extrude(landmarks);
      }
      pinkyWasUp = pinkyUp;
    } else if (mode === "holo" && holoGroup) {
      // The hologram continuously rests in your open hand: position, spin,
      // and apparent size all track the hand live, every frame -- no
      // separate "grab" gesture and no scripted idle animation. Twisting
      // the wrist spins it around the vertical axis (a real 3D turn that
      // reveals its extruded depth), while its position and size follow
      // the palm's screen position and distance from the camera.
      const palmC = palmCenter(landmarks);
      const world = screenToWorld(palmC.x, palmC.y, DEPTH_BASE);
      holoGroup.position.set(world.x, world.y, world.z);
      holoGroup.rotation.y = -wristTwistAngle(landmarks);
      const rawScale = handLength(landmarks) / referenceHandLength;
      let scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, rawScale));
      if (materializeT !== null) {
        const eased = materializeT * materializeT * (3 - 2 * materializeT); // smoothstep
        scale *= eased;
        holoGroup.traverse((obj) => {
          if (obj.material) obj.material.opacity = obj.userData.baseOpacity * eased;
        });
      }
      holoGroup.scale.setScalar(scale);
      setStatus("Resting in your open hand", "holding");
    }

    drawCursor(px, py, pinching);
  } else {
    lastDrawPx = null;
    pinkyWasUp = false;
    setStatus(mode === "holo" ? "Show your hand to see the hologram" : "Show your hand to the camera", "ready");
  }

  if (renderer) renderer.render(scene, camera3d);
  requestAnimationFrame(loop);
}

clearBtn.addEventListener("click", () => {
  clearDrawCanvas();
  strokePoints = [];
  lastDrawPx = null;
  pinkyWasUp = false;
  referenceHandLength = null;
  materializeStart = null;
  if (holoGroup) {
    scene.remove(holoGroup);
    holoGroup = null;
  }
  mode = "draw";
  setStatus("Pinch thumb + index to sketch", "ready");
});

startBtn.addEventListener("click", init);
