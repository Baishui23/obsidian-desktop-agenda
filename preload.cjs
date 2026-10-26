const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAgenda', {
  setOpacity: value => ipcRenderer.send('desktop-agenda-prototype', { action: 'opacity', value }),
  toggleDesktop: () => ipcRenderer.send('desktop-agenda-prototype', { action: 'toggle-desktop' }),
  fitScreen: () => ipcRenderer.send('desktop-agenda-prototype', { action: 'fit' }),
  close: () => ipcRenderer.send('desktop-agenda-prototype', { action: 'close' }),
  refreshTasks: () => ipcRenderer.send('desktop-agenda-prototype', { action: 'refresh-tasks' }),
  completeTask: (id, done) => ipcRenderer.send('desktop-agenda-prototype', { action: 'complete-task', id, done }),
  postponeTask: (id, date, changeDue) => ipcRenderer.send('desktop-agenda-prototype', { action: 'postpone-task', id, date, changeDue }),
  openTask: id => ipcRenderer.send('desktop-agenda-prototype', { action: 'open-task', id }),
  onTasks: callback => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('desktop-agenda-tasks', listener);
    return () => ipcRenderer.removeListener('desktop-agenda-tasks', listener);
  },
  onTaskResult: callback => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('desktop-agenda-task-result', listener);
    return () => ipcRenderer.removeListener('desktop-agenda-task-result', listener);
  },
  onError: callback => {
    const listener = (_event, error) => callback(error);
    ipcRenderer.on('desktop-agenda-error', listener);
    return () => ipcRenderer.removeListener('desktop-agenda-error', listener);
  },
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop-agenda-state', listener);
    return () => ipcRenderer.removeListener('desktop-agenda-state', listener);
  }
});
