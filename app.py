from flask import Flask, render_template, request, jsonify, redirect, url_for
import firebase_admin
from firebase_admin import credentials, auth, db, storage
import cv2
import numpy as np
import base64
import os
import face_recognition
from ultralytics import YOLO
import pandas as pd
from datetime import datetime
import json
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Firebase setup
cred = credentials.Certificate("firebase_credentials.json")
firebase_admin.initialize_app(cred, {
    'databaseURL': 'YOUR_FIREBASE_DATABASE_URL',
    'storageBucket': 'YOUR_FIREBASE_STORAGE_BUCKET'
})
db_ref = db.reference()
bucket = storage.bucket()

# YOLO model for face detection
yolo_model = YOLO("yolo-weights/yolov8n.pt")

# Directory for temporary image storage
CAPTURED_IMAGE_DIR = "static/captured_images"
if not os.path.exists(CAPTURED_IMAGE_DIR):
    os.makedirs(CAPTURED_IMAGE_DIR)

# Load known face encodings
known_face_encodings = []
known_face_ids = []

def load_known_faces():
    global known_face_encodings, known_face_ids
    students_ref = db_ref.child('students')
    students = students_ref.get()
    known_face_encodings = []
    known_face_ids = []
    if students:
        for student_id, data in students.items():
            if 'face_image' in data:
                blob = bucket.blob(data['face_image'])
                temp_file = os.path.join(CAPTURED_IMAGE_DIR, f"{student_id}.jpg")
                blob.download_to_filename(temp_file)
                image = face_recognition.load_image_file(temp_file)
                encodings = face_recognition.face_encodings(image)
                if encodings:
                    known_face_encodings.append(encodings[0])
                    known_face_ids.append(student_id)
                os.remove(temp_file)

load_known_faces()

@app.route('/')
def home():
    return render_template('index.html', title='Welcome', message='Hello from Flask!')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        courses = request.form.getlist('courses')
        try:
            user = auth.create_user(email=email, password=password)
            db_ref.child('lecturers').child(user.uid).set({
                'email': email,
                'courses': courses
            })
            return redirect(url_for('login'))
        except Exception as e:
            return render_template('register.html', title='Register', error=str(e))
    return render_template('register.html', title='Register')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form['email']
        password = request.form['password']
        try:
            # Firebase Authentication doesn't have a direct login method; use client-side SDK or custom token
            # For simplicity, assume client-side handles auth and sends token
            return redirect(url_for('home'))
        except Exception as e:
            return render_template('login.html', title='Login', error=str(e))
    return render_template('login.html', title='Login')

@app.route('/attendance', methods=['GET', 'POST'])
def attendance():
    return render_template('attendance.html', title='Attendance')

@app.route('/stream', methods=['POST'])
def stream():
    data_url = request.json['image']
    header, encoded = data_url.split(",", 1)
    img_data = base64.b64decode(encoded)
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

    # YOLO face detection
    results = yolo_model(img)
    faces = []
    for result in results:
        boxes = result.boxes.xyxy.cpu().numpy()
        for box in boxes:
            x1, y1, x2, y2 = map(int, box[:4])
            face_img = img[y1:y2, x1:x2]
            encodings = face_recognition.face_encodings(face_img)
            if encodings:
                matches = face_recognition.compare_faces(known_face_encodings, encodings[0])
                if True in matches:
                    matched_idx = matches.index(True)
                    student_id = known_face_ids[matched_idx]
                    # Mark attendance
                    attendance_ref = db_ref.child('attendance').child(student_id)
                    attendance_ref.push({
                        'date': datetime.now().strftime('%Y-%m-%d'),
                        'time': datetime.now().strftime('%H:%M:%S'),
                        'course': request.json.get('course', 'default')
                    })
                    return jsonify({'status': 'success', 'student_id': student_id})
    return jsonify({'status': 'no_match'})

@app.route('/students', methods=['GET', 'POST'])
def students():
    if request.method == 'POST':
        if 'file' in request.files:
            file = request.files['file']
            if file.filename.endswith('.xlsx'):
                df = pd.read_excel(file)
                for _, row in df.iterrows():
                    student_id = str(row['Matric No'])
                    student_data = {
                        'name': row['Name'],
                        'matric_no': student_id,
                        'department': row['Department'],
                        'level': str(row['Level'])
                    }
                    # Handle face image upload
                    if 'face_image' in request.files:
                        face_file = request.files['face_image']
                        blob = bucket.blob(f"faces/{student_id}.jpg")
                        blob.upload_from_file(face_file)
                        student_data['face_image'] = f"faces/{student_id}.jpg"
                    db_ref.child('students').child(student_id).set(student_data)
                load_known_faces()
                return redirect(url_for('students'))
    students = db_ref.child('students').get() or {}
    return render_template('students.html', title='Students', students=students)

@app.route('/dashboard')
def dashboard():
    attendance = db_ref.child('attendance').get() or {}
    return render_template('dashboard.html', title='Dashboard', attendance=attendance)

@app.route('/generate_report/<course>')
def generate_report(course):
    attendance = db_ref.child('attendance').get() or {}
    students = db_ref.child('students').get() or {}
    data = []
    for student_id, records in attendance.items():
        if any(record['course'] == course for record in records.values()):
            student = students.get(student_id, {})
            data.append({
                'Name': student.get('name', 'Unknown'),
                'Matric No': student.get('matric_no', student_id),
                'Date': records[list(records.keys())[-1]]['date'],
                'Time': records[list(records.keys())[-1]]['time'],
                'Status': 'Present'
            })
    absent_students = [
        {'Name': student['name'], 'Matric No': student_id, 'Status': 'Absent'}
        for student_id, student in students.items()
        if student_id not in attendance or not any(record['course'] == course for record in attendance[student_id].values())
    ]
    df = pd.DataFrame(data + absent_students)
    output_path = f"static/reports/attendance_{course}_{datetime.now().strftime('%Y%m%d')}.xlsx"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    df.to_excel(output_path, index=False)
    return jsonify({'path': f'/{output_path}'})

@app.route('/switch_course', methods=['POST'])
def switch_course():
    course = request.json['course']
    # Store current course in session or database for the lecturer
    return jsonify({'status': 'success', 'course': course})

if __name__ == '__main__':
    app.run(debug=True, use_reloader=True)