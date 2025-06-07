from flask import Flask, render_template

app = Flask(__name__)

@app.route('/')
def home():
    return render_template('index.html', title='Welcome', message='Hello from Flask!')

@app.route('/attendance')
def attendance():
    return render_template('attendance.html', title='Welcome', message='Hello from Attendance!')

@app.route('/students')
def students():
    return render_template('students.html', title='Welcome', message='Hello from Students!')

@app.route('/dashboard')
def dashboard():
    return render_template('dashboard.html', title='Welcome', message='Hello from Dashboard!')

@app.route('/login')
def login():
    return render_template('login.html', title='Welcome', message='Hello from Login!')

if __name__ == '__main__':
    app.run(debug=True, use_reloader=True)
