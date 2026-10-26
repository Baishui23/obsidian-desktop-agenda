const { Plugin, Notice, Platform } = require('obsidian');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const runtimeProcess = require('node:process');
const nativeFiles = require('node:fs/promises');

const CHANNEL = 'desktop-agenda-prototype';
const DEFAULTS = { opacity: 0.93, pinned: false, mode: 'bottom', bounds: null };

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function fitBounds(candidate, workArea) {
  const margin = 16;
  const maxWidth = Math.max(1, workArea.width - margin * 2);
  const maxHeight = Math.max(1, workArea.height - margin * 2);
  const width = clamp(Math.round(candidate?.width || 400), Math.min(320, maxWidth), maxWidth);
  const height = clamp(Math.round(candidate?.height || 700), Math.min(460, maxHeight), maxHeight);
  const right = workArea.x + workArea.width - margin - width;
  const bottom = workArea.y + workArea.height - margin - height;
  return {
    width, height,
    x: clamp(Math.round(candidate?.x ?? right), workArea.x + margin, right),
    y: clamp(Math.round(candidate?.y ?? workArea.y + 32), workArea.y + margin, bottom)
  };
}

function normalizeSettings(raw = {}) {
  const opacity = Number(raw.opacity);
  const bounds = raw.bounds && ['x', 'y', 'width', 'height'].every(key =>
    Number.isFinite(raw.bounds[key])) ? raw.bounds : null;
  return {
    opacity: Number.isFinite(opacity) ? clamp(opacity, 0, 1) : DEFAULTS.opacity,
    pinned: false,
    mode: raw.mode === 'window' ? 'window' : DEFAULTS.mode,
    bounds
  };
}

class DesktopAgendaPlugin extends Plugin {
  async onload() {
    this.agendaWindow = null;
    this.saveTimer = null;
    this.refreshTimer = null;
    this.disposed = false;
    this.refreshVersion = 0;
    this.taskCache = new Map();
    this.taskIndex = new Map();
    this.mutationChain = Promise.resolve();
    this.windowOperations = Promise.resolve();
    this.bottomWorkers = new Map();
    this.desktopAttached = false;
    this.desktopError = '';
    const taskModule = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'tasks.cjs');
    const localRequire = createRequire(path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'main.js'));
    delete localRequire.cache[localRequire.resolve(taskModule)];
    this.taskIO = localRequire(taskModule);
    this.settings = normalizeSettings((await this.loadData()) || {});
    this.addCommand({ id: 'open-window', name: '打开桌面日程', callback: () => this.openWindow() });
    this.addCommand({ id: 'restore-visible', name: '恢复可见并编辑窗口（100% 不透明）', callback: () => this.switchWindowMode('window', true) });
    this.addCommand({ id: 'attach-desktop', name: '放回置底显示', callback: () => this.switchWindowMode('bottom') });
    this.addCommand({ id: 'edit-window', name: '前置编辑窗口', callback: () => this.switchWindowMode('window') });
    this.addRibbonIcon('panels-top-left', '打开桌面日程', () => this.openWindow());
    this.registerObsidianProtocolHandler('desktop-agenda', params => {
      // Obsidian reserves `action` for the registered handler name.
      if (params.command === 'restore') return this.switchWindowMode('window', true);
      if (params.command === 'desktop' || params.command === 'bottom') return this.switchWindowMode('bottom');
      return this.openWindow();
    });
    const invalidate = (file, oldPath) => {
      if (oldPath) this.taskCache.delete(oldPath);
      if (file?.extension === 'md' || oldPath) {
        this.taskCache.delete(file.path);
        this.queueTaskRefresh();
      }
    };
    for (const event of ['modify', 'create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(event, invalidate));
    }
    // Recompute the date after midnight or resuming from sleep; unchanged notes stay cached.
    this.registerInterval(window.setInterval(() => this.queueTaskRefresh(), 30000));
    this.app.workspace.onLayoutReady(() => this.openWindow());
  }

  queueTaskRefresh() {
    if (this.disposed || !this.agendaWindow || this.agendaWindow.isDestroyed()) return;
    this.refreshVersion++;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshTasks().catch(error => {
      this.sendTaskMessage('desktop-agenda-error', { message: `读取任务失败：${error.message}` });
    }), 180);
  }

  sendTaskMessage(channel, data) {
    const win = this.agendaWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  }

  async refreshTasks() {
    if (this.disposed) return;
    const version = ++this.refreshVersion;
    const files = this.app.vault.getMarkdownFiles().filter(file => this.taskIO.isTaskFile(file.path));
    const paths = new Set(files.map(file => file.path));
    for (const key of this.taskCache.keys()) if (!paths.has(key)) this.taskCache.delete(key);
    let cursor = 0;
    const results = [];
    const read = async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const stamp = `${file.stat.mtime}:${file.stat.size}`;
        let cached = this.taskCache.get(file.path);
        if (!cached || cached.stamp !== stamp) {
          try {
            const text = await this.app.vault.cachedRead(file);
            cached = { stamp, ...this.taskIO.parseFile(text, file.path) };
            // A newer scan owns the cache if a note changed while this read was pending.
            if (version === this.refreshVersion && !this.disposed) this.taskCache.set(file.path, cached);
          } catch (error) {
            cached = { tasks: [], issues: [{ path: file.path, line: 0, message: `读取失败：${error.message}` }] };
          }
        }
        results.push(cached);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, read));
    if (this.disposed || version !== this.refreshVersion) return;
    const today = this.taskIO.todayISO();
    const originals = results.flatMap(result => result.tasks);
    this.taskIndex = new Map(originals.map(task => [task.id, task]));
    const tasks = originals.map(task => this.taskIO.viewTask(task, today));
    tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(a.done) - Number(b.done)
      || (a.date || '9999').localeCompare(b.date || '9999')
      || b.priority - a.priority || (a.start || '99:99').localeCompare(b.start || '99:99')
      || a.path.localeCompare(b.path) || a.line - b.line);
    this.sendTaskMessage('desktop-agenda-tasks', {
      today, tomorrow: this.taskIO.addDays(today, 1), tasks,
      issues: results.flatMap(result => result.issues)
    });
  }

  handleTaskAction(payload) {
    if (payload.action === 'refresh-tasks') {
      this.taskCache.clear();
      this.queueTaskRefresh();
      return;
    }
    const reference = typeof payload.id === 'string' && this.taskIndex.get(payload.id);
    if (!reference) {
      this.sendTaskMessage('desktop-agenda-error', { message: '任务已刷新，请重新点击', id: payload.id });
      this.queueTaskRefresh();
      return;
    }
    const act = async () => {
      if (this.disposed) return;
      const file = this.app.vault.getAbstractFileByPath(reference.path);
      if (!file || file.extension !== 'md') throw new Error('原笔记已移动或删除，请刷新');
      if (payload.action === 'open-task') {
        await this.app.workspace.getLeaf('tab').openFile(file, { eState: { line: reference.line } });
        this.getRemote().getCurrentWindow().show();
        this.getRemote().getCurrentWindow().focus();
        return;
      }
      const action = payload.action === 'complete-task'
        ? { type: 'complete', done: payload.done }
        : { type: 'postpone', date: payload.date, changeDue: payload.changeDue };
      await this.app.vault.process(file, content => this.taskIO.mutateTask(content, reference, action));
      this.taskCache.delete(file.path);
      await this.refreshTasks();
      this.sendTaskMessage('desktop-agenda-task-result', {
        id: payload.id, message: action.type === 'postpone' ? '计划日期已更新，原笔记保留改期记录' : '任务状态已更新'
      });
    };
    this.mutationChain = this.mutationChain.catch(() => {}).then(act).catch(error => {
      this.sendTaskMessage('desktop-agenda-error', { id: payload.id, message: error.message });
      this.queueTaskRefresh();
    });
  }

  getRemote() {
    try {
      return window.electron?.remote || require('electron').remote || require('@electron/remote');
    } catch {
      throw new Error('当前 Obsidian 没有提供桌面窗口接口。');
    }
  }

  stopBottomHost(win) {
    const child = this.bottomWorkers.get(win);
    this.bottomWorkers.delete(win);
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

  async startBottomHost(win, remote, title) {
    if (runtimeProcess.platform !== 'win32') throw new Error('置底模式目前只支持 Windows。');
    const packaged = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, 'desktop-host.exe');
    const binary = await nativeFiles.readFile(packaged);
    const digest = createHash('sha256').update(binary).digest('hex').slice(0, 16);
    // A vault may carry a Low integrity label. A helper launched there cannot adjust
    // a normal Obsidian window. Install our exact bundled binary in per-user app data.
    const nativeDir = path.join(runtimeProcess.env.LOCALAPPDATA || remote.app.getPath('userData'),
      'ObsidianDesktopAgenda', 'native', `${this.manifest.version}-${digest}`);
    await nativeFiles.mkdir(nativeDir, { recursive: true });
    const executable = path.join(nativeDir, 'desktop-host.exe');
    let existing;
    try { existing = await nativeFiles.readFile(executable); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing?.equals(binary)) await nativeFiles.writeFile(executable, binary);
    const bytes = Buffer.from(win.getNativeWindowHandle());
    const handle = bytes.length >= 8 ? bytes.readBigUInt64LE(0).toString() : String(bytes.readUInt32LE(0));
    const resultPath = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, `native-result-${randomUUID()}.json`);
    try {
      const child = spawn(executable, [handle, String(remote.process.pid), title, resultPath],
        { windowsHide: true, stdio: 'ignore' });
      this.bottomWorkers.set(win, child);
      let launchError = null;
      let exited = false;
      child.on('error', error => { launchError = error; });
      child.on('exit', () => {
        exited = true;
        if (this.bottomWorkers.get(win) !== child) return;
        this.bottomWorkers.delete(win);
        if (!this.disposed && this.agendaWindow === win && !win.isDestroyed() && this.desktopAttached) {
          this.desktopAttached = false;
          this.desktopError = '置底助手已退出，请点桌面图标重新启用。';
          win.setSkipTaskbar(false);
          win.webContents.send('desktop-agenda-state', {
            ...this.settings, desktopAttached: false, desktopError: this.desktopError
          });
        }
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (this.disposed || this.agendaWindow !== win || win.isDestroyed()) throw new Error('日程窗口已关闭。');
        let result;
        try { result = JSON.parse(await nativeFiles.readFile(resultPath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        if (result) {
          if (!result.ready) throw new Error(result.error || 'Windows 未确认置底。');
          if (launchError || exited) throw new Error(launchError?.message || '置底助手提前退出。');
          return;
        }
        if (launchError || exited) throw new Error(launchError?.message || '置底助手未能启动。');
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      throw new Error('置底助手启动超时。');
    } catch (error) {
      this.stopBottomHost(win);
      throw error;
    } finally {
      await nativeFiles.unlink(resultPath).catch(() => {});
    }
  }

  switchWindowMode(mode, recover = false) {
    this.windowOperations = this.windowOperations.catch(() => {}).then(async () => {
      if (this.disposed) return;
      const old = this.agendaWindow;
      clearTimeout(this.saveTimer);
      if (old && !old.isDestroyed()) {
        this.stopBottomHost(old);
        this.settings.bounds = old.getBounds();
        this.settings.opacity = old.getOpacity();
        this.agendaWindow = null;
        old.destroy();
      }
      this.desktopAttached = false;
      this.desktopError = '';
      this.settings.mode = mode;
      this.settings.pinned = false;
      if (recover) this.settings.opacity = 1;
      await this.saveData(this.settings);
      if (!this.disposed) await this.openWindow();
    }).catch(error => {
      if (!this.disposed) new Notice(`日程窗口切换失败：${error.message}`, 10000);
    });
    return this.windowOperations;
  }

  async openWindow() {
    if (this.disposed) return;
    if (this.agendaWindow && !this.agendaWindow.isDestroyed()) {
      if (this.agendaWindow.isMinimized()) this.agendaWindow.restore();
      if (this.desktopAttached) this.agendaWindow.showInactive();
      else { this.agendaWindow.show(); this.agendaWindow.focus(); }
      return;
    }
    let ownedWindow = null;
    try {
      if (!Platform.isDesktopApp) throw new Error('桌面日程样机仅支持桌面版 Obsidian。');
      const remote = this.getRemote();
      const pluginDir = path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
      const initialDisplay = this.settings.bounds
        ? remote.screen.getDisplayMatching(this.settings.bounds)
        : remote.screen.getDisplayNearestPoint(remote.screen.getCursorScreenPoint());
      const bounds = fitBounds(this.settings.bounds, initialDisplay.workArea);
      const title = `桌面日程 · ${randomUUID().slice(0, 8)}`;
      const win = new remote.BrowserWindow({
        ...bounds,
        minWidth: Math.min(320, bounds.width),
        minHeight: Math.min(460, bounds.height),
        title,
        frame: false,
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        show: false,
        backgroundColor: '#17221f',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(pluginDir, 'preload.cjs'),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      });
      ownedWindow = win;
      this.agendaWindow = win;
      this.desktopAttached = false;
      this.desktopError = '';
      win.setOpacity(this.settings.opacity);
      win.setIgnoreMouseEvents(this.settings.opacity === 0);
      win.setAlwaysOnTop(false);
      const report = () => {
        if (win.isDestroyed()) return;
        this.settings = { ...this.settings, opacity: win.getOpacity(), pinned: false, bounds: win.getBounds() };
        win.webContents.send('desktop-agenda-state', {
          ...this.settings, desktopAttached: this.desktopAttached, desktopError: this.desktopError
        });
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveData(this.settings).catch(console.error), 180);
      };
      const fitToScreen = () => {
        if (win.isDestroyed()) return;
        const display = remote.screen.getDisplayMatching(win.getBounds());
        const current = win.getBounds();
        win.setBounds(fitBounds({ width: current.width, height: current.height }, display.workArea));
        report();
      };
      win.webContents.on('ipc-message', (_event, channel, payload) => {
        if (channel !== CHANNEL || win.isDestroyed() || !payload || typeof payload !== 'object') return;
        switch (payload.action) {
          case 'opacity':
            if (Number.isFinite(payload.value)) {
              const opacity = clamp(payload.value, 0, 1);
              win.setOpacity(opacity);
              win.setIgnoreMouseEvents(opacity === 0);
            }
            break;
          case 'toggle-desktop': this.switchWindowMode(this.settings.mode === 'bottom' ? 'window' : 'bottom'); return;
          case 'fit':
            fitToScreen(); break;
          case 'close': win.close(); return;
          case 'refresh-tasks':
          case 'complete-task':
          case 'postpone-task':
          case 'open-task': this.handleTaskAction(payload); return;
          default: return;
        }
        report();
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      // Verify the unique title and owner before moving any native window.
      win.on('page-title-updated', event => event.preventDefault());
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.on('move', report);
      win.on('resize', report);
      const changed = () => {
        fitToScreen();
      };
      remote.screen.on('display-removed', changed);
      remote.screen.on('display-metrics-changed', changed);
      win.on('closed', () => {
        this.stopBottomHost(win);
        remote.screen.removeListener('display-removed', changed);
        remote.screen.removeListener('display-metrics-changed', changed);
        if (this.agendaWindow === win) this.agendaWindow = null;
      });
      await win.loadFile(path.join(pluginDir, 'window.html'));
      if (this.disposed || this.agendaWindow !== win || win.isDestroyed()) return;
      // Remote event callbacks cannot cancel every native title update synchronously.
      win.setTitle(title);
      if (this.settings.mode === 'bottom') {
        try {
          win.setSkipTaskbar(true);
          win.showInactive();
          await this.startBottomHost(win, remote, title);
          if (this.disposed || this.agendaWindow !== win || win.isDestroyed()) return;
          this.desktopAttached = true;
        } catch (error) {
          if (this.disposed || this.agendaWindow !== win || win.isDestroyed()) return;
          this.desktopError = `置底未成功，当前为普通窗口：${error.message}`;
          win.setSkipTaskbar(false);
        }
      }
      report();
      this.queueTaskRefresh();
      if (!this.desktopAttached) { win.show(); win.focus(); }
    } catch (error) {
      if (ownedWindow && !ownedWindow.isDestroyed()) ownedWindow.destroy();
      if (this.agendaWindow === ownedWindow) this.agendaWindow = null;
      console.error('Desktop Agenda:', error);
      new Notice(`桌面日程样机打开失败：${error.message}`, 10000);
    }
  }

  onunload() {
    this.disposed = true;
    this.refreshVersion++;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.saveTimer);
    for (const win of this.bottomWorkers.keys()) this.stopBottomHost(win);
    // Window events persist geometry before closure; keep the final settings on unload too.
    void this.saveData(this.settings).catch(console.error);
    if (this.agendaWindow && !this.agendaWindow.isDestroyed()) this.agendaWindow.close();
  }
}

module.exports = DesktopAgendaPlugin;
// Pure functions are exported for geometry and persisted-state checks without launching Obsidian.
module.exports.windowUtils = { fitBounds, normalizeSettings };
