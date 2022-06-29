# Kasm Installation Wizard

The purpose of this application is to wrap the existing Bash based installation logic for Kasm Workspaces into a web based wizard. Post install the wizard should display the installation's information.

# Usage

Install deps: 

```
npm install
```

Run:

```
sudo node index.js
```

# Requirements

Linux host:
[https://kasmweb.com/docs/develop/install/system_requirements.html](https://kasmweb.com/docs/develop/install/system_requirements.html)

Alternatively Docker [DinD](https://hub.docker.com/_/docker) setup with Docker and Docker Compose installed.

As configured files ingested from a current Kasm Workspaces installer are needed: 

```bash
/wizard/
├── default_images_amd64.yaml
├── default_images_arm64.yaml
└── LICENSE.txt
/opt/kasm/certs/
├── kasm_wizard.crt
└── kasm_wizard.key
/kasm_release/
└── Full Kasm workspaces installer
```
