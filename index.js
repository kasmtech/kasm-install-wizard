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
let gpuInfo = {};
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
// Returns e.g. "1.19.0-rolling-weekly", falling back to "develop".
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
// the first compatible workspace in the registry (e.g. "1.19.0-rolling-weekly").
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
      gpu_graphics_acceleration: ['MESA'],
      gpu_video_encoding: ['SW'],
      hidden: false,
      image_id: '${uuid:image_id:' + imageIdx + '}',
      image_src: 'https://registry.kasmweb.com/1.1/icons/' + ws.image_src,
      image_type: 'Container',
      launch_config: {},
      memory_bytes: 2768000000,
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
    currentVersion = '1.19.0';
  }
  images = await fetchWorkspaceList(currentVersion, arch);
}
installerBlobs();

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

// install.sh links /opt/kasm/current after initializing the database, and running it
// again resets the database, so a failed install past that point counts as installed.
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
  function refuse(message, keepTerminal) {
    console.error('Wizard request refused: ' + message);
    socket.emit('wizarderror', message, !!keepTerminal);
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

    // Write finalized image data
    let yamlStr = yaml.dump(imagesI);
    if (yamlStr.startsWith("false")) {
      installFlags = installFlags.filter(function(e) { return e !== '-W' });
    } else {
      await fsw.writeFile('/kasm_release/conf/database/seed_data/default_images_' + arch + '.yaml', yamlStr);
    }

    // Copy over version
    await fsw.copyFile('/version.txt', '/opt/version.txt');

    await fsw.writeFile(installPendingMarker, new Date().toISOString() + '\n');

    // Run install
    let cmd = pty.spawn('/bin/bash', installFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    cmd.on('exit', async function(code, signal) {
      try {
        if (code == 0) {
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
          refuse('Installer exited with code ' + code + ' after the database was set up, check the output above. ' +
            'The wizard will not run the installer again because that would reset the database.', true);
        } else {
          refuse('Installer exited with code ' + code + ', check the output above. The install can be retried.', true);
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

    // Run upgrade
    let cmd = pty.spawn('/bin/bash', upgradeFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    cmd.on('exit', async function(code, signal) {
      try {
        if (code == 0) {
          await fsw.copyFile('/version.txt', '/opt/version.txt');
          const rollingTag = await getRollingWeeklyTag(currentVersion, arch);
          socket.emit('done', {port, rollingTag});
        } else {
          refuse('Upgrade exited with code ' + code + ', check the output above.', true);
        }
      } catch (err) {
        console.error('Upgrade post-processing failed:', err.message);
        refuse('Upgrade finished but post-processing failed: ' + err.message, true);
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
