# CBRE Reporting Platform — Synology DS923+ Deployment Guide

## Overview

This deploys the CBRE Reporting Platform to your Synology DS923+ with:
- Persistent SQLite database
- File storage on NAS volumes
- HTTPS with Let's Encrypt
- Remote access via Synology DDNS
- JWT authentication for users

---

## Step 1 — Prepare Synology

### 1.1 Install required packages

DSM Package Center → install:
- **Container Manager** (formerly Docker)
- **Web Station**

### 1.2 Enable SSH (one-time, for setup only)

Control Panel → Terminal & SNMP → Enable SSH service → port 22

You can disable SSH after deployment.

### 1.3 Set up DDNS for remote access

Control Panel → External Access → DDNS → Add:
- **Service Provider**: Synology
- **Hostname**: `cbre-yourname` (you choose) — gives you `cbre-yourname.synology.me`
- **Username/Password**: your Synology Account
- **Get a Let's Encrypt SSL certificate**: ✓ check this

After saving, your NAS is reachable from the internet at `https://cbre-yourname.synology.me`.

### 1.4 Configure router port forwarding

Forward these ports from your router to NAS internal IP (192.168.1.158):
- TCP **80** → 80 (Let's Encrypt validation)
- TCP **443** → 443 (HTTPS)

DSM Control Panel → External Access → Router Configuration can auto-configure if your router supports UPnP.

### 1.5 Firewall (recommended)

Control Panel → Security → Firewall → Edit Rules:
- Allow ports 80, 443, 5001 (DSM)
- Block all other inbound by default
- Optional: Restrict by **country** (allow only Greece) or **IP whitelist**

---

## Step 2 — Deploy CBRE App

### 2.1 Create folder structure on NAS

File Station → create:
```
/docker/cbre/
```

### 2.2 Upload deployment package

Upload the entire `cbre-deploy/` folder to `/docker/cbre/` via File Station.

Final structure:
```
/docker/cbre/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── package.json
│   ├── server.js
│   └── init-db.js
└── frontend/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        └── api.js
```

### 2.3 Create `.env` file

Via SSH or File Station Text Editor, create `/docker/cbre/.env`:

```bash
JWT_SECRET=<paste a long random string here, 48+ chars>
CORS_ORIGIN=https://cbre-yourname.synology.me
```

To generate JWT_SECRET, you can use: https://generate-secret.vercel.app/48

### 2.4 Build & start container

**Option A — via Container Manager UI:**

1. Container Manager → Project → Create
2. **Project Name**: `cbre`
3. **Path**: `/docker/cbre`
4. **Source**: Upload docker-compose.yml (or "Use existing docker-compose.yml")
5. Click **Build** → wait 3-5 min for first build
6. Once built, click **Start**

**Option B — via SSH (faster):**

```bash
ssh admin@192.168.1.158
cd /volume1/docker/cbre
sudo docker compose up -d --build
```

### 2.5 Check it works

In browser: `http://192.168.1.158:3000`

You should see the CBRE login screen.

**Default credentials** (change immediately):
- `antonis` / `ChangeMe!2026` (admin)
- `manos` / `ChangeMe!2026` (finance)
- `kostas` / `ChangeMe!2026` (ops)
- `omiros` / `ChangeMe!2026` (ops)
- `iro` / `ChangeMe!2026` (ops)

---

## Step 3 — Set Up Reverse Proxy + HTTPS

### 3.1 Add reverse proxy rule

Control Panel → Login Portal → Advanced → Reverse Proxy → Create:

**Source:**
- Protocol: **HTTPS**
- Hostname: `cbre-yourname.synology.me`
- Port: **443**

**Destination:**
- Protocol: **HTTP**
- Hostname: `localhost`
- Port: **3000**

**Custom Header tab:**
- Add: `WebSocket` (Create → Websocket)

### 3.2 Bind SSL certificate

Control Panel → Security → Certificate:
- Find your Let's Encrypt cert for `cbre-yourname.synology.me`
- Configure → set as default for your reverse proxy

### 3.3 Test from outside

From your phone (turn off WiFi to use mobile data) browse to:
```
https://cbre-yourname.synology.me
```

You should see the login screen. ✓

---

## Step 4 — Initial Setup

### 4.1 Login as admin and change all passwords

1. Login as `antonis` / `ChangeMe!2026`
2. (We need to add a "Change Password" button in the UI — for now use the API directly via browser console:)

```javascript
fetch("/api/auth/change-password", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${localStorage.getItem("cbre_token")}`
  },
  body: JSON.stringify({ current: "ChangeMe!2026", next: "YourNewStrongPassword!" })
}).then(r=>r.json()).then(console.log);
```

3. Repeat for each user account.

### 4.2 Add new users (admin only)

```javascript
fetch("/api/users", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${localStorage.getItem("cbre_token")}`
  },
  body: JSON.stringify({
    username: "newuser",
    password: "StrongPass!2026",
    name: "New User",
    role: "ops",
    clients: ["Coca-Cola","Pfizer"]  // or "ALL" for admin
  })
}).then(r=>r.json()).then(console.log);
```

---

## Step 5 — Maintenance

### 5.1 Backup data

Hyper Backup (DSM) → schedule daily backup of `/docker/cbre/data/` to:
- USB drive
- Cloud (Synology C2, AWS S3)
- Another NAS

### 5.2 Update the app

When you have a new version of `App.jsx`:

```bash
ssh admin@192.168.1.158
cd /volume1/docker/cbre
# Replace App.jsx with new version (via File Station)
sudo docker compose up -d --build
```

Container will rebuild and restart with new version. Data preserved.

### 5.3 View logs

Container Manager → Container → cbre-reporting → Log

Or via SSH:
```bash
sudo docker compose logs -f
```

### 5.4 View audit log

Login as admin → browser console:
```javascript
fetch("/api/audit", { headers: { Authorization: `Bearer ${localStorage.getItem("cbre_token")}` } })
  .then(r=>r.json()).then(console.table);
```

---

## Security Checklist

- [ ] Changed all default passwords
- [ ] Generated strong JWT_SECRET in `.env`
- [ ] DSM admin uses 2FA
- [ ] Synology Firewall enabled
- [ ] SSL certificate valid (Let's Encrypt auto-renews)
- [ ] Hyper Backup scheduled
- [ ] Disabled SSH after setup (or restrict to trusted IPs)
- [ ] Optional: VPN-only access (Synology VPN Server)

---

## Troubleshooting

### Container won't start
Check logs: `sudo docker compose logs cbre`. Common issues:
- Port 3000 in use → change in docker-compose.yml
- Permission errors → `sudo chown -R 1000:1000 /volume1/docker/cbre/data`

### Cannot login
Verify DB initialized: container logs should show "Database ready. Users: 5"

### 502 Bad Gateway from reverse proxy
Container not running → check Container Manager status.
