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

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read JSON file synchronously
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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use(fileUpload());
app.use(
  session({
    secret: "your-secret-key",
    resave: false,
    saveUninitialized: false,
  })
);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Routes
app.get("/", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("index", {
    title: "Welcome",
    course: req.session.current_course || "default",
    session: req.session,
  });
});

app.get("/register", (req, res) => {
  res.render("register", { title: "Register", error: null });
});

app.post("/register", async (req, res) => {
  const { email, password, courses } = req.body;
  try {
    const userRecord = await getAuth().createUser({ email, password });
    await db.ref(`lecturers/${userRecord.uid}`).set({
      email,
      courses: courses.split(",").map((c) => c.trim()),
    });
    req.session.user = userRecord.uid;
    req.session.courses = courses.split(",").map((c) => c.trim());
    req.session.current_course = req.session.courses[0];
    res.redirect("/");
  } catch (error) {
    res.render("register", { title: "Register", error: error.message });
  }
});

app.get("/login", (req, res) => {
  res.render("login", { title: "Login", error: null });
});

app.post("/login", async (req, res) => {
  const { idToken } = req.body;
  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const lecturerData = (
      await db.ref(`lecturers/${decodedToken.uid}`).once("value")
    ).val();
    end = true;
    req.session.user = decodedToken.uid;
    req.session.courses = lecturerData.courses;
    req.session.current_course = lecturerData.courses[0];
    res.json({ status: "success" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/attendance", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  res.render("attendance", {
    title: "Attendance",
    course: req.session.current_course || "default",
  });
});

app.post("/stream", async (req, res) => {
  const { student_id } = req.body;
  if (!student_id) return res.json({ status: "no_id" });
  try {
    const student = (
      await db.ref(`students/${student_id}`).once("value")
    ).val();
    if (!student) return res.json({ status: "invalid_id" });
    await db.ref(`attendance/${student_id}`).push({
      date: new Date().toISOString(),
      course: req.session.current_course || "default",
    });
    res.json({
      status: "success",
      student_id,
      name: student.name || "Unknown",
    });
  } catch (error) {
    res.json({ status: "error", error: error.message });
  }
});

app.get("/students", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  db.ref("students").once("value", (snapshot) => {
    res.render("students", {
      title: "Students",
      students: snapshot.val() || {},
      course: req.session.current_course || "default",
      session: req.session,
    });
  });
});

app.post("/students", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  if (req.files && req.files.file) {
    const file = req.files.file;
    if (file.name.endsWith(".xlsx")) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.data);
      const worksheet = workbook.worksheets[0];
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          const student_id = row.getCell(2).value.toString();
          db.ref(`students/${student_id}`).set({
            name: row.getCell(1).value,
            matric_no: student_id,
            department: row.getCell(3).value,
            level: row.getCell(4).value.toString(),
          });
        }
      });
      return res.redirect("/students");
    }
  } else if (req.body.name) {
    const { name, matric_no, department, level } = req.body;
    const student_id = matric_no;
    const studentData = { name, matric_no, department, level };
    if (req.files && req.files.face_image) {
      const file = req.files.face_image;
      const filePath = `faces/${student_id}.jpg`;
      await storage.file(filePath).save(file.data);
      studentData.face_image = filePath;
    }
    await db.ref(`students/${student_id}`).set(studentData);
    return res.redirect("/students");
  }
  res.redirect("/students");
});

app.get("/dashboard", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  Promise.all([
    db.ref("attendance").once("value"),
    db.ref("students").once("value"),
  ]).then(([attendanceSnapshot, studentsSnapshot]) => {
    res.render("dashboard", {
      title: "Dashboard",
      attendance: attendanceSnapshot.val() || {},
      students: studentsSnapshot.val() || {},
      course: req.session.current_course || "default",
      session: req.session,
    });
  });
});

app.get("/generate_report/:course", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const course = req.params.course;
  const [attendanceSnapshot, studentsSnapshot] = await Promise.all([
    db.ref("attendance").once("value"),
    db.ref("students").once("value"),
  ]);
  const attendance = attendanceSnapshot.val() || {};
  const students = studentsSnapshot.val() || {};
  const data = [];
  for (const student_id in attendance) {
    for (const record_id in attendance[student_id]) {
      if (attendance[student_id][record_id].course === course) {
        const student = students[student_id] || {};
        data.push({
          Name: student.name || "Unknown",
          "Matric No": student.matric_no || student_id,
          Date: attendance[student_id][record_id].date,
          Status: "Present",
        });
      }
    }
  }
  const absentStudents = Object.keys(students)
    .filter(
      (student_id) =>
        !attendance[student_id] ||
        !Object.values(attendance[student_id]).some(
          (record) => record.course === course
        )
    )
    .map((student_id) => ({
      Name: students[student_id].name,
      "Matric No": student_id,
      Date: new Date().toISOString(),
      Status: "Absent",
    }));
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Attendance");
  worksheet.columns = [
    { header: "Name", key: "Name", width: 20 },
    { header: "Matric No", key: "Matric No", width: 15 },
    { header: "Date", key: "Date", width: 25 },
    { header: "Status", key: "Status", width: 10 },
  ];
  worksheet.addRows([...data, ...absentStudents]);
  const outputPath = path.join(
    __dirname,
    `reports/attendance_${course}_${Date.now()}.xlsx`
  );
  await workbook.xlsx.writeFile(outputPath);
  res.download(
    outputPath,
    path.basename(outputPath),
    async () => await fs.unlink(outputPath)
  );
});

app.post("/switch_course", (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  req.session.current_course = req.body.course;
  res.redirect(req.headers.referer || "/");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));
