const automationRuns = {};

const path = require('path');
const AutomationRun = require('./models/AutomationRun');
const AutomationReport = require('./models/AutomationReport');
const AutomationVideo = require('./models/AutomationVideo');
const fs = require('fs');
// Helper to start/stop video recording using ffmpeg (MacBook camera)
const recordingsDir = path.resolve(__dirname, '../recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);
const videoRecordings = {}; // runId -> ffmpeg proc
function startVideoRecording(runId) {
  const videoPath = path.join(recordingsDir, `${runId}.mp4`);
  // Use ffmpeg to record from MacBook camera (FaceTime HD)
  // Device name may need adjustment: '0:0' is default for AVFoundation
  const ffmpegArgs = ['-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-i', '0:0', '-pix_fmt', 'yuv420p', '-y', videoPath];
  const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
  videoRecordings[runId] = { proc: ffmpegProc, videoPath };
  return videoPath;
}
function stopVideoRecording(runId) {
  const rec = videoRecordings[runId];
  if (rec && rec.proc) {
    return new Promise((resolve) => {
      rec.proc.on('exit', () => {
        delete videoRecordings[runId];
        resolve(rec.videoPath);
      });
      rec.proc.kill('SIGINT');
    });
  }
  return Promise.resolve(null);
}

async function hydrateRunsFromDB() {
  const runs = await AutomationRun.find();
  runs.forEach(run => {
    automationRuns[run.runId] = run.toObject();
    automationRuns[run.runId].logs = [];
  });
}
hydrateRunsFromDB();

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const connectDB = require('./db');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
let gfsBucket;
const bodyParser = require('body-parser');
const Device = require('./models/Device');
const { setupLGDevice, removeLGDevice } = require('./lg');
const { addSamsungDevice } = require('./samsung');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const getPort = async (opts) => {
  const mod = await import('get-port');
  return mod.default(opts);
};
const axios = require('axios');
const geoEnvParamRoutes = require('./geoEnvParamRoutes');
const { main: appium } = require('appium');
let uuidv4;
async function getUuidV4() {
  if (!uuidv4) {
    const mod = await import('uuid');
    uuidv4 = mod.v4;
  }
  return uuidv4();
}

const app = express();
const AutomationLog = require('./models/AutomationLog');

// Connect MongoDB

connectDB().then(() => {
  const db = mongoose.connection.db;
  gfsBucket = new GridFSBucket(db, { bucketName: 'videos' });
});



// ===== WebSocket Server =====
let automationClients = [];
// ...existing code for wss and automationClients if needed...


// WebSocket log streaming
const logWss = new WebSocket.Server({ port: 7000 });
function broadcastLog(message, runId) {
  logWss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ runId, ...message }));
    }
  });
}



// Store running Appium servers by port
const appiumServers = {};

async function startAppiumServer(port, runId) {
  try {
    const args = {
      port,
      address: '0.0.0.0',
      loglevel: 'info',
      relaxedSecurity: true
    };
    console.log(`[Device Farm] Starting Appium server on port ${port}`);
    const { spawn } = require('child_process');
    // Start Appium as a child process so we can capture logs
    const appiumProc = spawn('npx', ['appium', '--port', port, '--address', '0.0.0.0', '--relaxed-security'], { detached: true });
    appiumServers[port] = appiumProc;
    appiumProc.stdout.on('data', data => {
      // Strip Appium prefix for clean log display
      let msg = data.toString();
      if (msg.startsWith('[APPIUM] ')) msg = msg.replace('[APPIUM] ', '');
      AutomationLog.create({ runId, log: msg, type: 'stdout', time: new Date() }).catch((err) => { console.error('Failed to save Appium stdout log:', err); });
      broadcastLog({ log: msg, type: 'stdout', time: new Date().toISOString(), runId }, runId);
    });
    appiumProc.stderr.on('data', data => {
      // Strip Appium error prefix for clean log display
      let msg = data.toString();
      if (msg.startsWith('[APPIUM][ERR] ')) msg = msg.replace('[APPIUM][ERR] ', '');
      AutomationLog.create({ runId, log: msg, type: 'stderr', time: new Date() }).catch((err) => { console.error('Failed to save Appium stderr log:', err); });
      broadcastLog({ log: msg, type: 'stderr', time: new Date().toISOString(), runId }, runId);
    });
    appiumProc.on('close', code => {
      let msg = `Process exited with code ${code}`;
      AutomationLog.create({ runId, log: msg, type: 'close', time: new Date() }).catch((err) => { console.error('Failed to save Appium close log:', err); });
      broadcastLog({ log: msg, type: 'close', time: new Date().toISOString(), runId }, runId);
    });
    return appiumProc;
  } catch (err) {
    console.error(`[Device Farm] Failed to start Appium:`, err);
    throw err;
  }
}

async function stopAppiumServer(port) {
  if (appiumServers[port]) {
    try {
      appiumServers[port].kill();
      console.log(`[Device Farm] Stopped Appium server on port ${port}`);
    } catch (err) {
      console.error(`[Device Farm] Failed to stop Appium on port ${port}:`, err);
    }
    delete appiumServers[port];
  }
}


// Middleware
app.use(bodyParser.json());
app.use(express.static('frontend'));
app.use('/api', geoEnvParamRoutes);

// Serve index.html at root
// const path = require('path');
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/automation-runner', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/automation-runner.html'));
});

app.get('/run-details', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/run-details.html'));
});

app.get('/view-video', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/view-video.html'));
});

// ===== API Endpoints =====

// GET all devices
app.get('/devices', async (req, res) => {
  try {
    const devices = await Device.find();
    res.json({ devices });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
// GET network status of enrolled devices
const ping = require('ping');

app.get('/api/devices/status', async (req, res) => {
  try {
    const devices = await Device.find();
    const statusPromises = devices.map(async device => {
      let status = 'offline';
      try {
        const result = await ping.promise.probe(device.ip, { timeout: 2 });
        status = result.alive ? 'online' : 'offline';
      } catch (e) {
        status = 'offline';
      }
      return {
        id: device._id,
        name: device.name,
        status
      };
    });
    const statusList = await Promise.all(statusPromises);
    res.json({ devices: statusList });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch device status' });
  }
});

app.post('/add-device', async (req, res) => {
  try {
    const { name, ip, type, model, location, passphrase } = req.body;
    if (!name || !ip) return res.status(400).json({ success: false, message: 'Name and IP required' });

    const existing = await Device.findOne({ ip });
    if (existing) return res.status(200).json({ success: true, message: 'Device already exists' });

    console.log("Saving device:", req.body);
    if (type === 'LG') {
      await setupLGDevice({ name, ip, passphrase, type, model, location });
    } else if (type === 'Samsung') {
      try {
        const sdbResult = await addSamsungDevice(name, ip);
        console.log('SDB connect result:', sdbResult);
      } catch (err) {
        console.error('SDB connect failed:', err);
        return res.status(400).json({ success: false, message: 'SDB connect failed: ' + err });
      }
    }
    // Save to DB
    try {
      // Only include passphrase for LG
      const deviceData = { name, ip, type, model, location };
      if (type === 'LG' && passphrase) deviceData.passphrase = passphrase;
      const device = new Device(deviceData);
      await device.save();
      console.log('Device saved in DB:', device);
      res.json({ success: true, message: `Device ${name} added successfully` });
    } catch (err) {
      console.error('Error saving device to DB:', err);
      res.status(500).json({ success: false, message: 'Error saving device to DB: ' + err.message });
    }
  } catch (err) {
    console.error('General error in /add-device:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// DELETE remove device by ID
app.delete('/devices/remove/:id', async (req, res) => {
  const { id } = req.params;
  console.log('id', id);
  const device = await Device.findById(id);
  console.log('device.name', device.name);
  if (!device) {
    return res.status(404).json({ success: false, message: 'Device not found' });
  }

  try {
    if (device.type === 'LG') {
      try {
        await removeLGDevice(device.name);
      } catch (e) {
        console.error('Failed to remove LG device from ARES:', e);
      }

    }
    // remove from DB
    const result = await Device.findByIdAndDelete(id);
    if (result) res.json({ success: true, message: `Device ${result.name} removed successfully` });
    else res.json({ success: false, message: `Device not found` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST install app (dummy)
app.post('/install-app', (req, res) => {
  const { device, ipkPath } = req.body;
  console.log(`Installing ${ipkPath} on ${device}`);
  res.json({ success: true, message: `Installation started on ${device}` });
});

// POST start-automation (dummy)
app.post('/start-automation', (req, res) => {
  console.log('Automation started');
  res.json({ success: true });
});

// POST /automation/stop/:runId - stop a running automation
app.post('/automation/stop/:runId', async (req, res) => {
  const { runId } = req.params;
  const run = automationRuns[runId];
  if (!run || run.status !== 'running' || !run.proc) {
    return res.status(400).json({ success: false, error: 'No running automation found for this runId' });
  }
  try {
    // Send SIGTERM to the process group
    if (run.pgid) {
      process.kill(-run.pgid, 'SIGTERM');
    } else {
      run.proc.kill('SIGTERM');
    }
    run.status = 'stopping';
    await AutomationRun.updateOne({ runId }, { status: 'stopping' });
    res.json({ success: true, message: 'Automation stopping...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reserve device
app.post('/devices/reserve', async (req, res) => {
  try {
    const { deviceId, userId } = req.body;

    // Check deviceId
    if (!deviceId) return res.status(400).json({ success: false, error: 'Device ID is required' });

    const device = await Device.findById(deviceId);

    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    if (device.status !== 'free') return res.status(400).json({ success: false, error: 'Device not available' });

    device.status = 'occupied';
    device.reservedBy = userId || null;
    await device.save();

    // Safe access: device is guaranteed to exist here
    res.json({ success: true, device: { _id: device._id, name: device.name, status: device.status } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/devices/release', async (req, res) => {
  try {
    const { deviceIds } = req.body; // handle multiple
    if (!deviceIds || !deviceIds.length) return res.status(400).json({ success: false, error: 'No device IDs provided' });

    const result = await Device.updateMany(
      { _id: { $in: deviceIds } },
      { $set: { status: 'free', reservedBy: null } }
    );

    res.json({ success: true, updatedCount: result.modifiedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /automation/runs
app.get('/automation/runs', async (req, res) => {
  // Return metadata for all runs (not logs)
  const runs = await AutomationRun.find().sort({ startTime: -1 });
  res.json({
    runs: runs.map(run => ({
      runId: run.runId,
      devices: run.devices,
      startTime: run.startTime,
      cucumberTag: run.cucumberTag,
      geo: run.geo,
      status: run.status,
      port: run.port !== undefined ? run.port : null
    }))
  });
});

// POST /automation/run
app.post('/automation/run', async (req, res) => {
  try {
    const { deviceIds, cucumberTag, geo, recordVideo } = req.body;
    if (!deviceIds || !deviceIds.length) return res.status(400).json({ success: false, error: 'No devices selected' });

    // Reserve devices
    const devices = await Device.find({ _id: { $in: deviceIds }, status: 'free' });
    if (!devices.length) return res.status(400).json({ success: false, error: 'No free devices found' });

    await Device.updateMany({ _id: { $in: deviceIds } }, { status: 'occupied' });

    // 1. Get a free port for Appium
    const port = await getPort({ port: Array.from({ length: 100 }, (_, i) => 4723 + i) });
    let appiumServer;
    let runId;
    try {
      runId = (await getUuidV4()) || (Date.now() + '-' + Math.random());
    } catch (e) {
      runId = Date.now() + '-' + Math.random();
    }
    const startTime = new Date().toISOString();
    automationRuns[runId] = {
      runId,
      devices,
      startTime,
      cucumberTag,
      geo,
      status: 'running',
      logs: [],
      port
    };
    // Persist run to DB
    AutomationRun.create({ runId, devices, startTime, cucumberTag, geo, status: 'running', port }).catch(() => { });
    // Start video recording if enabled
    if (recordVideo) {
      startVideoRecording(runId);
    }
    try {
      appiumServer = await startAppiumServer(port, runId);
    } catch (err) {
      await Device.updateMany({ _id: { $in: deviceIds } }, { status: 'free', reservedBy: null });
      automationRuns[runId].status = 'failed';
      await AutomationRun.updateOne({ runId }, { status: 'failed' });
      broadcastLog({ log: `[APPIUM][ERR] ${err}`, type: 'stderr', time: new Date().toISOString() }, runId);
      return res.status(500).json({ success: false, error: 'Failed to start Appium server: ' + err });
    }

    // 2. Wait for Appium to be ready
    let started = false;
    for (let i = 0; i < 20; i++) {
      try {
        await new Promise((res) => setTimeout(res, 1000));
        const axios = require('axios');
        const resp = await axios.get(`http://localhost:${port}/status`);
        if (resp.data && resp.data.value) {
          started = true;
          break;
        }
      } catch (e) { }
    }
    if (!started) {
      await stopAppiumServer(port);
      await Device.updateMany({ _id: { $in: deviceIds } }, { status: 'free', reservedBy: null });
      automationRuns[runId].status = 'failed';
      await AutomationRun.updateOne({ runId }, { status: 'failed' });
      return res.status(500).json({ success: false, error: 'Appium did not start' });
    }

    // 3. Change to automation repo dir and run automation
    const lgautomationDir = `${process.env.LG_AUTOMATION_DIR_PATH}`;
    const samsungautomationDir = `${process.env.SAMSUNG_AUTOMATION_DIR_PATH}`;
    // Pass TV name and IP address (first device in array)
    const tvName = devices[0]?.name || '';
    const tvIp = devices[0]?.ip || '';
    const deviceType = (devices[0] && devices[0].type) ? devices[0].type.toLowerCase() : 'lg';
    console.log(`deviceType: ${deviceType}`);

    const projectDir = (deviceType === 'samsung') ? require('path').resolve(samsungautomationDir) : require('path').resolve(lgautomationDir);

    // Compose geoParamsStr from extra fields in req.body (frontend already filters out empty fields)
    let geoParamsStr = '';
    const knownFields = new Set(['deviceIds', 'cucumberTag', 'geo', 'TEST_ENV_NAME', 'APPLICATION', 'recordVideo']);
    geoParamsStr = Object.entries(req.body)
      .filter(([key, value]) => !knownFields.has(key))
      .map(([key, value]) => `${key}='${value}'`)
      .join(' ');

    // Compose automation command with all GEO params
    const env = req.body.TEST_ENV_NAME || 'STAGE';
    const dapp = env === 'STAGE' ? 'com.stage-automation' : 'com.int-automation';
    const app = req.body.APPLICATION || 'Max';
    const appid = req.body.APPLICATION === 'Max' ? 'com.automation' : dapp;

    // Dynamic PARALLEL and device params
    const parallel = devices.length;
    let deviceParams = '';
    if (deviceType === 'lg') {
      if (parallel === 1) {
        deviceParams = `DEVICE_NAME='${devices[0].name}' DEVICE_HOST='${devices[0].ip}'`;
      } else {
        deviceParams = devices.map((dev, idx) => `DEVICE_NAME${idx}='${dev.name}' DEVICE_HOST${idx}='${dev.ip}'`).join(' ');
      }

    } else if (deviceType === 'samsung') {
      if (parallel === 1) {
        deviceParams = `DEVICE_NAME='${devices[0].ip}:26101'`;
      } else {
        deviceParams = devices.map((dev, idx) => `DEVICE_NAME${idx}='${dev.ip}:26101'`).join(' ');
      }
    }

    if (parallel > 1) {
      deviceParams = `ENABLE_LOCAL_PARALLEL=true ${deviceParams}`;
    }
    const parallelParam = `PARALLEL=${parallel}`;

    const lgautomationCmd = `cd '${projectDir}' && git checkout main && git pull origin main && ${geoParamsStr} ${parallelParam} TEST_ENV_NAME='${env}' APPLICATION='${app}' APP_ID='${appid}' AUTOMATION_NAME='webOS' MODEL='lg' PLATFORM_NAME='LGTV' DEVICE=${deviceType} GEO=${geo ? `${geo}` : ''} CUCUMBER_TAG=${cucumberTag ? `'${cucumberTag}'` : ''} LOCAL_PORT=${port} ${deviceParams} NODE_OPTIONS='--max-old-space-size=16384' npx jake FUSE:lg`;
    const samsungautomationCmd = `cd '${projectDir}' && git checkout main && git pull origin main && ${geoParamsStr} ${parallelParam} TEST_ENV_NAME='${env}' APPLICATION='${app}' APP_ID='${appid}' RESET_RC_TOKEN=false AUTOMATION_NAME='tizentv' MODEL='tizen' PLATFORM_NAME='tizentv' DEVICE=${deviceType} GEO=${geo ? `${geo}` : ''} CUCUMBER_TAG=${cucumberTag ? `'${cucumberTag}'` : ''} LOCAL_PORT=${port} ${deviceParams} NODE_OPTIONS='--max-old-space-size=16384' npx jake FUSE:samsung`;

    const fuseTarget = (deviceType === 'samsung') ? samsungautomationCmd : lgautomationCmd;

    console.log(`[Device Farm] Running automation: ${fuseTarget}`);
    const automationProc = spawn('bash', ['-c', fuseTarget], { detached: true });
    automationRuns[runId].proc = automationProc;
    automationRuns[runId].pgid = automationProc.pid;
    automationRuns[runId].port = port;
    automationRuns[runId].status = 'running';
    automationProc.stdout.on('data', data => {
      // Only display raw automation output, no prefix
      const msg = data.toString();
      automationRuns[runId].logs.push(msg);
      AutomationLog.create({ runId, log: msg, type: 'stdout', time: new Date() }).catch((err) => { console.error('Failed to save stdout log:', err); });
      broadcastLog({ log: msg, type: 'stdout', time: new Date().toISOString(), runId }, runId);
    });
    automationProc.stderr.on('data', data => {
      // Only display raw automation error output, no prefix
      const msg = data.toString();
      automationRuns[runId].logs.push(msg);
      AutomationLog.create({ runId, log: msg, type: 'stderr', time: new Date() }).catch((err) => { console.error('Failed to save stderr log:', err); });
      broadcastLog({ log: msg, type: 'stderr', time: new Date().toISOString(), runId }, runId);
    });
    automationProc.on('close', async (code) => {
      // Stop video recording and wait for ffmpeg to finish and file to be finalized
      const videoPath = await stopVideoRecording(runId);
      let gridFsId = null;
      let finalVideoPath = videoPath;
      // Re-encode to yuv420p for browser compatibility
      if (videoPath && fs.existsSync(videoPath)) {
        const path = require('path');
        const { spawnSync } = require('child_process');
        const reencodedPath = videoPath.replace(/\.mp4$/, '-420p.mp4');
        try {
          const ffmpegArgs = ['-i', videoPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', reencodedPath];
          const result = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
          if (fs.existsSync(reencodedPath)) {
            finalVideoPath = reencodedPath;
          } else {
            console.error('Re-encode failed, using original video');
          }
        } catch (e) {
          console.error('Re-encode error:', e);
        }
      }
      if (finalVideoPath && fs.existsSync(finalVideoPath) && gfsBucket) {
        try {
          // Store video in GridFS and wait for upload to finish
          await new Promise((resolve, reject) => {
            const uploadStream = gfsBucket.openUploadStream(`${runId}.mp4`, { metadata: { runId } });
            const readStream = fs.createReadStream(finalVideoPath);
            readStream.pipe(uploadStream)
              .on('error', (err) => {
                console.error('GridFS upload error:', err);
                reject(err);
              })
              .on('finish', async function () {
                gridFsId = uploadStream.id;
                try {
                  await AutomationVideo.create({ runId, videoPath: finalVideoPath, gridFsId });
                } catch (e) { console.error('Failed to save video info:', e); }
                resolve();
              });
          });
        } catch (e) { console.error('Failed to save video info:', e); }
      }
      // Mark run as finished or failed after video upload completes
      let msg;
      const endTime = new Date();
      if (code === 0) {
        msg = `Process exited successfully with code ${code}\n`;
        automationRuns[runId].status = 'finished';
        await AutomationRun.updateOne({ runId }, { status: 'finished', endTime, port: automationRuns[runId].port });
      } else {
        msg = `Process exited with error code ${code}\n`;
        automationRuns[runId].status = 'failed';
        await AutomationRun.updateOne({ runId }, { status: 'failed', endTime, port: automationRuns[runId].port });
      }
      automationRuns[runId].endTime = endTime;
      automationRuns[runId].logs.push(msg);
      AutomationLog.create({ runId, log: msg, type: 'close', time: endTime }).catch((err) => { console.error('Failed to save close log:', err); });
      broadcastLog({ log: msg, type: 'close', time: endTime.toISOString(), runId }, runId);

      // 1. Run report command and store report in DB
      try {
        // Demo: replace with actual report path/logic later
        await new Promise((resolve, reject) => {
          const reportProc = spawn('npx', ['jake', 'utils:report'], { cwd: projectDir });
          reportProc.on('close', (code) => {
            // Demo: read a static file as report
            let reportName = deviceType === 'samsung' ? '/results/samsung_report.html' : '/results/lg_report.html';

            const reportPath = projectDir + reportName;
            fs.readFile(reportPath, 'utf8', (err, data) => {
              if (!err && data) {
                AutomationReport.create({ runId, reportContent: data }).catch(() => { });
              }
              resolve();
            });
          });
          reportProc.on('error', reject);
        });
      } catch (e) {
        console.error('Failed to generate or store report:', e);
      }

      // 2. Stop Appium and release devices
      await stopAppiumServer(port);
      await Device.updateMany({ _id: { $in: deviceIds } }, { status: 'free', reservedBy: null });
    });

    res.json({ success: true, message: 'Automation triggered successfully', runId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /automation/logs/:runId - fetch all logs for a run
app.get('/automation/logs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const logs = await AutomationLog.find({ runId }).sort({ time: 1 });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/automation/report/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const report = await AutomationReport.findOne({ runId });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.status(200).json({ report: report.reportContent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download report as HTML file for a run
app.get('/automation/report/:runId/download', async (req, res) => {
  try {
    const { runId } = req.params;
    const report = await AutomationReport.findOne({ runId });
    if (!report) return res.status(404).send('Report not found');
    res.setHeader('Content-Disposition', `attachment; filename="report-${runId}.html"`);
    res.setHeader('Content-Type', 'text/html');
    res.send(report.reportContent);
  } catch (err) {
    res.status(500).send('Error downloading report');
  }
});

// Start server

// Video info and streaming routes (always registered)
console.log("video router registered");
app.get('/automation/video/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    let video = await AutomationVideo.findOne({ runId });
    let response = null;
    if (video) {
      response = {
        videoPath: `/recordings/${runId}.mp4`,
        hasData: !!video.gridFsId
      };
      if (video.gridFsId) {
        response.streamAvailable = true;
        response.streamUrl = `/automation/video/${runId}/stream`;
      }
    } else {
      const fs = require('fs');
      const path = require('path');
      const recordingsDir = path.resolve(__dirname, '../recordings');
      const filePath = path.join(recordingsDir, `${runId}.mp4`);
      if (fs.existsSync(filePath)) {
        response = {
          videoPath: `/recordings/${runId}.mp4`,
          hasData: true
        };
      }
    }
    if (!response) return res.status(404).json({ error: 'Video not found' });
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Video streaming route for preview
app.get('/automation/video/:runId/stream', async (req, res) => {
  try {
    const { runId } = req.params;
    const video = await AutomationVideo.findOne({ runId });
    if (video && video.gridFsId) {
      // Stream from GridFS
      const mongoose = require('mongoose');
      const { connection } = mongoose;
      const gfsBucket = new (require('mongodb')).GridFSBucket(connection.db, { bucketName: 'videos' });
      const downloadStream = gfsBucket.openDownloadStream(video.gridFsId);
      res.set('Content-Type', 'video/mp4');
      downloadStream.on('error', () => res.status(404).end());
      downloadStream.pipe(res);
    } else {
      // Stream from local file system
      const fs = require('fs');
      const path = require('path');
      const recordingsDir = path.resolve(__dirname, '../recordings');
      const filePath = path.join(recordingsDir, `${runId}.mp4`);
      if (fs.existsSync(filePath)) {
        res.set('Content-Type', 'video/mp4');
        const readStream = fs.createReadStream(filePath);
        readStream.on('error', () => res.status(404).end());
        readStream.pipe(res);
      } else {
        res.status(404).json({ error: 'Video not found' });
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use('/recordings', express.static(recordingsDir));

// Periodically check and free stuck Appium ports
setInterval(async () => {
  for (const port in appiumServers) {
    const server = appiumServers[port];
    // Check if port is not in use by any running automation
    const isUsed = Object.values(automationRuns).some(run => run.port == port && run.status === 'running');
    if (!isUsed) {
      try {
        await stopAppiumServer(port);
        console.log(`[Device Farm] Freed stuck Appium port ${port}`);
      } catch (e) {
        console.error(`[Device Farm] Error freeing port ${port}:`, e);
      }
    }
  }
}, 60000); // every 60 seconds

const PORT = process.env.PORT || 4567;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// DELETE /automation/run/:runId - delete run, logs, recordings from local and DB
app.delete('/automation/run/:runId', async (req, res) => {
  const { runId } = req.params;
  try {
    // Delete logs
    await AutomationLog.deleteMany({ runId });
    // Delete report
    await AutomationReport.deleteMany({ runId });
    // Delete video info and GridFS file
    const video = await AutomationVideo.findOne({ runId });
    if (video) {
      if (video.gridFsId && gfsBucket) {
        try {
          await gfsBucket.delete(video.gridFsId);
        } catch (e) {
          console.error('Failed to delete GridFS video:', e);
        }
      }
      await AutomationVideo.deleteOne({ runId });
    }
    // Delete local recording
    const path = require('path');
    const fs = require('fs');
    const recordingsDir = path.resolve(__dirname, '../recordings');
    const videoPath = path.join(recordingsDir, `${runId}.mp4`);
    const reencodedPath = path.join(recordingsDir, `${runId}-420p.mp4`);
    [videoPath, reencodedPath].forEach(p => {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { console.error('Failed to delete local video:', e); }
      }
    });
    // Delete run
    await AutomationRun.deleteOne({ runId });
    // Remove from memory
    delete automationRuns[runId];
    res.json({ success: true, message: 'Automation run deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
