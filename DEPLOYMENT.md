# District Court CJ - Backend Deployment Guide

## VM Details

| Property          | Value                          |
|-------------------|--------------------------------|
| **VM Name**       | `district-court-cj-vm`         |
| **External IP**   | `34.100.212.116`               |
| **Internal IP**   | `10.160.0.7`                   |
| **Zone**          | `asia-south1-a`                |
| **Machine Type**  | `e2-micro`                     |
| **OS**            | Ubuntu 22.04 LTS               |
| **GCP Project**   | `valsco-jurident`              |
| **Boot Disk**     | 10 GB                          |
| **Node.js**       | v20.x                          |
| **Process Manager** | PM2                          |

## Live Endpoints

- **Base URL**: `http://34.100.212.116:3000`
- **Health Check**: `http://34.100.212.116:3000/health`
- **Portal API**: `http://34.100.212.116:3000/api/common`
- **Party Name API**: `http://34.100.212.116:3000/api/partyname`

## Firewall Rules

| Rule Name                        | Protocol | Port | Source        |
|----------------------------------|----------|------|---------------|
| `allow-district-court-cj-3000`   | TCP      | 3000 | `0.0.0.0/0`  |

## SSH into the VM

```bash
gcloud compute ssh district-court-cj-vm --zone=asia-south1-a
```

## Project Location on VM

```
/home/indreshgoswami/district-court-cj/
```

## Environment Configuration

The `.env` file is located at `/home/indreshgoswami/district-court-cj/.env` with the following variables:

```
NODE_ENV=production
PORT=3000
FIREBASE_API_KEY=<your-firebase-api-key>
FIREBASE_AUTH_DOMAIN=valsco-jurident.firebaseapp.com
FIREBASE_PROJECT_ID=valsco-jurident
FIREBASE_STORAGE_BUCKET=valsco-jurident.firebasestorage.app
FIREBASE_MESSAGING_SENDER_ID=<your-sender-id>
FIREBASE_APP_ID=<your-app-id>
FIREBASE_MEASUREMENT_ID=<your-measurement-id>
```

The Firebase service account key is at:
```
/home/indreshgoswami/district-court-cj/src/config/serviceAccountKey.json
```

## Deployment Steps (Future Updates)

### 1. SSH into the VM

```bash
gcloud compute ssh district-court-cj-vm --zone=asia-south1-a
```

### 2. Pull latest code

```bash
cd ~/district-court-cj
git pull origin main
```

### 3. Install dependencies

```bash
npm install
```

### 4. Restart the application

```bash
pm2 restart district-court-cj
```

### Or deploy everything in one command

```bash
gcloud compute ssh district-court-cj-vm --zone=asia-south1-a --command="cd ~/district-court-cj && git pull origin main && npm install && pm2 restart district-court-cj"
```

## Deploy via SCP (without git on VM)

```bash
# From local machine
gcloud compute scp --recurse /Users/indreshgoswami/Downloads/Jr/district-court-cj district-court-cj-vm:~/district-court-cj --zone=asia-south1-a --compress

# Then SSH and restart
gcloud compute ssh district-court-cj-vm --zone=asia-south1-a --command="cd ~/district-court-cj && npm install && pm2 restart district-court-cj"
```

## PM2 Commands

```bash
pm2 status                        # Check process status
pm2 logs district-court-cj        # View logs (live)
pm2 logs district-court-cj --lines 100  # View last 100 lines
pm2 restart district-court-cj     # Restart app
pm2 stop district-court-cj        # Stop app
pm2 delete district-court-cj      # Remove from PM2
pm2 save                          # Save process list for auto-restart
```

## Cron Jobs (Configured in server.js)

| Job                  | Schedule          | Timezone       |
|----------------------|-------------------|----------------|
| Case Sync            | `0 0 * * *` (midnight daily) | Asia/Kolkata |
| Due Notifications    | `* 8 * * *` (every minute at 8 AM) | Asia/Kolkata |

## GCP Management Commands

```bash
# Start VM
gcloud compute instances start district-court-cj-vm --zone=asia-south1-a

# Stop VM
gcloud compute instances stop district-court-cj-vm --zone=asia-south1-a

# Check VM status
gcloud compute instances describe district-court-cj-vm --zone=asia-south1-a --format="value(status)"

# View firewall rules
gcloud compute firewall-rules describe allow-district-court-cj-3000
```

## Troubleshooting

```bash
# Check if app is running
pm2 status

# Check error logs
pm2 logs district-court-cj --err --lines 50

# Restart if crashed
pm2 restart district-court-cj

# Check port usage
sudo lsof -i :3000

# Check system resources
free -h && df -h
```
