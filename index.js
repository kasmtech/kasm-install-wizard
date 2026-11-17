// Imports
const Docker = require('dockerode');
const socketIO = require('socket.io');
const pty = require("node-pty");
const fsw = require('fs').promises;
const fs = require('fs');
const noWizardMarker = '/opt/NO_WIZARD';
if (fs.existsSync(noWizardMarker)) {
  console.log(noWizardMarker + ' exists, install wizard disabled. Remove it and restart to re-enable.');
  process.exit(0);
}
const os = require('os');
const yaml = require('js-yaml');
const _ = require('lodash');
const si = require('systeminformation');
const express = require('express');
const app = require('express')();
const privateKey  = fs.readFileSync('/opt/kasm/certs/kasm_wizard.key', 'utf8');
const certificate = fs.readFileSync('/opt/kasm/certs/kasm_wizard.crt', 'utf8');
const credentials = {key: privateKey, cert: certificate};
const https = require('https').Server(credentials, app);
const baserouter = express.Router();
const docker = new Docker({socketPath: '/var/run/docker.sock'});
const arch = os.arch().replace('x64', 'amd64');
const baseUrl = process.env.SUBFOLDER || '/';
const port = process.env.KASM_PORT || '443';
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const installedMarker = '/opt/kasm/current';
// Written only when install.sh exits successfully
const installCompleteMarker = '/opt/kasm/.wizard_install_complete';
// Written before install.sh runs and removed on success
const installPendingMarker = '/opt/kasm/.wizard_install_pending';
let EULA;
let images;
let currentVersion;
let sourceLocal = false;
let gpuInfo;
let installSettings = {};
let upgradeSettings = {};

// Find the best matching compatibility entry for the current version.
// Exact version match takes precedence over wildcard (e.g. "1.18.x").
function matchVersion(currentVer, compatibilityList) {
  if (!compatibilityList || compatibilityList.length === 0) return null;
  const parts = currentVer.split('.');
  const major = parts[0];
  const minor = parts[1] !== undefined ? parts[1] : '0';

  // Exact match (most precise)
  let match = compatibilityList.find(c => c.version === currentVer);
  if (match) return match;

  // Major.minor wildcard, e.g. "1.18.x"
  match = compatibilityList.find(c => c.version === `${major}.${minor}.x`);
  if (match) return match;

  return null;
}

// Build the image tag for a given compat entry.
// Returns e.g. "1.18.1-rolling-weekly", falling back to "develop".
function buildImageTag(compat) {
  const compatTag = compat.image.split(':')[1] || '';
  const versionPrefix = compatTag.replace(/-[^-]+-[^-]+$/, ''); // strip last two dash-segments
  const candidate = versionPrefix + '-rolling-weekly';
  return (compat.available_tags && compat.available_tags.includes(candidate)) ? candidate : 'develop';
}

// Fetch the registry workspace list, with local fallback.
async function fetchListData() {
  try {
    const response = await fetch('https://registry.kasmweb.com/1.1/list.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error('Failed to fetch workspace list, falling back to local list.json:', err.message);
    sourceLocal = true;
    return JSON.parse(await fsw.readFile('/wizard/list.json', 'utf8'));
  }
}

// Return the rolling-weekly tag string for the current version by finding
// the first compatible workspace in the registry (e.g. "1.18.1-rolling-weekly").
async function getRollingWeeklyTag(currentVer, archName) {
  const listData = await fetchListData();
  const ws = (listData.workspaces || []).find(
    w => w.architecture && w.architecture.includes(archName) && matchVersion(currentVer, w.compatibility || [])
  );
  if (!ws) return currentVer + '-rolling-weekly';
  return buildImageTag(matchVersion(currentVer, ws.compatibility));
}

// Fetch workspace list from registry and convert to the images YAML structure.
// Falls back to local list.json if the remote is unavailable.
async function fetchWorkspaceList(currentVer, archName) {
  const listData = await fetchListData();

  const filtered = (listData.workspaces || []).filter(
    ws => ws.architecture && ws.architecture.includes(archName)
  );

  let imageIdx = 1;
  const imagesList = [];
  for (const ws of filtered) {
    const compat = matchVersion(currentVer, ws.compatibility || []);
    if (!compat) continue;

    const imageBase = compat.image.split(':')[0];
    const imageTag = buildImageTag(compat);
    const imageName = imageBase + ':' + imageTag;

    imagesList.push({
      categories: ws.categories,
      cores: 2.0,
      cpu_allocation_method: 'Inherit',
      description: ws.description,
      docker_registry: ws.docker_registry,
      enabled: true,
      exec_config: {},
      friendly_name: ws.friendly_name,
      gpu_count: 0,
      hidden: false,
      image_id: '${uuid:image_id:' + imageIdx + '}',
      image_src: 'https://registry.kasmweb.com/1.1/icons/' + ws.image_src,
      image_type: 'Container',
      launch_config: {},
      memory: 2768000000,
      name: imageName,
      notes: ws.notes || null,
      run_config: {},
      uncompressed_size_mb: compat.uncompressed_size_mb,
      zone_id: null
    });
    imageIdx++;
  }

  let alembicVersion = 'e3900d8a4fee';
  try {
    const propsText = await fsw.readFile('/kasm_release/conf/database/seed_data/default_properties.yaml', 'utf8');
    const props = yaml.load(propsText);
    if (props && props.alembic_version) alembicVersion = props.alembic_version;
  } catch (err) {
    console.error('Could not read default_properties.yaml, using hardcoded alembic_version:', err.message);
  }

  return { alembic_version: alembicVersion, images: imagesList };
}

// Grab installer variables
async function installerBlobs() {
  EULA = await fsw.readFile('/kasm_release/licenses/LICENSE.txt', 'utf8');
  try {
    currentVersion = fs.readFileSync('/version.txt', 'utf8').replace(/(\r\n|\n|\r)/gm,'');
  } catch (err) {
    currentVersion = '1.18.1';
  }
  images = await fetchWorkspaceList(currentVersion, arch);
  gpuInfo = {};
  await new Promise((resolve) => {
    let gpuData = [];
    let gpuCmd = spawn('/gpuinfo.sh');
    gpuCmd.stdout.on('data', function(data) {
      gpuData.push(data);
    });
    gpuCmd.on('close', function(code) {
      try {
        if (code == 0) {
          gpuInfo = JSON.parse(gpuData.join(''));
        } else {
          gpuInfo = {};
        }
      } catch (err) {
        // Manually backfill GPU info if available
        gpuInfo = {};
        for (let i = 0; i < 10; i++) {
          let num = i.toString();
          if (fs.existsSync('/dev/dri/card' + num)) {
            gpuInfo['/dev/dri/card' + num] = "Unknown GPU";
          }
        }
      }
      resolve();
    });
  });
}
installerBlobs();

// GPU image yaml merging
async function setGpu(imagesI) {
  if (upgradeSettings['forceGpu'] !== undefined) {
    installSettings = upgradeSettings;
  }
  const forceGpu = installSettings.forceGpu;
  if (!forceGpu || forceGpu === 'disabled' || !forceGpu.includes('|')) {
    console.error('setGpu: invalid or missing forceGpu value:', forceGpu);
    return imagesI;
  }
  const [gpu, gpuName] = forceGpu.split('|');
  if (!gpu || !gpuName) {
    console.error('setGpu: could not parse GPU path or name from forceGpu:', forceGpu);
    return imagesI;
  }
  const card = gpu.slice(-1);
  const render = (Number(card) + 128).toString();
  // Handle NVIDIA Gpus
  let baseRun;
  if (gpuName.includes('NVIDIA')) {
    baseRun = JSON.parse('{"runtime":"nvidia","environment":{"NVIDIA_DRIVER_CAPABILITIES":"all","KASM_EGL_CARD":"/dev/dri/card' + card + '","KASM_RENDERD":"/dev/dri/renderD' + render + '"},"device_requests":[{"driver": "","count": -1,"device_ids": null,"capabilities":[["gpu"]],"options":{}}]}');
  } else {
    baseRun = JSON.parse('{"environment":{"DRINODE":"/dev/dri/renderD' + render + '", "HW3D": true},"devices":["/dev/dri/card' + card + ':/dev/dri/card' + card + ':rwm","/dev/dri/renderD' + render + ':/dev/dri/renderD' + render + ':rwm"]}');
  }
  let baseExec = JSON.parse('{"first_launch":{"user":"root","cmd": "bash -c \'chown -R kasm-user:kasm-user /dev/dri/*\'"}}');
  for (let i=0; i<imagesI.images.length; i++) {
    console.log(imagesI.images[i]['run_config']);
    let finalRun = _.merge(imagesI.images[i]['run_config'], baseRun)
    let finalExec = _.merge(imagesI.images[i]['exec_config'], baseExec)
    imagesI.images[i]['run_config'] = finalRun;
    imagesI.images[i]['exec_config'] = finalExec;
  }
  return imagesI;
}

// For rolling-weekly installs, append -rolling to service image tags in docker conf yamls.
// Prevents -rolling-rolling by only modifying tags that don't already end with -rolling.
async function appendRollingToServiceImages() {
  const confDir = '/kasm_release/docker';
  let entries;
  try {
    entries = await fsw.readdir(confDir);
  } catch (err) {
    return;
  }
  for (const file of entries.filter(f => f.endsWith('.yaml'))) {
    const filePath = confDir + '/' + file;
    const content = await fsw.readFile(filePath, 'utf8');
    const updated = content.split('\n').map(line => {
      if (/ image:/.test(line) && /"$/.test(line) && !/-rolling"$/.test(line) && !/develop"$/.test(line)) {
        return line.replace(/"$/, '-rolling"');
      }
      return line;
    }).join('\n');
    await fsw.writeFile(filePath, updated);
  }
}

const setupToken = crypto.randomBytes(32).toString('hex');
console.log('==================================================================');
console.log('Kasm Install Wizard setup token (required to use the wizard):');
console.log('  ' + setupToken);
console.log('Open: https://<host>:3000' + baseUrl + '#token=' + setupToken);
console.log('==================================================================');

function tokenValid(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// install.sh creates /opt/kasm/current after seeding the database and before it first
// starts Kasm's services. Before that the database only holds this install's seed data,
// after it may hold user data that re-running install.sh would reset, so a failed
// install past that point counts as installed.
// lstat so a dangling symlink still counts as installed
function kasmInstalled() {
  if (fs.existsSync(installCompleteMarker)) return true;
  try {
    fs.lstatSync(installedMarker);
    return true;
  } catch (err) {
    return false;
  }
}

function exitText(code, signal) {
  return signal ? 'was killed by signal ' + signal : 'exited with code ' + code;
}

let jobRunning = false;
let jobOwner = null;
// Set synchronously by noWizard so no job can start while it writes the marker and exits
let stopping = false;

//// Http server ////
baserouter.use('/public', express.static(__dirname + '/public'));
baserouter.get("/", function (req, res) {
  res.sendFile(__dirname + '/public/index.html');
});
baserouter.get("/favicon.ico", function (req, res) {
  res.sendFile(__dirname + '/public/favicon.ico');
});
app.use(baseUrl, baserouter);
https.listen(3000);

//// socketIO comms ////
const io = socketIO(https, {path: baseUrl + 'socket.io'});
io.use(function (socket, next) {
  if (tokenValid(socket.handshake.auth && socket.handshake.auth.token)) {
    return next();
  }
  console.error('Rejected wizard connection with missing or invalid setup token from ' + socket.handshake.address);
  next(new Error('unauthorized'));
});
io.on('connection', async function (socket) {
  // keepTerminal: this client has job output on screen
  // jobEnded: that job has finished, so the client can offer a way back
  function refuse(message, keepTerminal, jobEnded) {
    console.error('Wizard request refused: ' + message);
    socket.emit('wizarderror', message, !!keepTerminal, !!jobEnded);
  }
  function refuseBusy() {
    return refuse('An install or upgrade is already running.', jobOwner === socket.id);
  }
  function startJob() {
    jobRunning = true;
    jobOwner = socket.id;
  }
  function endJob() {
    jobRunning = false;
    jobOwner = null;
  }

  // Run bash install with our custom flags
  async function install(data) {
    if (kasmInstalled()) {
      return refuse('Kasm is already installed, refusing to run the installer again.');
    }
    if (stopping) {
      return refuse('The install wizard is stopping.');
    }
    if (jobRunning) {
      return refuseBusy();
    }
    if (!Array.isArray(data) || !data[0] || typeof data[0] !== 'object' ||
        typeof data[0].adminPass !== 'string' || data[0].adminPass.length === 0 ||
        typeof data[0].userPass !== 'string' || data[0].userPass.length === 0) {
      return refuse('Invalid install settings.');
    }
    startJob();
    try {
      await runInstall(data);
    } catch (err) {
      endJob();
      console.error('Install failed to start:', err.message);
      refuse('Install failed to start: ' + err.message);
    }
  }

  async function runInstall(data) {
    // Determine install settings
    installSettings = data[0];
    let imagesI = data[1];
    let installFlags = ['/kasm_release/install.sh', '-W', '-B' ,'-H', '-e', '-L', port, '-P', installSettings.adminPass, '-U', installSettings.userPass];
    if (imagesI && typeof imagesI === 'object' && Array.isArray(imagesI.images) && imagesI.images.length < 10) {
      installFlags.push('-b');
    }

    // GPU yaml merge
    if (installSettings.forceGpu !== 'disabled' && imagesI && imagesI.images) {
      imagesI = await setGpu(imagesI);
    }

    // Write finalized image data
    let yamlStr = yaml.dump(imagesI);
    if (yamlStr.startsWith("false")) {
      installFlags = installFlags.filter(function(e) { return e !== '-W' });
    } else {
      await fsw.writeFile('/kasm_release/conf/database/seed_data/default_images_' + arch + '.yaml', yamlStr);
      await appendRollingToServiceImages();
    }

    // Copy over version
    await fsw.copyFile('/version.txt', '/opt/version.txt');

    await fsw.writeFile(installPendingMarker, new Date().toISOString() + '\n');

    // Run install
    let cmd = pty.spawn('/bin/bash', installFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    // node-pty reports code 0 for a process killed by a signal
    cmd.on('exit', async function(code, signal) {
      try {
        if (code === 0 && !signal) {
          try {
            await fsw.writeFile(installCompleteMarker, new Date().toISOString() + '\n');
          } catch (err) {
            console.error('Could not write install completion marker:', err.message);
          }
          try {
            await fsw.unlink(installPendingMarker);
          } catch (err) {
            console.error('Could not remove install pending marker:', err.message);
          }
          socket.emit('done', port);
        } else if (kasmInstalled()) {
          refuse('Installer ' + exitText(code, signal) + ' after Kasm was installed, check the output above. ' +
            'The wizard will not run the installer again because that would reset the database.', true, true);
        } else {
          refuse('Installer ' + exitText(code, signal) + ' before Kasm services were started, check the output above. ' +
            'The install can be retried, this starts it over including its database.', true, true);
        }
      } finally {
        endJob();
      }
    });
  }

  // Run bash upgrade with our custom flags
  async function upgrade(data) {
    if (!kasmInstalled()) {
      return refuse('Kasm is not installed, nothing to upgrade.');
    }
    if (stopping) {
      return refuse('The install wizard is stopping.');
    }
    if (jobRunning) {
      return refuseBusy();
    }
    startJob();
    try {
      await runUpgrade();
    } catch (err) {
      endJob();
      console.error('Upgrade failed to start:', err.message);
      refuse('Upgrade failed to start: ' + err.message);
    }
  }

  async function runUpgrade() {
    let upgradeFlags = ['/kasm_release/upgrade.sh', '-L', port];

    // Patch service image tags for rolling builds
    await appendRollingToServiceImages();

    // Run upgrade
    let cmd = pty.spawn('/bin/bash', upgradeFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    // node-pty reports code 0 for a process killed by a signal
    cmd.on('exit', async function(code, signal) {
      try {
        if (code === 0 && !signal) {
          await fsw.copyFile('/version.txt', '/opt/version.txt');
          const rollingTag = await getRollingWeeklyTag(currentVersion, arch);
          socket.emit('done', {port, rollingTag});
        } else {
          refuse('Upgrade ' + exitText(code, signal) + ', check the output above.', true, true);
        }
      } catch (err) {
        console.error('Upgrade post-processing failed:', err.message);
        refuse('Upgrade finished but post-processing failed: ' + err.message, true, true);
      } finally {
        endJob();
      }
    });
  }

  // Render landing page depending on installed status
  async function renderLanding() {
    try {
      await sendLanding();
    } catch (err) {
      console.error('Could not render landing page:', err.message);
    }
  }
  async function sendLanding() {
    let containers = await docker.listContainers();
    // Installed systems get the dashboard even when their containers are stopped
    // An install that failed before /opt/kasm/current may leave containers behind; offer the installer again
    if (kasmInstalled() || (containers.length !== 0 && !fs.existsSync(installPendingMarker))) {
      let dashinfo = {};
      // Get version information
      if (fs.existsSync('/opt/version.txt')) {
        dashinfo['localVersion'] = fs.readFileSync('/opt/version.txt', 'utf8').replace(/(\r\n|\n|\r)/gm,''); 
      } else {
        dashinfo['localVersion'] = 'Unknown';
      }
      dashinfo['currentVersion'] = currentVersion;
      dashinfo['sourceLocal'] = sourceLocal;
      dashinfo['gpuInfo'] = gpuInfo;
      dashinfo['containers'] = containers;
      dashinfo['cpu'] = await si.cpu();
      dashinfo['mem'] = await si.mem();
      dashinfo['cpuPercent'] = await si.currentLoad();
      dashinfo['port'] = port;
      socket.emit('renderdash', [dashinfo, images]);
    // Render installer
    } else {
      socket.emit('renderinstall', [EULA, images, gpuInfo, currentVersion, sourceLocal]);
    }
  }
  // Disable wizard
  async function noWizard() {
    if (jobRunning) {
      return refuse('An install or upgrade is running, not stopping the wizard.');
    }
    stopping = true;
    try {
      await fsw.writeFile(noWizardMarker, '');
    } catch (err) {
      stopping = false;
      return refuse('Could not write ' + noWizardMarker + ': ' + err.message);
    }
    socket.emit('wizardkilled');
    console.log('Install wizard disabled via ' + noWizardMarker + ', exiting.');
    setTimeout(function () { process.exit(0); }, 500);
  }
  //// Incoming requests ////
  socket.on('renderlanding', renderLanding);
  socket.on('install', install);
  socket.on('upgrade', upgrade);
  socket.on('nowizard', noWizard);
});
