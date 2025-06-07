from flask import Flask, render_template, request, jsonify
import cv2
import numpy as np
import base64
import os

app = Flask(__name__)

@app.route('/')
def home():
    return render_template('index.html', title='Welcome', message='Hello from Flask!')
 
@app.route('/capture', methods=['POST'])
def capture():
    data_url = request.json['image']
    header, encoded = data_url.split(",", 1)
    img_data = base64.b64decode(encoded)  

    # Convert bytes to NumPy array and decode with OpenCV
    nparr = np.frombuffer(img_data, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    cv2.imwrite(CAPTURED_IMAGE, img) # type: ignore

    return jsonify({'status': 'success', 'path': f'/{CAPTURED_IMAGE}'}) # type: ignore
 

@app.route('/attendance')
def attendance():
    return render_template('attendance.html', title='Attendance', message='Hello from Attendance!')

@app.route('/students')
def students():
    return render_template('students.html', title='Students', message='Hello from Students!')

@app.route('/dashboard')
def dashboard():
    return render_template('dashboard.html', title='Welcome', message='Hello from Dashboard!')

@app.route('/login')
def login():
    return render_template('login.html', title='Welcome', message='Hello from Login!')

if __name__ == '__main__':
    app.run(debug=True, use_reloader=True)
