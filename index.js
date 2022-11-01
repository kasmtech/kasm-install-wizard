// Imports
var Docker = require('dockerode');
var socketIO = require('socket.io');
var pty = require("node-pty");
var fsw = require('fs').promises;
var fs = require('fs');
var os = require('os');
var yaml = require('js-yaml');
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
// Grab installer variables
async function installerBlobs() {
  EULA = await fsw.readFile('/kasm_release/licenses/LICENSE.txt', 'utf8');
  let imagesText = await fsw.readFile('/wizard/default_images_' + arch + '.yaml', 'utf8');
  images = yaml.load(imagesText);
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
io = socketIO(https, {path: baseUrl + 'socket.io'});
io.on('connection', async function (socket) {
  // Run bash install with our custom flags
  async function install(data) {
    installSettings = data[0];
    let imagesI = data[1];
    let imagesD = images;
    installFlags = ['/kasm_release/install.sh', '-B' ,'-H', '-e', '-L', port, '-P', installSettings.adminPass, '-U', installSettings.userPass];
    if (installSettings.useRolling == true) {
      installFlags.push('-O');
    }
    if ((installSettings.noDownload == true) || (imagesI == false)) {
      installFlags.push('-u');
    }
    if ((imagesI.hasOwnProperty('images')) && (Object.keys(imagesI.images).length < 10)) {
      installFlags.push('-b');
    }
    // Flag the images properly based on selection
    for await (let image of Object.keys(images.images)) {
      if ((imagesI.hasOwnProperty('images')) && (imagesI.images.hasOwnProperty(image))) {
        imagesD.images[image].enabled = true;
        imagesD.images[image].hidden = false;
      } else {
        imagesD.images[image].enabled = false;
        imagesD.images[image].hidden = true;
      }
    }
    if (installSettings.forceGpu !== 'disabled') {
      let card = installSettings.forceGpu.slice(-1);
      let render = (Number(card) + 128).toString();
      console.log(card, render);
      for await (let image of Object.keys(images.images)) {
        imagesD.images[image]['run_config'] = '{"environment":{"KASM_EGL_CARD":"/dev/dri/card' + card + '","KASM_RENDERD":"/dev/dri/renderD' + render + '"},"devices":["/dev/dri/card' + card + ':/dev/dri/card' + card + ':rwm","/dev/dri/renderD' + render + ':/dev/dri/renderD' + render + ':rwm"]}'
        imagesD.images[image]['exec_config'] = '{"first_launch":{"user":"root","cmd": "bash -c \'chown -R kasm-user:kasm-user /dev/dri/*\'"}}'
      }
    }
    let yamlStr = yaml.dump(imagesD);
    await fsw.writeFile('/kasm_release/conf/database/seed_data/default_images_' + arch + '.yaml', yamlStr);
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
  // Render landing page depending on installed status
  async function renderLanding() {
    let containers = await docker.listContainers();
    if (containers.length !== 0) {
      let dashinfo = {};
      dashinfo['containers'] = containers;
      dashinfo['cpu'] = await si.cpu();
      dashinfo['mem'] = await si.mem();
      dashinfo['cpuPercent'] = await si.currentLoad();
      dashinfo['port'] = port;
      socket.emit('renderdash', dashinfo);
    } else {
      let gpuData = [];
      let gpuCmd = spawn('/gpuinfo.sh');
      gpuCmd.stdout.on('data', function(data) {
        gpuData.push(data);
      });
      gpuCmd.on('close', function(code) {
        if (code == 0) {
          socket.emit('renderinstall', [EULA, images, JSON.parse(gpuData.join(''))]);
        } else {
          socket.emit('renderinstall', [EULA, images, {}]);
        }
      });
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
  socket.on('nowizard', noWizard);
});
