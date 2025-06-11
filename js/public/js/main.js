import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDnue-qykLWX85SJqDKbgixAv8y1CRuJXA",
  authDomain: "attendance-e75b0.firebaseapp.com",
  projectId: "attendance-e75b0",
  storageBucket: "attendance-e75b0.appspot.com",
  messagingSenderId: "426044164583",
  appId: "1:426044164583:web:f947cb98449896dcd01542",
  measurementId: "G-2B94KZC2B7",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function startFaceRecognition() {
  const video = document.getElementById("video");
  const status = document.getElementById("status");
  const student = document.getElementById("student");
  const date = document.getElementById("date");

  // Load face-api.js models
  await faceapi.nets.ssdMobilenetv1.loadFromUri("/models");
  await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
  await faceapi.nets.faceRecognitionNet.loadFromUri("/models");

  // Start webcam
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  video.srcObject = stream;

  // Fetch student data
  const idToken = await auth.currentUser.getIdToken();
  const response = await fetch(
    `https://attendance-e75b0-default-rtdb.firebaseio.com/students.json?auth=${idToken}`
  );
  const students = await response.json();
  const labeledDescriptors = [];

  // Load reference images
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
        }
      } catch (error) {
        console.error(`Error loading image for ${student_id}:`, error);
      }
    }
  }

  const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);

  // Process webcam frames
  setInterval(async () => {
    const detections = await faceapi
      .detectAllFaces(video)
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (detections.length > 0) {
      const match = faceMatcher.findBestMatch(detections[0].descriptor);
      if (match._label !== "unknown") {
        const response = await fetch("/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ student_id: match._label }),
        });
        const data = await response.json();
        if (data.status === "success") {
          status.textContent = "Attendance Marked Successfully!";
          student.textContent = `Attendance for ${data.name} (${data.student_id}) marked`;
          date.textContent = `Date: ${new Date().toLocaleString()}`;
        } else {
          status.textContent = "Error Marking Attendance";
        }
      } else {
        status.textContent = "No Student Recognized";
        student.textContent = "";
        date.textContent = "";
      }
    } else {
      status.textContent = "No Face Detected";
      student.textContent = "";
      date.textContent = "";
    }
  }, 2000);
}

onAuthStateChanged(auth, (user) => {
  if (user && window.location.pathname === "/attendance") {
    startFaceRecognition();
  } else if (
    !user &&
    window.location.pathname !== "/login" &&
    window.location.pathname !== "/register"
  ) {
    window.location.href = "/attendance";
  }
});
