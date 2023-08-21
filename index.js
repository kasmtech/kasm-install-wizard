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
var gpuInfo;
var installSettings = {};
var upgradeSettings = {};
// Grab installer variables
async function installerBlobs() {
  EULA = await fsw.readFile('/kasm_release/licenses/LICENSE.txt', 'utf8');
  let imagesText = await fsw.readFile('/wizard/default_images_' + arch + '.yaml', 'utf8');
  images = yaml.load(imagesText);
  currentVersion = fs.readFileSync('/version.txt', 'utf8').replace(/(\r\n|\n|\r)/gm,'');
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
    baseRun = JSON.parse('{"environment":{"KASM_EGL_CARD":"/dev/dri/card' + card + '","KASM_RENDERD":"/dev/dri/renderD' + render + '"},"devices":["/dev/dri/card' + card + ':/dev/dri/card' + card + ':rwm","/dev/dri/renderD' + render + ':/dev/dri/renderD' + render + ':rwm"],"device_requests":[{"driver": "","count": -1,"device_ids": null,"capabilities":[["gpu"]],"options":{}}]}');
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
    installFlags = ['/kasm_release/install.sh', '-W', '-A', '-B' ,'-H', '-e', '-L', port, '-P', installSettings.adminPass, '-U', installSettings.userPass];
    if ((imagesI.hasOwnProperty('images')) && (imagesI.images.length < 10)) {
      installFlags.push('-b');
    }

    // GPU yaml merge
    if (installSettings.forceGpu !== 'disabled') {
      imagesI = await setGpu(imagesI);
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
    // Determine upgrade settings
    upgradeSettings = data[0];
    var imagesI = data[1];
    upgradeFlags = ['/kasm_release/upgrade.sh', '-A', '-L', port];
    if (upgradeSettings.keepOldImages == true) {
      upgradeFlags.push('-K');
    } else {
      upgradeFlags.push('-U');
    }

    // GPU yaml merge
    if (upgradeSettings.forceGpu !== 'disabled') {
      imagesI = await setGpu(imagesI);
    }

    // Write finalized image data
    let yamlStr = yaml.dump(imagesI);
    if (yamlStr.startsWith("false")) {
      upgradeFlags = upgradeFlags.filter(function(e) { return e !== '-K' });
      upgradeFlags = upgradeFlags.filter(function(e) { return e !== '-U' });
    } else {
      await fsw.writeFile('/kasm_release/conf/database/seed_data/default_images_' + arch + '.yaml', yamlStr);
    }

    // Copy over version
    await fsw.copyFile('/version.txt', '/opt/version.txt');

    // Run upgrade
    let cmd = pty.spawn('/bin/bash', upgradeFlags);
    cmd.on('data', function(data) {
      socket.emit('term', data);
    });
    cmd.on('exit', function(code, signal) {
      if (code == 0) {
        socket.emit('done', port);
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
      dashinfo['gpuInfo'] = gpuInfo;
      dashinfo['containers'] = containers;
      dashinfo['cpu'] = await si.cpu();
      dashinfo['mem'] = await si.mem();
      dashinfo['cpuPercent'] = await si.currentLoad();
      dashinfo['port'] = port;
      socket.emit('renderdash', [dashinfo, images]);
    // Render installer
    } else {
      socket.emit('renderinstall', [EULA, images, gpuInfo]);
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
