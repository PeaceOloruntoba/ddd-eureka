import express from "express";
import session from "express-session";
import cors from "cors";
import admin from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
// import { getStorage } from "firebase-admin/storage";
import { getDatabase } from "firebase-admin/database";
import ExcelJS from "exceljs";
import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";
import fs from "fs/promises"; // Using promises version
import { readFileSync } from "fs"; // Using sync for service account
import dotenv from "dotenv";
import cloudinary from "./config/cloudinary.js"

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccount = JSON.parse(
  readFileSync("./firebase_credentials.json", "utf8")
);

const app = express();

// Firebase Admin SDK Initialization
let db, storage, auth;
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://attendance-e75b0-default-rtdb.firebaseio.com/",
    // storageBucket: "attendance-e75b0.appspot.com",
  });
  db = getDatabase();
  // storage = getStorage().bucket();
  auth = getAuth();
  console.log("Firebase initialized successfully");
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
  // Exit process if Firebase fails to initialize, as it's critical
  process.exit(1);
}

// Mock data store (for fallback) - keep for development/testing if DB connection fails
let mockData = {
  lecturers: {
    "mock-lecturer-uid": {
      email: "lecturer@example.com",
      courses: ["CS101", "MTH202", "PHY303"],
    },
  },
  students: {
    S001: {
      name: "John Doe",
      matric_no: "S001",
      department: "Computer Science",
      level: "200",
      courses: ["CS101"],
      // Update this to a sample Cloudinary URL
      face_image: "https://res.cloudinary.com/ducorig4o/image/upload/v1751329786/sample-s001.jpg", // Replace with a real sample from your Cloudinary
    },
    S002: {
      name: "Jane Smith",
      matric_no: "S002",
      department: "Mathematics",
      level: "300",
      courses: ["MTH202"],
      // Update this to a sample Cloudinary URL
      face_image: "https://res.cloudinary.com/ducorig4o/image/upload/v1751329786/sample-s002.jpg", // Replace with a real sample from your Cloudinary
    },
  },
  attendance: {
    S001: {
      "-M123": {
        date: "2025-06-13T10:00:00Z",
        course: "CS101",
        lecturerId: "mock-lecturer-uid",
      },
    },
  },
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // Serves static files including 'models' and 'faces'
app.use(fileUpload());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "davzee",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" },
  })
);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.locals.firebaseClientConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "mock-api-key",
  authDomain: process.env.AUTH_DOMAIN || "mock-auth-domain",
  projectId: process.env.PROJECT_ID || "mock-project-id",
  storageBucket: process.env.STORAGE_BUCKET || "mock-storage-bucket",
  messagingSenderId: process.env.MESSAGING_SENDER_ID || "mock-sender-id",
  appId: process.env.APP_ID || "mock-app-id",
  measurementId: process.env.MEASUREMENT_ID || "mock-measurement-id",
};

// Session validation middleware - fetches lecturer data for session
app.use(async (req, res, next) => {
  if (req.session.user) {
    try {
      const lecturerData = db
        ? (await db.ref(`lecturers/${req.session.user}`).once("value")).val()
        : mockData.lecturers[req.session.user];

      if (lecturerData) {
        req.session.courses = lecturerData.courses || [];
        if (
          !req.session.current_course ||
          !req.session.courses.includes(req.session.current_course)
        ) {
          req.session.current_course =
            req.session.courses.length > 0 ? req.session.courses[0] : null;
        }
      } else {
        console.error("No lecturer data for UID:", req.session.user);
        req.session.destroy(() => {
          res.redirect("/login");
        });
        return;
      }
    } catch (error) {
      console.error("Error fetching lecturer data:", error.message);
      req.session.destroy(() => {
        res.redirect("/login");
      });
      return;
    }
  }
  next();
});

// Authentication middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    return next();
  }
  // For API requests, send 401. For page requests, redirect.
  if (req.xhr || req.headers.accept.indexOf("json") > -1) {
    res.status(401).json({ message: "Unauthorized" });
  } else {
    res.redirect("/login");
  }
};

// --- Routes ---

app.get("/", isAuthenticated, (req, res) => {
  res.render("index", {
    title: "Real-time Attendance",
    course: req.session.current_course || "N/A",
    session: req.session,
    firebaseClientConfig: app.locals.firebaseClientConfig,
  });
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", {
    title: "Login",
    error: null,
    firebaseClientConfig: app.locals.firebaseClientConfig,
    session: req.session,
  });
});

app.post("/login", async (req, res) => {
  console.log("Login attempt:", req.body);
  const { idToken } = req.body;
  try {
    if (!auth) throw new Error("Firebase Auth not initialized");
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerData = db
      ? (await db.ref(`lecturers/${decodedToken.uid}`).once("value")).val()
      : mockData.lecturers[decodedToken.uid];

    if (!lecturerData) {
      throw new Error("Lecturer profile not found. Please register.");
    }

    req.session.user = decodedToken.uid;
    req.session.courses = lecturerData.courses || [];
    req.session.current_course =
      req.session.courses.length > 0 ? req.session.courses[0] : null;

    res.json({ status: "success" });
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(400).json({ error: error.message || "Login failed." });
  }
});

app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("register", {
    title: "Register",
    error: null,
    session: req.session,
  });
});

app.post("/register", async (req, res) => {
  const { idToken, courses } = req.body;
  try {
    if (!auth) throw new Error("Firebase Auth not initialized");
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerUid = decodedToken.uid;
    const lecturerEmail = decodedToken.email;

    const parsedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter((c) => c)
      : [];

    const existingLecturer = db
      ? (await db.ref(`lecturers/${lecturerUid}`).once("value")).val()
      : mockData.lecturers[lecturerUid];

    if (existingLecturer) {
      const updatedCourses = [
        ...new Set([...(existingLecturer.courses || []), ...parsedCourses]),
      ];
      if (db) {
        await db.ref(`lecturers/${lecturerUid}`).update({
          courses: updatedCourses,
        });
      } else {
        mockData.lecturers[lecturerUid] = {
          email: lecturerEmail,
          courses: updatedCourses,
        };
      }
    } else {
      const lecturerData = {
        email: lecturerEmail,
        courses: parsedCourses,
      };
      if (db) {
        await db.ref(`lecturers/${lecturerUid}`).set(lecturerData);
      } else {
        mockData.lecturers[lecturerUid] = lecturerData;
      }
    }

    req.session.user = lecturerUid;
    req.session.courses = parsedCourses;
    req.session.current_course =
      parsedCourses.length > 0 ? parsedCourses[0] : null;

    res.json({ status: "success", message: "Registration successful!" });
  } catch (error) {
    console.error("Registration error:", error.message);
    let errorMessage = error.message;
    if (error.code === "auth/email-already-in-use") {
      errorMessage = "This email is already registered.";
    } else if (error.code === "auth/weak-password") {
      errorMessage = "Password is too weak. Must be at least 6 characters.";
    } else if (
      error.code === "auth/id-token-expired" ||
      error.code === "auth/invalid-id-token"
    ) {
      errorMessage =
        "Authentication token expired or invalid. Please try logging in again.";
    }
    res.status(400).json({ status: "error", error: errorMessage });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/login");
  });
});

app.post("/stream", isAuthenticated, async (req, res) => {
  const { student_id } = req.body;
  const lecturerId = req.session.user;
  const currentCourse = req.session.current_course;

  if (!student_id) {
    return res.json({ status: "no_id", message: "No student ID provided." });
  }
  if (!currentCourse) {
    return res.json({
      status: "error",
      message: "No course selected.",
    });
  }

  try {
    const student = db
      ? (await db.ref(`students/${student_id}`).once("value")).val()
      : mockData.students[student_id];

    if (!student) {
      return res.json({
        status: "invalid_id",
        message: "Student not found in records.",
      });
    }

    if (!student.courses || !student.courses.includes(currentCourse)) {
      return res.json({
        status: "invalid_course",
        message: `Student (${student.name}) is not assigned to ${currentCourse}.`,
      });
    }

    const today = new Date().toISOString().split("T")[0]; // "2025-07-01"
    let attendanceRecords = db
      ? (await db.ref(`attendance/${student_id}`).once("value")).val() || {}
      : mockData.attendance[student_id] || {};

    let alreadyMarkedToday = Object.values(attendanceRecords).some(
      (record) =>
        new Date(record.date).toISOString().split("T")[0] === today &&
        record.course === currentCourse
    );

    if (alreadyMarkedToday) {
      return res.json({
        status: "already_marked",
        student_id,
        name: student.name || "Unknown",
        message: "Attendance already marked for today.",
      });
    }

    // Use push() to generate a unique ID for the new attendance record
    const newRecordRef = db ? db.ref(`attendance/${student_id}`).push() : null;
    const newRecordId = newRecordRef
      ? newRecordRef.key
      : `-${Math.random().toString(36).substr(2, 9)}`;

    const attendanceEntry = {
      date: new Date().toISOString(),
      course: currentCourse,
      lecturerId: lecturerId,
    };

    if (db) {
      await newRecordRef.set(attendanceEntry);
    } else {
      mockData.attendance[student_id] = mockData.attendance[student_id] || {};
      mockData.attendance[student_id][newRecordId] = attendanceEntry;
    }

    res.json({
      status: "success",
      student_id,
      name: student.name || "Unknown",
      message: "Attendance marked successfully!",
    });
  } catch (error) {
    console.error("Stream attendance error:", error);
    res.json({ status: "error", message: error.message });
  }
});

app.get("/attendance", isAuthenticated, async (req, res) => {
  const { course } = req.query;
  let attendance = db
    ? (await db.ref("attendance").once("value")).val() || {}
    : mockData.attendance;
  const students = db
    ? (await db.ref("students").once("value")).val() || {}
    : mockData.students;

  if (course) {
    const filteredAttendance = {};
    for (const student_id in attendance) {
      filteredAttendance[student_id] = {};
      for (const record_id in attendance[student_id]) {
        if (attendance[student_id][record_id].course === course) {
          filteredAttendance[student_id][record_id] =
            attendance[student_id][record_id];
        }
      }
      if (Object.keys(filteredAttendance[student_id]).length === 0) {
        delete filteredAttendance[student_id];
      }
    }
    attendance = filteredAttendance;
  }

  res.render("attendance", {
    title: "Attendance History",
    attendance,
    students,
    course: course || req.session.current_course || "N/A",
    session: req.session,
  });
});

app.delete(
  "/attendance/:student_id/:record_id",
  isAuthenticated,
  async (req, res) => {
    const { student_id, record_id } = req.params;
    try {
      if (db) {
        await db.ref(`attendance/${student_id}/${record_id}`).remove();
      } else {
        // Handle mock data deletion carefully
        if (mockData.attendance[student_id]) {
          delete mockData.attendance[student_id][record_id];
          if (Object.keys(mockData.attendance[student_id]).length === 0) {
            delete mockData.attendance[student_id]; // Remove student if no records left
          }
        }
      }
      res
        .status(200)
        .json({ status: "success", message: "Attendance record deleted." });
    } catch (error) {
      console.error("Error deleting attendance record:", error);
      res.status(500).json({
        status: "error",
        message: "Failed to delete attendance record.",
      });
    }
  }
);

app.get("/students", isAuthenticated, async (req, res) => {
  const students = db
    ? (await db.ref("students").once("value")).val() || {}
    : mockData.students;
  res.render("students", {
    title: "Manage Students",
    students,
    course: req.session.current_course || null,
    session: req.session,
  });
});

// IMPORTANT: Ensure the 'faces' directory exists in 'public' for local file storage fallback
const LOCAL_FACE_IMAGES_DIR = path.join(__dirname, "public", "faces");
fs.mkdir(LOCAL_FACE_IMAGES_DIR, { recursive: true }).catch(console.error);

app.post("/students", isAuthenticated, async (req, res) => {
  const currentCourse = req.session.current_course;
  if (!currentCourse) {
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "No course selected. Please select a course from your profile."
      )}`
    );
  }

  if (req.files && req.files.file) {
    // Handling XLSX upload - No changes needed here related to image storage,
    // as XLSX upload doesn't handle images.
    // ... (rest of XLSX handling logic)
    const file = req.files.file;
    const courseToAssign = req.body.course_to_upload_students || currentCourse;

    if (!file.name.endsWith(".xlsx")) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Invalid file format. Please upload an XLSX file."
        )}`
      );
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.data);
      const worksheet = workbook.worksheets[0];

      if (!worksheet) {
        return res.redirect(
          `/students?error=${encodeURIComponent(
            "XLSX file is empty or corrupted."
          )}`
        );
      }

      const studentUpdates = {};
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row
        const name = row.getCell(1).value?.toString()?.trim();
        const matric_no_raw = row.getCell(2).value?.toString()?.trim();
        const department = row.getCell(3).value?.toString()?.trim();
        const level = row.getCell(4).value?.toString()?.trim();

        if (name && matric_no_raw && department && level) {
          const student_id = matric_no_raw.toUpperCase();
          studentUpdates[student_id] = {
            name,
            matric_no: student_id,
            department,
            level,
          };
        } else {
          console.warn(
            `Skipping invalid row ${rowNumber} in XLSX:`,
            row.values
          );
        }
      });

      if (Object.keys(studentUpdates).length === 0) {
        return res.redirect(
          `/students?error=${encodeURIComponent(
            "No valid student data found in the XLSX file. Check column headers and data."
          )}`
        );
      }

      for (const student_id in studentUpdates) {
        const newStudentData = studentUpdates[student_id];
        let existingStudent = {};
        if (db) {
          existingStudent =
            (await db.ref(`students/${student_id}`).once("value")).val() || {};
        } else {
          existingStudent = mockData.students[student_id] || {};
        }

        let courses = existingStudent.courses || [];
        if (!courses.includes(courseToAssign)) {
          courses.push(courseToAssign);
        }

        const studentDataToSave = {
          ...newStudentData,
          courses,
          // Preserve existing face_image or set to null if not present
          face_image: existingStudent.face_image || null,
        };

        if (db) {
          await db.ref(`students/${student_id}`).set(studentDataToSave);
        } else {
          mockData.students[student_id] = studentDataToSave;
        }
      }

      return res.redirect(
        "/students?success=Students from XLSX uploaded successfully!"
      );
    } catch (error) {
      console.error("Error processing XLSX:", error);
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Failed to upload XLSX: " + error.message
        )}`
      );
    }
  }

  // Handling single student add/update form submission
  const { name, matric_no, department, level, course_to_add_student } =
    req.body;
  const student_id_formatted = matric_no?.trim().toUpperCase();
  const assignedCourse = course_to_add_student || currentCourse;

  if (
    !name ||
    !student_id_formatted ||
    !department ||
    !level ||
    !assignedCourse
  ) {
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "All fields (Name, Matric No, Department, Level, Course) are required for adding a student."
      )}`
    );
  }

  try {
    let existingStudent = {};
    if (db) {
      existingStudent = (
        await db.ref(`students/${student_id_formatted}`).once("value")
      ).val();
    } else {
      existingStudent = mockData.students[student_id_formatted];
    }

    if (existingStudent) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          `Student with Matric No '${student_id_formatted}' already exists. Use the edit feature to update.`
        )}`
      );
    }

    let courses = [assignedCourse];
    if (existingStudent && existingStudent.courses) {
      courses = [...new Set([...existingStudent.courses, ...courses])];
    }

    let studentData = {
      name,
      matric_no: student_id_formatted,
      department,
      level,
      courses,
      face_image: null, // Initialize as null, will be updated if image is uploaded
    };

    if (req.files && req.files.face_image) {
      console.log("Face image file seen for upload.");
      const file = req.files.face_image;

      if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
        return res.redirect(
          `/students?error=${encodeURIComponent(
            "Face image must be JPEG or PNG format."
          )}`
        );
      }

      try {
        // **Upload to Cloudinary**
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.data.toString("base64")}`,
          {
            folder: "student_faces", // Folder in your Cloudinary account
            public_id: student_id_formatted, // Unique ID for the image (e.g., matric number)
            resource_type: "image", // Specify resource type
            overwrite: true, // If a student with this matric_no uploads a new image, overwrite the old one
          }
        );

        studentData.face_image = result.secure_url; // Store the secure HTTPS URL from Cloudinary
        console.log(`Face image uploaded to Cloudinary: ${result.secure_url}`);
      } catch (imageError) {
        console.warn(
          "Failed to save face image to Cloudinary (continuing without image):",
          imageError.message
        );
        studentData.face_image = null; // Ensure it's null if save fails
        // Fallback to local storage if Cloudinary upload fails
        try {
          const imageExtension = file.mimetype.split("/")[1];
          const localFilePath = path.join(
            LOCAL_FACE_IMAGES_DIR,
            `${student_id_formatted}.${imageExtension}`
          );
          await fs.writeFile(localFilePath, file.data);
          studentData.face_image = `faces/${student_id_formatted}.${imageExtension}`;
          console.log(`Face image saved locally as fallback: ${localFilePath}`);
        } catch (localSaveError) {
          console.error(
            "Failed to save face image locally as fallback:",
            localSaveError.message
          );
          studentData.face_image = null; // Ensure it's null if even local save fails
        }
      }
    } else {
      console.warn(`No face image provided for ${student_id_formatted}.`);
      studentData.face_image = null;
    }

    // Save student data to Firebase Realtime Database or mockData
    if (db) {
      await db.ref(`students/${student_id_formatted}`).set(studentData);
    } else {
      mockData.students[student_id_formatted] = studentData;
    }
    console.log(studentData);

    return res.redirect(
      `/students?success=${encodeURIComponent("Student added successfully!")}`
    );
  } catch (error) {
    console.error("Error adding student:", error);
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "Failed to add student: " + error.message
      )}`
    );
  }
});


app.post("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  const { name, department, level, courses } = req.body;

  try {
    const existingStudent = db
      ? (await db.ref(`students/${student_id}`).once("value")).val()
      : mockData.students[student_id];
    if (!existingStudent) {
      return res.redirect(
        `/students?error=${encodeURIComponent("Student not found for update.")}`
      );
    }

    let updatedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim().toUpperCase())
          .filter((c) => c)
      : existingStudent.courses || [];

    let studentData = {
      name: name || existingStudent.name,
      matric_no: student_id,
      department: department || existingStudent.department,
      level: level || existingStudent.level,
      courses: updatedCourses,
      face_image: existingStudent.face_image || null, // Preserve existing image by default
    };

    if (req.files && req.files.face_image) {
      console.log("Face image file seen for update.");
      const file = req.files.face_image;
      if (!["image/jpeg", "image/png"].includes(file.mimetype)) {
        return res.redirect(
          `/students?error=${encodeURIComponent(
            "Face image must be JPEG or PNG."
          )}`
        );
      }

      try {
        // Delete old Cloudinary image if it exists
        if (
          existingStudent.face_image &&
          existingStudent.face_image.includes("cloudinary.com")
        ) {
          // Extract public_id from the Cloudinary URL
          // Example URL: https://res.cloudinary.com/ducorig4o/image/upload/v1751329786/student_faces/ZXCV.jpg
          const parts = existingStudent.face_image.split("/");
          const folderAndPublicId = parts
            .slice(parts.indexOf("upload") + 1)
            .join("/")
            .split(".")[0]; // "student_faces/ZXCV"
          const oldPublicId = folderAndPublicId;

          // Only delete if the public_id is available and it's not the same as the new one (if overwriting with same public_id logic is strict)
          // For simplicity and safety, we're doing a general delete if it's a Cloudinary URL
          await cloudinary.uploader
            .destroy(oldPublicId)
            .catch((err) =>
              console.warn(
                `Could not delete old Cloudinary image ${oldPublicId}:`,
                err.message
              )
            );
          console.log(`Deleted old Cloudinary image: ${oldPublicId}`);
        } else if (existingStudent.face_image) {
          // Handle deletion of old local file if it existed (from fallback)
          try {
            await fs.unlink(
              path.join(__dirname, "public", existingStudent.face_image)
            );
            console.log(
              `Deleted old local fallback image: ${existingStudent.face_image}`
            );
          } catch (err) {
            console.warn(
              `Could not delete old local fallback image ${existingStudent.face_image}:`,
              err.message
            );
          }
        }

        // Upload new image to Cloudinary
        const result = await cloudinary.uploader.upload(
          `data:${file.mimetype};base64,${file.data.toString("base64")}`,
          {
            folder: "student_faces",
            public_id: student_id, // Use student_id as public_id for new image
            resource_type: "image",
            overwrite: true,
          }
        );
        studentData.face_image = result.secure_url; // Update to new Cloudinary URL
        console.log(
          `Face image updated and uploaded to Cloudinary: ${result.secure_url}`
        );
      } catch (error) {
        console.warn(
          "Failed to save/update face image to Cloudinary during student update (continuing without image):",
          error.message
        );
        // Fallback to local storage if Cloudinary fails during update
        try {
          const imageExtension = file.mimetype.split("/")[1];
          const localFilePath = path.join(
            LOCAL_FACE_IMAGES_DIR,
            `${student_id}.${imageExtension}`
          );
          await fs.writeFile(localFilePath, file.data);
          studentData.face_image = `faces/${student_id}.${imageExtension}`;
          console.log(`Face image saved locally as fallback: ${localFilePath}`);
        } catch (localSaveError) {
          console.error(
            "Failed to save face image locally as fallback during update:",
            localSaveError.message
          );
          studentData.face_image = existingStudent.face_image || null; // Keep old if local also fails
        }
      }
    } else if (req.body.delete_face_image === "true") {
      // Added to handle explicit deletion
      if (existingStudent.face_image) {
        try {
          if (existingStudent.face_image.includes("cloudinary.com")) {
            // Extract public_id from Cloudinary URL
            const parts = existingStudent.face_image.split("/");
            const folderAndPublicId = parts
              .slice(parts.indexOf("upload") + 1)
              .join("/")
              .split(".")[0];
            await cloudinary.uploader.destroy(folderAndPublicId);
            console.log(`Face image deleted from Cloudinary for ${student_id}`);
          } else {
            // Handle local file deletion (from fallback)
            await fs.unlink(
              path.join(__dirname, "public", existingStudent.face_image)
            );
            console.log(`Face image deleted locally for ${student_id}`);
          }
        } catch (err) {
          console.warn(
            `Could not delete face image for ${student_id}:`,
            err.message
          );
        }
      }
      studentData.face_image = null; // Set to null after deletion
    }

    if (db) {
      await db.ref(`students/${student_id}`).set(studentData);
    } else {
      mockData.students[student_id] = studentData;
    }
    return res.redirect("/students?success=Student updated successfully!");
  } catch (error) {
    console.error("Error updating student:", error);
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "Failed to update student: " + error.message
      )}`
    );
  }
});

app.delete("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  try {
    const studentData = db
      ? (await db.ref(`students/${student_id}`).once("value")).val()
      : mockData.students[student_id];
    if (!studentData) {
      return res
        .status(404)
        .json({ status: "error", message: "Student not found." });
    }

    if (studentData.face_image) {
      try {
        if (studentData.face_image.includes("cloudinary.com")) {
          // Extract public_id from Cloudinary URL for deletion
          const parts = studentData.face_image.split("/");
          const folderAndPublicId = parts
            .slice(parts.indexOf("upload") + 1)
            .join("/")
            .split(".")[0];
          await cloudinary.uploader.destroy(folderAndPublicId);
          console.log(
            `Deleted face image from Cloudinary: ${studentData.face_image}`
          );
        } else {
          // Handle local file deletion (from fallback)
          await fs.unlink(
            path.join(__dirname, "public", studentData.face_image)
          );
          console.log(`Deleted local face image: ${studentData.face_image}`);
        }
      } catch (err) {
        console.warn(`Could not delete image for ${student_id}:`, err.message);
      }
    }

    // Delete attendance records for the student first
    if (db) {
      await db.ref(`attendance/${student_id}`).remove();
      console.log(`Deleted attendance records for student: ${student_id}`);
      await db.ref(`students/${student_id}`).remove();
      console.log(`Deleted student data for: ${student_id}`);
    } else {
      delete mockData.attendance[student_id];
      delete mockData.students[student_id];
    }
    res.status(200).json({
      status: "success",
      message: "Student and associated data deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting student:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to delete student: " + error.message,
    });
  }
});

// --- NEW/MODIFIED: /students_data endpoint for Face-API.js ---
app.get("/students_data", isAuthenticated, async (req, res) => {
  try {
    const students = db
      ? (await db.ref("students").once("value")).val() || {}
      : mockData.students;

    const studentsWithFaceData = {};
    for (const studentId in students) {
      const student = students[studentId];
      if (student.face_image) {
        let url;
        // Check if the URL is a Cloudinary URL or a local fallback path
        if (student.face_image.includes("cloudinary.com")) {
          url = student.face_image; // Already a direct Cloudinary URL
          console.log(`Using Cloudinary URL for ${student.matric_no}: ${url.substring(0, 50)}...`);
        } else if (student.face_image.startsWith("faces/")) {
          // This is a local fallback path, ensure it exists
          url = `/${student.face_image}`; // e.g., /faces/S001.jpg
          try {
            await fs.access(path.join(__dirname, "public", student.face_image));
            console.log(`Using local URL for ${student.matric_no}: ${url}`);
          } catch (localFileError) {
            console.warn(
              `Local face image file not found for ${student.face_image}:`,
              localFileError.message
            );
            url = null; // Set to null if local file not found
          }
        } else {
            // Unknown or invalid face_image format
            console.warn(`Unknown face_image format for ${student.matric_no}: ${student.face_image}`);
            url = null;
        }

        // Only include face_image_url if a valid URL was obtained
        if (url) {
          studentsWithFaceData[studentId] = { ...student, face_image_url: url };
        } else {
          console.warn(
            `Skipping student ${studentId} (Name: ${student.name}) due to missing/inaccessible face image.`
          );
        }
      } else {
        console.warn(
          `Student ${studentId} (Name: ${student.name}) has no face_image path in Realtime Database.`
        );
      }
    }
    console.log(
      `Sending ${Object.keys(studentsWithFaceData).length} students with face data to client.`
    );
    res.json(studentsWithFaceData);
  } catch (error) {
    console.error("Error fetching students data for Face-API.js:", error);
    res.status(500).json({ error: "Failed to fetch student face data." });
  }
});

app.get("/dashboard", isAuthenticated, async (req, res) => {
  const attendance = db
    ? (await db.ref("attendance").once("value")).val() || {}
    : mockData.attendance;
  const students = db
    ? (await db.ref("students").once("value")).val() || {}
    : mockData.students;

  res.render("dashboard", {
    title: "Dashboard",
    attendance,
    students,
    course: req.session.current_course || "N/A",
    session: req.session,
  });
});

app.get("/add_courses", isAuthenticated, (req, res) => {
  res.render("add_courses", {
    title: "Manage My Courses",
    courses: req.session.courses || [],
    error: null,
    success: null,
    session: req.session,
  });
});

app.post("/add_courses", isAuthenticated, async (req, res) => {
  const { new_course } = req.body;
  const lecturerId = req.session.user;

  if (!new_course || new_course.trim() === "") {
    return res.render("add_courses", {
      title: "Manage My Courses",
      courses: req.session.courses || [],
      error: "Course name cannot be empty.",
      success: null,
      session: req.session,
    });
  }

  const courseToAdd = new_course.trim().toUpperCase();

  try {
    const lecturerData = db
      ? (await db.ref(`lecturers/${lecturerId}`).once("value")).val()
      : mockData.lecturers[lecturerId];

    let currentCourses = lecturerData.courses || [];
    if (!currentCourses.includes(courseToAdd)) {
      currentCourses.push(courseToAdd);
      if (db) {
        await db
          .ref(`lecturers/${lecturerId}`)
          .update({ courses: currentCourses });
      } else {
        mockData.lecturers[lecturerId].courses = currentCourses;
      }
      req.session.courses = currentCourses;
      if (!req.session.current_course) {
        req.session.current_course = courseToAdd;
      }
      res.render("add_courses", {
        title: "Manage My Courses",
        courses: req.session.courses,
        error: null,
        success: `Course '${courseToAdd}' added successfully!`,
        session: req.session,
      });
    } else {
      res.render("add_courses", {
        title: "Manage My Courses",
        courses: req.session.courses,
        error: `Course '${courseToAdd}' already exists.`,
        success: null,
        session: req.session,
      });
    }
  } catch (error) {
    console.error("Error adding course:", error);
    res.render("add_courses", {
      title: "Manage My Courses",
      courses: req.session.courses,
      error: `Failed to add course: ${error.message}`,
      success: null,
      session: req.session,
    });
  }
});

app.delete("/courses/:course_code", isAuthenticated, async (req, res) => {
  const { course_code } = req.params;
  const lecturerId = req.session.user;

  try {
    const lecturerData = db
      ? (await db.ref(`lecturers/${lecturerId}`).once("value")).val()
      : mockData.lecturers[lecturerId];

    let currentCourses = lecturerData.courses || [];
    const updatedCourses = currentCourses.filter((c) => c !== course_code);

    if (updatedCourses.length === currentCourses.length) {
      return res
        .status(404)
        .json({ status: "error", message: "Course not found." });
    }

    if (db) {
      await db
        .ref(`lecturers/${lecturerId}`)
        .update({ courses: updatedCourses });
    } else {
      mockData.lecturers[lecturerId].courses = updatedCourses;
    }
    req.session.courses = updatedCourses;

    if (req.session.current_course === course_code) {
      req.session.current_course =
        updatedCourses.length > 0 ? updatedCourses[0] : null;
    }

    res
      .status(200)
      .json({ status: "success", message: `Course '${course_code}' removed.` });
  } catch (error) {
    console.error("Error removing course:", error);
    res.status(500).json({
      status: "error",
      message: `Failed to remove course: ${error.message}`,
    });
  }
});

app.post("/switch_course", isAuthenticated, (req, res) => {
  const { course } = req.body;
  if (req.session.courses && req.session.courses.includes(course)) {
    req.session.current_course = course;
  }
  res.redirect(req.headers.referer || "/");
});

app.get("/generate_report/:courseCode", isAuthenticated, async (req, res) => {
  const courseCode = req.params.courseCode;
  if (!req.session.courses || !req.session.courses.includes(courseCode)) {
    return res.status(403).send("Unauthorized: You do not manage this course.");
  }

  const attendance = db
    ? (await db.ref("attendance").once("value")).val() || {}
    : mockData.attendance;
  const students = db
    ? (await db.ref("students").once("value")).val() || {}
    : mockData.students;

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(`Attendance Report - ${courseCode}`);

  worksheet.columns = [
    { header: "Name", key: "Name", width: 25 },
    { header: "Matric No", key: "Matric No", width: 15 },
    { header: "Date", key: "Date", width: 15 },
    { header: "Time", key: "Time", width: 15 },
    { header: "Course", key: "Course", width: 10 },
    { header: "Status", key: "Status", width: 10 },
  ];

  const studentsInCourse = Object.values(students).filter(
    (s) => s.courses && s.courses.includes(courseCode)
  );
  const studentAttendanceSummary = {};

  for (const student_id in attendance) {
    for (const record_id in attendance[student_id]) {
      const record = attendance[student_id][record_id];
      if (record.course === courseCode) {
        const student = students[student_id] || {};
        const recordDate = new Date(record.date);
        worksheet.addRow({
          Name: student.name || "Unknown",
          "Matric No": student.matric_no || student_id,
          Date: recordDate.toLocaleDateString(),
          Time: recordDate.toLocaleTimeString(),
          Course: record.course,
          Status: "Present",
        });
        studentAttendanceSummary[student_id] = true;
      }
    }
  }

  for (const student of studentsInCourse) {
    if (!studentAttendanceSummary[student.matric_no]) {
      worksheet.addRow({
        Name: student.name || "Unknown",
        "Matric No": student.matric_no,
        Date: "N/A",
        Time: "N/A",
        Course: courseCode,
        Status: "Absent",
      });
    }
  }

  const reportsDir = path.join(__dirname, `public/reports`);
  await fs.mkdir(reportsDir, { recursive: true }).catch((e) => {}); // Ensure reports directory exists

  const outputPath = path.join(
    reportsDir,
    `attendance_${courseCode}_${Date.now()}.xlsx`
  );

  await workbook.xlsx.writeFile(outputPath);

  res.download(outputPath, path.basename(outputPath), async (err) => {
    if (err) {
      console.error("Error downloading file:", err);
      res.status(500).send("Error generating report.");
    }
    try {
      await fs.unlink(outputPath);
    } catch (unlinkErr) {
      console.error("Error deleting temporary report file:", unlinkErr);
    }
  });
});

// Error handling middleware (catch-all for 404)
app.use((req, res) => {
  res
    .status(404)
    .render("404", { title: "Page Not Found", session: req.session });
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render("error", {
    title: "Something Went Wrong",
    error: err.message,
    session: req.session,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
