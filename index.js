// Imports
var Docker = require('dockerode');
var socketIO = require('socket.io');
var pty = require("node-pty");
var fsw = require('fs').promises;
var fs = require('fs');
var os = require('os');
var yaml = require('js-yaml');
var _ = require('lodash');
var si = require('systeminformation');
var express = require('express');
var app = require('express')();
var privateKey  = fs.readFileSync('/opt/kasm/certs/kasm_wizard.key', 'utf8');
var certificate = fs.readFileSync('/opt/kasm/certs/kasm_wizard.crt', 'utf8');
var credentials = {key: privateKey, cert: certificate};
var https = require('https').Server(credentials, app);
var baserouter = express.Router();
var docker = new Docker({socketPath: '/var/run/docker.sock'});
var arch = os.arch().replace('x64', 'amd64');
var baseUrl = process.env.SUBFOLDER || '/';
var version = process.env.VERSION || 'stable';
var port = process.env.KASM_PORT || '443';
const { spawn } = require('node:child_process');
var EULA;
var images;
var currentVersion;
var sourceLocal = false;
var gpuInfo;
var installSettings = {};
var upgradeSettings = {};

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
    currentVersion = '1.18.1!';
  }
  images = await fetchWorkspaceList(currentVersion, arch);
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
  });
}
installerBlobs();

// GPU image yaml merging
async function setGpu(imagesI) {
  if (upgradeSettings['forceGpu'] !== undefined) {
    installSettings = upgradeSettings;
  }
  let gpu = installSettings.forceGpu.split('|')[0];
  let gpuName = installSettings.forceGpu.split('|')[1];
  let card = gpu.slice(-1);
  let render = (Number(card) + 128).toString();
  // Handle NVIDIA Gpus
  var baseRun;
  if (gpuName.indexOf('NVIDIA') !== -1) {
    baseRun = JSON.parse('{"runtime":"nvidia","environment":{"NVIDIA_DRIVER_CAPABILITIES":"all","KASM_EGL_CARD":"/dev/dri/card' + card + '","KASM_RENDERD":"/dev/dri/renderD' + render + '"},"device_requests":[{"driver": "","count": -1,"device_ids": null,"capabilities":[["gpu"]],"options":{}}]}');
  } else {
    baseRun = JSON.parse('{"environment":{"DRINODE":"/dev/dri/renderD' + render + '", "HW3D": true},"devices":["/dev/dri/card' + card + ':/dev/dri/card' + card + ':rwm","/dev/dri/renderD' + render + ':/dev/dri/renderD' + render + ':rwm"]}');
  }
  let baseExec = JSON.parse('{"first_launch":{"user":"root","cmd": "bash -c \'chown -R kasm-user:kasm-user /dev/dri/*\'"}}');
  for (var i=0; i<imagesI.images.length; i++) {
    console.log(imagesI.images[i]['run_config']);
    finalRun = _.merge(imagesI.images[i]['run_config'], baseRun)
    finalExec = _.merge(imagesI.images[i]['exec_config'], baseExec)
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
io = socketIO(https, {path: baseUrl + 'socket.io'});
io.on('connection', async function (socket) {
  // Run bash install with our custom flags
  async function install(data) {
    // Determine install settings
    installSettings = data[0];
    var imagesI = data[1];
    installFlags = ['/kasm_release/install.sh', '-W', '-B' ,'-H', '-e', '-L', port, '-P', installSettings.adminPass, '-U', installSettings.userPass];
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
    upgradeFlags = ['/kasm_release/upgrade.sh', '-L', port];

    // Patch service image tags for rolling builds
    await appendRollingToServiceImages();

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
