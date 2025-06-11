import express from "express";
import session from "express-session";
import cors from "cors";
import admin from "firebase-admin";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";
import { getDatabase } from "firebase-admin/database";
import ExcelJS from "exceljs";
import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import fileUpload from "express-fileupload";
import fs from "fs/promises";
import { readFileSync } from "fs";
import dotenv from "dotenv";

dotenv.config(); // Load environment variables from .env file

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read Firebase Admin SDK credentials
const serviceAccount = JSON.parse(
  readFileSync("./firebase_credentials.json", "utf8")
);

const app = express();

// Firebase Admin SDK Initialization
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://attendance-e75b0-default-rtdb.firebaseio.com/", // REPLACE WITH YOUR DB URL
  storageBucket: "attendance-e75b0.appspot.com", // REPLACE WITH YOUR STORAGE BUCKET
});
const db = getDatabase();
const storage = getStorage().bucket();
const auth = getAuth();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // Serves static files from 'public' directory
app.use(fileUpload());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "a_default_secret_if_env_fails", // Use a strong secret from .env
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" }, // Use secure cookies in production
  })
);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Pass Firebase client config to all EJS templates
app.locals.firebaseClientConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.AUTH_DOMAIN,
  projectId: process.env.PROJECT_ID,
  storageBucket: process.env.STORAGE_BUCKET,
  messagingSenderId: process.env.MESSAGING_SENDER_ID,
  appId: process.env.APP_ID,
  measurementId: process.env.MEASUREMENT_ID,
};

// --- Middleware for Authentication and Session Data ---
app.use(async (req, res, next) => {
  // Ensure session.user exists for authenticated requests
  if (req.session.user) {
    try {
      const lecturerRef = db.ref(`lecturers/${req.session.user}`);
      const lecturerSnapshot = await lecturerRef.once("value");
      const lecturerData = lecturerSnapshot.val();

      if (lecturerData) {
        req.session.courses = lecturerData.courses || [];
        // Set current_course if not already set or if it's no longer valid for this lecturer
        if (
          !req.session.current_course ||
          !req.session.courses.includes(req.session.current_course)
        ) {
          req.session.current_course =
            req.session.courses.length > 0 ? req.session.courses[0] : null;
        }
      } else {
        // User's UID exists in session but not in DB, clear session
        req.session.destroy(() => {
          res.redirect("/login");
        });
        return;
      }
    } catch (error) {
      console.error("Error fetching lecturer data for session:", error);
      req.session.destroy(() => {
        res.redirect("/login");
      });
      return;
    }
  }
  next();
});

// Authentication Guard Middleware
const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    return next();
  }
  res.redirect("/login");
};

// --- Routes ---

// GET / - Home/Root page (Real-time attendance camera)
app.get("/", isAuthenticated, (req, res) => {
  res.render("index", {
    title: "Real-time Attendance",
    course: req.session.current_course || "N/A",
    session: req.session, // Pass session data to EJS
    firebaseClientConfig: app.locals.firebaseClientConfig, // Pass Firebase config for client-side
  });
});

// GET /login - Login page
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/"); // Redirect if already logged in
  res.render("login", {
    title: "Login",
    error: null,
    firebaseClientConfig: app.locals.firebaseClientConfig, // Pass Firebase config
  });
});

// POST /login - Handle Firebase client-side ID token login
app.post("/login", async (req, res) => {
  const { idToken } = req.body;
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerData = (
      await db.ref(`lecturers/${decodedToken.uid}`).once("value")
    ).val();

    if (!lecturerData) {
      // User authenticated with Firebase, but no lecturer profile in our DB
      // This could happen if they registered directly with Firebase Auth without our custom flow.
      // You might want to auto-create a profile here or reject.
      throw new Error("Lecturer profile not found. Please register.");
    }

    req.session.user = decodedToken.uid;
    req.session.courses = lecturerData.courses || [];
    req.session.current_course =
      req.session.courses.length > 0 ? req.session.courses[0] : null;

    res.json({ status: "success" });
  } catch (error) {
    console.error("Login error:", error);
    res.status(400).json({ error: error.message || "Login failed." });
  }
});

// GET /register - Register page
app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/"); // Redirect if already logged in
  res.render("register", { title: "Register", error: null });
});

// POST /register - Handle user registration and initial course assignment
app.post("/register", async (req, res) => {
  const { email, password, courses } = req.body;
  try {
    const userRecord = await auth.createUser({ email, password });
    const parsedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c)
      : [];

    await db.ref(`lecturers/${userRecord.uid}`).set({
      email,
      courses: parsedCourses,
    });

    req.session.user = userRecord.uid;
    req.session.courses = parsedCourses;
    req.session.current_course =
      parsedCourses.length > 0 ? parsedCourses[0] : null;

    res.redirect("/");
  } catch (error) {
    console.error("Registration error:", error);
    let errorMessage = error.message;
    if (error.code === "auth/email-already-in-use") {
      errorMessage = "This email is already registered.";
    } else if (error.code === "auth/weak-password") {
      errorMessage = "Password is too weak. Must be at least 6 characters.";
    }
    res.render("register", { title: "Register", error: errorMessage });
  }
});

// GET /logout - Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/login");
  });
});

// POST /stream - Mark attendance via facial recognition
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
      message:
        "No course selected. Please select a course from the profile menu.",
    });
  }

  try {
    const studentRef = db.ref(`students/${student_id}`);
    const studentSnapshot = await studentRef.once("value");
    const student = studentSnapshot.val();

    if (!student) {
      return res.json({
        status: "invalid_id",
        message: "Student not found in records.",
      });
    }

    // Check if the student is assigned to the current course
    if (!student.courses || !student.courses.includes(currentCourse)) {
      return res.json({
        status: "invalid_course",
        message: `Student (${student.name}) is not assigned to ${currentCourse}.`,
      });
    }

    // Check if attendance already marked for today for this course
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const attendanceRef = db.ref(`attendance/${student_id}`);
    const attendanceSnapshot = await attendanceRef.once("value");
    const records = attendanceSnapshot.val();

    let alreadyMarkedToday = false;
    for (const recordId in records) {
      const record = records[recordId];
      const recordDate = new Date(record.date).toISOString().split("T")[0];
      if (recordDate === today && record.course === currentCourse) {
        alreadyMarkedToday = true;
        break;
      }
    }

    if (alreadyMarkedToday) {
      return res.json({
        status: "already_marked",
        student_id,
        name: student.name || "Unknown",
        message: "Attendance already marked for today.",
      });
    }

    // Mark attendance
    await attendanceRef.push({
      date: new Date().toISOString(),
      course: currentCourse,
      lecturerId: lecturerId, // Record which lecturer marked it
    });

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

// GET /attendance - Attendance History page
app.get("/attendance", isAuthenticated, async (req, res) => {
  const attendanceSnapshot = await db.ref("attendance").once("value");
  const studentsSnapshot = await db.ref("students").once("value");

  const attendance = attendanceSnapshot.val() || {};
  const students = studentsSnapshot.val() || {};

  res.render("attendance", {
    title: "Attendance History",
    attendance: attendance,
    students: students,
    course: req.session.current_course || "N/A", // The currently selected course
    session: req.session,
  });
});

// DELETE /attendance/:student_id/:record_id - Delete attendance record
app.delete(
  "/attendance/:student_id/:record_id",
  isAuthenticated,
  async (req, res) => {
    const { student_id, record_id } = req.params;
    try {
      await db.ref(`attendance/${student_id}/${record_id}`).remove();
      res
        .status(200)
        .json({ status: "success", message: "Attendance record deleted." });
    } catch (error) {
      console.error("Error deleting attendance record:", error);
      res
        .status(500)
        .json({
          status: "error",
          message: "Failed to delete attendance record.",
        });
    }
  }
);

// GET /students - Student Management page
app.get("/students", isAuthenticated, async (req, res) => {
  const studentsSnapshot = await db.ref("students").once("value");
  const students = studentsSnapshot.val() || {};

  res.render("students", {
    title: "Manage Students",
    students: students,
    course: req.session.current_course || "N/A", // The currently selected course
    session: req.session,
  });
});

// POST /students - Add/Upload Students
app.post("/students", isAuthenticated, async (req, res) => {
  const currentCourse = req.session.current_course;
  if (!currentCourse) {
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "No course selected. Please select a course from the profile menu to add/upload students."
      )}`
    );
  }

  // Handle XLSX upload
  if (req.files && req.files.file) {
    const file = req.files.file;
    // Allow lecturer to specify a course for uploaded students if different from current_course
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

      const studentUpdates = {}; // Batch update object

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip header row

        const name = row.getCell(1).value;
        const matric_no = row.getCell(2).value;
        const department = row.getCell(3).value;
        const level = row.getCell(4).value;

        if (name && matric_no && department && level) {
          const student_id = matric_no.toString().trim(); // Ensure string and no whitespace

          // Fetch existing student data to merge courses
          // IMPORTANT: This is asynchronous. A batch update after all rows are processed is better.
          // For simplicity here, I'll assume that new students are primarily assigned to this course,
          // and for existing students, the course is added if not present.
          // A more robust solution would collect all updates and then apply them in one db.ref().update() call.
          // For now, we'll fetch existing courses synchronously for each row, which might be slow for huge files.
          // Let's refine this to make it more efficient.

          // This approach will perform N reads and N writes for N rows.
          // For truly large files, a better approach is to read all rows,
          // then query Firebase for all existing students in one go,
          // then merge data in memory, then perform one large update.

          // Simplified approach for demonstration:
          studentUpdates[`students/${student_id}`] = {
            name,
            matric_no: student_id,
            department,
            level: level.toString(),
            // courses will be handled by the update loop below
          };

          // To ensure courses are properly merged, we need to read existing courses first.
          // This requires `await` inside the loop, which `eachRow` doesn't directly support well.
          // A better pattern:
          // 1. Read all rows into an array of objects.
          // 2. Map student_ids from array.
          // 3. Fetch all existing students in one query.
          // 4. Merge new data with existing data (especially courses).
          // 5. Perform a single batch update.

          // For current quick demo, assuming we'll add course to student's courses array
          // if not present. If student already has courses, we ensure the `courseToAssign` is added.
          // This needs to be done *after* fetching existing student data.
          // The current single-student add and edit already do this.
          // For XLSX, the simplest is to just add the student with the course,
          // and lecturer must ensure the XLSX doesn't overwrite existing courses.
          // Let's stick to the simpler approach of adding the course if not present.
        }
      });

      // Now, process the collected updates and ensure courses are merged
      const studentIdsToUpdate = Object.keys(studentUpdates).map(
        (path) => path.split("/")[1]
      );
      const existingStudentsSnapshot = await db.ref("students").once("value");
      const existingStudents = existingStudentsSnapshot.val() || {};

      const finalUpdates = {};
      for (const studentPath in studentUpdates) {
        const student_id = studentPath.split("/")[1];
        const newStudentData = studentUpdates[studentPath];
        const existingStudent = existingStudents[student_id];

        let courses =
          existingStudent && existingStudent.courses
            ? existingStudent.courses
            : [];
        if (!courses.includes(courseToAssign)) {
          courses.push(courseToAssign);
        }
        finalUpdates[studentPath] = { ...newStudentData, courses };
      }

      await db.ref().update(finalUpdates);

      return res.redirect(
        "/students?success=Students from XLSX uploaded successfully!"
      );
    } catch (error) {
      console.error("Error processing XLSX upload:", error);
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Failed to upload XLSX: " + error.message
        )}`
      );
    }
  }
  // Handle single student addition (with image)
  else if (req.body.name && req.body.matric_no) {
    const { name, matric_no, department, level, course_to_add_student } =
      req.body;
    const student_id = matric_no.trim(); // Use matric_no as ID
    const assignedCourse = course_to_add_student || currentCourse;

    if (!assignedCourse) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Please select a course to assign the student to."
        )}`
      );
    }

    try {
      // Fetch existing student data to merge courses
      const studentRef = db.ref(`students/${student_id}`);
      const existingStudentSnapshot = await studentRef.once("value");
      const existingStudent = existingStudentSnapshot.val();

      let courses =
        existingStudent && existingStudent.courses
          ? existingStudent.courses
          : [];
      if (!courses.includes(assignedCourse)) {
        courses.push(assignedCourse);
      }

      let studentData = {
        name,
        matric_no: student_id,
        department,
        level: level.toString(),
        courses,
      };

      if (req.files && req.files.face_image) {
        const file = req.files.face_image;
        const filePath = `faces/${student_id}.jpg`;
        await storage
          .file(filePath)
          .save(file.data, { contentType: file.mimetype });
        studentData.face_image = filePath;
      } else if (existingStudent && existingStudent.face_image) {
        // Keep existing image if no new one is uploaded during edit
        studentData.face_image = existingStudent.face_image;
      }

      await db.ref(`students/${student_id}`).set(studentData); // Use set to fully overwrite or create
      return res.redirect("/students?success=Student added successfully!");
    } catch (error) {
      console.error("Error adding student:", error);
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Failed to add student: " + error.message
        )}`
      );
    }
  }
  res.redirect("/students?error=Invalid request for adding student.");
});

// DELETE /students/:student_id - Delete student profile
app.delete("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  try {
    const studentRef = db.ref(`students/${student_id}`);
    const studentSnapshot = await studentRef.once("value");
    const studentData = studentSnapshot.val();

    if (studentData && studentData.face_image) {
      // Optionally delete face image from storage
      await storage
        .file(studentData.face_image)
        .delete()
        .catch((err) => {
          console.warn(
            `Could not delete image for ${student_id}:`,
            err.message
          );
          // Don't fail the entire deletion if image deletion fails
        });
    }
    await studentRef.remove(); // Remove student profile
    res
      .status(200)
      .json({
        status: "success",
        message: "Student profile deleted (attendance records remain).",
      });
  } catch (error) {
    console.error("Error deleting student:", error);
    res
      .status(500)
      .json({ status: "error", message: "Failed to delete student." });
  }
});

// POST /students/:student_id - Update student details (used for edit modal)
app.post("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  const { name, department, level, courses } = req.body; // matric_no should be read-only if it's the ID

  try {
    const studentRef = db.ref(`students/${student_id}`);
    const existingStudentSnapshot = await studentRef.once("value");
    const existingStudent = existingStudentSnapshot.val();

    if (!existingStudent) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Student not found for editing."
        )}`
      );
    }

    let updatedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c)
      : [];

    let studentData = {
      name: name || existingStudent.name,
      matric_no: student_id, // Keep matric_no as the ID
      department: department || existingStudent.department,
      level: level || existingStudent.level,
      courses: updatedCourses, // Overwrite with new courses
    };

    if (req.files && req.files.face_image) {
      const file = req.files.face_image;
      const filePath = `faces/${student_id}.jpg`;
      await storage
        .file(filePath)
        .save(file.data, { contentType: file.mimetype });
      studentData.face_image = filePath;
    } else if (existingStudent.face_image) {
      studentData.face_image = existingStudent.face_image; // Retain existing image if not updated
    }

    await studentRef.update(studentData); // Use update to only change specified fields
    res.redirect("/students?success=Student updated successfully!");
  } catch (error) {
    console.error("Error updating student:", error);
    res.redirect(
      `/students?error=${encodeURIComponent(
        "Failed to update student: " + error.message
      )}`
    );
  }
});

// GET /students_data - API to fetch all student data for client-side ML
app.get("/students_data", isAuthenticated, async (req, res) => {
  try {
    const studentsSnapshot = await db.ref("students").once("value");
    const students = studentsSnapshot.val() || {};

    // Generate signed URLs for face images
    const studentsWithSignedUrls = {};
    for (const studentId in students) {
      const student = students[studentId];
      if (student.face_image) {
        // Generate a public URL for the image
        // Make sure your Firebase Storage rules allow public read for 'faces/*'
        // Or generate signed URLs if rules are private and URLs are temporary
        const file = storage.file(student.face_image);
        // Option 1: Public URL (if your storage rules allow public read)
        // const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${storage.name}/o/${encodeURIComponent(student.face_image)}?alt=media`;
        // studentsWithSignedUrls[studentId] = { ...student, face_image_url: publicUrl };

        // Option 2: Generate Signed URLs (more secure)
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000, // URL valid for 1 hour
        });
        studentsWithSignedUrls[studentId] = { ...student, face_image_url: url };
      } else {
        studentsWithSignedUrls[studentId] = student;
      }
    }
    res.json(studentsWithSignedUrls);
  } catch (error) {
    console.error("Error fetching students data for ML:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch student data for recognition." });
  }
});

// GET /dashboard - Dashboard page
app.get("/dashboard", isAuthenticated, async (req, res) => {
  const attendanceSnapshot = await db.ref("attendance").once("value");
  const studentsSnapshot = await db.ref("students").once("value");

  res.render("dashboard", {
    title: "Dashboard",
    attendance: attendanceSnapshot.val() || {},
    students: studentsSnapshot.val() || {},
    course: req.session.current_course || "N/A",
    session: req.session,
  });
});

// GET /add_courses - Page to manage lecturer's courses
app.get("/add_courses", isAuthenticated, async (req, res) => {
  res.render("add_courses", {
    title: "Manage My Courses",
    courses: req.session.courses || [],
    error: null,
    success: null,
    session: req.session,
  });
});

// POST /add_courses - Add new courses to lecturer's profile
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

  const courseToAdd = new_course.trim().toUpperCase(); // Standardize course names

  try {
    const lecturerRef = db.ref(`lecturers/${lecturerId}`);
    const lecturerSnapshot = await lecturerRef.once("value");
    const lecturerData = lecturerSnapshot.val();

    let currentCourses = lecturerData.courses || [];
    if (!currentCourses.includes(courseToAdd)) {
      currentCourses.push(courseToAdd);
      await lecturerRef.update({ courses: currentCourses });
      req.session.courses = currentCourses; // Update session
      // If it's the first course, set it as current
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

// DELETE /courses/:course_code - Remove a course from lecturer's profile
app.delete("/courses/:course_code", isAuthenticated, async (req, res) => {
  const { course_code } = req.params;
  const lecturerId = req.session.user;

  try {
    const lecturerRef = db.ref(`lecturers/${lecturerId}`);
    const lecturerSnapshot = await lecturerRef.once("value");
    const lecturerData = lecturerSnapshot.val();

    let currentCourses = lecturerData.courses || [];
    const updatedCourses = currentCourses.filter((c) => c !== course_code);

    if (updatedCourses.length === currentCourses.length) {
      return res
        .status(404)
        .json({ status: "error", message: "Course not found in your list." });
    }

    await lecturerRef.update({ courses: updatedCourses });
    req.session.courses = updatedCourses; // Update session

    // If the removed course was the current active course, switch to another or null
    if (req.session.current_course === course_code) {
      req.session.current_course =
        updatedCourses.length > 0 ? updatedCourses[0] : null;
    }

    res
      .status(200)
      .json({ status: "success", message: `Course '${course_code}' removed.` });
  } catch (error) {
    console.error("Error removing course:", error);
    res
      .status(500)
      .json({
        status: "error",
        message: `Failed to remove course: ${error.message}`,
      });
  }
});

// POST /switch_course - Switch lecturer's active course
app.post("/switch_course", isAuthenticated, (req, res) => {
  const { course } = req.body;
  if (req.session.courses && req.session.courses.includes(course)) {
    req.session.current_course = course;
  }
  // Redirect back to the previous page or home if no referer
  res.redirect(req.headers.referer || "/");
});

// GET /generate_report/:courseCode - Generate Excel Report
app.get("/generate_report/:courseCode", isAuthenticated, async (req, res) => {
  const courseCode = req.params.courseCode;
  // Ensure the lecturer is authorized to generate report for this course
  if (!req.session.courses || !req.session.courses.includes(courseCode)) {
    return res.status(403).send("Unauthorized: You do not manage this course.");
  }

  const [attendanceSnapshot, studentsSnapshot] = await Promise.all([
    db.ref("attendance").once("value"),
    db.ref("students").once("value"),
  ]);
  const attendance = attendanceSnapshot.val() || {};
  const students = studentsSnapshot.val() || {};

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
  const studentAttendanceSummary = {}; // To track present students for this course

  // Populate present students
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

  // Populate absent students (those assigned to the course but not marked present)
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

  const outputPath = path.join(
    __dirname,
    `public/reports/attendance_${courseCode}_${Date.now()}.xlsx`
  );
  // Ensure reports directory exists
  await fs
    .mkdir(path.dirname(outputPath), { recursive: true })
    .catch((e) => {});

  await workbook.xlsx.writeFile(outputPath);

  res.download(outputPath, path.basename(outputPath), async (err) => {
    if (err) {
      console.error("Error downloading file:", err);
      res.status(500).send("Error generating report.");
    }
    try {
      await fs.unlink(outputPath); // Clean up the file after download
    } catch (unlinkErr) {
      console.error("Error deleting temporary report file:", unlinkErr);
    }
  });
});

// Handle unhandled routes (404)
app.use((req, res) => {
  res
    .status(404)
    .render("404", { title: "Page Not Found", session: req.session });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res
    .status(500)
    .render("error", {
      title: "Something Went Wrong",
      error: err.message,
      session: req.session,
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);

