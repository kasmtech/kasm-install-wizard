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

* **Setup token:** on every start the wizard prints a new random token to its log, valid until the wizard stops (`docker logs <container>`). Open `https://<host>:3000/#token=<token>` (the token stays in the URL fragment, so it is not sent in HTTP requests), or enter the token when prompted. Socket connections without the token are rejected.
* **No re-install:** the `install` action is refused once `/opt/kasm/current` exists. The installer creates it after seeding the database and before it first starts Kasm's services, and running the installer again resets the database, so a wizard install that fails after that point is not retried by the wizard; finish or repair it from the installer output. An install that fails earlier (`/opt/kasm/.wizard_install_pending` present, no `/opt/kasm/current`) can be retried; the retry starts over, including the database that attempt seeded. A successful wizard install writes `/opt/kasm/.wizard_install_complete`.
* **Stop Install Wizard** writes `/opt/NO_WIZARD` and exits the wizard process. It is refused while an install or upgrade is running.

Never expose port 3000 to untrusted networks; bind it to `127.0.0.1` where possible.
