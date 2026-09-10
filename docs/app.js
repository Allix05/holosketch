import * as THREE from "three";
import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

import { isPinching, isPinkyUp, isThumbUp, penPoint, holdPoint, gripWidth, wristTwistAngle, Debouncer } from "./hand.js";
import { preparePathForExtrusion } from "./path.js";

const COLORS = ["#4df3ff", "#ff8a3d", "#4dffa0", "#ff4dc4", "#ffffff"];
const MIN_STROKE_POINTS = 8;
const DEPTH_BASE = 3.0;
const TARGET_SIZE = 0.5; // world-unit size the drawn shape is normalized to at scale 1
const GRIP_FIT = 0.25; // fraction of the live finger gap the object's size should fill, leaving a small margin
const SCALE_MIN = 0.15;
const SCALE_MAX = 4;
const MATERIALIZE_MS = 500;
// Per-frame blend factors (0..1) toward the freshly tracked target each
// frame -- lower means smoother/laggier, higher means snappier/jitterier.
// Raw per-frame hand-landmark estimates are noisy enough that tracking
// them directly makes a held object look shaky; smoothing this way is
// what makes it read as a solid object rather than a nervous overlay.
// Biased toward snappier than smoother, since a hologram that visibly
// lags behind a moving hand reads as broken/detached, not solid.
const POSITION_SMOOTH = 0.45;
const ROTATION_SMOOTH = 0.3;
const SCALE_SMOOTH = 0.32;

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
let smoothedScale = 1;

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

// The width/height (world units) visible at a given depth in front of the
// camera -- shared by screenToWorld (position) and the grip-to-world-size
// conversion (scale), so both agree on the same projection.
function visibleSizeAtDepth(depth) {
  const vFov = (camera3d.fov * Math.PI) / 180;
  const visibleHeight = 2 * Math.tan(vFov / 2) * depth;
  return { width: visibleHeight * camera3d.aspect, height: visibleHeight };
}

// Maps normalized (0..1) screen coordinates to a world position at the
// given depth (distance in front of the camera), so a hologram "stuck" to
// a screen position via this function visually tracks the hand.
function screenToWorld(nx, ny, depth) {
  const { width, height } = visibleSizeAtDepth(depth);
  return {
    x: (nx - 0.5) * width,
    y: -(ny - 0.5) * height,
    z: -depth,
  };
}

// Hand-tracking coordinates are normalized to the FULL raw camera frame,
// but the video element (and every canvas layered on it) is cropped to
// its box via object-fit:cover whenever the camera's actual aspect ratio
// doesn't match the display box's aspect ratio (640x480 was requested,
// but many webcams ignore that and negotiate 16:9 or something else
// entirely). Without correcting for that crop, anything off-center gets
// progressively more wrong toward the edges of the frame. This remaps
// every landmark from raw-frame-normalized into visible-frame-normalized
// coordinates, so everything downstream -- drawing, gestures, position,
// size -- works in the same space the pixels are actually shown in.
function remapToVisibleFrame(landmarks) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return landmarks;
  const videoAspect = vw / vh;
  const rect = video.getBoundingClientRect();
  const boxAspect = rect.width / (rect.height || 1);
  if (!boxAspect || Math.abs(videoAspect - boxAspect) < 1e-3) return landmarks;

  let scaleX = 1, offsetX = 0, scaleY = 1, offsetY = 0;
  if (videoAspect > boxAspect) {
    // Video is relatively wider than the box -- sides get cropped.
    scaleX = boxAspect / videoAspect;
    offsetX = (1 - scaleX) / 2;
  } else {
    // Video is relatively taller than the box -- top/bottom get cropped.
    scaleY = videoAspect / boxAspect;
    offsetY = (1 - scaleY) / 2;
  }
  return landmarks.map((lm) => ({
    x: (lm.x - offsetX) / scaleX,
    y: (lm.y - offsetY) / scaleY,
    z: lm.z,
  }));
}

function applyColorToHolo(group, hex) {
  const color = new THREE.Color(hex);
  group.traverse((obj) => {
    if (obj.material) obj.material.color = color;
  });
}

// Interpolates an angle (radians) toward a target by the shortest path,
// so smoothing never spins the long way around when the tracked angle
// crosses the +-PI wraparound.
function lerpAngle(from, to, t) {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * t;
}

function buildHologram(points2D, hex, startWorld) {
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

  group.position.set(startWorld.x, startWorld.y, startWorld.z);

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
const shakaDebouncer = new Debouncer(4, false);
let shakaWasUp = false;
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
  const shape2D = preparePathForExtrusion(strokePoints, { simplifyTolerance: 0.008, targetSize: TARGET_SIZE });
  if (!shape2D) return;
  smoothedScale = 1;

  const hp = holdPoint(landmarks);
  const startWorld = screenToWorld(hp.x, hp.y, DEPTH_BASE);
  buildHologram(shape2D, currentColor, startWorld);
  holoGroup.rotation.y = -wristTwistAngle(landmarks);

  mode = "holo";
  clearDrawCanvas();
  setStatus("Floating between your fingers", "holding");

  materializeStart = performance.now();
  materializeOriginPx = { x: hp.x * overlay.width, y: hp.y * overlay.height };
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
  const rawLandmarks = (result.landmarks || [])[0];
  const landmarks = rawLandmarks && remapToVisibleFrame(rawLandmarks);

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
          strokePoints.length >= MIN_STROKE_POINTS ? "Raise thumb + pinky (🤙) to make it 3D" : "Pinch thumb + index to sketch",
          "ready"
        );
      }

      // Lower than the defaults (140/150deg) so the gesture fires without
      // needing a perfectly ruler-straight thumb/pinky.
      const shakaUp = shakaDebouncer.update(isThumbUp(landmarks, 120) && isPinkyUp(landmarks, 130));
      if (shakaUp && !shakaWasUp && strokePoints.length >= MIN_STROKE_POINTS) {
        extrude(landmarks);
      }
      shakaWasUp = shakaUp;

      // Only shown while sketching -- once the hologram exists it's its
      // own indicator of where your hand is, so the tracking dot goes away.
      drawCursor(px, py, pinching);
    } else if (mode === "holo" && holoGroup) {
      // The hologram continuously rests between your thumb and middle
      // finger -- a natural "holding a small object" grip -- with its
      // position, spin, and apparent size all tracking the hand live,
      // every frame, no separate "grab" gesture and no scripted idle
      // animation. Twisting the wrist spins it around the vertical axis
      // (a real 3D turn that reveals its extruded depth), while its size
      // is set directly from the live gap between those same two fingers
      // (converted to world units at its depth) so it always fits snugly
      // between them with a small margin -- not a ratio to whatever the
      // gap happened to be when it was created, an actual live fit every
      // frame. Everything is smoothed toward its target rather than
      // snapped, so it reads as a solid object settling in your hand
      // instead of jittering with every small tracking error.
      const hp = holdPoint(landmarks);
      const targetWorld = screenToWorld(hp.x, hp.y, DEPTH_BASE);
      holoGroup.position.x += (targetWorld.x - holoGroup.position.x) * POSITION_SMOOTH;
      holoGroup.position.y += (targetWorld.y - holoGroup.position.y) * POSITION_SMOOTH;
      holoGroup.position.z += (targetWorld.z - holoGroup.position.z) * POSITION_SMOOTH;
      holoGroup.rotation.y = lerpAngle(holoGroup.rotation.y, -wristTwistAngle(landmarks), ROTATION_SMOOTH);

      const gripWorldSize = gripWidth(landmarks) * visibleSizeAtDepth(DEPTH_BASE).width;
      const targetScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, (gripWorldSize * GRIP_FIT) / TARGET_SIZE));
      smoothedScale += (targetScale - smoothedScale) * SCALE_SMOOTH;
      let scale = smoothedScale;
      if (materializeT !== null) {
        const eased = materializeT * materializeT * (3 - 2 * materializeT); // smoothstep
        scale *= eased;
        holoGroup.traverse((obj) => {
          if (obj.material) obj.material.opacity = obj.userData.baseOpacity * eased;
        });
      }
      holoGroup.scale.setScalar(scale);
      setStatus("Floating between your fingers", "holding");
    }
  } else {
    lastDrawPx = null;
    shakaWasUp = false;
    setStatus(mode === "holo" ? "Show your hand to see the hologram" : "Show your hand to the camera", "ready");
  }

  if (renderer) renderer.render(scene, camera3d);
  requestAnimationFrame(loop);
}

clearBtn.addEventListener("click", () => {
  clearDrawCanvas();
  strokePoints = [];
  lastDrawPx = null;
  shakaWasUp = false;
  smoothedScale = 1;
  materializeStart = null;
  if (holoGroup) {
    scene.remove(holoGroup);
    holoGroup = null;
  }
  mode = "draw";
  setStatus("Pinch thumb + index to sketch", "ready");
});

startBtn.addEventListener("click", init);
