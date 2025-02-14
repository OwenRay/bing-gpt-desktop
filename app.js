const {
  app,
  dialog,
  ipcMain,
  shell,
  globalShortcut,
  screen,
  net,
  Menu,
  Tray,
  BrowserWindow,
  protocol
} = require('electron');
const { autoUpdater } = require('electron-updater');
const AutoLaunch = require('auto-launch');
const Positioner = require('electron-traywindow-positioner');
const Bonjour = require('bonjour-service');
const bonjour = new Bonjour.Bonjour();
const logger = require('electron-log');
const config = require('./config');
const updateUrl = `https://update.iprodanov.com/files`;
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS']=true

autoUpdater.logger = logger;
autoUpdater.setFeedURL({
  provider: 'generic',
  url: updateUrl,
});
logger.catchErrors();
logger.info(`${app.name} started`);
logger.info(`Platform: ${process.platform} ${process.arch}`);

// hide dock icon on macOS
if (process.platform === 'darwin') {
  app.dock.hide();
}

const autoLauncher = new AutoLaunch({ name: 'BingChat Desktop' });

const indexFile = `file://${__dirname}/web/index.html`;
const errorFile = `file://${__dirname}/web/error.html`;

let initialized = false;
let autostartEnabled = false;
let forceQuit = false;
let resizeEvent = false;
let mainWindow;
let tray;
let updateCheckerInterval;
let availabilityCheckerInterval;

function registerKeyboardShortcut() {
  globalShortcut.register('CommandOrControl+Alt+C', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      showWindow();
    }
  });
}

function unregisterKeyboardShortcut() {
  globalShortcut.unregisterAll();
}

function checkAutoStart() {
  autoLauncher
    .isEnabled()
    .then((isEnabled) => {
      autostartEnabled = isEnabled;
    })
    .catch((err) => {
      logger.error('There was a problem with application auto start');
      logger.error(err);
    });
}

function changePosition() {
  const trayBounds = tray.getBounds();
  const windowBounds = mainWindow.getBounds();
  const displayWorkArea = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  }).workArea;
  const taskBarPosition = Positioner.getTaskbarPosition(trayBounds);

  if (taskBarPosition === 'top' || taskBarPosition === 'bottom') {
    const alignment = {
      x: 'center',
      y: taskBarPosition === 'top' ? 'up' : 'down',
    };

    if (trayBounds.x + (trayBounds.width + windowBounds.width) / 2 < displayWorkArea.width) {
      Positioner.position(mainWindow, trayBounds, alignment);
    } else {
      const { y } = Positioner.calculate(mainWindow.getBounds(), trayBounds, alignment);

      mainWindow.setPosition(
        displayWorkArea.width - windowBounds.width + displayWorkArea.x,
        y + (taskBarPosition === 'bottom' && displayWorkArea.y),
        false,
      );
    }
  } else {
    const alignment = {
      x: taskBarPosition,
      y: 'center',
    };

    if (trayBounds.y + (trayBounds.height + windowBounds.height) / 2 < displayWorkArea.height) {
      const { x, y } = Positioner.calculate(mainWindow.getBounds(), trayBounds, alignment);
      mainWindow.setPosition(x + (taskBarPosition === 'right' && displayWorkArea.x), y);
    } else {
      const { x } = Positioner.calculate(mainWindow.getBounds(), trayBounds, alignment);
      mainWindow.setPosition(x, displayWorkArea.y + displayWorkArea.height - windowBounds.height, false);
    }
  }
}

function getMenu() {
  let instancesMenu = [
    {
      label: 'Open in Browser',
      click: async () => {
        await shell.openExternal(currentInstance());
      },
    },
    {
      type: 'separator',
    },
  ];

  return Menu.buildFromTemplate([
    {
      label: 'Show/Hide Window',
      visible: process.platform === 'linux',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          showWindow();
        }
      },
    },
    {
      visible: process.platform === 'linux',
      type: 'separator',
    },
    ...instancesMenu,
    {
      type: 'separator',
    },
    {
      label: 'Hover to Show',
      visible: process.platform !== 'linux' && !config.get('detachedMode'),
      enabled: !config.get('detachedMode'),
      type: 'checkbox',
      checked: !config.get('disableHover'),
      click: () => {
        config.set('disableHover', !config.get('disableHover'));
      },
    },
    {
      label: 'Stay on Top',
      type: 'checkbox',
      checked: config.get('stayOnTop'),
      click: () => {
        config.set('stayOnTop', !config.get('stayOnTop'));
        mainWindow.setAlwaysOnTop(config.get('stayOnTop'));

        if (mainWindow.isAlwaysOnTop()) {
          showWindow();
        }
      },
    },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: autostartEnabled,
      click: () => {
        if (autostartEnabled) {
          autoLauncher.disable();
        } else {
          autoLauncher.enable();
        }

        checkAutoStart();
      },
    },
    {
      label: 'Enable Shortcut',
      type: 'checkbox',
      accelerator: 'CommandOrControl+Alt+C',
      checked: config.get('shortcutEnabled'),
      click: () => {
        config.set('shortcutEnabled', !config.get('shortcutEnabled'));

        if (config.get('shortcutEnabled')) {
          registerKeyboardShortcut();
        } else {
          unregisterKeyboardShortcut();
        }
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Use detached Window',
      type: 'checkbox',
      checked: config.get('detachedMode'),
      click: async () => {
        config.set('detachedMode', !config.get('detachedMode'));
        mainWindow.hide();
        await createMainWindow(config.get('detachedMode'));
      },
    },
    {
      label: 'Use Fullscreen',
      type: 'checkbox',
      checked: config.get('fullScreen'),
      accelerator: 'CommandOrControl+Alt+Return',
      click: () => {
        toggleFullScreen();
      },
    },
    {
      type: 'separator',
    },
    {
      label: `v${app.getVersion()}`,
      enabled: false,
    },
    {
      label: 'Automatic Updates',
      type: 'checkbox',
      checked: config.get('autoUpdate'),
      click: async () => {
        const currentStatus = config.get('autoUpdate');
        config.set('autoUpdate', !currentStatus);

        if (currentStatus) {
          clearInterval(updateCheckerInterval);
          updateCheckerInterval = null;
        } else {
          await useAutoUpdater();
        }
      },
    },
    {
      label: 'Open on github.com',
      click: async () => {
        await shell.openExternal('https://github.com/owenray/bing-gpt-desktop');
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Restart Application',
      click: () => {
        app.relaunch();
        app.exit();
      },
    },
    {
      label: '⚠️ Reset Application',
      click: () => {
        dialog
          .showMessageBox({
            message: 'Are you sure you want to reset Bing GPT Desktop?',
            buttons: ['Reset Everything!', 'Reset Windows', 'Cancel'],
          })
          .then(async (res) => {
            if (res.response !== 2) {
              if (res.response === 0) {
                config.clear();
                await mainWindow.webContents.session.clearCache();
                await mainWindow.webContents.session.clearStorageData();
              } else {
                config.delete('windowSizeDetached');
                config.delete('windowSize');
                config.delete('windowPosition');
                config.delete('fullScreen');
                config.delete('detachedMode');
              }

              app.relaunch();
              app.exit();
            }
          });
      },
    },
    {
      type: 'separator',
    },
    {
      label: 'Quit',
      click: () => {
        forceQuit = true;
        app.quit();
      },
    },
  ]);
}

async function createMainWindow() {
  logger.info('Initialized main window');
  mainWindow = new BrowserWindow({
    width: 420,
    height: 460,
    minWidth: 420,
    minHeight: 460,
    show: false,
    skipTaskbar: false,
    autoHideMenuBar: true,
    frame: config.get('detachedMode') && process.platform !== 'darwin',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // mainWindow.webContents.openDevTools();
  mainWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36 Edg/111.0.1661.62');

  await mainWindow.loadURL('https://www.bing.com/search?q=Bing+AI&showconv=1&FORM=hpcodx');

  setInterval(() => mainWindow.url, 2000);

  createTray();

  // open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (config.get('detachedMode')) {
    if (config.has('windowPosition')) {
      mainWindow.setSize(...config.get('windowSizeDetached'));
    } else {
      config.set('windowPosition', mainWindow.getPosition());
    }

    if (config.has('windowSizeDetached')) {
      mainWindow.setPosition(...config.get('windowPosition'));
    } else {
      config.set('windowSizeDetached', mainWindow.getSize());
    }
  } else if (config.has('windowSize')) {
    mainWindow.setSize(...config.get('windowSize'));
  } else {
    config.set('windowSize', mainWindow.getSize());
  }

  mainWindow.on('resize', (e) => {
    // ignore resize event when using fullscreen mode
    if (mainWindow.isFullScreen()) {
      return e;
    }

    if (!config.get('disableHover') || resizeEvent) {
      config.set('disableHover', true);
      resizeEvent = e;
      setTimeout(() => {
        if (resizeEvent === e) {
          config.set('disableHover', false);
          resizeEvent = false;
        }
      }, 600);
    }

    if (config.get('detachedMode')) {
      config.set('windowSizeDetached', mainWindow.getSize());
    } else {
      if (process.platform !== 'linux') {
        changePosition();
      }

      config.set('windowSize', mainWindow.getSize());
    }
  });

  mainWindow.on('move', () => {
    if (config.get('detachedMode')) {
      config.set('windowPosition', mainWindow.getPosition());
    }
  });

  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      mainWindow.hide();
      e.preventDefault();
    }
  });

  mainWindow.on('blur', () => {
    if (!config.get('detachedMode') && !mainWindow.isAlwaysOnTop()) {
      mainWindow.hide();
    }
  });

  mainWindow.setAlwaysOnTop(!!config.get('stayOnTop'));

  if (initialized && (mainWindow.isAlwaysOnTop() || show)) {
    showWindow();
  }

  toggleFullScreen(!!config.get('fullScreen'));

  initialized = true;
}

async function reinitMainWindow() {
  logger.info('Re-initialized main window');
  mainWindow.destroy();
  mainWindow = null;
  await createMainWindow(!config.has('currentInstance'));

  if (!availabilityCheckerInterval) {
    logger.info('Re-initialized availability check');
    availabilityCheckerInterval = setInterval(availabilityCheck, 3000);
  }
}

function showWindow() {
  if (!config.get('detachedMode')) {
    changePosition();
  }

  if (!mainWindow.isVisible()) {
    mainWindow.setVisibleOnAllWorkspaces(true); // put the window on all screens
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setVisibleOnAllWorkspaces(false); // disable all screen behavior
    mainWindow.setSkipTaskbar(!config.get("detachedMode"));
  }
}

function createTray() {
  if (tray instanceof Tray) {
    return;
  }

  logger.info('Initialized Tray menu');
  tray = new Tray(
    ['win32', 'linux'].includes(process.platform) ? `${__dirname}/assets/IconWin.png` : `${__dirname}/assets/IconTemplate.png`,
  );

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();

      if (process.platform === 'darwin') {
        app.dock.hide();
      }
    } else {
      showWindow();
    }
  });

  tray.on('right-click', () => {
    if (!config.get('detachedMode')) {
      mainWindow.hide();
    }

    tray.popUpContextMenu(getMenu());
  });

  let timer = undefined;

  tray.on('mouse-move', () => {
    if (config.get('detachedMode') || mainWindow.isAlwaysOnTop() || config.get('disableHover')) {
      return;
    }

    if (!mainWindow.isVisible()) {
      showWindow();
    }

    if (timer) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      let mousePos = screen.getCursorScreenPoint();
      let trayBounds = tray.getBounds();

      if (
        !(mousePos.x >= trayBounds.x && mousePos.x <= trayBounds.x + trayBounds.width) ||
        !(mousePos.y >= trayBounds.y && mousePos.y <= trayBounds.y + trayBounds.height)
      ) {
        setWindowFocusTimer();
      }
    }, 100);
  });
}

function setWindowFocusTimer() {
  setTimeout(() => {
    let mousePos = screen.getCursorScreenPoint();
    let windowPosition = mainWindow.getPosition();
    let windowSize = mainWindow.getSize();

    if (
      !resizeEvent &&
      (
        !(mousePos.x >= windowPosition[ 0 ] && mousePos.x <= windowPosition[ 0 ] + windowSize[ 0 ]) ||
        !(mousePos.y >= windowPosition[ 1 ] && mousePos.y <= windowPosition[ 1 ] + windowSize[ 1 ])
      )
    ) {
      mainWindow.hide();
    } else {
      setWindowFocusTimer();
    }
  }, 110);
}

function toggleFullScreen(mode = !mainWindow.isFullScreen()) {
  config.set('fullScreen', mode);
  mainWindow.setFullScreen(mode);

  if (mode) {
    mainWindow.setAlwaysOnTop(true);
  } else {
    mainWindow.setAlwaysOnTop(config.get('stayOnTop'));
  }
}

async function showError(isError) {
  if (!isError && mainWindow.webContents.getURL().includes('error.html')) {
    await mainWindow.loadURL(indexFile);
  }

  if (isError && currentInstance() && !mainWindow.webContents.getURL().includes('error.html')) {
    await mainWindow.loadURL(errorFile);
  }
}

app.whenReady().then(async () => {
  checkAutoStart();

  await createMainWindow();

  if (process.platform === 'linux') {
    tray.setContextMenu(getMenu());
  }

  // register shortcut
  if (config.get('shortcutEnabled')) {
    registerKeyboardShortcut();
  }

  globalShortcut.register('CommandOrControl+Alt+Return', () => {
    toggleFullScreen();
  });

  // enable auto update by default
  if (!config.has('autoUpdate')) {
    config.set('autoUpdate', true);
  }
});

app.on('will-quit', () => {
  unregisterKeyboardShortcut();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
