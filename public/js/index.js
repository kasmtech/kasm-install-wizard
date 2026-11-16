// Variables
let EULA;
let images;
let term;
let installImages = [];
const installSettings = {};
const upgradeSettings = {};
let currentVersion = '';
let isUpgrade = false;
let selected = false;

// Socket.io connection
const host = window.location.hostname;
const port = window.location.port;
const protocol = window.location.protocol;
const path = window.location.pathname;

// In-memory copy for browsers where sessionStorage is blocked
let memToken = '';
function storeToken(value) {
  memToken = value;
  try { sessionStorage.setItem('kasmWizardToken', value); } catch (err) {}
}
function loadToken() {
  let stored = '';
  try { stored = sessionStorage.getItem('kasmWizardToken') || ''; } catch (err) {}
  return stored || memToken;
}
// #token= keeps the token out of HTTP requests; ?token= still works
(function captureToken() {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const urlToken = hashParams.get('token') || params.get('token');
  if (!urlToken && !params.has('token') && !hashParams.has('token')) return;
  if (urlToken) storeToken(urlToken);
  params.delete('token');
  hashParams.delete('token');
  const query = params.toString();
  const hash = hashParams.toString();
  window.history.replaceState(null, '', path + (query ? '?' + query : '') + (hash ? '#' + hash : ''));
})();

const socket = io(protocol + '//' + host + ':' + port, {
  path: path + 'socket.io',
  auth: function (cb) { cb({ token: loadToken() }); }
});

let tokenRequired = false;
function showTokenRequired() {
  showContainer();
  view = 'loading';
  titleChange('Setup token required');
  $('#container').append($('<h2>', {class: 'center'}).text('A setup token is required. Find it in the container logs (docker logs <container>) and reload this page.'));
}

socket.on('connect_error', function (err) {
  if (err && err.message === 'unauthorized') {
    const entered = window.prompt('Enter the install wizard setup token (shown in the container logs):');
    if (entered) {
      storeToken(entered.trim());
      socket.connect();
    } else {
      tokenRequired = true;
      if (pageLoaded) showTokenRequired();
    }
  }
});

function wizardError(message, keepTerminal) {
  alert(message);
  // Keep job output on screen; a refused job's empty terminal goes back to landing
  if (!jobStarted || keepTerminal) return;
  jobStarted = false;
  isUpgrade = false;
  view = 'loading';
  requestLanding();
}

//// Page Functions ////

// Render term data
function renderTerm(data) {
  if (term) term.write(data);
}

// Execute install
async function install() {
  if (jobStarted) return;
  jobStarted = true;
  showTerminal()
  titleChange('Installing');
  // Create new object based on image selection
  let selectedImages = {alembic_version: images.alembic_version, images: [], group_images: []};
  if (installImages.length == 0) {
    socket.emit('install', [installSettings, false]);
  } else {
    for (let image of installImages) {
      let srcImage = images.images.find(x => x.friendly_name === image);
      if (!srcImage) {
        jobStarted = false;
        alert('Error: image "' + image + '" not found. Please refresh and try again.');
        return;
      }
      srcImage['enabled'] = true;
      selectedImages.images.push(srcImage);
      selectedImages.group_images.push({image_id: srcImage.image_id, group_id: "68d557ac-4cac-42cc-a9f3-1c7c853de0f3"});
    }
    socket.emit('install', [installSettings, selectedImages]);
  }
}

// Execute upgrade
async function upgrade() {
  if (jobStarted) return;
  isUpgrade = true;
  jobStarted = true;
  showTerminal();
  titleChange('Upgrading');
  socket.emit('upgrade', [upgradeSettings, false]);
}

// Show page container
function showContainer() {
  view = 'form';
  $('#terminal').empty();
  $('#terminal').css('display', 'none');
  term = null;
  $('#container').empty();
  $('#container').css('display', 'block');
}

// Show terminal
function showTerminal() {
  view = 'terminal';
  $('#container').empty();
  $('#container').css('display', 'none');
  $('#terminal').empty();
  $('#terminal').css('display', 'block');
  term = new Terminal();
  let fitaddon = new FitAddon.FitAddon();
  term.loadAddon(fitaddon);
  term.open($('#terminal')[0]);
  fitaddon.fit();
}

// Change nav title
function titleChange(value) {
  $('#title').empty();
  $('#title').text(value);
}

function versionChange(ver, local) {
  document.title = 'Kasm Wizard ' + ver + (local ? ' (local)' : '');
}

// Render landing as installer page
function renderInstall(data) {
  showContainer();
  titleChange('EULA');
  EULA = data[0];
  images = data[1];
  versionChange(data[3], data[4]);
  let EULADiv = $('<div>', {id: 'EULA'}).text(EULA);
  $('#container').append(EULADiv);
  let EULAButton = $('<button>', {id: 'EULAButton', onclick: 'pickSettings()', class: 'btn btn-default btn-ghost'}).text('Accept and continue');
  $('#container').append(EULAButton);
  view = 'landing';
}

// Render Dashboard
async function renderDash(data) {
  showContainer();
  titleChange('Dashboard');
  let info = data[0];
  images = data[1];
  currentVersion = info.currentVersion;
  versionChange(info.currentVersion, info.sourceLocal);
  // Store GPU info
  $('body').data('gpuInfo', info.gpuInfo);
  // Upgrade button if needed
  let upgrade;
  if (info.currentVersion !== info.localVersion) {
    upgrade = $('<button>', {class: 'btn btn-primary', onclick: 'renderUpgrade()'}).text('Upgrade to ' + info.currentVersion)
  } else {
    upgrade = info.currentVersion;
  }
  // Kasm docker containers
  let containersTable = $('<tbody>');
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
  for (let container of info.containers) {
    containersTable.append(
      $('<tr>').append([
        $('<th>').text(container.Names[0]),
        $('<td>').text(container.State + ' ' + container.Status)
      ])
    );
  }
  let dockerCard = $('<div>', {id: 'dockerinfo', class: 'terminal-card'}).append([
    $('<header>').text('Kasm Docker containers'),
    $('<table>').append(containersTable)
  ]);
  // System Information
  let usedmem = (info.mem.active/info.mem.total)*100;
  let totalmem = parseFloat(info.mem.total/1000000000).toFixed(2);
  let diskbuffer = parseFloat(info.mem.buffcache/1000000000).toFixed(2);
  let sysinfoTable = $('<tbody>').append([
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
  let systemCard = $('<div>', {id: 'systeminfo', class: 'terminal-card'}).append([
    $('<header>').text('System Information'),
    $('<table>').append(sysinfoTable)
  ]);
  let killButton = $('<button>', {class: 'btn btn-default btn-ghost center', onclick: 'nowizard()'}).text('Stop Install Wizard');
  $('#container').append([
    systemCard,
    dockerCard,
    killButton
  ]);
  view = 'landing';
}

// Kill off wizard
function nowizard() {
  socket.emit('nowizard');
}
function wizardKilled() {
  showContainer();
  titleChange('Wizard killed');
  view = 'done';
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
    $('<input>', {name: 'userPass', id: 'userPass', type: 'password', required: true, placeholder: 'required'})
  ]);
  let gpuNotice = $('<p>').text('GPU acceleration is automatically managed by Kasm Workspaces 1.19.0. Configure GPU settings after installation in the admin panel under Infrastructure > Agents.');
  let submit = $('<div>', {class: 'form-group'}).append([
    $('<input>', {name: 'submit', type: 'submit', value: 'Next', class: 'btn btn-default btn-ghost'})
  ]);
  let passHint = $('<p>', {
    id: 'pass-hint',
    style: 'color: inherit;'
  }).text('Passwords must be at least 8 characters and include uppercase, lowercase, a number, and a special character (!#$%^&*@).');
  fieldset.append([
    passHint,
    adminPass,
    userPass,
    gpuNotice,
    submit
  ]);
  form.append(fieldset);
  $('#container').append(form);
  // Grab data and move to image selection
  form.on('submit', function (e) {
    e.preventDefault();
    const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!#$%^&*@]).{8,}$/;
    const adminPassVal = $('#adminPass').val();
    const userPassVal = $('#userPass').val();
    if (!passRegex.test(adminPassVal) || !passRegex.test(userPassVal)) {
      $('#pass-hint').css('color', '#df2f87');
      return;
    }
    $('#pass-hint').css('color', 'inherit');
    installSettings.adminPass = adminPassVal;
    installSettings.userPass = userPassVal;
    pickImages(false);
  });
}

// Render upgrade form
function renderUpgrade() {
  showContainer();
  titleChange('Upgrade Settings');
  let fieldset = $('<fieldset>').append($('<legend>').text('Kasm Upgrade Settings'));
  fieldset.append($('<p>').text('Are you sure you want to upgrade Kasm to version ' + currentVersion + '?'));
  let confirmCheck = $('<div>', {class: 'form-group'}).append([
    $('<label>', {for: 'confirmUpgrade'}).text('I confirm I want to upgrade'),
    $('<input>', {name: 'confirmUpgrade', id: 'confirmUpgrade', type: 'checkbox'})
  ]);
  fieldset.append(confirmCheck);
  let upgradeButton = $('<button>', {
    class: 'btn btn-default btn-ghost',
    id: 'upgradeButton',
    onclick: 'upgrade()',
    disabled: true
  }).text('Upgrade');
  $('#container').append([$('<div>', {class: 'terminal-card', style: 'margin: 20px 0; border: none;'}).append(fieldset), upgradeButton]);
  $('#confirmUpgrade').on('change', function() {
    $('#upgradeButton').prop('disabled', !this.checked);
  });
}


// Render image selection
async function pickImages(upgrade) {
  let installText;
  let installFunction;
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
  for (let image of images.images) {
    let imageName = $('<p>').text(image.friendly_name);
    let imageDiv = $('<div>', {
      class: 'card',
      id: image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-'),
      title: image.description,
      'data-friendly-name': image.friendly_name
    }).append(imageName).css('filter', 'grayscale(100%)');
    imageDiv.on('click', function() {
      selectImage($(this).data('friendly-name'));
    });
    let thumb = $('<img>', {class: 'thumb', src: image.image_src, loading: 'lazy'});
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
function selectImage(friendlyName) {
  let elemId = friendlyName.replace(new RegExp(' ', 'g'), '_').replace('.', '-');
  let safeSelectorId = $.escapeSelector(elemId); // Escape the ID for jQuery
  if (installImages.includes(friendlyName)) {
    installImages = installImages.filter(e => e !== friendlyName);
    $('#' + safeSelectorId).css({
      filter: 'grayscale(100%) brightness(0.7)',
      background: ''
    });
  } else {
    installImages.push(friendlyName);
    $('#' + safeSelectorId).css({
      filter: '',
      background: '#30426c'
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
      let safeSelectorId = $.escapeSelector(imageElem); // Escape the ID for jQuery
      $('#' + safeSelectorId).css({
        filter: 'grayscale(100%)',
        background: ''
      });
    }
  } else {
    selected = true;
    for (let image of images.images) {
      let imageElem = image.friendly_name.replace(new RegExp(' ', 'g'), '_').replace('.', '-');
      let safeSelectorId = $.escapeSelector(imageElem); // Escape the ID for jQuery
      installImages.push(image.friendly_name);
      $('#' + safeSelectorId).css({
        filter: '',
        background: '#89cff0'
      });
    }
  }
}

// Show finished page
function done(data) {
  const port = (typeof data === 'object') ? data.port : data;
  const rollingTag = (typeof data === 'object') ? data.rollingTag : null;
  showContainer();
  titleChange('Complete');
  view = 'done';
  let titleBar = $('<div>');
  if (isUpgrade) {
    titleBar.append($('<h2>', {class: 'center'}).text('Upgrade Complete'));
    titleBar.append($('<h3>', {class: 'center'}).text('Remember to update your workspace image tags to :' + (rollingTag || (currentVersion + '-rolling-weekly'))));
  } else {
    titleBar.append($('<h2>', {class: 'center'}).text('Installation Complete'));
  }
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
socket.on('wizarderror', wizardError);
// Refreshed on every (re)connect, but not over a form, job terminal or final page
let pageLoaded = false;
let view = 'loading';  // loading | landing | form | terminal | done
let jobStarted = false;
function requestLanding() {
  if (pageLoaded && socket.connected && !jobStarted && (view === 'loading' || view === 'landing')) {
    socket.emit('renderlanding');
  }
}
socket.on('connect', function () {
  tokenRequired = false;
  requestLanding();
});

// Render landing on page load
window.onload = function() {
  pageLoaded = true;
  if (tokenRequired) {
    showTokenRequired();
    return;
  }
  if (view === 'loading') {
    showContainer();
    view = 'loading';
    titleChange('Loading');
    $('#container').append($('<div>').append($('<h2>', {class: 'center'}).text('Docker still loading, please refresh for installer')))
  }
  requestLanding();
}
