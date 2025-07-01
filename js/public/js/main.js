import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = window.firebaseClientConfig;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlay");
const statusSpan = document.getElementById("status");
const studentInfoSpan = document.getElementById("student-info");
const datetimeInfoSpan = document.getElementById("datetime-info");
const cameraStatusSpan = document.getElementById("camera-status");

let faceMatcher = null;
let labeledDescriptors = [];
let detectionInterval = null;
let lastMarkedStudentId = null;
let lastMarkedTime = 0;
let modelsLoaded = false;
let studentDataLoaded = false;

const DETECTION_INTERVAL_MS = 2000;
const SUCCESS_DISPLAY_DURATION_MS = 5000;
const DEBOUNCE_MARKING_MS = 30000;

async function startCameraStream() {
  cameraStatusSpan.textContent = "Requesting camera access...";
  console.log("Attempting to start camera stream...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;
      cameraStatusSpan.style.display = "none";
      statusSpan.textContent = "Camera active.";
      console.log("Camera stream started successfully.");
      loadModelsAndStudentData();
    };
  } catch (error) {
    console.error("Error accessing camera:", error);
    cameraStatusSpan.textContent = `Error: Camera access denied or not available.`;
    statusSpan.textContent = "";
    studentInfoSpan.textContent = "";
    datetimeInfoSpan.textContent = "";
    alert(
      "Could not access your camera. Please ensure it is connected and you have granted permissions."
    );
  }
}

async function loadModelsAndStudentData() {
  console.log("Attempting to load Face Recognition Models...");
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
    await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
    await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
    modelsLoaded = true;
    console.log("✅ Face-API.js models loaded successfully.");
  } catch (error) {
    modelsLoaded = false;
    console.error("❌ Error loading Face-API.js models:", error);
    statusSpan.textContent =
      "Warning: AI models failed to load. Recognition may not work.";
    return;
  }

  if (!modelsLoaded) return;

  console.log("Fetching student data for recognition...");
  statusSpan.textContent = "Fetching student data...";

  try {
    const user = auth.currentUser;
    if (!user) {
      console.warn("User not authenticated. Redirecting to login...");
      statusSpan.textContent = "Not authenticated. Redirecting...";
      setTimeout(() => (window.location.href = "/login"), 2000);
      return;
    }

    const response = await fetch(`/students_data`);
    if (!response.ok) {
      throw new Error(`Failed to fetch student data: ${response.statusText}`);
    }
    const students = await response.json();

    labeledDescriptors = [];
    let failedCount = 0;

    for (const [student_id, studentData] of Object.entries(students || {})) {
      if (!studentData.face_image_url) {
        console.warn(`⚠️ No image URL for student ${student_id}`);
        continue;
      }

      try {
        const rawImg = await faceapi.fetchImage(studentData.face_image_url);

        // Fix: Draw on white canvas and resize
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(rawImg, 0, 0, canvas.width, canvas.height);

        document.body.append(canvas);

        const detection = await faceapi
          .detectSingleFace(canvas)
          .withFaceLandmarks()
          .withFaceDescriptor();

          console.log(detection)

        if (detection && detection.descriptor) {
          labeledDescriptors.push(
            new faceapi.LabeledFaceDescriptors(student_id, [
              detection.descriptor,
            ])
          );
          console.log(`✅ Descriptor loaded for ${student_id}`);
        } else {
          console.warn(
            `⚠️ No face detected for ${studentData.name} (${student_id})`,
            studentData.face_image_url
          );
          failedCount++;
        }
      } catch (error) {
        console.error(
          `❌ Error processing ${student_id} (${studentData.name}):`,
          error
        );
        failedCount++;
      }
    }

    if (labeledDescriptors.length === 0) {
      console.warn("⚠️ No labeled face descriptors loaded.");
      statusSpan.textContent =
        "No student face data available. Recognition paused.";
    } else {
      faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
      studentDataLoaded = true;
      console.log(`✅ Loaded ${labeledDescriptors.length} descriptors.`);
      console.log(`❌ Failed detections: ${failedCount}`);

      statusSpan.className = "text-green-600 text-2xl font-semibold mb-2";
      statusSpan.textContent = "Ready for attendance!";
      studentInfoSpan.textContent = "Waiting for face detection...";
      datetimeInfoSpan.textContent = "";

      if (detectionInterval) clearInterval(detectionInterval);
      detectionInterval = setInterval(
        detectAndMarkAttendance,
        DETECTION_INTERVAL_MS
      );
    }
  } catch (error) {
    studentDataLoaded = false;
    console.error("❌ Error fetching student data:", error);
    statusSpan.textContent =
      "Warning: Could not load student data. Recognition paused.";
  }
}

async function detectAndMarkAttendance() {
  if (!video.srcObject) {
    console.warn(
      "[Detection Loop] Video stream not active. Skipping detection."
    );
    statusSpan.textContent = "Camera not active.";
    return;
  }
  if (!modelsLoaded) {
    console.warn(
      "[Detection Loop] Face-API.js models not loaded. Skipping detection."
    );
    statusSpan.textContent = "Recognition unavailable (models not loaded).";
    return;
  }
  if (!faceMatcher) {
    console.warn(
      "[Detection Loop] FaceMatcher not initialized (no student data). Skipping recognition."
    );
    statusSpan.textContent = "Recognition unavailable (no student data).";
    return;
  }

  const detections = await faceapi
    .detectAllFaces(video, new faceapi.SsdMobilenetv1Options())
    .withFaceLandmarks()
    .withFaceDescriptors();

  const dims = faceapi.matchDimensions(overlayCanvas, video, true);
  const resizedDetections = faceapi.resizeResults(detections, dims);
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (detections.length > 0) {
    let bestMatch = null;
    let bestDistance = Infinity;

    resizedDetections.forEach((detection) => {
      const match = faceMatcher.findBestMatch(detection.descriptor);
      if (match.label !== "unknown" && match.distance < bestDistance) {
        bestDistance = match.distance;
        bestMatch = match;
      }
      faceapi.draw.drawDetections(overlayCanvas, [detection]);
      const box = detection.detection.box;
      const text = `${match.label} (${Math.round(match.distance * 100) / 100})`;
      new faceapi.draw.DrawBox(box, { label: text }).draw(overlayCanvas);
    });

    if (bestMatch && bestMatch.label !== "unknown") {
      const recognizedStudentId = bestMatch.label;

      if (
        lastMarkedStudentId === recognizedStudentId &&
        Date.now() - lastMarkedTime < DEBOUNCE_MARKING_MS
      ) {
        statusSpan.className = "text-orange-500 text-2xl font-semibold mb-2";
        statusSpan.textContent = "Attendance already checked recently.";
        studentInfoSpan.textContent = `Recognized: ${recognizedStudentId}`;
        datetimeInfoSpan.textContent = `Last check: ${new Date(
          lastMarkedTime
        ).toLocaleTimeString()}`;
        return;
      }

      statusSpan.textContent = `Recognizing: ${recognizedStudentId}...`;
      studentInfoSpan.textContent = "";
      datetimeInfoSpan.textContent = "";

      try {
        const response = await fetch("/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ student_id: recognizedStudentId }),
        });
        const data = await response.json();

        if (data.status === "success") {
          statusSpan.className = "text-green-600 text-2xl font-semibold mb-2";
          statusSpan.textContent = "Attendance Marked Successfully!";
          studentInfoSpan.textContent = `Attendance for ${data.name} (${data.student_id}) marked.`;
          datetimeInfoSpan.textContent = `Date: ${new Date().toLocaleString()}`;
          lastMarkedStudentId = data.student_id;
          lastMarkedTime = Date.now();
        } else if (data.status === "already_marked") {
          statusSpan.className = "text-orange-500 text-2xl font-semibold mb-2";
          statusSpan.textContent = "Already Marked!";
          studentInfoSpan.textContent = `Attendance for ${data.name} (${data.student_id}) already marked today.`;
          datetimeInfoSpan.textContent = `Date: ${new Date().toLocaleString()}`;
          lastMarkedStudentId = data.student_id;
          lastMarkedTime = Date.now();
        } else {
          statusSpan.className = "text-red-600 text-2xl font-semibold mb-2";
          statusSpan.textContent = "Failed to mark Attendance!";
          studentInfoSpan.textContent =
            data.message || "An unknown error occurred.";
          datetimeInfoSpan.textContent = `Time: ${new Date().toLocaleTimeString()}`;
        }
      } catch (error) {
        console.error("Error sending attendance data:", error);
        statusSpan.className = "text-red-600 text-2xl font-semibold mb-2";
        statusSpan.textContent = "Network Error!";
        studentInfoSpan.textContent =
          "Could not send attendance. Check console.";
        datetimeInfoSpan.textContent = "";
      } finally {
        setTimeout(() => {
          statusSpan.className = "text-2xl font-semibold mb-2";
          statusSpan.textContent = studentDataLoaded
            ? "Ready for attendance!"
            : "No student data loaded.";
          studentInfoSpan.textContent = studentDataLoaded
            ? "Waiting for face detection..."
            : "";
          datetimeInfoSpan.textContent = "";
        }, SUCCESS_DISPLAY_DURATION_MS);
      }
    } else {
      statusSpan.textContent = "No Known Student Recognized";
      studentInfoSpan.textContent =
        "Please ensure your face is clear and added to the system.";
      datetimeInfoSpan.textContent = `Time: ${new Date().toLocaleTimeString()}`;
    }
  } else {
    statusSpan.textContent = "No Face Detected";
    studentInfoSpan.textContent = "Position yourself in front of the camera.";
    datetimeInfoSpan.textContent = `Time: ${new Date().toLocaleTimeString()}`;
  }
}

onAuthStateChanged(auth, (user) => {
  if (user && window.location.pathname === "/") {
    const currentCourseElement = document.querySelector(
      ".text-xl.text-gray-700"
    );
    if (
      currentCourseElement &&
      currentCourseElement.textContent.includes("None Selected")
    ) {
      statusSpan.className = "text-red-500 font-bold";
      statusSpan.textContent =
        "Please select a course from the Profile menu to begin.";
      cameraStatusSpan.textContent = "Camera paused: No course selected.";
      if (detectionInterval) clearInterval(detectionInterval);
      console.warn("Attendance system paused: No course selected.");
    } else {
      startCameraStream();
    }
  } else if (
    !user &&
    window.location.pathname !== "/login" &&
    window.location.pathname !== "/register"
  ) {
    window.location.href = "/login";
  }
});
