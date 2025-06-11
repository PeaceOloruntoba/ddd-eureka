// public/js/main.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// firebaseClientConfig is passed from the EJS template via a global variable
const firebaseConfig = window.firebaseClientConfig;

// Initialize Firebase client SDK
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

const DETECTION_INTERVAL_MS = 2000; // Check for faces every 2 seconds
const SUCCESS_DISPLAY_DURATION_MS = 5000; // How long success/fail messages stay on screen
const DEBOUNCE_MARKING_MS = 30000; // Don't mark attendance for same student within this period

async function loadModelsAndStartCamera() {
  cameraStatusSpan.textContent = "Loading Face Recognition Models...";
  try {
    // Load models from the public/models directory
    await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
    await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
    await faceapi.nets.faceRecognitionNet.loadFromUri("/models");

    cameraStatusSpan.textContent = "Models loaded. Starting camera...";

    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      video.play();
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;
      cameraStatusSpan.style.display = "none"; // Hide status once video is playing
      statusSpan.textContent = "Camera started. Fetching student data...";
      fetchStudentDataAndStartDetection();
    };
  } catch (error) {
    console.error("Error loading models or accessing camera:", error);
    cameraStatusSpan.textContent = `Error: ${error.message}. Please ensure camera is enabled and models are in /public/models.`;
    statusSpan.textContent = "";
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

    const response = await fetch(`/students_data`); // Fetches all students data from our backend
    if (!response.ok) {
      throw new Error(`Failed to fetch student data: ${response.statusText}`);
    }
    const students = await response.json();

    labeledDescriptors = [];
    statusSpan.textContent = "Loading student face images...";

    for (const [student_id, studentData] of Object.entries(students || {})) {
      if (studentData.face_image_url) {
        // Use the provided URL (signed or public)
        try {
          const img = await faceapi.fetchImage(studentData.face_image_url);
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

    if (labeledDescriptors.length === 0) {
      statusSpan.textContent =
        "No student face data loaded. Please add students with images.";
      studentInfoSpan.textContent = "";
      datetimeInfoSpan.textContent = "";
      return;
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
  if (!video.srcObject || !faceMatcher) return; // Camera or face matcher not ready

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
      // Only consider matches that are not 'unknown' and are within a reasonable distance
      if (match.label !== "unknown" && match.distance < bestDistance) {
        bestDistance = match.distance;
        bestMatch = match;
      }
      // Draw all detections, even if not matched
      faceapi.draw.drawDetections(overlayCanvas, [detection]);

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
        Date.now() - lastMarkedTime < DEBOUNCE_MARKING_MS
      ) {
        statusSpan.className = "text-orange-500 text-2xl font-semibold mb-2";
        statusSpan.textContent =
          "Attendance already checked for this student recently.";
        studentInfoSpan.textContent = `Recognized: ${recognizedStudentId}`;
        datetimeInfoSpan.textContent = `Last update: ${new Date().toLocaleTimeString()}`;
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
    // Only proceed if a course is selected
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
      // Optionally disable video or don't load models
    } else {
      loadModelsAndStartCamera();
    }
  } else if (
    !user &&
    window.location.pathname !== "/login" &&
    window.location.pathname !== "/register"
  ) {
    // If not logged in and not on login/register page, redirect to login
    window.location.href = "/login";
  }
});
