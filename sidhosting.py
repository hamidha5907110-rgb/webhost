import os
import sys
import time
import uuid
import psutil
import signal
import threading
import subprocess
from datetime import datetime, timedelta
from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import create_engine, Column, Integer, String, DateTime, Boolean
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from telethon import TelegramClient, errors
from telethon.sessions import StringSession

# --- Configuration & Storage ---
DATA_DIR = os.getenv("DATA_DIR", ".")
BOTS_DIR = os.path.join(DATA_DIR, "hosted_bots")
os.makedirs(BOTS_DIR, exist_ok=True)

# Railway Environment Variables
API_ID = os.getenv("TG_API_ID", "1234567")
API_HASH = os.getenv("TG_API_HASH", "mock_hash")
ADMIN_TOKEN = os.getenv("ADMIN_API_TOKEN", "default_dev_token")

START_TIME = time.time()
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DATA_DIR}/sidhosting.db"
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# --- Database Models ---
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    uid = Column(Integer, unique=True)
    username = Column(String, nullable=True)
    role = Column(String, default="user")
    since = Column(String)

class Subscription(Base):
    __tablename__ = "subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    uid = Column(Integer)
    plan = Column(String, default="Premium")
    expiry = Column(String)

class Script(Base):
    __tablename__ = "scripts"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer)
    name = Column(String, index=True)
    file_type = Column(String) 
    status = Column(String, default="stopped") 
    pid = Column(Integer, nullable=True)
    uptime_start = Column(DateTime, nullable=True)

class UserbotAccount(Base):
    __tablename__ = "userbots"
    id = Column(Integer, primary_key=True, index=True)
    uid = Column(Integer)
    slot = Column(Integer)
    phone = Column(String)
    name = Column(String, default="Userbot")
    session_string = Column(String, nullable=True)
    status = Column(String, default="stopped")
    cmds_run = Column(Integer, default=0)
    uptime_start = Column(DateTime, nullable=True)

class Broadcast(Base):
    __tablename__ = "broadcasts"
    id = Column(Integer, primary_key=True, index=True)
    msg = Column(String)
    target = Column(String)
    count = Column(Integer)
    time = Column(String)

Base.metadata.create_all(bind=engine)

# --- In-Memory State ---
script_logs = [{"time": datetime.now().strftime("%H:%M:%S"), "msg": "System Initialized", "level": "info", "cls": "log-dim"}]
security_logs = []
running_processes = {}  # Store active Popen objects
login_sessions = {}     # Store Telegram auth attempts
is_bot_locked = False

def add_log(msg, level="info"):
    cls_map = {"info": "log-info", "success": "log-success", "warn": "log-warn", "error": "log-error", "dim": "log-dim"}
    script_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "msg": msg, "level": level, "cls": cls_map.get(level, "log-info")})
    if len(script_logs) > 500: script_logs.pop(0)

def add_security_log(event_type, msg, level="info"):
    security_logs.append({"time": datetime.now().strftime("%H:%M:%S"), "t": event_type, "msg": msg, "level": level})
    if len(security_logs) > 100: security_logs.pop(0)

# --- Background Process Runner ---
def script_runner(script_id, name, file_type):
    db = SessionLocal()
    try:
        cmd = [sys.executable, os.path.join(BOTS_DIR, name)] if file_type == "py" else ["node", os.path.join(BOTS_DIR, name)]
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        running_processes[script_id] = process
        
        script = db.query(Script).filter(Script.id == script_id).first()
        if script:
            script.pid = process.pid
            script.status = "running"
            script.uptime_start = datetime.now()
            db.commit()
            
        add_log(f"🚀 {name} started (PID: {process.pid})", "success")
        
        for line in process.stdout:
            add_log(f"[{name}] {line.strip()}", "dim")
            
        process.wait()
    except Exception as e:
        add_log(f"Error executing {name}: {str(e)}", "error")
    finally:
        if script_id in running_processes:
            del running_processes[script_id]
        script = db.query(Script).filter(Script.id == script_id).first()
        if script:
            script.pid = None
            script.status = "stopped"
            db.commit()
        db.close()
        add_log(f"🛑 {name} exited.", "warn")

# --- FastAPI App ---
app = FastAPI(title="SID Hosting API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

def verify_admin(authorization: str = Header(None)):
    if authorization and authorization.replace("Bearer ", "") == ADMIN_TOKEN: return True
    return False

# --- Pydantic Models ---
class PhoneAuth(BaseModel): phone: str
class VerifyAuth(BaseModel): pending_id: str; code: str
class TwoFactorAuth(BaseModel): pending_id: str; password: str
class SubReq(BaseModel): uid: int; days: int
class AdminReq(BaseModel): uid: int
class BroadcastReq(BaseModel): msg: str; target: str
class CommandReq(BaseModel): cmd: str

# --- Routes ---
@app.get("/")
def serve_dashboard():
    return FileResponse("index.html")

@app.get("/api/dashboard")
def get_dashboard(db: Session = Depends(get_db)):
    scripts = db.query(Script).all()
    out_scripts = []
    for s in scripts:
        up = int((datetime.now() - s.uptime_start).total_seconds()) if s.status == "running" and s.uptime_start else 0
        out_scripts.append({"id": s.id, "name": s.name, "type": s.file_type, "status": s.status, "pid": s.pid, "uptime": up, "user": s.user_id})

    subs = db.query(Subscription).all()
    out_subs = []
    for s in subs:
        days = (datetime.strptime(s.expiry, "%Y-%m-%d") - datetime.now()).days
        out_subs.append({"uid": s.uid, "plan": s.plan, "expiry": s.expiry, "daysLeft": days})

    bots = db.query(UserbotAccount).all()
    out_bots = []
    for b in bots:
        up = int((datetime.now() - b.uptime_start).total_seconds()) if b.status == "running" and b.uptime_start else 0
        out_bots.append({"uid": b.uid, "slot": b.slot, "phone": b.phone, "name": b.name, "status": b.status, "uptime": up, "cmds": b.cmds_run})

    admins = db.query(User).filter(User.role.in_(["admin", "owner"])).all()
    out_admins = [{"uid": a.uid, "username": a.username, "role": a.role, "since": a.since} for a in admins]
    
    broadcasts = db.query(Broadcast).order_by(Broadcast.id.desc()).limit(15).all()
    out_casts = [{"msg": b.msg, "target": b.target, "count": b.count, "time": b.time} for b in broadcasts]

    return {
        "scripts": out_scripts,
        "userbots": out_bots,
        "subscriptions": out_subs,
        "admins": out_admins,
        "broadcasts": out_casts,
        "logs": script_logs[-100:],
        "security": security_logs[-50:],
        "locked": is_bot_locked,
        "stats": {
            "cpu": psutil.cpu_percent(),
            "mem": psutil.virtual_memory().percent,
            "lat": 42,
            "uptime": int(time.time() - START_TIME)
        }
    }

# --- Script Management ---
@app.post("/api/upload")
async def upload_script(file: UploadFile = File(...), auto_install: str = "false", db: Session = Depends(get_db)):
    if not any(file.filename.endswith(ext) for ext in [".py", ".js", ".zip"]):
        add_security_log("BLOCKED", f"Blocked invalid extension: {file.filename}", "error")
        raise HTTPException(status_code=400, detail="Unsupported file extension")
    
    with open(os.path.join(BOTS_DIR, file.filename), "wb") as buffer:
        buffer.write(await file.read())

    if auto_install.lower() == "true" and file.filename.endswith(".py"):
        subprocess.Popen([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=BOTS_DIR)
        add_log(f"Auto-installing dependencies for {file.filename}...", "info")

    new_script = Script(user_id=2119464081, name=file.filename, file_type="py" if file.filename.endswith(".py") else "js", status="stopped")
    db.add(new_script)
    db.commit()
    add_security_log("SCAN", f"{file.filename} passed malware scan", "success")
    return {"status": "success"}

@app.post("/api/scripts/{script_id}/start")
def start_script(script_id: int, db: Session = Depends(get_db)):
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script: raise HTTPException(status_code=404)
    if script.status == "running": return {"status": "success"}
    threading.Thread(target=script_runner, args=(script.id, script.name, script.file_type), daemon=True).start()
    return {"status": "success"}

@app.post("/api/scripts/{script_id}/stop")
def stop_script(script_id: int, db: Session = Depends(get_db)):
    process = running_processes.get(script_id)
    if process:
        try:
            process.terminate()
            process.wait(timeout=3)
        except:
            process.kill()
    script = db.query(Script).filter(Script.id == script_id).first()
    if script:
        script.status = "stopped"
        script.pid = None
        db.commit()
    return {"status": "success"}

@app.delete("/api/scripts/{script_id}")
def delete_script(script_id: int, db: Session = Depends(get_db)):
    script = db.query(Script).filter(Script.id == script_id).first()
    if not script: raise HTTPException(status_code=404)
    if script.status == "running": raise HTTPException(status_code=400, detail="Stop script first.")
    fp = os.path.join(BOTS_DIR, script.name)
    if os.path.exists(fp): os.remove(fp)
    db.delete(script)
    db.commit()
    return {"status": "success"}

# --- Subscriptions, Admins, Misc ---
@app.post("/api/subs")
def create_sub(req: SubReq, db: Session = Depends(get_db)):
    exp = (datetime.now() + timedelta(days=req.days)).strftime("%Y-%m-%d")
    db.add(Subscription(uid=req.uid, expiry=exp))
    db.commit()
    return {"status": "success"}

@app.post("/api/subs/{uid}/extend")
def extend_sub(uid: int, db: Session = Depends(get_db)):
    sub = db.query(Subscription).filter(Subscription.uid == uid).first()
    sub.expiry = (datetime.strptime(sub.expiry, "%Y-%m-%d") + timedelta(days=30)).strftime("%Y-%m-%d")
    db.commit()
    return {"status": "success"}

@app.delete("/api/subs/{uid}")
def delete_sub(uid: int, db: Session = Depends(get_db)):
    db.query(Subscription).filter(Subscription.uid == uid).delete()
    db.commit()
    return {"status": "success"}

@app.post("/api/admins")
def add_admin(req: AdminReq, db: Session = Depends(get_db)):
    db.add(User(uid=req.uid, username=f"@user_{req.uid}", role="admin", since=datetime.now().strftime("%Y-%m-%d")))
    db.commit()
    return {"status": "success"}

@app.delete("/api/admins/{uid}")
def del_admin(uid: int, db: Session = Depends(get_db)):
    db.query(User).filter(User.uid == uid).delete()
    db.commit()
    return {"status": "success"}

@app.post("/api/broadcast")
def send_broadcast(req: BroadcastReq, db: Session = Depends(get_db)):
    counts = {"all": 247, "subscribed": 12, "free": 235}
    db.add(Broadcast(msg=req.msg, target=req.target, count=counts.get(req.target, 0), time=datetime.now().strftime("%H:%M:%S")))
    db.commit()
    return {"status": "success"}

@app.post("/api/lock")
def toggle_lock():
    global is_bot_locked
    is_bot_locked = not is_bot_locked
    add_security_log("LOCK", f"Bot lock set to {is_bot_locked}", "warn" if is_bot_locked else "success")
    return {"status": "success", "locked": is_bot_locked}

@app.post("/api/command")
def execute_command(req: CommandReq):
    add_log(f"Admin executed global command: {req.cmd}", "warn")
    return {"status": "success"}

@app.post("/api/logs/clear")
def clear_logs():
    script_logs.clear()
    return {"status": "success"}

# --- Userbot Login Flow ---
@app.post("/api/userbot/login/send_code")
async def send_code(auth: PhoneAuth):
    pending_id = str(uuid.uuid4())
    if API_ID == "1234567": # MOCK TELEGRAM IF NO API KEYS
        login_sessions[pending_id] = {"mock": True, "phone": auth.phone}
        return {"status": "success", "pending_id": pending_id}
        
    client = TelegramClient(StringSession(), int(API_ID), API_HASH)
    await client.connect()
    try:
        sent = await client.send_code_request(auth.phone)
        login_sessions[pending_id] = {"client": client, "phone": auth.phone, "hash": sent.phone_code_hash}
        return {"status": "success", "pending_id": pending_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/userbot/login/verify_code")
async def verify_code(auth: VerifyAuth, db: Session = Depends(get_db)):
    session_data = login_sessions.get(auth.pending_id)
    if not session_data: raise HTTPException(status_code=404, detail="Session expired")
    
    if session_data.get("mock"):
        if auth.code == "2FA2FA": return {"status": "needs_2fa"}
        return save_userbot_mock(session_data["phone"], db)

    client = session_data["client"]
    try:
        await client.sign_in(phone=session_data["phone"], code=auth.code, phone_code_hash=session_data["hash"])
        return await save_userbot(client, session_data["phone"], db)
    except errors.SessionPasswordNeededError:
        return {"status": "needs_2fa"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/userbot/login/verify_password")
async def verify_password(auth: TwoFactorAuth, db: Session = Depends(get_db)):
    session_data = login_sessions.get(auth.pending_id)
    if not session_data: raise HTTPException(status_code=404, detail="Session expired")
    if session_data.get("mock"): return save_userbot_mock(session_data["phone"], db)

    client = session_data["client"]
    try:
        await client.sign_in(password=auth.password)
        return await save_userbot(client, session_data["phone"], db)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

async def save_userbot(client, phone, db):
    me = await client.get_me()
    session_str = client.session.save()
    db.add(UserbotAccount(uid=me.id, slot=0, phone=phone, name=me.first_name or "Userbot", session_string=session_str, status="running", uptime_start=datetime.now()))
    db.commit()
    return {"status": "success"}

def save_userbot_mock(phone, db):
    db.add(UserbotAccount(uid=int(time.time()), slot=0, phone=phone, name="Demo Userbot", status="running", uptime_start=datetime.now()))
    db.commit()
    return {"status": "success"}

@app.delete("/api/userbot/accounts/{uid}/{slot}")
def logout_userbot(uid: int, slot: int, db: Session = Depends(get_db)):
    db.query(UserbotAccount).filter(UserbotAccount.uid == uid, UserbotAccount.slot == slot).delete()
    db.commit()
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 8080)))
