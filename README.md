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


# Security

The wizard can install, re-install and upgrade Kasm, so access to it is gated:

* **Setup token:** on every start the wizard prints a random one-time token to its log (`docker logs <container>`). Open `https://<host>:3000/?token=<token>`, or enter the token when prompted. Socket connections without the token are rejected.
* **No re-install:** the `install` action is refused once `/opt/kasm/current` exists, unless a previous wizard install failed or was interrupted (`/opt/kasm/.wizard_install_pending` present), in which case it can be retried. A successful wizard install writes `/opt/kasm/.wizard_install_complete`.
* **Stop Install Wizard** writes `/opt/NO_WIZARD` and exits the wizard process.

Never expose port 3000 to untrusted networks; bind it to `127.0.0.1` where possible.
