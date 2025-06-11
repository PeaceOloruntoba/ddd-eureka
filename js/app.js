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
import fs from "fs/promises"; // For async file operations
import { readFileSync } from "fs"; // For sync file read for credentials

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read JSON file synchronously for Firebase credentials
const serviceAccount = JSON.parse(
  readFileSync("./firebase_credentials.json", "utf8")
);

const app = express();

// Firebase setup
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://attendance-e75b0-default-rtdb.firebaseio.com/",
  storageBucket: "attendance-e75b0.appspot.com",
});
const db = getDatabase();
const storage = getStorage().bucket();
const auth = getAuth(); // Initialize Firebase Auth admin SDK

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public")); // For static assets like CSS
app.use(fileUpload()); // For handling file uploads (images, excel)
app.use(
  session({
    secret: "your-secret-key-very-strong-and-random", // CHANGE THIS TO A STRONG, RANDOM STRING
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production" }, // Use secure cookies in production
  })
);
app.set("view engine", "ejs"); // Set EJS as the templating engine
app.set("views", path.join(__dirname, "views")); // Specify views directory

// Middleware to check authentication and set session data for all routes
app.use(async (req, res, next) => {
  if (req.session.user) {
    // If user is in session, try to fetch their data
    try {
      const lecturerRef = db.ref(`lecturers/${req.session.user}`);
      const lecturerSnapshot = await lecturerRef.once("value");
      const lecturerData = lecturerSnapshot.val();
      if (lecturerData) {
        req.session.courses = lecturerData.courses || [];
        // Set current_course if not already set or if it's no longer valid
        if (
          !req.session.current_course ||
          !req.session.courses.includes(req.session.current_course)
        ) {
          req.session.current_course =
            req.session.courses.length > 0 ? req.session.courses[0] : null;
        }
      } else {
        // User session exists but user not found in DB, clear session
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

// Home/Root page - Real-time attendance via camera
app.get("/", isAuthenticated, (req, res) => {
  res.render("index", {
    title: "Real-time Attendance",
    course: req.session.current_course || "N/A",
    session: req.session,
  });
});

// Register page
app.get("/register", (req, res) => {
  if (req.session.user) return res.redirect("/"); // Redirect if already logged in
  res.render("register", { title: "Register", error: null });
});

app.post("/register", async (req, res) => {
  const { email, password, courses } = req.body; // courses can be optional
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
    res.render("register", { title: "Register", error: error.message });
  }
});

// Login page
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/"); // Redirect if already logged in
  res.render("login", { title: "Login", error: null });
});

app.post("/login", async (req, res) => {
  const { idToken } = req.body; // ID token from Firebase client SDK
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerData = (
      await db.ref(`lecturers/${decodedToken.uid}`).once("value")
    ).val();

    if (!lecturerData) {
      throw new Error("Lecturer profile not found in database.");
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

// Real-time attendance stream endpoint (for face recognition data)
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
      message: "No course selected. Please select a course.",
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
        message: `Student is not assigned to ${currentCourse}.`,
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

// Attendance History page
app.get("/attendance", isAuthenticated, async (req, res) => {
  const attendanceSnapshot = await db.ref("attendance").once("value");
  const studentsSnapshot = await db.ref("students").once("value");

  const attendance = attendanceSnapshot.val() || {};
  const students = studentsSnapshot.val() || {};

  res.render("attendance", {
    title: "Attendance History",
    attendance: attendance,
    students: students,
    course: req.session.current_course || "N/A",
    session: req.session,
  });
});

// DELETE attendance record
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

// Student Management page
app.get("/students", isAuthenticated, async (req, res) => {
  const studentsSnapshot = await db.ref("students").once("value");
  const students = studentsSnapshot.val() || {};

  res.render("students", {
    title: "Manage Students",
    students: students,
    course: req.session.current_course || "N/A",
    session: req.session,
  });
});

// Add/Upload Students
app.post("/students", isAuthenticated, async (req, res) => {
  const currentCourse = req.session.current_course;
  if (!currentCourse) {
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "No course selected. Please select a course to add students."
      )}`
    );
  }

  // Handle XLSX upload
  if (req.files && req.files.file) {
    const file = req.files.file;
    const courseToUploadStudents =
      req.body.course_to_upload_students || currentCourse;

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

      const updates = {};
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          // Skip header row
          const name = row.getCell(1).value;
          const matric_no = row.getCell(2).value;
          const department = row.getCell(3).value;
          const level = row.getCell(4).value;

          if (name && matric_no && department && level) {
            const student_id = matric_no.toString(); // Ensure it's a string

            // Retrieve existing courses for the student, or initialize if new
            const studentRef = db.ref(`students/${student_id}`);
            studentRef
              .once("value")
              .then((snapshot) => {
                const existingStudent = snapshot.val();
                let courses =
                  existingStudent && existingStudent.courses
                    ? existingStudent.courses
                    : [];

                if (!courses.includes(courseToUploadStudents)) {
                  courses.push(courseToUploadStudents);
                }

                updates[`students/${student_id}`] = {
                  name,
                  matric_no: student_id,
                  department,
                  level: level.toString(),
                  courses: courses, // Assign courses to the student
                };
                // Batch update once all rows are processed, or per row if needed
                db.ref().update(updates); // This will update in batch or per row depending on logic
              })
              .catch((error) =>
                console.error("Error processing Excel row:", error)
              );
          }
        }
      });
      // A small delay or promise.all might be needed if you want to ensure all async updates
      // from eachRow are complete before redirecting. For simplicity, we'll redirect.
      return res.redirect("/students?success=Students uploaded successfully!");
    } catch (error) {
      console.error("Error processing XLSX upload:", error);
      return res.redirect(
        `/students?error=${encodeURIComponent(error.message)}`
      );
    }
  }
  // Handle single student addition (with image)
  else if (req.body.name && req.body.matric_no) {
    const { name, matric_no, department, level, course_to_add_student } =
      req.body;
    const student_id = matric_no;
    const assignedCourse = course_to_add_student || currentCourse; // Use selected course or current

    if (!assignedCourse) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Please select a course to assign the student."
        )}`
      );
    }

    try {
      let studentData = {
        name,
        matric_no: student_id,
        department,
        level: level.toString(),
      };

      // Retrieve existing courses for the student, or initialize if new
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
      studentData.courses = courses;

      if (req.files && req.files.face_image) {
        const file = req.files.face_image;
        const filePath = `faces/${student_id}.jpg`;
        await storage
          .file(filePath)
          .save(file.data, { contentType: file.mimetype });
        studentData.face_image = filePath;
      } else if (existingStudent && existingStudent.face_image) {
        // Keep existing image if no new one is uploaded
        studentData.face_image = existingStudent.face_image;
      }

      await db.ref(`students/${student_id}`).set(studentData);
      return res.redirect("/students?success=Student added successfully!");
    } catch (error) {
      console.error("Error adding student:", error);
      return res.redirect(
        `/students?error=${encodeURIComponent(error.message)}`
      );
    }
  }
  res.redirect("/students?error=Invalid request for adding student.");
});

// DELETE student (only deletes the student profile, attendance records remain)
app.delete("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  try {
    await db.ref(`students/${student_id}`).remove();
    res.status(200).json({ status: "success", message: "Student deleted." });
  } catch (error) {
    console.error("Error deleting student:", error);
    res
      .status(500)
      .json({ status: "error", message: "Failed to delete student." });
  }
});

// UPDATE student details (PUT request for editing)
app.post("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  const { name, matric_no, department, level, courses } = req.body;

  try {
    const studentRef = db.ref(`students/${student_id}`);
    const existingStudentSnapshot = await studentRef.once("value");
    const existingStudent = existingStudentSnapshot.val();

    if (!existingStudent) {
      return res
        .status(404)
        .json({ status: "error", message: "Student not found." });
    }

    let updatedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c)
      : [];

    let studentData = {
      name: name || existingStudent.name,
      matric_no: matric_no || existingStudent.matric_no, // Matric_no might be read-only on UI
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
    res.redirect(`/students?error=${encodeURIComponent(error.message)}`);
  }
});

// Dashboard page
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

// Generate Excel Report
app.get("/generate_report/:courseCode", isAuthenticated, async (req, res) => {
  const courseCode = req.params.courseCode; // Use courseCode from URL parameter
  if (!req.session.courses.includes(courseCode)) {
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
    { header: "Status", key: "Status", width: 10 },
  ];

  const studentAttendanceSummary = {}; // To track if a student has attended at all for this course

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
          Status: "Present",
        });
        studentAttendanceSummary[student_id] = true;
      }
    }
  }

  // Populate absent students (those registered for the course but not in attendance records for it)
  for (const student_id in students) {
    const student = students[student_id];
    // Check if student is assigned to the current course and hasn't appeared in attendance
    if (
      student.courses &&
      student.courses.includes(courseCode) &&
      !studentAttendanceSummary[student_id]
    ) {
      worksheet.addRow({
        Name: student.name || "Unknown",
        "Matric No": student.matric_no || student_id,
        Date: "N/A", // Or a specific date if you're reporting for a particular period
        Time: "N/A",
        Status: "Absent",
      });
    }
  }

  const outputPath = path.join(
    __dirname,
    `reports/attendance_${courseCode}_${Date.now()}.xlsx`
  );
  await workbook.xlsx.writeFile(outputPath);

  res.download(outputPath, path.basename(outputPath), async (err) => {
    if (err) {
      console.error("Error downloading file:", err);
      // Handle error, maybe send a 500 response
    }
    try {
      await fs.unlink(outputPath); // Clean up the file after download
    } catch (unlinkErr) {
      console.error("Error deleting temporary report file:", unlinkErr);
    }
  });
});

// Switch Course
app.post("/switch_course", isAuthenticated, (req, res) => {
  const { course } = req.body;
  if (req.session.courses && req.session.courses.includes(course)) {
    req.session.current_course = course;
  }
  // Redirect back to the previous page or home if no referer
  res.redirect(req.headers.referer || "/");
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/login");
  });
});

// Handle unhandled routes (404)
app.use((req, res) => {
  res.status(404).render("404", { title: "Page Not Found" }); // You might need to create a 404.ejs
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res
    .status(500)
    .render("error", { title: "Something Went Wrong", error: err.message }); // Create an error.ejs
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
