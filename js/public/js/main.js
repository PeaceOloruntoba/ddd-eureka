// public/js/main.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Your Firebase client-side configuration
const firebaseConfig = {
  apiKey: "AIzaSyDnue-qykLWX85SJqDKbgixAv8y1CRuJXA", // Replace with your actual client-side API key
  authDomain: "attendance-e75b0.firebaseapp.com",
  projectId: "attendance-e75b0",
  storageBucket: "attendance-e75b0.appspot.com",
  messagingSenderId: "426044164583",
  appId: "1:426044164583:web:f947cb98449896dcd01542",
  measurementId: "G-2B94KZC2B7",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const video = document.getElementById("video");
const overlayCanvas = document.getElementById("overlay");
const statusSpan = document.getElementById("status");
const studentInfoSpan = document.getElementById("student-info");
const datetimeInfoSpan = document.getElementById("datetime-info");

let faceMatcher = null;
let labeledDescriptors = [];
let detectionInterval = null;
let lastMarkedStudentId = null; // To prevent marking the same student repeatedly in a short time

const DETECTION_INTERVAL_MS = 2000; // Check for faces every 2 seconds
const SUCCESS_DISPLAY_DURATION_MS = 5000; // How long success/fail messages stay on screen
const DEBOUNCE_MARKING_MS = 30000; // Don't mark attendance for same student within this period

async function loadModelsAndStartCamera() {
  statusSpan.textContent = "Loading Face Recognition Models...";
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
    await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
    await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
    statusSpan.textContent = "Models loaded. Starting camera...";

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;
      statusSpan.textContent = "Camera started. Fetching student data...";
      fetchStudentDataAndStartDetection();
    };
  } catch (error) {
    console.error("Error loading models or accessing camera:", error);
    statusSpan.textContent = `Error: ${error.message}. Please ensure camera is enabled and models are in /public/models.`;
    studentInfoSpan.textContent = "";
    datetimeInfoSpan.textContent = "";
  }
}

async function fetchStudentDataAndStartDetection() {
  try {
    const user = auth.currentUser;
    if (!user) {
      statusSpan.textContent = "Not authenticated. Redirecting to login...";
      setTimeout(() => (window.location.href = "/login"), 2000);
      return;
    }

    const idToken = await user.getIdToken();
    const response = await fetch(`/students_data?auth=${idToken}`); // New backend endpoint to get student data
    if (!response.ok) {
      throw new Error(`Failed to fetch student data: ${response.statusText}`);
    }
    const students = await response.json();

    labeledDescriptors = [];
    statusSpan.textContent = "Loading student face images...";
    for (const [student_id, studentData] of Object.entries(students || {})) {
      if (studentData.face_image) {
        try {
          const img = await faceapi.fetchImage(
            `https://firebasestorage.googleapis.com/v0/b/attendance-e75b0.appspot.com/o/${encodeURIComponent(
              studentData.face_image
            )}?alt=media`
          );
          const detection = await faceapi
            .detectSingleFace(img)
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (detection) {
            labeledDescriptors.push(
              new faceapi.LabeledFaceDescriptors(student_id, [
                detection.descriptor,
              ])
            );
          } else {
            console.warn(
              `No face detected in reference image for ${studentData.name} (${student_id}).`
            );
          }
        } catch (error) {
          console.error(`Error loading image for ${student_id}:`, error);
        }
      }
    }
    faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6); // Lower distance = stricter match
    statusSpan.textContent = "Ready for attendance!";
    studentInfoSpan.textContent = "Waiting for face detection...";
    datetimeInfoSpan.textContent = "";

    // Start the detection loop
    if (detectionInterval) clearInterval(detectionInterval);
    detectionInterval = setInterval(
      detectAndMarkAttendance,
      DETECTION_INTERVAL_MS
    );
  } catch (error) {
    console.error(
      "Error fetching student data or initializing face matcher:",
      error
    );
    statusSpan.textContent = `Error: ${error.message}. Could not load student data.`;
    studentInfoSpan.textContent = "";
    datetimeInfoSpan.textContent = "";
  }
}

async function detectAndMarkAttendance() {
  if (!video.srcObject) return; // Camera not ready

  const detections = await faceapi
    .detectAllFaces(video, new faceapi.SsdMobilenetv1Options())
    .withFaceLandmarks()
    .withFaceDescriptors();

  const dims = faceapi.matchDimensions(overlayCanvas, video, true);
  const resizedDetections = faceapi.resizeResults(detections, dims);
  const ctx = overlayCanvas.getContext("2d");
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (detections.length > 0 && faceMatcher) {
    let bestMatch = null;
    let bestDistance = Infinity;

    resizedDetections.forEach((detection) => {
      const match = faceMatcher.findBestMatch(detection.descriptor);
      if (match.distance < bestDistance) {
        // Find the closest match
        bestDistance = match.distance;
        bestMatch = match;
      }
      faceapi.draw.drawDetections(overlayCanvas, resizedDetections); // Draw all detections

      // Draw match label (optional, for debugging)
      const box = detection.detection.box;
      const text = `${match.label} (${Math.round(match.distance * 100) / 100})`;
      new faceapi.draw.DrawBox(box, { label: text }).draw(overlayCanvas);
    });

    if (bestMatch && bestMatch.label !== "unknown") {
      const recognizedStudentId = bestMatch.label;

      // Debounce mechanism: check if same student was marked recently
      if (
        lastMarkedStudentId === recognizedStudentId &&
        Date.now() - window.lastMarkedTime < DEBOUNCE_MARKING_MS
      ) {
        statusSpan.textContent =
          "Attendance already marked for this student recently.";
        studentInfoSpan.textContent = `Recognized: ${recognizedStudentId}`;
        datetimeInfoSpan.textContent = `Last check: ${new Date().toLocaleTimeString()}`;
        return; // Don't mark again
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
          window.lastMarkedTime = Date.now();
        } else if (data.status === "already_marked") {
          statusSpan.className = "text-orange-500 text-2xl font-semibold mb-2";
          statusSpan.textContent = "Already Marked!";
          studentInfoSpan.textContent = `Attendance for ${data.name} (${data.student_id}) already marked today.`;
          datetimeInfoSpan.textContent = `Date: ${new Date().toLocaleString()}`;
          lastMarkedStudentId = data.student_id; // Still update to debounce
          window.lastMarkedTime = Date.now();
        } else {
          statusSpan.className = "text-red-600 text-2xl font-semibold mb-2";
          statusSpan.textContent = "Error Marking Attendance!";
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
        // Clear status message after a delay
        setTimeout(() => {
          statusSpan.className = "text-2xl font-semibold mb-2"; // Reset class
          statusSpan.textContent = "Ready for attendance!";
          studentInfoSpan.textContent = "Waiting for face detection...";
          datetimeInfoSpan.textContent = "";
        }, SUCCESS_DISPLAY_DURATION_MS);
      }
    } else {
      statusSpan.textContent = "No Student Recognized";
      studentInfoSpan.textContent = "";
      datetimeInfoSpan.textContent = "";
    }
  } else {
    statusSpan.textContent = "No Face Detected";
    studentInfoSpan.textContent = "";
    datetimeInfoSpan.textContent = "";
  }
}

// Check auth state and start face recognition if on the home page
onAuthStateChanged(auth, (user) => {
  if (user && window.location.pathname === "/") {
    loadModelsAndStartCamera();
  } else if (
    !user &&
    window.location.pathname !== "/login" &&
    window.location.pathname !== "/register"
  ) {
    // If not logged in and not on login/register page, redirect to login
    window.location.href = "/login";
  }
});
