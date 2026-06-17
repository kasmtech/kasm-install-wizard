// Imports
const Docker = require('dockerode');
const socketIO = require('socket.io');
const pty = require("node-pty");
const fsw = require('fs').promises;
const fs = require('fs');
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
io.on('connection', async function (socket) {
  // Run bash install with our custom flags
  async function install(data) {
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

    // Run install
    let cmd = pty.spawn('/bin/bash', installFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    cmd.on('exit', function(code, signal) {
      if (code == 0) {
        socket.emit('done', port);
      }
    });
  }

  // Run bash upgrade with our custom flags
  async function upgrade(data) {
    let upgradeFlags = ['/kasm_release/upgrade.sh', '-L', port];

    // Run upgrade
    let cmd = pty.spawn('/bin/bash', upgradeFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    cmd.on('exit', async function(code, signal) {
      if (code == 0) {
        await fsw.copyFile('/version.txt', '/opt/version.txt');
        const rollingTag = await getRollingWeeklyTag(currentVersion, arch);
        socket.emit('done', {port, rollingTag});
      }
    });
  }

  // Render landing page depending on installed status
  async function renderLanding() {
    let containers = await docker.listContainers();
    // This is a running system
    if (containers.length !== 0) {
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
    await fsw.writeFile('/opt/NO_WIZARD', '');
    socket.emit('wizardkilled');
    let cmd = pty.spawn('/usr/bin/pkill', ['node']);
  }
  //// Incoming requests ////
  socket.on('renderlanding', renderLanding);
  socket.on('install', install);
  socket.on('upgrade', upgrade);
  socket.on('nowizard', noWizard);
});
