// Variables
var EULA;
var images;
var gpus;
var term;
var installImages = [];
var installSettings = {};
var upgradeSettings = {};
var selected = false;

// Socket.io connection
var host = window.location.hostname; 
var port = window.location.port;
var protocol = window.location.protocol;
var path = window.location.pathname;
var socket = io(protocol + '//' + host + ':' + port, { path: path + 'socket.io'});

//// Page Functions ////

// Render term data
function renderTerm(data) {
  term.write(data);
}

// Execute install
async function install() {
  showTerminal()
  titleChange('Installing');
  // Create new object based on image selection
  let selectedImages = {alembic_version: images.alembic_version, images: [], group_images: []};
  if (installImages.length == 0) {
    socket.emit('install', [installSettings, false]);
  } else {
    for await (let image of installImages) {
      let srcImage = images.images.find(x => x.friendly_name === image);
      srcImage['enabled'] = true;
      selectedImages.images.push(srcImage);
      selectedImages.group_images.push({image_id: srcImage.image_id, group_id: "68d557ac-4cac-42cc-a9f3-1c7c853de0f3"});
    }
    socket.emit('install', [installSettings, selectedImages]);
  }
}

// Execute upgrade
async function upgrade() {
  showTerminal()
  titleChange('Upgrading');
  // Create new object based on image selection
  let selectedImages = {alembic_version: images.alembic_version, images: [], group_images: []};
  if (installImages.length == 0) {
    socket.emit('upgrade', [upgradeSettings, false]);
  } else {
    for await (let image of installImages) {
      let srcImage = images.images.find(x => x.friendly_name === image);
      srcImage['enabled'] = true;
      selectedImages.images.push(srcImage);
      selectedImages.group_images.push({image_id: srcImage.image_id, group_id: "68d557ac-4cac-42cc-a9f3-1c7c853de0f3"});
    }
    socket.emit('upgrade', [upgradeSettings, selectedImages]);
  }
}

// Show page container
function showContainer() {
  $('#terminal').empty();
  $('#terminal').css('display', 'none');
  term = null;
  $('#container').empty();
  $('#container').css('display', 'block');
}

// Show terminal
function showTerminal() {
  $('#container').empty();
  $('#container').css('display', 'none');
  $('#terminal').empty();
  $('#terminal').css('display', 'block');
  term = new Terminal();
  fitaddon = new FitAddon.FitAddon();
  term.loadAddon(fitaddon);
  term.open($('#terminal')[0]);
  fitaddon.fit();
}

// Change nav title
function titleChange(value) {
  $('#title').empty();
  $('#title').text(value);
}

// Render landing as installer page
function renderInstall(data) {
  showContainer();
  titleChange('EULA');
  EULA = data[0];
  images = data[1];
  gpus = data[2];
  let EULADiv = $('<div>', {id: 'EULA'}).text(EULA);
  $('#container').append(EULADiv);
  let EULAButton = $('<button>', {id: 'EULAButton', onclick: 'pickSettings()', class: 'btn btn-default btn-ghost'}).text('Accept and continue');
  $('#container').append(EULAButton);
}

// Render Dashboard
async function renderDash(data) {
  showContainer();
  titleChange('Dashboard');
  let info = data[0];
  images = data[1];
  // Store GPU info
  $('body').data('gpuInfo', info.gpuInfo);
  // Upgrade button if needed
  var upgrade;
  if (info.currentVersion !== info.localVersion) {
    upgrade = $('<button>', {class: 'btn btn-primary', onclick: 'renderUpgrade()'}).text('Upgrade to ' + info.currentVersion)
  } else {
    upgrade = info.currentVersion;
  }
  // Kasm docker containers
  containersTable = $('<tbody>');
  containersTable.append(
    $('<tr>').append([
      $('<th>').text('Web URL'),
      $('<td>').append($('<a>', {href: 'https://' + host + ':' + info.port, target: '_blank'}).text('https://' + host + ':' + info.port))
    ]),
    $('<tr>').append([
      $('<th>').text('Installed Version'),
      $('<td>').text(info.localVersion)
    ]),
    $('<tr>').append([
      $('<th>').text('Current Version'),
      $('<td>').append(upgrade)
    ])
  );
  for await (let container of info.containers) {
    containersTable.append(
      $('<tr>').append([
        $('<th>').text(container.Names[0]),
        $('<td>').text(container.State + ' ' + container.Status)
      ])
    );
  }
  dockerCard = $('<div>', {id: 'dockerinfo', class: 'terminal-card'}).append([
    $('<header>').text('Kasm Docker containers'),
    $('<table>').append(containersTable)
  ]);
  // System Information
  let usedmem = (info.mem.active/info.mem.total)*100;
  let totalmem = parseFloat(info.mem.total/1000000000).toFixed(2);
  let diskbuffer = parseFloat(info.mem.buffcache/1000000000).toFixed(2);
  sysinfoTable = $('<tbody>').append([
    $('<tr>').append([
      $('<th>').text('CPU'),
      $('<td>').text(info.cpu.vendor + ' ' + info.cpu.brand)
    ]),
    $('<tr>').append([
      $('<th>').text('CPU Cores'),
      $('<td>').text(info.cpu.cores)
    ]),
    $('<tr>').append([
      $('<th>').text('CPU Usage'),
      $('<td>').append(
        $('<div>', {class: 'progress-bar progress-bar-no-arrow'}).append(
          $('<div>', {
            class: 'progress-bar-filled',
            style: 'width: ' + info.cpuPercent.currentLoad + '%'
          })
        )
      )
    ]),
    $('<tr>').append([
      $('<th>').text('Total Memory'),
      $('<td>').text(totalmem + 'G')
    ]),
    $('<tr>').append([
      $('<th>').text('Disk Buffer'),
      $('<td>').text(diskbuffer + 'G')
    ]),
    $('<tr>').append([
      $('<th>').text('Memory Usage'),
      $('<td>').append(
        $('<div>', {class: 'progress-bar progress-bar-no-arrow'}).append(
          $('<div>', {
            class: 'progress-bar-filled',
            style: 'width: ' + usedmem + '%'
          })
        )
      )
    ])
  ]);
  systemCard = $('<div>', {id: 'systeminfo', class: 'terminal-card'}).append([
    $('<header>').text('System Information'),
    $('<table>').append(sysinfoTable)
  ]);
  let killButton = $('<button>', {class: 'btn btn-default btn-ghost center', onclick: 'nowizard()'}).text('Stop Install Wizard');
  $('#container').append([
    systemCard,
    dockerCard,
    killButton
  ]);
}

// Kill off wizard
function nowizard() {
  socket.emit('nowizard');
}
function wizardKilled() {
  showContainer();
  titleChange('Wizard killed');
  let titleBar = $('<div>');
  titleBar.append($('<h2>', {class: 'center'}).text('Install Wizard has been disabled'));
  titleBar.append($('<h3>', {class: 'center'}).text('To re-enable please remove the /opt/NO_WIZARD file'));
  titleBar.append($('<h3>', {class: 'center'}).text('And restart the container'));
  $('#container').append(titleBar); 
}

// Render primary form
async function pickSettings() {
  showContainer();
  titleChange('Install Settings');
  let form = $('<form>', {id: 'settingsform'});
  let fieldset = $('<fieldset>').append($('<legend>').text('Kasm Install Settings'));
  let adminPass = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'adminPass'}).text('admin@kasm.local Password: '),
    $('<input>', {name: 'adminPass', id: 'adminPass', type: 'password', required: true, placeholder: 'required'})
  ]);
  let userPass = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'userPass'}).text('user@kasm.local Password: '),
    $('<input>', {name: 'userPass', id: 'userPass', type: 'password', placeholder: 'required'}).prop('required',true)
  ]);
  let gpuOptions = [$('<option>', {value: 'disabled'}).text('Disabled')];
  for await (let card of Object.keys(gpus)) {
    gpuOptions.push($('<option>', {value: card + '|' + gpus[card]}).text(card + ' - ' + gpus[card]));
  }
  let forceGpu = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'forceGpu'}).text('Use GPU on all images: '),
    $('<select>', {name: 'forceGpu', id: 'forceGpu',}).append(gpuOptions)
  ]);
  let submit = $('<div>', {class: 'form-group'}).append([
    $('<input>', {name: 'submit', type: 'submit', value: 'Next', class: 'btn btn-default btn-ghost'})
  ]);
  fieldset.append([
    adminPass,
    userPass,
    forceGpu,
    submit
  ]);
  form.append(fieldset);
  $('#container').append(form);
  // Grab data and move to image selection
  form.on('submit', function (e) {
    e.preventDefault();
    installSettings.adminPass = $('#adminPass').val();
    installSettings.userPass = $('#userPass').val();
    installSettings.forceGpu = $('#forceGpu').val();
    pickImages(false);
  });
}

// Render upgrade form
async function renderUpgrade() {
  showContainer();
  let gpus = $('body').data('gpuInfo');
  titleChange('Upgrade Settings');
  let form = $('<form>', {id: 'settingsform'});
  let fieldset = $('<fieldset>').append($('<legend>').text('Kasm Upgrade Settings'));
  let keepOldImages = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'keepOldImages'}).text('Do not purge existing images: '),
    $('<input>', {name: 'keepOldImages', id: 'keepOldImages', type: 'checkbox'})
  ]);
  let gpuOptions = [$('<option>', {value: 'disabled'}).text('Disabled')];
  for await (let card of Object.keys(gpus)) {
    gpuOptions.push($('<option>', {value: card + '|' + gpus[card]}).text(card + ' - ' + gpus[card]));
  }
  let forceGpu = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'forceGpu'}).text('Use GPU on all new images: '),
    $('<select>', {name: 'forceGpu', id: 'forceGpu',}).append(gpuOptions)
  ]);
  let submit = $('<div>', {class: 'form-group'}).append([
    $('<input>', {name: 'submit', type: 'submit', value: 'Next', class: 'btn btn-default btn-ghost'})
  ]);
  fieldset.append([
    keepOldImages,
    forceGpu,
    submit
  ]);
  form.append(fieldset);
  $('#container').append(form);
  // Grab data and move to image selection
  form.on('submit', function (e) {
    e.preventDefault();
    upgradeSettings.keepOldImages = $('#keepOldImages').is(":checked");
    upgradeSettings.forceGpu = $('#forceGpu').val();
    pickImages(true);
  });
}


// Render image selection
async function pickImages(upgrade) {
  var installText;
  var installFunction;
  if (upgrade) {
    installText = 'Upgrade';
    installFunction = 'upgrade()';
  } else {
    installText = 'Install';
    installFunction = 'install()';
  }
  showContainer();
  titleChange('Image Selection');
  let imagesDiv = $('<div>', {class: 'cardcontainer', id: 'images'});
  $('#container').append(imagesDiv);
  for await (let image of images.images) {
    let imageName = $('<p>').text(image.friendly_name);
    let imageDiv = $('<div>', {
      class: 'card',
      id: image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-'),
      title: image.description,
      onclick: 'selectImage(\'' + image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-') + '\')'
    }).append(imageName).css('filter', 'grayscale(100%)')
    let thumb = $('<img>', {class: 'thumb', src: 'public/' + image.image_src});
    imageDiv.append(thumb);
    $('#images').append(imageDiv);
  }
  let allButton = $('<button>', {class: 'btn btn-default btn-ghost center', onclick: 'selectAll()'}).text('Select All');
  let installButton = $('<button>', {class: 'btn btn-default btn-ghost center', onclick: installFunction}).text(installText);
  $('#container').append([
    allButton,
    installButton
  ]);
}

// Select an individual image
function selectImage(image) {
  let imageKey = image.replace(new RegExp('_', 'g'), ' ').replace('-', '.');
  if (installImages.includes(imageKey)) {
    installImages = installImages.filter(e => e !== imageKey)
    $('#' + image).css({
      filter: 'grayscale(100%)',
      background: ''
    });
  } else {
    installImages.push(imageKey);
    $('#' + image).css({
      filter: '',
      background: '#89cff0'
    });
  }
}

// Select all images
function selectAll() {
  installImages = [];
  if (selected) {
    selected = false;
    for (let image of images.images) {
      let imageElem = image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-');
      $('#' + imageElem).css({
        filter: 'grayscale(100%)',
        background: ''
      });
    }
  } else {
    selected = true;
    for (let image of images.images) {
      let imageElem = image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-');
      installImages.push(image.friendly_name);
      $('#' + imageElem).css({
        filter: '',
        background: '#89cff0'
      });
    }
  }
}

// Show finished page
function done(port) {
  showContainer();
  titleChange('Complete');
  let titleBar = $('<div>');
  titleBar.append($('<h2>', {class: 'center'}).text('Installation Complete'));
  titleBar.append($('<h3>', {class: 'center'}).text('This page will reload in 5 seconds'));
  titleBar.append($('<h3>', {class: 'center'}).text('Your installation is available on port ' + port));
  $('#container').append(titleBar);
  setTimeout(function(){
    location.reload(true);
  }, 5000); 
}

//// Socket events ////
socket.on('renderinstall', renderInstall);
socket.on('renderdash', renderDash);
socket.on('term', renderTerm);
socket.on('done', done);
socket.on('wizardkilled', wizardKilled);

// Render landing on page load
window.onload = function() {
  showContainer();
  titleChange('Loading');
  $('#container').append($('<div>').append($('<h2>', {class: 'center'}).text('Docker still loading, please refresh for installer')))
  socket.emit('renderlanding');
}
