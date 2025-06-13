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

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccount = JSON.parse(
  readFileSync("./firebase_credentials.json", "utf8")
);

const app = express();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://attendance-e75b0-default-rtdb.firebaseio.com/",
  storageBucket: "attendance-e75b0.appspot.com",
});
const db = getDatabase();
const storage = getStorage().bucket();
const auth = getAuth();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
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
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.AUTH_DOMAIN,
  projectId: process.env.PROJECT_ID,
  storageBucket: process.env.STORAGE_BUCKET,
  messagingSenderId: process.env.MESSAGING_SENDER_ID,
  appId: process.env.APP_ID,
  measurementId: process.env.MEASUREMENT_ID,
};

app.use(async (req, res, next) => {
  if (req.session.user) {
    try {
      const lecturerRef = db.ref(`lecturers/${req.session.user}`);
      const lecturerSnapshot = await lecturerRef.once("value");
      const lecturerData = lecturerSnapshot.val();

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

const isAuthenticated = (req, res, next) => {
  if (req.session.user) {
    return next();
  }
  res.redirect("/login");
};

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
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerData = (
      await db.ref(`lecturers/${decodedToken.uid}`).once("value")
    ).val();

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
  console.log("Register attempt:", req.body);
  const { idToken, courses } = req.body;
  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    const lecturerUid = decodedToken.uid;
    const lecturerEmail = decodedToken.email;

    const parsedCourses = courses
      ? courses
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c)
      : [];

    const existingLecturer = (
      await db.ref(`lecturers/${lecturerUid}`).once("value")
    ).val();
    if (existingLecturer) {
      await db.ref(`lecturers/${lecturerUid}`).update({
        courses: [
          ...new Set([...(existingLecturer.courses || []), ...parsedCourses]),
        ],
      });
    } else {
      await db.ref(`lecturers/${lecturerUid}`).set({
        email: lecturerEmail,
        courses: parsedCourses,
      });
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

    if (!student.courses || !student.courses.includes(currentCourse)) {
      return res.json({
        status: "invalid_course",
        message: `Student (${student.name}) is not assigned to ${currentCourse}.`,
      });
    }

    const today = new Date().toISOString().split("T")[0];
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

    await attendanceRef.push({
      date: new Date().toISOString(),
      course: currentCourse,
      lecturerId: lecturerId,
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
      res.status(500).json({
        status: "error",
        message: "Failed to delete attendance record.",
      });
    }
  }
);

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

app.post("/students", isAuthenticated, async (req, res) => {
  const currentCourse = req.session.current_course;
  if (!currentCourse) {
    return res.redirect(
      `/students?error=${encodeURIComponent(
        "No course selected. Please select a course from the profile menu to add/upload students."
      )}`
    );
  }

  if (req.files && req.files.file) {
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

      const studentUpdates = {};

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        const name = row.getCell(1).value;
        const matric_no = row.getCell(2).value;
        const department = row.getCell(3).value;
        const level = row.getCell(4).value;

        if (name && matric_no && department && level) {
          const student_id = matric_no.toString().trim();
          studentUpdates[`students/${student_id}`] = {
            name,
            matric_no: student_id,
            department,
            level: level.toString(),
          };
        }
      });

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
  } else if (req.body.name && req.body.matric_no) {
    const { name, matric_no, department, level, course_to_add_student } =
      req.body;
    const student_id = matric_no.trim();
    const assignedCourse = course_to_add_student || currentCourse;

    if (!assignedCourse) {
      return res.redirect(
        `/students?error=${encodeURIComponent(
          "Please select a course to assign the student to."
        )}`
      );
    }

    try {
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
        studentData.face_image = existingStudent.face_image;
      }

      await db.ref(`students/${student_id}`).set(studentData);
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

app.delete("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  try {
    const studentRef = db.ref(`students/${student_id}`);
    const studentSnapshot = await studentRef.once("value");
    const studentData = studentSnapshot.val();

    if (studentData && studentData.face_image) {
      await storage
        .file(studentData.face_image)
        .delete()
        .catch((err) => {
          console.warn(
            `Could not delete image for ${student_id}:`,
            err.message
          );
        });
    }
    await studentRef.remove();
    res.status(200).json({
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

app.post("/students/:student_id", isAuthenticated, async (req, res) => {
  const { student_id } = req.params;
  const { name, department, level, courses } = req.body;

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
      matric_no: student_id,
      department: department || existingStudent.department,
      level: level || existingStudent.level,
      courses: updatedCourses,
    };

    if (req.files && req.files.face_image) {
      const file = req.files.face_image;
      const filePath = `faces/${student_id}.jpg`;
      await storage
        .file(filePath)
        .save(file.data, { contentType: file.mimetype });
      studentData.face_image = filePath;
    } else if (existingStudent.face_image) {
      studentData.face_image = existingStudent.face_image;
    }

    await studentRef.update(studentData);
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

app.get("/students_data", isAuthenticated, async (req, res) => {
  try {
    const studentsSnapshot = await db.ref("students").once("value");
    const students = studentsSnapshot.val() || {};

    const studentsWithSignedUrls = {};
    for (const studentId in students) {
      const student = students[studentId];
      if (student.face_image) {
        const file = storage.file(student.face_image);
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 60 * 60 * 1000,
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

app.get("/add_courses", isAuthenticated, async (req, res) => {
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
    const lecturerRef = db.ref(`lecturers/${lecturerId}`);
    const lecturerSnapshot = await lecturerRef.once("value");
    const lecturerData = lecturerSnapshot.val();

    let currentCourses = lecturerData.courses || [];
    if (!currentCourses.includes(courseToAdd)) {
      currentCourses.push(courseToAdd);
      await lecturerRef.update({ courses: currentCourses });
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

  const outputPath = path.join(
    __dirname,
    `public/reports/attendance_${courseCode}_${Date.now()}.xlsx`
  );
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
      await fs.unlink(outputPath);
    } catch (unlinkErr) {
      console.error("Error deleting temporary report file:", unlinkErr);
    }
  });
});

app.use((req, res) => {
  res
    .status(404)
    .render("404", { title: "Page Not Found", session: req.session });
});

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
